"""Read and update the application settings stored in the root .env file."""

import os
import re
from pathlib import Path

from dotenv import dotenv_values, set_key, unset_key


ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
MANAGED_KEYS = {"HF_TOKEN", "OPENAI_API_KEY", "OPENAI_MODEL", "OLLAMA_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "CAMBRIDGE_API_KEY", "CAMBRIDGE_DICTIONARY_CODE"}
DEFAULT_MODEL = "gpt-4o-mini"


def status() -> dict:
    values = dotenv_values(ENV_FILE) if ENV_FILE.exists() else {}

    def source(key: str) -> str:
        if values.get(key):
            return "dotenv"
        if os.getenv(key):
            return "environment"
        return "missing"

    return {
        "hf_token": {"configured": source("HF_TOKEN") != "missing", "source": source("HF_TOKEN")},
        "openai_api_key": {"configured": source("OPENAI_API_KEY") != "missing", "source": source("OPENAI_API_KEY")},
        "openai_model": {"value": values.get("OPENAI_MODEL") or os.getenv("OPENAI_MODEL") or DEFAULT_MODEL, "source": source("OPENAI_MODEL") if source("OPENAI_MODEL") != "missing" else "default"},
        "ollama_model": {"value": values.get("OLLAMA_MODEL") or os.getenv("OLLAMA_MODEL") or "qwen2.5:7b", "source": source("OLLAMA_MODEL") if source("OLLAMA_MODEL") != "missing" else "default"},
        "openrouter_api_key": {"configured": source("OPENROUTER_API_KEY") != "missing", "source": source("OPENROUTER_API_KEY")},
        "openrouter_model": {"value": values.get("OPENROUTER_MODEL") or os.getenv("OPENROUTER_MODEL") or "openai/gpt-4o-mini", "source": source("OPENROUTER_MODEL") if source("OPENROUTER_MODEL") != "missing" else "default"},
        "cambridge_api_key": {"configured": source("CAMBRIDGE_API_KEY") != "missing", "source": source("CAMBRIDGE_API_KEY")},
        "cambridge_dictionary_code": {"value": values.get("CAMBRIDGE_DICTIONARY_CODE") or os.getenv("CAMBRIDGE_DICTIONARY_CODE") or "english-russian", "source": source("CAMBRIDGE_DICTIONARY_CODE") if source("CAMBRIDGE_DICTIONARY_CODE") != "missing" else "default"},
    }


def change(key: str, value: str | None) -> dict:
    if key not in MANAGED_KEYS:
        raise ValueError("Эта настройка недоступна")
    if value is not None:
        value = value.strip()
        if not value or len(value) > 1000 or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Введите значение без переносов строк и управляющих символов")
        if (key.endswith("_MODEL") or key == "CAMBRIDGE_DICTIONARY_CODE") and (len(value) > 100 or not re.fullmatch(r"[A-Za-z0-9_.:/-]+", value)):
            raise ValueError("Некорректное название модели")
        ENV_FILE.touch(mode=0o600, exist_ok=True)
        set_key(ENV_FILE, key, value, quote_mode="always")
    elif ENV_FILE.exists():
        unset_key(ENV_FILE, key)
    if ENV_FILE.exists():
        ENV_FILE.chmod(0o600)
    return status()
