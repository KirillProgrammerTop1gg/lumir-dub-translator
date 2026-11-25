import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Callable

from dotenv import dotenv_values

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
PYANNOTE_MODEL = "pyannote/speaker-diarization-community-1"
PYANNOTE_URL = f"https://huggingface.co/{PYANNOTE_MODEL}"


def duration_seconds(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, timeout=30, check=True,
    )
    return float(result.stdout.strip())


def _speaker_at(start: float, end: float, turns: list[tuple[float, float, str]]) -> str | None:
    overlaps: dict[str, float] = {}
    for turn_start, turn_end, speaker in turns:
        amount = max(0.0, min(end, turn_end) - max(start, turn_start))
        if amount:
            overlaps[speaker] = overlaps.get(speaker, 0.0) + amount
    if overlaps:
        return max(overlaps, key=overlaps.get)
    nearest = min(turns, key=lambda turn: max(turn[0] - end, start - turn[1], 0.0), default=None)
    if nearest and max(nearest[0] - end, start - nearest[1], 0.0) <= 0.35:
        return nearest[2]
    return None


def _make_segments(aligned: dict, turns: list[tuple[float, float, str]]):
    segments = []
    speaker_ids = {speaker for _, _, speaker in turns}
    for item in aligned["segments"]:
        if not item.get("text", "").strip():
            continue
        item_speaker = _speaker_at(float(item["start"]), float(item["end"]), turns)
        words = []
        for source in item.get("words", []):
            start, end = source.get("start"), source.get("end")
            speaker = _speaker_at(float(start), float(end), turns) if start is not None and end is not None else None
            words.append({"text": source.get("word", ""), "start": start, "end": end, "speaker_id": speaker})
        groups: list[list[dict]] = []
        for word in words:
            # Alignment occasionally omits timing for punctuation or short words.
            # Keep those words with the preceding voice instead of discarding all splits.
            if word["speaker_id"] is None:
                word["speaker_id"] = groups[-1][0]["speaker_id"] if groups else item_speaker
            if not groups or (word["speaker_id"] != groups[-1][0]["speaker_id"] and word["speaker_id"] is not None):
                groups.append([])
            groups[-1].append(word)
        if not groups:
            groups = [[]]
        for group in groups:
            speaker = group[0]["speaker_id"] if group else item_speaker
            if speaker:
                speaker_ids.add(speaker)
            timed = [word for word in group if word["start"] is not None and word["end"] is not None]
            text = item["text"].strip() if len(groups) == 1 else re.sub(r"\s+([,.!?;:])", r"\1", " ".join(word["text"].strip() for word in group)).strip()
            segments.append({
                "id": str(uuid.uuid4()),
                "start": float(timed[0]["start"] if len(groups) > 1 and timed else item["start"]),
                "end": float(timed[-1]["end"] if len(groups) > 1 and timed else item["end"]),
                "text": text, "speaker_id": speaker, "words": group,
            })
    return sorted(speaker_ids), segments


def process_video(path: Path, device: str, progress: Callable[[str, int], None] | None = None, expected_speakers: int | None = None):
    def report(stage: str, percent: int):
        if progress:
            progress(stage, percent)

    report("loading", 2)
    try:
        import torch
        import whisperx
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import HfHubHTTPError
        from whisperx.diarize import DiarizationPipeline
    except ImportError as exc:
        raise RuntimeError("Установите ML-зависимости: uv sync --extra ml") from exc

    token = dotenv_values(ENV_FILE).get("HF_TOKEN") or os.getenv("HF_TOKEN")
    if not token:
        raise RuntimeError("Укажите HF_TOKEN в .env для модели определения говорящих")
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("NVIDIA GPU недоступен; выберите CPU")

    def gated_error(exc: Exception):
        if isinstance(exc, HfHubHTTPError) and exc.response is not None and exc.response.status_code in (401, 403):
            raise RuntimeError(
                f"Нет доступа к модели pyannote. Откройте {PYANNOTE_URL}, примите условия доступа под тем же аккаунтом Hugging Face, что создал HF_TOKEN, затем повторите обработку."
            ) from exc
        raise exc

    report("access", 4)
    try:
        hf_hub_download(repo_id=PYANNOTE_MODEL, filename="config.yaml", token=token)
    except HfHubHTTPError as exc:
        gated_error(exc)

    with tempfile.TemporaryDirectory() as tmp:
        report("audio", 8)
        wav = Path(tmp) / "audio.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", str(wav)], check=True, timeout=3600)
        audio = whisperx.load_audio(str(wav))
        report("loading", 15)
        model = whisperx.load_model("small.en", device, compute_type="float16" if device == "cuda" else "int8", language="en")
        report("transcribing", 20)
        result = model.transcribe(audio, batch_size=8 if device == "cuda" else 2, language="en", progress_callback=lambda p: report("transcribing", 20 + int(p * 0.35)))
        del model
        report("aligning", 58)
        align_model, metadata = whisperx.load_align_model(language_code="en", device=device)
        result = whisperx.align(result["segments"], align_model, metadata, audio, device, return_char_alignments=False, progress_callback=lambda p: report("aligning", 60 + int(p * 0.15)))
        del align_model
        report("diarizing", 78)
        try:
            pipeline = DiarizationPipeline(token=token, device=device)
            def hook(step_name, artifact, file=None, total=None, completed=None):
                if total and completed is not None:
                    part = (completed / total) * 0.5 + (0.5 if step_name == "embeddings" else 0)
                    report("diarizing", 80 + min(15, int(part * 15)))
            output = pipeline.model({"waveform": torch.from_numpy(audio[None, :]), "sample_rate": 16000}, num_speakers=expected_speakers, hook=hook)
            if expected_speakers is None and len(output.exclusive_speaker_diarization.labels()) == 1:
                # Auto clustering sometimes collapses an entire cast to one voice.
                # Retry only that case with two clusters; an explicit count of 1
                # remains available for a single-speaker recording.
                report("diarizing", 94)
                output = pipeline.model({"waveform": torch.from_numpy(audio[None, :]), "sample_rate": 16000}, num_speakers=2)
        except HfHubHTTPError as exc:
            gated_error(exc)
        # Community-1 supplies a non-overlapping timeline intended for matching
        # transcript words to voices; WhisperX's wrapper discards this output.
        turns = [(turn.start, turn.end, speaker) for turn, _, speaker in output.exclusive_speaker_diarization.itertracks(yield_label=True)]

    report("saving", 97)
    return _make_segments(result, turns)
