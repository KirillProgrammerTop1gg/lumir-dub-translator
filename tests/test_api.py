import importlib
import sqlite3
import threading
import time

from fastapi.testclient import TestClient


def test_upload_process_and_edit(tmp_path, monkeypatch):
    monkeypatch.setenv("LUMIR_DATA_DIR", str(tmp_path))
    import app.api as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "duration_seconds", lambda path: 12.0)
    seen_speakers = []
    def fake_process(path, device, progress, expected_speakers):
        seen_speakers.append(expected_speakers)
        progress("transcribing", 45)
        progress("diarizing", 85)
        return ["SPEAKER_00"], [{"id": "segment-1", "start": 1.0, "end": 3.0, "text": "Hello world", "speaker_id": "SPEAKER_00", "words": [{"text": "Hello", "start": 1.0, "end": 1.5}]}]
    monkeypatch.setattr(module, "process_video", fake_process)
    client = TestClient(module.app)
    response = client.post("/projects", files={"file": ("clip.mp4", b"fake", "video/mp4")})
    assert response.status_code == 201
    project_id = response.json()["id"]
    assert client.post(f"/projects/{project_id}/process", json={"device": "cpu", "expected_speakers": 2}).status_code == 202
    for _ in range(100):
        result = client.get(f"/projects/{project_id}").json()
        if result["status"] == "complete":
            break
        time.sleep(0.01)
    assert result["status"] == "complete"
    assert seen_speakers == [2]
    assert result["progress"] == 100
    assert result["stage"] == "complete"
    assert result["segments"][0]["words"][0]["text"] == "Hello"
    assert client.patch(f"/projects/{project_id}/segments/segment-1", json={"text": "Hi world", "speaker_id": "SPEAKER_00"}).json()["segments"][0]["text"] == "Hi world"
    assert client.patch(f"/projects/{project_id}/speakers/SPEAKER_00", json={"name": "Alex"}).json()["speakers"][0]["name"] == "Alex"
    assert client.get(f"/projects/{project_id}").json()["segments"][0]["original_text"] == "Hello world"
    assert client.patch(f"/projects/{project_id}", json={"title": "Episode one"}).json()["title"] == "Episode one"
    assert client.post(f"/projects/{project_id}/speakers", json={"name": "Second character"}).status_code == 201
    transcript = client.get(f"/projects/{project_id}/export/srt")
    assert transcript.status_code == 200
    assert "Alex: Hi world" in transcript.text
    assert "00:00:01,000 --> 00:00:03,000" in transcript.text
    assert client.get(f"/projects/{project_id}/export/json").json()["title"] == "Episode one"
    assert "Alex: Hi world" in client.get(f"/projects/{project_id}/export/txt").text
    with module.store.connect() as conn:
        conn.execute("UPDATE projects SET status='failed' WHERE id=?", (project_id,))
    assert client.get(f"/projects/{project_id}/export/srt").status_code == 200
    with module.store.connect() as conn:
        conn.execute("UPDATE projects SET status='complete' WHERE id=?", (project_id,))
    assert client.post(f"/projects/{project_id}/process", json={"device": "cpu"}).status_code == 409
    assert client.post(f"/projects/{project_id}/process", json={"device": "cpu", "expected_speakers": 9, "replace_existing": True}).status_code == 422
    assert client.post(f"/projects/{project_id}/process", json={"device": "cpu", "expected_speakers": 2, "replace_existing": True}).status_code == 202
    for _ in range(100):
        if client.get(f"/projects/{project_id}").json()["status"] == "complete":
            break
        time.sleep(0.01)
    assert seen_speakers == [2, 2]
    assert client.delete(f"/projects/{project_id}").status_code == 204
    assert client.get(f"/projects/{project_id}").status_code == 404
    assert not (tmp_path / project_id).exists()


def test_upload_rejects_long_video(tmp_path, monkeypatch):
    monkeypatch.setenv("LUMIR_DATA_DIR", str(tmp_path))
    import app.api as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "duration_seconds", lambda path: 1801.0)
    response = TestClient(module.app).post("/projects", files={"file": ("long.mp4", b"fake", "video/mp4")})
    assert response.status_code == 400
    assert not list(tmp_path.glob("*/video.mp4"))


def test_existing_database_gets_progress_columns(tmp_path):
    with sqlite3.connect(tmp_path / "projects.sqlite3") as conn:
        conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, filename TEXT NOT NULL, video_path TEXT NOT NULL, duration REAL NOT NULL, status TEXT NOT NULL, device TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        conn.execute("INSERT INTO projects (id,filename,video_path,duration,status) VALUES ('old','old.mp4','/tmp/old.mp4',1,'processing')")
    from app.store import Store
    project = Store(tmp_path).get("old")
    assert project["status"] == "failed"
    assert project["progress"] == 0
    assert project["stage"] == "failed"
    assert project["context_notes"] == ""
    assert project["target_language"] == "Russian"
    assert project["ai_status"] == "idle"
    assert project["ai_lines"] == []


def test_second_project_waits_in_queue(tmp_path, monkeypatch):
    monkeypatch.setenv("LUMIR_DATA_DIR", str(tmp_path))
    import app.api as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "duration_seconds", lambda path: 12.0)
    started = threading.Event()
    release = threading.Event()
    processed = []

    def fake_process(path, device, progress, expected_speakers):
        processed.append(path.parent.name)
        if len(processed) == 1:
            started.set()
            assert release.wait(3)
        return [], []

    monkeypatch.setattr(module, "process_video", fake_process)
    client = TestClient(module.app)
    first = client.post("/projects", files={"file": ("one.mp4", b"a", "video/mp4")}).json()["id"]
    second = client.post("/projects", files={"file": ("two.mp4", b"b", "video/mp4")}).json()["id"]
    try:
        assert client.post(f"/projects/{first}/process", json={"device": "cpu"}).status_code == 202
        assert started.wait(3)
        assert client.post(f"/projects/{second}/process", json={"device": "cpu"}).status_code == 202
        assert client.get(f"/projects/{second}").json()["status"] == "queued"
        assert {row["status"] for row in client.get("/projects").json()} == {"processing", "queued"}
    finally:
        release.set()
    for _ in range(100):
        if client.get(f"/projects/{second}").json()["status"] == "complete":
            break
        time.sleep(0.01)
    assert processed == [first, second]


def test_ai_analysis_translation_edit_and_export(tmp_path, monkeypatch):
    monkeypatch.setenv("LUMIR_DATA_DIR", str(tmp_path))
    import app.api as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "duration_seconds", lambda path: 12.0)
    monkeypatch.setattr(module, "process_video", lambda *args: (["SPEAKER_00"], [
        {"id": "one", "start": 1.0, "end": 2.0, "text": "Hello", "speaker_id": "SPEAKER_00", "words": []},
        {"id": "two", "start": 2.1, "end": 3.0, "text": "world.", "speaker_id": "SPEAKER_00", "words": []},
    ]))
    client = TestClient(module.app)
    project_id = client.post("/projects", files={"file": ("clip.mp4", b"fake", "video/mp4")}).json()["id"]
    assert client.post(f"/projects/{project_id}/process", json={"device": "cpu"}).status_code == 202
    for _ in range(100):
        if client.get(f"/projects/{project_id}").json()["status"] == "complete":
            break
        time.sleep(0.01)
    assert client.patch(f"/projects/{project_id}/ai/config", json={"context_notes": "A friendly greeting", "target_language": "Ukrainian"}).status_code == 200
    seen = []
    def fake_analyze(project, progress):
        seen.append((project["context_notes"], project["target_language"]))
        progress(50)
        return [{"id": "line-one", "segment_ids": ["one", "two"], "start": 1.0, "end": 3.0, "speaker_id": "SPEAKER_00", "source_text": "Hello world.", "translated_text": "Привіт, світе."}]
    monkeypatch.setattr(module, "analyze_project", fake_analyze)
    assert client.post(f"/projects/{project_id}/ai/run").status_code == 202
    for _ in range(100):
        project = client.get(f"/projects/{project_id}").json()
        if project["ai_status"] == "complete":
            break
        time.sleep(0.01)
    assert project["ai_status"] == "complete"
    assert project["ai_progress"] == 100
    assert seen == [("A friendly greeting", "Ukrainian")]
    assert project["ai_lines"][0]["segment_ids"] == ["one", "two"]
    assert client.patch(f"/projects/{project_id}/ai/lines/line-one", json={"translated_text": "Вітаю, світе!"}).status_code == 200
    assert "Вітаю, світе!" in client.get(f"/projects/{project_id}/export/translated-srt").text
    assert "Вітаю, світе!" in client.get(f"/projects/{project_id}/export/translated-txt").text
    assert "Говорящий 1 — Вітаю, світе!" in client.get(f"/projects/{project_id}/export/dialogue-txt").text
    english_dialogue = client.get(f"/projects/{project_id}/export/english-dialogue-txt")
    assert "Говорящий 1 — Hello world." in english_dialogue.text
    assert "00:00" not in english_dialogue.text
    assert client.patch(f"/projects/{project_id}/segments/one", json={"text": "Hi", "speaker_id": "SPEAKER_00"}).json()["ai_status"] == "stale"


def test_ai_rejects_missing_or_mixed_segments():
    import pytest
    from app.ai import validate_lines
    segments = [{"id": "one", "start": 1.0, "end": 2.0, "speaker_id": "A"}, {"id": "two", "start": 2.0, "end": 3.0, "speaker_id": "B"}]
    with pytest.raises(RuntimeError, match="разных говорящих"):
        validate_lines([{"segment_ids": ["one", "two"], "source_text": "Hi there", "translated_text": "Привет"}], segments)
    with pytest.raises(RuntimeError, match="пропустил"):
        validate_lines([{"segment_ids": ["one"], "source_text": "Hi", "translated_text": "Привет"}], segments)


def test_ai_batch_extends_to_sentence_boundary(monkeypatch):
    import app.ai as ai
    segments = [{"id": str(index), "start": index, "end": index + 1, "speaker_id": "A", "text": "end." if index == 15 else "word"} for index in range(35)]
    sizes = []
    def fake_request(chunk, before, after, names, context, language, provider):
        sizes.append(len(chunk))
        return []
    monkeypatch.setattr(ai, "request_lines", fake_request)
    ai.analyze_project({"segments": segments, "speakers": [], "context_notes": "", "target_language": "Russian"})
    assert sizes == [16, 19]


def test_split_merge_and_reassign_segments(tmp_path, monkeypatch):
    monkeypatch.setenv("LUMIR_DATA_DIR", str(tmp_path))
    import app.api as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "duration_seconds", lambda path: 12.0)
    client = TestClient(module.app)
    project_id = client.post("/projects", files={"file": ("clip.mp4", b"fake", "video/mp4")}).json()["id"]
    module.store.save_result(project_id, ["A", "B"], [
        {"id": "one", "start": 1.0, "end": 3.0, "text": "Hello world", "speaker_id": "A", "words": [{"text": "Hello", "start": 1.0, "end": 1.5}, {"text": "world", "start": 2.0, "end": 2.5}]},
        {"id": "two", "start": 4.0, "end": 6.0, "text": "How are you?", "speaker_id": "B", "words": []},
        {"id": "three", "start": 7.0, "end": 8.0, "text": "Fine.", "speaker_id": "A", "words": []},
    ])
    module.store.save_ai_lines(project_id, [{"id": "ai-one", "segment_ids": ["one"], "start": 1.0, "end": 3.0, "speaker_id": "A", "source_text": "Hello world", "translated_text": "Привет, мир"}])
    assert client.post(f"/projects/{project_id}/segments/one/split", json={"text": "Hello world", "split_at": 3, "first_speaker_id": "A", "second_speaker_id": "B"}).status_code == 400
    response = client.post(f"/projects/{project_id}/segments/one/split", json={"text": "Hello world", "split_at": 6, "first_speaker_id": "A", "second_speaker_id": "B"})
    assert response.status_code == 200
    project = response.json()
    assert project["ai_status"] == "stale"
    assert project["ai_lines"][0]["translated_text"] == "Привет, мир"
    first, second = project["segments"][:2]
    assert (first["text"], second["text"]) == ("Hello", "world")
    assert (first["speaker_id"], second["speaker_id"]) == ("A", "B")
    assert first["end"] == second["start"] == 1.75
    assert first["words"][0]["speaker_id"] == "A"
    assert second["words"][0]["speaker_id"] == "B"
    assert client.post(f"/projects/{project_id}/segments/merge", json={"segment_ids": ["one", second["id"]], "speaker_id": "missing"}).status_code == 400
    merged = client.post(f"/projects/{project_id}/segments/merge", json={"segment_ids": ["one", second["id"]], "speaker_id": "A"}).json()
    assert [segment["id"] for segment in merged["segments"]] == ["one", "two", "three"]
    assert merged["segments"][0]["text"] == "Hello world"
    assert merged["segments"][0]["speaker_id"] == "A"
    assert merged["segments"][0]["words"][1]["speaker_id"] == "A"
    assert client.post(f"/projects/{project_id}/segments/merge", json={"segment_ids": ["one", "three"], "speaker_id": "A"}).status_code == 400
    assert client.patch(f"/projects/{project_id}/segments/two", json={"text": "How are you?", "speaker_id": "A"}).json()["segments"][1]["speaker_id"] == "A"
    assert client.get(f"/projects/{project_id}/export/english-dialogue-txt").text.count("Говорящий 1 —") == 1
    assert client.patch(f"/projects/{project_id}/segments/speaker/bulk", json={"segment_ids": ["two"], "speaker_id": "B"}).status_code == 200
    dialogue = client.get(f"/projects/{project_id}/export/english-dialogue-txt").text
    assert dialogue.count("Говорящий 1 —") == 2
    assert dialogue.count("Говорящий 2 —") == 1


def test_delete_speaker_keeps_lines_and_clears_word_and_translation_labels(tmp_path, monkeypatch):
    monkeypatch.setenv("LUMIR_DATA_DIR", str(tmp_path))
    import app.api as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "duration_seconds", lambda path: 12.0)
    client = TestClient(module.app)
    project_id = client.post("/projects", files={"file": ("clip.mp4", b"fake", "video/mp4")}).json()["id"]
    module.store.save_result(project_id, ["A", "B"], [
        {"id": "one", "start": 0.0, "end": 1.0, "text": "Hello", "speaker_id": "A", "words": [{"text": "Hello", "speaker_id": "A"}]},
        {"id": "two", "start": 1.0, "end": 2.0, "text": "World", "speaker_id": "B", "words": [{"text": "World", "speaker_id": "A"}]},
    ])
    module.store.save_ai_lines(project_id, [{"id": "line", "segment_ids": ["one"], "start": 0.0, "end": 1.0, "speaker_id": "A", "source_text": "Hello", "translated_text": "Привет"}])
    response = client.delete(f"/projects/{project_id}/speakers/A")
    assert response.status_code == 200
    project = response.json()
    assert [speaker["id"] for speaker in project["speakers"]] == ["B"]
    assert [segment["text"] for segment in project["segments"]] == ["Hello", "World"]
    assert [segment["speaker_id"] for segment in project["segments"]] == [None, "B"]
    assert all(segment["words"][0]["speaker_id"] is None for segment in project["segments"])
    assert project["ai_lines"][0]["speaker_id"] is None
    assert project["ai_lines"][0]["translated_text"] == "Привет"
    assert project["ai_status"] == "stale"
    assert "Неизвестно — Hello" in client.get(f"/projects/{project_id}/export/english-dialogue-txt").text
    assert client.delete(f"/projects/{project_id}/speakers/A").status_code == 404


def test_english_dialogue_joins_consecutive_lines_until_speaker_changes(tmp_path, monkeypatch):
    monkeypatch.setenv("LUMIR_DATA_DIR", str(tmp_path))
    import app.api as module
    module = importlib.reload(module)
    monkeypatch.setattr(module, "duration_seconds", lambda path: 12.0)
    client = TestClient(module.app)
    project_id = client.post("/projects", files={"file": ("clip.mp4", b"fake", "video/mp4")}).json()["id"]
    texts = ["Oh man, it is seriously gorgeous out.", "Did fish fart?", "What?", "Ooh, I got something on the line already.", "Get that fish, boy.", "Swan, we got an order.", "Hold on, let me reel this back boy in.", "Time to shine."]
    segments = [{"id": str(i), "start": float(i), "end": float(i + 1), "text": text, "speaker_id": "SPEAKER_04", "words": []} for i, text in enumerate(texts)]
    segments.append({"id": "next", "start": 8.0, "end": 9.0, "text": "Hello.", "speaker_id": "SPEAKER_03", "words": []})
    module.store.save_result(project_id, ["SPEAKER_03", "SPEAKER_04"], segments)
    dialogue = client.get(f"/projects/{project_id}/export/english-dialogue-txt")
    assert dialogue.status_code == 200
    assert dialogue.text.splitlines() == ["Говорящий 2 — " + " ".join(texts), "Говорящий 1 — Hello."]
    assert "00:00" not in dialogue.text
    created = client.post(f"/projects/{project_id}/speakers", json={"name": "Говорящий 2"}).json()
    duplicate_id = next(speaker["id"] for speaker in created["speakers"] if speaker["id"].startswith("MANUAL_"))
    assert client.patch(f"/projects/{project_id}/segments/speaker/bulk", json={"segment_ids": ["1"], "speaker_id": duplicate_id}).status_code == 200
    assert client.get(f"/projects/{project_id}/export/english-dialogue-txt").text.splitlines() == ["Говорящий 2 — " + " ".join(texts), "Говорящий 1 — Hello."]


def test_env_settings_update_without_returning_secrets(tmp_path, monkeypatch):
    import app.env_settings as env_settings
    monkeypatch.setattr(env_settings, "ENV_FILE", tmp_path / ".env")
    for key in ("HF_TOKEN", "OPENAI_API_KEY", "OPENAI_MODEL"):
        monkeypatch.delenv(key, raising=False)
    import app.api as module
    client = TestClient(module.app)
    initial = client.get("/settings/env").json()
    assert initial["hf_token"]["configured"] is False
    response = client.patch("/settings/env", json={"key": "HF_TOKEN", "value": "hf_test_secret"})
    assert response.status_code == 200
    assert response.json()["hf_token"] == {"configured": True, "source": "dotenv"}
    assert "hf_test_secret" not in response.text
    assert env_settings.ENV_FILE.stat().st_mode & 0o777 == 0o600
    assert env_settings.status()["hf_token"]["configured"] is True
    assert client.patch("/settings/env", json={"key": "OPENAI_MODEL", "value": "gpt-4o-mini"}).json()["openai_model"]["value"] == "gpt-4o-mini"
    assert client.patch("/settings/env", json={"key": "OPENAI_API_KEY", "value": "bad\nvalue"}).status_code == 400
    assert client.patch("/settings/env", json={"key": "OTHER_KEY", "value": "x"}).status_code == 422
    assert client.patch("/settings/env", json={"key": "HF_TOKEN", "value": None}).json()["hf_token"]["configured"] is False
    assert client.patch("/settings/env", json={"key": "CAMBRIDGE_API_KEY", "value": "cambridge_test"}).json()["cambridge_api_key"]["configured"] is True
    assert "cambridge_test" not in client.get("/settings/env").text


def test_local_and_openrouter_translation_requests(tmp_path, monkeypatch):
    import io
    import json
    import app.ai as ai
    env_file = tmp_path / ".env"
    env_file.write_text("OLLAMA_MODEL=qwen2.5:7b\nOPENROUTER_API_KEY=test-key\nOPENROUTER_MODEL=openrouter/free\n")
    monkeypatch.setattr(ai, "ENV_FILE", env_file)
    segment = {"id": "one", "start": 1.0, "end": 2.0, "speaker_id": "A", "text": "Hello"}
    output = {"lines": [{"segment_ids": ["one"], "source_text": "Hello", "translated_text": "Привет", "word_links": [{"english": "Hello", "russian": "Привет"}]}]}
    seen = []
    def fake_urlopen(request, timeout):
        seen.append((request.full_url, json.loads(request.data)))
        if request.full_url.endswith("/api/chat"):
            return io.BytesIO(json.dumps({"message": {"content": json.dumps(output)}}).encode())
        return io.BytesIO(json.dumps({"choices": [{"message": {"content": json.dumps(output)}}]}).encode())
    monkeypatch.setattr(ai.urllib.request, "urlopen", fake_urlopen)
    for provider in ("ollama", "openrouter"):
        assert ai.request_lines([segment], [], [], {"A": "Alex"}, "A shop", "Russian", provider)[0]["word_links"][0]["russian"] == "Привет"
    assert seen[0][0] == "http://127.0.0.1:11434/api/chat"
    assert seen[0][1]["stream"] is False
    assert seen[1][0] == "https://openrouter.ai/api/v1/chat/completions"
    assert seen[1][1]["response_format"]["type"] == "json_schema"
    assert seen[1][1]["provider"]["require_parameters"] is True
