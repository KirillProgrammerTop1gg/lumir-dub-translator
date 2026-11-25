import os
import json
import re
import shutil
import threading
import queue
import uuid
import urllib.request
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.processor import duration_seconds, process_video
from app.ai import analyze_project
from app.env_settings import change as change_env, status as env_status
from app.cambridge import lookup as cambridge_lookup
from app.store import Store

DATA_DIR = Path(os.getenv("LUMIR_DATA_DIR", "data")).resolve()
store = Store(DATA_DIR)
app = FastAPI(title="Lumir Dub Translator")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["*"], allow_headers=["*"])
queue_lock = threading.Lock()
env_lock = threading.Lock()
jobs: queue.Queue[tuple[str, str, Path, int | None]] = queue.Queue()
job_thread: threading.Thread | None = None
MAX_BYTES = 2 * 1024 * 1024 * 1024


class ProcessRequest(BaseModel):
    device: str = Field(pattern="^(cpu|cuda)$")
    expected_speakers: int | None = Field(default=None, ge=1, le=8)
    replace_existing: bool = False


class ProjectPatch(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class SpeakerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class SegmentPatch(BaseModel):
    text: str = Field(min_length=1, max_length=10000)
    speaker_id: str | None = None


class SegmentMerge(BaseModel):
    segment_ids: list[str] = Field(min_length=2, max_length=100)
    speaker_id: str | None = None


class SegmentSpeakerChange(BaseModel):
    segment_ids: list[str] = Field(min_length=1, max_length=500)
    speaker_id: str | None = None


class SegmentSplit(BaseModel):
    text: str = Field(min_length=1, max_length=10000)
    split_at: int = Field(ge=1)
    first_speaker_id: str | None = None
    second_speaker_id: str | None = None


class SpeakerPatch(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class AIConfig(BaseModel):
    context_notes: str = Field(max_length=10000)
    target_language: str = Field(min_length=2, max_length=80)
    ai_provider: Literal["ollama", "openrouter"] = "ollama"


class AILinePatch(BaseModel):
    translated_text: str = Field(min_length=1, max_length=10000)


class EnvChange(BaseModel):
    key: Literal["HF_TOKEN", "OPENAI_API_KEY", "OPENAI_MODEL", "OLLAMA_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "CAMBRIDGE_API_KEY", "CAMBRIDGE_DICTIONARY_CODE"]
    value: str | None = None


def row_or_404(project_id: str):
    with store.connect() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Проект не найден")
    return row


@app.get("/settings/env")
def get_env_settings():
    return env_status()


@app.get("/version")
def version():
    return {"revision": 7}


@app.get("/ai/providers")
def ai_providers():
    settings = env_status()
    model = settings["ollama_model"]["value"]
    running = False
    installed = False
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2) as response:
            models = json.load(response).get("models", [])
        running = True
        installed = any(item.get("name") == model or item.get("model") == model for item in models)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return {"ollama_running": running, "ollama_model_installed": installed, "ollama_model": model,
            "openrouter_configured": settings["openrouter_api_key"]["configured"], "openrouter_model": settings["openrouter_model"]["value"]}


@app.get("/dictionary/cambridge")
def dictionary_cambridge(word: str = Query(min_length=1, max_length=64, pattern=r"^[A-Za-z][A-Za-z'-]*$")):
    try:
        return cambridge_lookup(word)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(502, str(exc)) from exc


@app.patch("/settings/env")
def update_env_settings(body: EnvChange):
    try:
        with env_lock:
            return change_env(body.key, body.value)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/projects", status_code=201)
def upload_video(file: UploadFile = File(...)):
    if not file.filename or Path(file.filename).suffix.lower() not in {".mp4", ".mkv", ".mov", ".webm"}:
        raise HTTPException(400, "Поддерживаются MP4, MKV, MOV и WebM")
    project_id = str(uuid.uuid4())
    directory = DATA_DIR / project_id
    directory.mkdir(parents=True)
    path = directory / ("video" + Path(file.filename).suffix.lower())
    size = 0
    try:
        with path.open("wb") as output:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413, "Видео превышает лимит 2 ГБ")
                output.write(chunk)
        try:
            duration = duration_seconds(path)
        except Exception as exc:
            raise HTTPException(400, "Не удалось прочитать видео") from exc
        if not 0 < duration <= 1800:
            raise HTTPException(400, "Длительность видео должна быть не больше 30 минут")
        with store.connect() as conn:
            conn.execute("INSERT INTO projects(id,filename,video_path,duration,status) VALUES(?,?,?,?,?)", (project_id, Path(file.filename).name, str(path), duration, "ready"))
        return store.get(project_id)
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise


@app.get("/projects")
def list_projects():
    with store.connect() as conn:
        return [dict(row) for row in conn.execute("SELECT id,filename,COALESCE(title,filename) AS title,duration,status,device,expected_speakers,progress,stage,error,created_at FROM projects ORDER BY created_at DESC")]


@app.get("/projects/{project_id}")
def get_project(project_id: str):
    project = store.get(project_id)
    if project is None:
        raise HTTPException(404, "Проект не найден")
    return project


@app.patch("/projects/{project_id}")
def edit_project(project_id: str, body: ProjectPatch):
    row_or_404(project_id)
    if not body.title.strip():
        raise HTTPException(400, "Название проекта не может быть пустым")
    with store.connect() as conn:
        conn.execute("UPDATE projects SET title=? WHERE id=?", (body.title.strip(), project_id))
    return store.get(project_id)


@app.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str):
    row = row_or_404(project_id)
    if row["status"] in {"queued", "processing"} or row["ai_status"] == "processing":
        raise HTTPException(409, "Нельзя удалить проект во время обработки")
    with store.connect() as conn:
        conn.execute("DELETE FROM segments WHERE project_id=?", (project_id,))
        conn.execute("DELETE FROM speakers WHERE project_id=?", (project_id,))
        conn.execute("DELETE FROM ai_lines WHERE project_id=?", (project_id,))
        conn.execute("DELETE FROM projects WHERE id=?", (project_id,))
    shutil.rmtree(DATA_DIR / project_id, ignore_errors=True)


def srt_time(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole, fraction = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{whole:02},{fraction:03}"


@app.get("/projects/{project_id}/export/{format}")
def export_project(project_id: str, format: str):
    project = store.get(project_id)
    if project is None:
        raise HTTPException(404, "Проект не найден")
    if format not in {"srt", "txt", "json", "translated-srt", "translated-txt", "dialogue-txt", "english-dialogue-txt"}:
        raise HTTPException(400, "Недоступный формат экспорта")
    translated = format in {"translated-srt", "translated-txt", "dialogue-txt"}
    english_dialogue = format == "english-dialogue-txt"
    if not (project["ai_lines"] if translated else project["segments"]):
        raise HTTPException(409, "Транскрипция ещё не готова")
    if format == "json":
        body = json.dumps({key: project[key] for key in ("id", "title", "filename", "duration", "speakers", "segments")}, ensure_ascii=False, indent=2)
        media_type = "application/json"
    else:
        names = {speaker["id"]: speaker["name"] for speaker in project["speakers"]}
        lines = []
        use_ai_english = english_dialogue and project["ai_status"] == "complete" and bool(project["ai_lines"])
        export_lines = project["ai_lines"] if translated or use_ai_english else project["segments"]
        current_name = None
        dialogue_parts = []
        for index, segment in enumerate(export_lines, 1):
            name = names.get(segment["speaker_id"], "Неизвестно")
            body_text = segment["translated_text"] if translated else segment["source_text"] if use_ai_english else segment["text"]
            if format in {"dialogue-txt", "english-dialogue-txt"}:
                if dialogue_parts and name != current_name:
                    lines.append(f"{current_name} — {' '.join(dialogue_parts)}")
                    dialogue_parts = []
                current_name = name
                dialogue_parts.append(body_text.strip())
            elif format.endswith("srt"):
                lines.append(f"{index}\n{srt_time(segment['start'])} --> {srt_time(segment['end'])}\n{name}: {body_text}\n")
            else:
                lines.append(f"[{srt_time(segment['start'])}–{srt_time(segment['end'])}] {name}: {body_text}")
        if dialogue_parts:
            lines.append(f"{current_name} — {' '.join(dialogue_parts)}")
        body = "\n".join(lines) + ("\n" if lines else "")
        media_type = "application/x-subrip" if format.endswith("srt") else "text/plain"
    extension = format.rsplit("-", 1)[-1]
    filename = f"{'dialogue-en' if english_dialogue else 'dialogue-ru' if format == 'dialogue-txt' else 'translation' if translated else 'transcript'}.{extension}"
    return Response(content=body, media_type=f"{media_type}; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/projects/{project_id}/video")
def get_video(project_id: str):
    row = row_or_404(project_id)
    return FileResponse(row["video_path"], filename=row["filename"], content_disposition_type="inline")


@app.patch("/projects/{project_id}/ai/config")
def configure_ai(project_id: str, body: AIConfig):
    row = row_or_404(project_id)
    if row["ai_status"] == "processing":
        raise HTTPException(409, "Дождитесь завершения AI-анализа")
    if not body.target_language.strip():
        raise HTTPException(400, "Укажите язык перевода")
    with store.connect() as conn:
        conn.execute("UPDATE projects SET context_notes=?, target_language=?, ai_provider=? WHERE id=?", (body.context_notes.strip(), body.target_language.strip(), body.ai_provider, project_id))
    return store.get(project_id)


def ai_worker(project_id: str, snapshot: dict):
    try:
        def progress(value: int):
            with store.connect() as conn:
                conn.execute("UPDATE projects SET ai_progress=? WHERE id=? AND ai_status='processing'", (value, project_id))
        lines = analyze_project(snapshot, progress)
        with queue_lock:
            current = store.get(project_id)
            if current is None or current["segments"] != snapshot["segments"] or current["status"] != "complete":
                raise RuntimeError("Транскрипция изменилась во время AI-анализа; запустите его снова")
            store.save_ai_lines(project_id, lines)
    except Exception as exc:
        with store.connect() as conn:
            conn.execute("UPDATE projects SET ai_status='failed', ai_error=? WHERE id=?", (str(exc), project_id))


@app.post("/projects/{project_id}/ai/run", status_code=202)
def start_ai(project_id: str):
    with queue_lock:
        project = store.get(project_id)
        if project is None:
            raise HTTPException(404, "Проект не найден")
        if project["status"] != "complete" or not project["segments"]:
            raise HTTPException(409, "Сначала завершите транскрипцию видео")
        if project["ai_status"] == "processing":
            raise HTTPException(409, "AI-анализ уже выполняется")
        with store.connect() as conn:
            conn.execute("UPDATE projects SET ai_status='processing', ai_error=NULL, ai_progress=0 WHERE id=?", (project_id,))
        threading.Thread(target=ai_worker, args=(project_id, project), name=f"lumir-ai-{project_id}", daemon=True).start()
    return store.get(project_id)


@app.patch("/projects/{project_id}/ai/lines/{line_id}")
def edit_ai_line(project_id: str, line_id: str, body: AILinePatch):
    row = row_or_404(project_id)
    if row["ai_status"] == "processing":
        raise HTTPException(409, "Дождитесь завершения AI-анализа")
    if not body.translated_text.strip():
        raise HTTPException(400, "Перевод не может быть пустым")
    with store.connect() as conn:
        cursor = conn.execute("UPDATE ai_lines SET translated_text=? WHERE project_id=? AND id=?", (body.translated_text.strip(), project_id, line_id))
        if cursor.rowcount == 0:
            raise HTTPException(404, "Строка перевода не найдена")
    return store.get(project_id)


def worker(project_id: str, device: str, path: Path, expected_speakers: int | None):
    try:
        with store.connect() as conn:
            conn.execute("UPDATE projects SET status='processing' WHERE id=?", (project_id,))
        speakers, segments = process_video(path, device, lambda stage, percent: store.update_progress(project_id, stage, percent), expected_speakers)
        store.save_result(project_id, speakers, segments)
    except Exception as exc:
        with store.connect() as conn:
            conn.execute("UPDATE projects SET status='failed', stage='failed', error=? WHERE id=?", (str(exc), project_id))


def run_queue():
    while True:
        job = jobs.get()
        try:
            worker(*job)
        finally:
            jobs.task_done()


def ensure_queue_worker():
    global job_thread
    if job_thread is None or not job_thread.is_alive():
        job_thread = threading.Thread(target=run_queue, name="lumir-processing", daemon=True)
        job_thread.start()


@app.post("/projects/{project_id}/process", status_code=202)
def start_processing(project_id: str, body: ProcessRequest):
    if body.device == "cuda":
        try:
            import torch
            if not torch.cuda.is_available():
                raise HTTPException(400, "NVIDIA GPU недоступен; выберите CPU")
        except ImportError as exc:
            raise HTTPException(400, "Установите ML-зависимости для работы с GPU") from exc
    with queue_lock:
        row = row_or_404(project_id)
        if row["status"] == "complete" and not body.replace_existing:
            raise HTTPException(409, "Подтвердите повторную обработку проекта")
        if row["status"] not in {"ready", "failed", "complete"}:
            raise HTTPException(409, "Проект уже стоит в очереди или обрабатывается")
        if row["ai_status"] == "processing":
            raise HTTPException(409, "Дождитесь завершения AI-анализа перед повторной транскрипцией")
        with store.connect() as conn:
            conn.execute("UPDATE projects SET status='queued', stage='queued', progress=0, device=?, expected_speakers=?, error=NULL WHERE id=?", (body.device, body.expected_speakers, project_id))
        jobs.put((project_id, body.device, Path(row["video_path"]), body.expected_speakers))
        ensure_queue_worker()
    return store.get(project_id)


@app.patch("/projects/{project_id}/segments/{segment_id}")
def edit_segment(project_id: str, segment_id: str, body: SegmentPatch):
    row_or_404(project_id)
    if not body.text.strip():
        raise HTTPException(400, "Текст реплики не может быть пустым")
    with store.connect() as conn:
        if body.speaker_id is not None and conn.execute("SELECT 1 FROM speakers WHERE project_id=? AND id=?", (project_id, body.speaker_id)).fetchone() is None:
            raise HTTPException(400, "Говорящий не найден")
        cursor = conn.execute("UPDATE segments SET text=?, speaker_id=? WHERE project_id=? AND id=?", (body.text.strip(), body.speaker_id, project_id, segment_id))
        if cursor.rowcount == 0:
            raise HTTPException(404, "Реплика не найдена")
        conn.execute("UPDATE projects SET ai_status='stale' WHERE id=? AND ai_status IN ('complete', 'failed') AND EXISTS (SELECT 1 FROM ai_lines WHERE project_id=?)", (project_id, project_id))
    return store.get(project_id)


def check_speaker(conn, project_id: str, speaker_id: str | None):
    if speaker_id is not None and conn.execute("SELECT 1 FROM speakers WHERE project_id=? AND id=?", (project_id, speaker_id)).fetchone() is None:
        raise HTTPException(400, "Говорящий не найден")


def mark_ai_stale(conn, project_id: str):
    conn.execute("UPDATE projects SET ai_status='stale' WHERE id=? AND ai_status IN ('complete', 'failed') AND EXISTS (SELECT 1 FROM ai_lines WHERE project_id=?)", (project_id, project_id))


@app.patch("/projects/{project_id}/segments/speaker/bulk")
def change_segments_speaker(project_id: str, body: SegmentSpeakerChange):
    with store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone() is None:
            raise HTTPException(404, "Проект не найден")
        check_speaker(conn, project_id, body.speaker_id)
        rows = conn.execute(f"SELECT id,words_json FROM segments WHERE project_id=? AND id IN ({','.join('?' for _ in body.segment_ids)})", (project_id, *body.segment_ids)).fetchall()
        if len(rows) != len(set(body.segment_ids)):
            raise HTTPException(404, "Одна из выбранных реплик не найдена")
        for row in rows:
            words = json.loads(row["words_json"])
            for word in words:
                word["speaker_id"] = body.speaker_id
            conn.execute("UPDATE segments SET speaker_id=?, words_json=? WHERE id=? AND project_id=?", (body.speaker_id, json.dumps(words), row["id"], project_id))
        mark_ai_stale(conn, project_id)
    return store.get(project_id)


@app.post("/projects/{project_id}/segments/merge")
def merge_segments(project_id: str, body: SegmentMerge):
    with store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        project = conn.execute("SELECT status, ai_status FROM projects WHERE id=?", (project_id,)).fetchone()
        if project is None:
            raise HTTPException(404, "Проект не найден")
        if project["status"] != "complete" or project["ai_status"] == "processing":
            raise HTTPException(409, "Дождитесь завершения обработки")
        check_speaker(conn, project_id, body.speaker_id)
        rows = conn.execute("SELECT * FROM segments WHERE project_id=? ORDER BY start,id", (project_id,)).fetchall()
        indices = [next((i for i, row in enumerate(rows) if row["id"] == selected_id), None) for selected_id in body.segment_ids]
        if any(index is None for index in indices):
            raise HTTPException(404, "Одна из выбранных реплик не найдена")
        if len(set(body.segment_ids)) != len(body.segment_ids) or indices != list(range(indices[0], indices[0] + len(indices))):
            raise HTTPException(400, "Выберите несколько соседних реплик по порядку")
        selected = [rows[index] for index in indices]
        first = selected[0]
        words = [word for row in selected for word in json.loads(row["words_json"])]
        for word in words:
            word["speaker_id"] = body.speaker_id
        conn.execute("UPDATE segments SET start=?, end=?, text=?, original_text=?, speaker_id=?, words_json=? WHERE id=? AND project_id=?", (
            min(row["start"] for row in selected), max(row["end"] for row in selected),
            " ".join(row["text"].strip() for row in selected),
            " ".join(row["original_text"].strip() for row in selected).strip(),
            body.speaker_id, json.dumps(words), first["id"], project_id,
        ))
        conn.executemany("DELETE FROM segments WHERE id=? AND project_id=?", [(row["id"], project_id) for row in selected[1:]])
        mark_ai_stale(conn, project_id)
    return store.get(project_id)


@app.post("/projects/{project_id}/segments/{segment_id}/split")
def split_segment(project_id: str, segment_id: str, body: SegmentSplit):
    text = body.text.strip()
    offset = body.split_at - (len(body.text) - len(body.text.lstrip()))
    if not 0 < offset < len(text) or (not text[offset - 1].isspace() and not text[offset].isspace()):
        raise HTTPException(400, "Поставьте курсор между словами")
    left, right = text[:offset].strip(), text[offset:].strip()
    if not left or not right:
        raise HTTPException(400, "В каждой реплике должно остаться хотя бы одно слово")
    with store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        project = conn.execute("SELECT status, ai_status FROM projects WHERE id=?", (project_id,)).fetchone()
        if project is None:
            raise HTTPException(404, "Проект не найден")
        if project["status"] != "complete" or project["ai_status"] == "processing":
            raise HTTPException(409, "Дождитесь завершения обработки")
        row = conn.execute("SELECT * FROM segments WHERE id=? AND project_id=?", (segment_id, project_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Реплика не найдена")
        check_speaker(conn, project_id, body.first_speaker_id)
        check_speaker(conn, project_id, body.second_speaker_id)
        duration = row["end"] - row["start"]
        if duration <= 0.02:
            raise HTTPException(409, "Реплика слишком короткая для разделения")
        left_count = len(left.split())
        total_count = left_count + len(right.split())
        words = json.loads(row["words_json"])
        word_index = round(len(words) * left_count / total_count)
        left_words, right_words = words[:word_index], words[word_index:]
        left_end = left_words[-1].get("end") if left_words else None
        right_start = right_words[0].get("start") if right_words else None
        if isinstance(left_end, (int, float)) and isinstance(right_start, (int, float)) and left_end <= right_start:
            split_time = (left_end + right_start) / 2
        else:
            split_time = row["start"] + duration * left_count / total_count
        split_time = min(row["end"] - 0.01, max(row["start"] + 0.01, split_time))
        original_words = re.findall(r"\S+", row["original_text"])
        original_index = round(len(original_words) * left_count / total_count)
        left_original = " ".join(original_words[:original_index])
        right_original = " ".join(original_words[original_index:])
        for word in left_words:
            word["speaker_id"] = body.first_speaker_id
        for word in right_words:
            word["speaker_id"] = body.second_speaker_id
        conn.execute("UPDATE segments SET end=?, text=?, original_text=?, speaker_id=?, words_json=? WHERE id=? AND project_id=?", (split_time, left, left_original, body.first_speaker_id, json.dumps(left_words), segment_id, project_id))
        conn.execute("INSERT INTO segments(id,project_id,start,end,text,original_text,speaker_id,words_json) VALUES(?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), project_id, split_time, row["end"], right, right_original, body.second_speaker_id, json.dumps(right_words)))
        mark_ai_stale(conn, project_id)
    return store.get(project_id)


@app.patch("/projects/{project_id}/speakers/{speaker_id}")
def edit_speaker(project_id: str, speaker_id: str, body: SpeakerPatch):
    row_or_404(project_id)
    if not body.name.strip():
        raise HTTPException(400, "Имя говорящего не может быть пустым")
    with store.connect() as conn:
        cursor = conn.execute("UPDATE speakers SET name=? WHERE project_id=? AND id=?", (body.name.strip(), project_id, speaker_id))
        if cursor.rowcount == 0:
            raise HTTPException(404, "Говорящий не найден")
    return store.get(project_id)


@app.delete("/projects/{project_id}/speakers/{speaker_id}")
def delete_speaker(project_id: str, speaker_id: str):
    with store.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        project = conn.execute("SELECT status, ai_status FROM projects WHERE id=?", (project_id,)).fetchone()
        if project is None:
            raise HTTPException(404, "Проект не найден")
        if project["status"] in ("queued", "processing") or project["ai_status"] == "processing":
            raise HTTPException(409, "Дождитесь завершения обработки")
        if conn.execute("SELECT 1 FROM speakers WHERE project_id=? AND id=?", (project_id, speaker_id)).fetchone() is None:
            raise HTTPException(404, "Говорящий не найден")
        rows = conn.execute("SELECT id, speaker_id, words_json FROM segments WHERE project_id=?", (project_id,)).fetchall()
        for row in rows:
            words = json.loads(row["words_json"])
            changed = row["speaker_id"] == speaker_id
            for word in words:
                if word.get("speaker_id") == speaker_id:
                    word["speaker_id"] = None
                    changed = True
            if changed:
                conn.execute("UPDATE segments SET speaker_id=?, words_json=? WHERE id=?", (None if row["speaker_id"] == speaker_id else row["speaker_id"], json.dumps(words), row["id"]))
        conn.execute("UPDATE ai_lines SET speaker_id=NULL WHERE project_id=? AND speaker_id=?", (project_id, speaker_id))
        conn.execute("DELETE FROM speakers WHERE project_id=? AND id=?", (project_id, speaker_id))
        mark_ai_stale(conn, project_id)
    return store.get(project_id)


@app.post("/projects/{project_id}/speakers", status_code=201)
def create_speaker(project_id: str, body: SpeakerCreate):
    row_or_404(project_id)
    if not body.name.strip():
        raise HTTPException(400, "Имя говорящего не может быть пустым")
    speaker_id = "MANUAL_" + uuid.uuid4().hex[:12]
    with store.connect() as conn:
        conn.execute("INSERT INTO speakers(project_id,id,name) VALUES(?,?,?)", (project_id, speaker_id, body.name.strip()))
    return store.get(project_id)


def run():
    import uvicorn
    uvicorn.run("app.api:app", host="127.0.0.1", port=8000, reload=False)
