import io
import json
import threading

from app import ai


def test_openrouter_free_requests_structured_json_and_accepts_translation(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("OPENROUTER_API_KEY=test_key\nOPENROUTER_MODEL=openrouter/free\n")
    monkeypatch.setattr(ai, "ENV_FILE", env)
    seen = {}

    def fake_urlopen(request, timeout):
        seen.update(json.loads(request.data))
        answer = {"choices": [{"message": {"content": json.dumps({"lines": [{"segment_ids": ["one"], "source_text": "Hello.", "translated_text": "Привет.", "word_links": []}]})}}]}
        return io.BytesIO(json.dumps(answer).encode())

    monkeypatch.setattr(ai.urllib.request, "urlopen", fake_urlopen)
    segments = [{"id": "one", "start": 0.0, "end": 1.0, "speaker_id": "A", "text": "Hello."}]
    result = ai.request_lines(segments, [], [], {"A": "Alex"}, "", "Russian", "openrouter")
    assert result[0]["translated_text"] == "Привет."
    assert seen["response_format"]["type"] == "json_schema"
    assert seen["provider"]["require_parameters"] is True


def test_malformed_json_falls_back_to_single_line_translation(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("OPENROUTER_API_KEY=test_key\nOPENROUTER_MODEL=openrouter/free\n")
    monkeypatch.setattr(ai, "ENV_FILE", env)
    calls = []

    def fake_urlopen(request, timeout):
        payload = json.loads(request.data)
        calls.append(payload)
        if "response_format" in payload:
            answer = {"choices": [{"message": {"content": "{broken json"}}]}
        else:
            english = json.loads(payload["messages"][1]["content"])["english"]
            answer = {"choices": [{"message": {"content": "Привет." if english == "Hello." else "Мир."}}]}
        return io.BytesIO(json.dumps(answer).encode())

    monkeypatch.setattr(ai.urllib.request, "urlopen", fake_urlopen)
    project = {"segments": [
        {"id": "one", "start": 0.0, "end": 1.0, "speaker_id": "A", "text": "Hello."},
        {"id": "two", "start": 1.0, "end": 2.0, "speaker_id": "A", "text": "World."},
    ], "speakers": [{"id": "A", "name": "Alex"}], "context_notes": "", "target_language": "Russian", "ai_provider": "openrouter"}
    lines = ai.analyze_project(project)
    assert [line["translated_text"] for line in lines] == ["Привет.", "Мир."]
    assert [line["segment_ids"] for line in lines] == [["one"], ["two"]]
    assert len(calls) == 5


def test_length_finish_retries_plain_translation_with_larger_budget(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("OPENROUTER_API_KEY=test_key\nOPENROUTER_MODEL=openrouter/free\n")
    monkeypatch.setattr(ai, "ENV_FILE", env)
    calls = []

    def fake_urlopen(request, timeout):
        payload = json.loads(request.data)
        calls.append(payload)
        if len(calls) < 3:
            answer = {"choices": [{"finish_reason": "length", "message": {"content": ""}}]}
        else:
            answer = {"choices": [{"finish_reason": "stop", "message": {"content": "Привет."}}]}
        return io.BytesIO(json.dumps(answer).encode())

    monkeypatch.setattr(ai.urllib.request, "urlopen", fake_urlopen)
    project = {"segments": [{"id": "one", "start": 0.0, "end": 1.0, "speaker_id": "A", "text": "Hello."}],
               "speakers": [{"id": "A", "name": "Alex"}], "context_notes": "", "target_language": "Russian", "ai_provider": "openrouter"}
    lines = ai.analyze_project(project)
    assert lines[0]["translated_text"] == "Привет."
    assert [call["max_completion_tokens"] for call in calls] == [8192, 4096, 8192]
    assert all("reasoning" not in call for call in calls)


def test_openrouter_batches_run_in_parallel_but_keep_transcript_order(monkeypatch):
    rendezvous = threading.Barrier(2)
    def fake_request(chunk, before, after, names, context, language, provider):
        rendezvous.wait(timeout=2)
        return [{"segment_ids": [segment["id"]], "translated_text": segment["text"]} for segment in chunk]
    monkeypatch.setattr(ai, "request_lines", fake_request)
    segments = [{"id": str(index), "start": index, "end": index + 1, "speaker_id": "A" if index < 6 else "B", "text": str(index)} for index in range(12)]
    project = {"segments": segments, "speakers": [], "context_notes": "", "target_language": "Russian", "ai_provider": "openrouter"}
    progress = []
    lines = ai.analyze_project(project, progress.append)
    assert [line["segment_ids"][0] for line in lines] == [str(index) for index in range(12)]
    assert progress[-1] == 95
