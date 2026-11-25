import json
import sqlite3
from pathlib import Path


class Store:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = root / "projects.sqlite3"
        with self.connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, filename TEXT NOT NULL, video_path TEXT NOT NULL,
                    duration REAL NOT NULL, status TEXT NOT NULL, device TEXT,
                    error TEXT, title TEXT, expected_speakers INTEGER,
                    progress INTEGER NOT NULL DEFAULT 0,
                    stage TEXT NOT NULL DEFAULT 'ready', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS speakers (
                    project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
                    PRIMARY KEY (project_id, id)
                );
                CREATE TABLE IF NOT EXISTS segments (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, start REAL NOT NULL,
                    end REAL NOT NULL, text TEXT NOT NULL, original_text TEXT NOT NULL,
                    speaker_id TEXT, words_json TEXT NOT NULL DEFAULT '[]'
                );
                CREATE INDEX IF NOT EXISTS segments_project ON segments(project_id, start);
                CREATE TABLE IF NOT EXISTS ai_lines (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, segment_ids_json TEXT NOT NULL,
                    start REAL NOT NULL, end REAL NOT NULL, speaker_id TEXT,
                    source_text TEXT NOT NULL, translated_text TEXT NOT NULL, position INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ai_lines_project ON ai_lines(project_id, position);
            """)
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}
            if "progress" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN progress INTEGER NOT NULL DEFAULT 0")
            if "stage" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN stage TEXT NOT NULL DEFAULT 'ready'")
            if "title" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN title TEXT")
            if "expected_speakers" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN expected_speakers INTEGER")
            if "context_notes" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN context_notes TEXT NOT NULL DEFAULT ''")
            if "target_language" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN target_language TEXT NOT NULL DEFAULT 'Russian'")
            if "ai_status" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'idle'")
            if "ai_error" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN ai_error TEXT")
            if "ai_progress" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN ai_progress INTEGER NOT NULL DEFAULT 0")
            if "ai_provider" not in columns:
                conn.execute("ALTER TABLE projects ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'ollama'")
            ai_columns = {row["name"] for row in conn.execute("PRAGMA table_info(ai_lines)")}
            if "word_links_json" not in ai_columns:
                conn.execute("ALTER TABLE ai_lines ADD COLUMN word_links_json TEXT NOT NULL DEFAULT '[]'")
            conn.execute("UPDATE projects SET status='failed', stage='failed', error='Обработка прервана перезапуском сервера' WHERE status IN ('queued', 'processing')")
            conn.execute("UPDATE projects SET ai_status='failed', ai_error='AI-анализ прерван перезапуском сервера' WHERE ai_status='processing'")

    def connect(self):
        conn = sqlite3.connect(self.db, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def get(self, project_id: str):
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            if row is None:
                return None
            project = dict(row)
            project["title"] = project["title"] or project["filename"]
            project["speakers"] = [dict(x) for x in conn.execute("SELECT id, name FROM speakers WHERE project_id=? ORDER BY id", (project_id,))]
            project["segments"] = []
            for x in conn.execute("SELECT id, start, end, text, original_text, speaker_id, words_json FROM segments WHERE project_id=? ORDER BY start, id", (project_id,)):
                segment = dict(x)
                segment["words"] = json.loads(segment.pop("words_json"))
                project["segments"].append(segment)
            project["ai_lines"] = []
            for x in conn.execute("SELECT id, segment_ids_json, start, end, speaker_id, source_text, translated_text, word_links_json FROM ai_lines WHERE project_id=? ORDER BY position", (project_id,)):
                line = dict(x)
                line["segment_ids"] = json.loads(line.pop("segment_ids_json"))
                line["word_links"] = json.loads(line.pop("word_links_json"))
                project["ai_lines"].append(line)
            project.pop("video_path")
            return project

    def save_result(self, project_id: str, speakers: list, segments: list):
        with self.connect() as conn:
            conn.execute("DELETE FROM segments WHERE project_id=?", (project_id,))
            conn.execute("DELETE FROM speakers WHERE project_id=?", (project_id,))
            conn.execute("DELETE FROM ai_lines WHERE project_id=?", (project_id,))
            conn.executemany("INSERT INTO speakers(project_id,id,name) VALUES(?,?,?)", [(project_id, s, f"Говорящий {i + 1}") for i, s in enumerate(speakers)])
            conn.executemany("INSERT INTO segments(id,project_id,start,end,text,original_text,speaker_id,words_json) VALUES(?,?,?,?,?,?,?,?)", [
                (x["id"], project_id, x["start"], x["end"], x["text"], x["text"], x.get("speaker_id"), json.dumps(x.get("words", []))) for x in segments
            ])
            conn.execute("UPDATE projects SET status='complete', stage='complete', progress=100, error=NULL, ai_status='idle', ai_error=NULL, ai_progress=0 WHERE id=?", (project_id,))

    def save_ai_lines(self, project_id: str, lines: list[dict]):
        with self.connect() as conn:
            conn.execute("DELETE FROM ai_lines WHERE project_id=?", (project_id,))
            conn.executemany("INSERT INTO ai_lines(id,project_id,segment_ids_json,start,end,speaker_id,source_text,translated_text,position,word_links_json) VALUES(?,?,?,?,?,?,?,?,?,?)", [
                (line["id"], project_id, json.dumps(line["segment_ids"]), line["start"], line["end"], line["speaker_id"], line["source_text"], line["translated_text"], index, json.dumps(line.get("word_links", []), ensure_ascii=False))
                for index, line in enumerate(lines)
            ])
            conn.execute("UPDATE projects SET ai_status='complete', ai_error=NULL, ai_progress=100 WHERE id=?", (project_id,))

    def update_progress(self, project_id: str, stage: str, progress: int):
        with self.connect() as conn:
            conn.execute("UPDATE projects SET stage=?, progress=? WHERE id=? AND status='processing' AND progress<=?", (stage, progress, project_id, progress))
