import io
import json

from app import cambridge


def test_cambridge_lookup_requires_its_own_key(tmp_path, monkeypatch):
    monkeypatch.setattr(cambridge, "ENV_FILE", tmp_path / ".env")
    monkeypatch.delenv("CAMBRIDGE_API_KEY", raising=False)
    result = cambridge.lookup("house")
    assert result["configured"] is False
    assert result["translations"] == []
    assert result["url"].endswith("/house")


def test_cambridge_lookup_returns_first_three_unique_translations(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("CAMBRIDGE_API_KEY=test_key\nCAMBRIDGE_DICTIONARY_CODE=english-russian\n")
    monkeypatch.setattr(cambridge, "ENV_FILE", env)
    requests = []

    def fake_urlopen(request, timeout):
        requests.append(request)
        html = '<span class="trans dtrans">дом</span><span class="trans">дом</span><span class="trans">здание</span><span class="trans"><b>жильё</b></span><span class="trans">палата</span>'
        return io.BytesIO(json.dumps({"entryContent": html}).encode())

    monkeypatch.setattr(cambridge.urllib.request, "urlopen", fake_urlopen)
    result = cambridge.lookup("house")
    assert result["translations"] == ["дом", "здание", "жильё"]
    assert requests[0].get_header("Accesskey") == "test_key"
    assert "search/first?q=house&format=html" in requests[0].full_url
