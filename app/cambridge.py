"""On-demand Cambridge Dictionary lookup through the licensed API."""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

from dotenv import dotenv_values

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class _Translations(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.parts: list[str] = []
        self.values: list[str] = []

    def handle_starttag(self, tag, attrs):
        if self.depth:
            if tag not in {"br", "img", "wbr", "hr", "input", "source"}:
                self.depth += 1
        elif tag == "span" and {"trans", "dtrans"}.intersection(dict(attrs).get("class", "").split()):
            self.depth = 1
            self.parts = []

    def handle_data(self, data):
        if self.depth:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if not self.depth:
            return
        self.depth -= 1
        if self.depth == 0:
            value = re.sub(r"\s+", " ", "".join(self.parts)).strip(" ,; ")
            if value and value not in self.values:
                self.values.append(value)


def lookup(word: str) -> dict:
    url = "https://dictionary.cambridge.org/dictionary/english-russian/" + urllib.parse.quote(word.lower())
    settings = dotenv_values(ENV_FILE)
    key = settings.get("CAMBRIDGE_API_KEY") or os.getenv("CAMBRIDGE_API_KEY")
    if not key:
        return {"configured": False, "translations": [], "url": url}
    code = settings.get("CAMBRIDGE_DICTIONARY_CODE") or os.getenv("CAMBRIDGE_DICTIONARY_CODE") or "english-russian"
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", code):
        raise ValueError("Некорректный код словаря Cambridge")
    api_url = f"https://dictionary.cambridge.org/api/v1/dictionaries/{code}/search/first?" + urllib.parse.urlencode({"q": word, "format": "html"})
    request = urllib.request.Request(api_url, headers={"accessKey": key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            entry = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"configured": True, "translations": [], "url": url}
        raise RuntimeError(f"Cambridge API вернул ошибку {exc.code}") from exc
    except (urllib.error.URLError, ValueError) as exc:
        raise RuntimeError("Не удалось получить ответ Cambridge Dictionary") from exc
    parser = _Translations()
    parser.feed(entry.get("entryContent", ""))
    return {"configured": True, "translations": parser.values[:3], "url": url}
