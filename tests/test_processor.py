from app.processor import _make_segments


def test_speaker_change_inside_whisper_segment_survives_untimed_word():
    aligned = {"segments": [{
        "start": 0.0, "end": 2.0, "text": "Hello, you go.",
        "words": [
            {"word": "Hello,", "start": 0.0, "end": 0.6},
            {"word": "you"},
            {"word": "go.", "start": 1.2, "end": 1.8},
        ],
    }]}
    speakers, segments = _make_segments(aligned, [(0.0, 0.8, "A"), (1.0, 2.0, "B")])
    assert speakers == ["A", "B"]
    assert [segment["speaker_id"] for segment in segments] == ["A", "B"]
    assert [segment["text"] for segment in segments] == ["Hello, you", "go."]
    assert segments[0]["words"][1]["speaker_id"] == "A"


def test_word_without_diarization_is_not_assigned_a_distant_voice():
    aligned = {"segments": [{"start": 10.0, "end": 11.0, "text": "Hi", "words": [{"word": "Hi", "start": 10.0, "end": 10.5}]}]}
    speakers, segments = _make_segments(aligned, [(0.0, 1.0, "A")])
    assert speakers == ["A"]
    assert segments[0]["speaker_id"] is None
