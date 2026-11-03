#!/usr/bin/env python3
import base64
import io
import json
import os
import re
import sqlite3
import ssl
import sys
import threading
import traceback
import webbrowser
import zipfile
from html import unescape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlparse

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = APP_DIR / "data"
DB_PATH = DATA_DIR / "studybuddy.db"
CONFIG_PATH = DATA_DIR / "config.json"

DEFAULT_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "openai/gpt-oss-120b"
OPENROUTER_FREE_FALLBACKS = (
    "nvidia/nemotron-3.5-super-vl:free",
    "xingchen-agi/xing4.0-29b-a4b:free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "dots-studio/dots-3-note-preview:free",
)
MAX_BODY = 25 * 1024 * 1024
MAX_NOTE_CHARS = 60000
MOCK = os.environ.get("STUDY_BUDDY_MOCK") == "1"

try:
    import certifi

    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

QUESTION_TYPES = ("multiple_choice", "true_false", "short_answer")

STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "are", "was", "were",
    "have", "has", "had", "not", "but", "you", "your", "they", "their", "its",
    "into", "than", "then", "when", "where", "which", "while", "what", "who",
    "how", "why", "can", "could", "would", "should", "will", "shall", "may",
    "might", "must", "about", "over", "under", "between", "within", "without",
    "also", "such", "each", "more", "most", "some", "any", "all", "both",
    "one", "two", "three", "been", "being", "does", "did", "doing", "there",
}


class AppError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now():
    return __import__("datetime").datetime.now().isoformat(timespec="seconds")


def load_config():
    cfg = {"base_url": DEFAULT_BASE_URL, "model": DEFAULT_MODEL, "api_key": ""}
    if CONFIG_PATH.exists():
        try:
            stored = json.loads(CONFIG_PATH.read_text())
            if isinstance(stored, dict):
                cfg.update({k: v for k, v in stored.items() if v is not None})
        except Exception:
            pass
    env_key = os.environ.get("GROQ_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
    if not cfg.get("api_key") and env_key:
        cfg["api_key"] = env_key
        cfg["source"] = "env"
        if not os.environ.get("GROQ_API_KEY"):
            cfg["base_url"] = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    elif cfg.get("api_key"):
        cfg["source"] = "file"
    else:
        cfg["source"] = "none"
    return cfg


def save_config(updates):
    cfg = {"base_url": DEFAULT_BASE_URL, "model": DEFAULT_MODEL, "api_key": ""}
    if CONFIG_PATH.exists():
        try:
            stored = json.loads(CONFIG_PATH.read_text())
            if isinstance(stored, dict):
                cfg.update({k: v for k, v in stored.items() if v is not None})
        except Exception:
            pass
    cfg.update(updates)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    os.chmod(CONFIG_PATH, 0o600)


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS quizzes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                questions TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
                score INTEGER NOT NULL,
                total INTEGER NOT NULL,
                results TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )


def parse_json_object(text):
    if not isinstance(text, str):
        raise ValueError("empty model response")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    start = cleaned.find("{")
    if start == -1:
        raise ValueError("no JSON object in model response")
    decoder = json.JSONDecoder()
    try:
        obj, _ = decoder.raw_decode(cleaned[start:])
        return obj
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON from model: {exc}") from exc


def llm_chat(messages, json_mode=True, timeout=180):
    cfg = load_config()
    key = cfg.get("api_key", "")
    if not key:
        raise AppError(400, "No API key configured. Open Settings and add an API key.")
    base_url = cfg.get("base_url", DEFAULT_BASE_URL).rstrip("/")
    url = base_url + "/chat/completions"
    primary_model = cfg.get("model", DEFAULT_MODEL)
    candidates = [primary_model]
    if "openrouter.ai" in base_url and primary_model.endswith(":free"):
        for fallback in OPENROUTER_FREE_FALLBACKS:
            if fallback not in candidates:
                candidates.append(fallback)

    def send(body):
        req = urlrequest.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
                "User-Agent": "study-buddy/1.0",
                "HTTP-Referer": "http://localhost",
                "X-Title": "Study Buddy",
            },
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as resp:
            return json.loads(resp.read().decode())

    last_error = None
    for model in candidates:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.4,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        try:
            try:
                result = send(json.dumps(payload).encode())
            except urlerror.HTTPError as exc:
                if exc.code == 400 and json_mode:
                    payload.pop("response_format", None)
                    result = send(json.dumps(payload).encode())
                elif exc.code == 401:
                    raise AppError(401, "The API key was rejected. Check it in Settings.")
                elif exc.code in (429, 502, 503, 504) and len(candidates) > 1:
                    last_error = AppError(
                        exc.code,
                        "Rate limited by the provider. Free models have tight limits; wait a minute, switch models, or add credits.",
                    )
                    continue
                elif exc.code == 429:
                    raise AppError(
                        429,
                        "Rate limited by the provider. Free models have tight limits; wait a minute, switch models, or add credits.",
                    )
                else:
                    detail = exc.read().decode("utf-8", "replace")[:400]
                    raise AppError(502, f"Provider error {exc.code}: {detail}")
        except urlerror.URLError as exc:
            raise AppError(502, f"Could not reach the provider: {exc.reason}")
        except TimeoutError:
            last_error = AppError(504, "The provider timed out. Try fewer questions or a smaller note.")
            if len(candidates) > 1:
                continue
            raise last_error

        try:
            content = result["choices"][0]["message"]["content"]
            if content:
                return content
        except (KeyError, IndexError, TypeError):
            pass
        last_error = AppError(502, "Unexpected response from the provider.")

    raise last_error or AppError(502, "Could not generate response from provider.")


def derive_title(content, fallback="Untitled note"):
    for line in content.splitlines():
        cleaned = line.strip().lstrip("#").strip()
        if cleaned:
            return cleaned[:80]
    return fallback


def normalize_question(raw):
    if not isinstance(raw, dict):
        return None
    qtype = str(raw.get("type", "")).strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "mcq": "multiple_choice",
        "multiplechoice": "multiple_choice",
        "multiple_choice": "multiple_choice",
        "choice": "multiple_choice",
        "tf": "true_false",
        "truefalse": "true_false",
        "true_false": "true_false",
        "boolean": "true_false",
        "short": "short_answer",
        "shortanswer": "short_answer",
        "short_answer": "short_answer",
        "open": "short_answer",
        "open_ended": "short_answer",
    }
    qtype = aliases.get(qtype)
    if qtype not in QUESTION_TYPES:
        return None
    question = str(raw.get("question") or raw.get("prompt") or "").strip()
    if not question:
        return None
    explanation = str(
        raw.get("explanation") or raw.get("rationale") or raw.get("why") or ""
    ).strip()
    answer_raw = raw.get("answer", raw.get("correct_answer", raw.get("correct")))

    if qtype == "multiple_choice":
        options = raw.get("options") or raw.get("choices") or []
        if not isinstance(options, list):
            return None
        options = [str(opt).strip() for opt in options if str(opt).strip()]
        if len(options) < 2:
            return None
        options = options[:6]
        answer = coerce_choice(answer_raw, options)
        if answer is None:
            return None
        return {
            "type": qtype,
            "question": question[:2000],
            "options": [opt[:500] for opt in options],
            "answer": answer,
            "explanation": explanation[:2000],
        }

    if qtype == "true_false":
        answer = coerce_bool(answer_raw)
        if answer is None:
            return None
        return {
            "type": qtype,
            "question": question[:2000],
            "answer": answer,
            "explanation": explanation[:2000],
        }

    answer = str(answer_raw if answer_raw is not None else "").strip()
    if not answer:
        return None
    return {
        "type": qtype,
        "question": question[:2000],
        "answer": answer[:2000],
        "explanation": explanation[:2000],
    }


def coerce_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "t", "yes", "y", "1", "correct"):
            return True
        if lowered in ("false", "f", "no", "n", "0", "incorrect"):
            return False
    return None


def coerce_choice(value, options):
    if isinstance(value, bool):
        value = int(value)
    if isinstance(value, int):
        return value if 0 <= value < len(options) else None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
        return value if 0 <= value < len(options) else None
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            index = int(text)
            return index if 0 <= index < len(options) else None
        if len(text) == 1 and text.upper() in "ABCDEF":
            index = ord(text.upper()) - 65
            return index if index < len(options) else None
        for index, option in enumerate(options):
            if option.strip().lower() == text.lower():
                return index
    return None


def build_quiz_messages(note, count, difficulty, types):
    type_labels = {
        "multiple_choice": "multiple choice",
        "true_false": "true/false",
        "short_answer": "short answer",
    }
    wanted = ", ".join(type_labels[t] for t in types)
    system = (
        "You are an expert tutor who writes fair, high-quality quizzes.\n"
        "Rules:\n"
        "- Use ONLY the provided notes. Never rely on outside knowledge.\n"
        "- Every question must be answerable from the notes alone.\n"
        "- Avoid trick questions, ambiguity, and duplicates.\n"
        "- Keep questions clear and concise.\n"
        "- Return ONLY a JSON object with no markdown fences and no commentary.\n\n"
        "JSON schema:\n"
        "{\n"
        '  "title": "short quiz title",\n'
        '  "questions": [\n'
        '    {"type": "multiple_choice", "question": "...", "options": ["...", "...", "...", "..."], "answer": 0, "explanation": "..."},\n'
        '    {"type": "true_false", "question": "...", "answer": true, "explanation": "..."},\n'
        '    {"type": "short_answer", "question": "...", "answer": "expected answer", "explanation": "..."}\n'
        "  ]\n"
        "}\n"
        "For multiple_choice, answer is the zero-based index of the correct option. "
        "Use exactly 4 options per multiple-choice question."
    )
    user = (
        f"Notes title: {note['title']}\n"
        f"Difficulty: {difficulty}\n"
        f"Allowed question types: {wanted}\n"
        f"Create exactly {count} questions. Mix the allowed types evenly when possible.\n\n"
        f"Notes:\n---\n{note['content'][:MAX_NOTE_CHARS]}\n---"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def mock_quiz(note, count, types):
    sentences = [
        s.strip()
        for s in re.split(r"(?<=[.!?])\s+|\n+", note["content"])
        if len(s.strip()) > 30
    ]
    sample = sentences[0] if sentences else note["content"][:120]
    questions = []
    if "multiple_choice" in types:
        questions.append(
            {
                "type": "multiple_choice",
                "question": "Which statement appears in the notes?",
                "options": [
                    sample[:180],
                    "A claim that is not supported by the notes.",
                    "An unrelated historical fact.",
                    "A definition from a different subject.",
                ],
                "answer": 0,
                "explanation": "This statement is taken directly from the notes.",
            }
        )
    if "true_false" in types:
        questions.append(
            {
                "type": "true_false",
                "question": f"The notes contain this idea: {sample[:160]}",
                "answer": True,
                "explanation": "The quoted idea comes from the notes.",
            }
        )
    if "short_answer" in types:
        questions.append(
            {
                "type": "short_answer",
                "question": "Summarize the main idea of the notes in one sentence.",
                "answer": sample[:240],
                "explanation": "A good answer captures the central idea.",
            }
        )
    while len(questions) < count and questions:
        questions.append(dict(questions[len(questions) % len(questions)]))
    return {"title": f"Mock quiz: {note['title']}", "questions": questions[:count]}


def generate_quiz(note, count, difficulty, types):
    types = [t for t in types if t in QUESTION_TYPES] or list(QUESTION_TYPES)
    count = max(1, min(int(count or 8), 20))
    if MOCK:
        raw = mock_quiz(note, count, types)
    else:
        content = llm_chat(build_quiz_messages(note, count, difficulty, types))
        try:
            raw = parse_json_object(content)
        except ValueError as exc:
            raise AppError(502, f"Could not parse the generated quiz: {exc}")
        if not isinstance(raw, dict):
            raise AppError(502, "The model returned an unexpected quiz format. Try again.")
    questions = [q for q in (normalize_question(item) for item in raw.get("questions", [])) if q]
    if not questions:
        raise AppError(502, "The model did not return any valid questions. Try again.")
    title = str(raw.get("title") or f"Quiz: {note['title']}").strip()[:120]
    return {"title": title, "questions": questions[:count]}


def sanitize_quiz(quiz_id, quiz, note_id):
    return {
        "id": quiz_id,
        "note_id": note_id,
        "title": quiz["title"],
        "questions": [
            {
                "id": index,
                "type": q["type"],
                "question": q["question"],
                **({"options": q["options"]} if q["type"] == "multiple_choice" else {}),
            }
            for index, q in enumerate(quiz["questions"])
        ],
    }


def keyword_match(expected, given):
    if not str(given).strip():
        return False
    expected_clean = str(expected).strip().lower()
    given_clean = str(given).strip().lower()
    if not expected_clean:
        return False
    if expected_clean == given_clean or expected_clean in given_clean:
        return True
    expected_tokens = {
        w for w in re.findall(r"[a-z0-9]+", expected_clean)
        if len(w) > 3 and w not in STOPWORDS
    }
    if not expected_tokens:
        return False
    given_tokens = set(re.findall(r"[a-z0-9]+", given_clean))
    return len(expected_tokens & given_tokens) / len(expected_tokens) >= 0.6


def grade_short_batch(items):
    if not items:
        return []
    if MOCK:
        return [
            {
                "index": item["index"],
                "correct": keyword_match(item["expected"], item["response"]),
                "feedback": "",
            }
            for item in items
        ]
    system = (
        "You are a strict but fair exam grader. Grade each short answer against the "
        "expected answer and the question. Accept paraphrases and equivalent meaning. "
        "Return ONLY JSON: {\"results\":[{\"index\":0,\"correct\":true,\"feedback\":\"one short sentence\"}]}. "
        "The index must match the provided index. Grade every item."
    )
    user = json.dumps(
        [
            {
                "index": item["index"],
                "question": item["question"],
                "expected": item["expected"],
                "response": item["response"],
            }
            for item in items
        ],
        ensure_ascii=False,
    )
    try:
        content = llm_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}]
        )
        parsed = parse_json_object(content)
        results = {}
        for entry in parsed.get("results", []):
            try:
                index = int(entry.get("index"))
            except (TypeError, ValueError):
                continue
            correct = coerce_bool(entry.get("correct"))
            if correct is None:
                continue
            results[index] = {
                "index": index,
                "correct": correct,
                "feedback": str(entry.get("feedback") or "")[:400],
            }
        return [
            results.get(
                item["index"],
                {
                    "index": item["index"],
                    "correct": keyword_match(item["expected"], item["response"]),
                    "feedback": "",
                },
            )
            for item in items
        ]
    except (AppError, ValueError):
        return [
            {
                "index": item["index"],
                "correct": keyword_match(item["expected"], item["response"]),
                "feedback": "",
            }
            for item in items
        ]


def grade_quiz(quiz, answers):
    results = []
    short_items = []
    for index, question in enumerate(quiz["questions"]):
        given = answers[index] if isinstance(answers, list) and index < len(answers) else None
        entry = {
            "index": index,
            "type": question["type"],
            "question": question["question"],
            "explanation": question.get("explanation", ""),
            "student_answer": given,
            "correct": False,
            "feedback": "",
        }
        if question["type"] == "multiple_choice":
            choice = coerce_choice(given, question["options"])
            entry["correct"] = choice == question["answer"]
            entry["student_answer"] = (
                question["options"][choice] if choice is not None else ""
            )
            entry["correct_answer"] = question["options"][question["answer"]]
        elif question["type"] == "true_false":
            value = coerce_bool(given)
            entry["correct"] = value == question["answer"]
            entry["student_answer"] = (
                "True" if value else "False" if value is False else ""
            )
            entry["correct_answer"] = "True" if question["answer"] else "False"
        else:
            text = str(given or "").strip()
            entry["student_answer"] = text
            entry["correct_answer"] = question["answer"]
            short_items.append(
                {
                    "index": index,
                    "question": question["question"],
                    "expected": question["answer"],
                    "response": text,
                }
            )
        results.append(entry)

    graded = {
        item["index"]: item
        for item in grade_short_batch(short_items)
        if isinstance(item, dict) and "index" in item
    }
    for entry in results:
        if entry["type"] == "short_answer":
            match = graded.get(entry["index"], {})
            entry["correct"] = bool(match.get("correct"))
            entry["feedback"] = match.get("feedback", "")

    score = sum(1 for entry in results if entry["correct"])
    return results, score


def extract_text(filename, raw):
    name = (filename or "").lower()
    if name.endswith((".txt", ".md", ".markdown", ".csv", ".json", ".log")):
        return raw.decode("utf-8", "replace")
    if name.endswith(".docx"):
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                xml = archive.read("word/document.xml").decode("utf-8", "replace")
        except (KeyError, zipfile.BadZipFile):
            raise AppError(400, "Could not read that .docx file.")
        xml = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t").replace("<w:br/>", "\n")
        text = unescape(re.sub(r"<[^>]+>", "", xml))
        return re.sub(r"\n{3,}", "\n\n", text).strip()
    if name.endswith(".pdf"):
        try:
            from pypdf import PdfReader
        except ImportError:
            raise AppError(415, "PDF import needs pypdf. Run: python3 -m pip install --user pypdf")
        try:
            reader = PdfReader(io.BytesIO(raw))
            text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception:
            raise AppError(400, "Could not read that PDF.")
        if not text.strip():
            raise AppError(400, "That PDF has no extractable text (it may be scanned images).")
        return text
    raise AppError(415, "Unsupported file type. Use .txt, .md, .docx, or .pdf.")


def row_to_note(row, include_content=True):
    note = {
        "id": row["id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "length": len(row["content"]),
    }
    if include_content:
        note["content"] = row["content"]
    return note


def get_note(note_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not row:
            raise AppError(404, "Note not found.")
        quiz_rows = conn.execute(
            """
            SELECT q.id, q.title, q.questions, q.created_at,
                   COUNT(a.id) AS attempt_count,
                   MAX(a.score) AS best_score,
                   MAX(a.total) AS best_total
            FROM quizzes q
            LEFT JOIN attempts a ON a.quiz_id = q.id
            WHERE q.note_id = ?
            GROUP BY q.id
            ORDER BY q.created_at DESC, q.id DESC
            """,
            (note_id,),
        ).fetchall()
    note = row_to_note(row)
    note["quizzes"] = [
        {
            "id": q["id"],
            "title": q["title"],
            "question_count": len(json.loads(q["questions"])),
            "created_at": q["created_at"],
            "attempt_count": q["attempt_count"],
            "best_score": q["best_score"],
            "best_total": q["best_total"],
        }
        for q in quiz_rows
    ]
    return note


def get_quiz(quiz_id):
    with db() as conn:
        row = conn.execute(
            "SELECT q.*, n.title AS note_title FROM quizzes q JOIN notes n ON n.id = q.note_id WHERE q.id = ?",
            (quiz_id,),
        ).fetchone()
    if not row:
        raise AppError(404, "Quiz not found.")
    return {
        "id": row["id"],
        "note_id": row["note_id"],
        "note_title": row["note_title"],
        "title": row["title"],
        "questions": json.loads(row["questions"]),
        "created_at": row["created_at"],
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        if not urlparse(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api("GET", path)
        else:
            super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api("POST", path)
        else:
            self.send_error(404)

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api("PUT", path)
        else:
            self.send_error(404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self.handle_api("DELETE", path)
        else:
            self.send_error(404)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise AppError(413, "That file is too large (limit 25 MB).")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise AppError(400, "Invalid JSON body.")
        if not isinstance(data, dict):
            raise AppError(400, "Expected a JSON object.")
        return data

    def send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def handle_api(self, method, path):
        origin = self.headers.get("Origin")
        if origin and not re.fullmatch(r"https?://(127\.0\.0\.1|localhost)(:\d+)?", origin):
            self.send_json(403, {"error": "Cross-origin requests are not allowed."})
            return
        try:
            data = self.read_json() if method in ("POST", "PUT") else {}
            result, status = self.route(method, path, data)
            self.send_json(status, result)
        except AppError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except Exception as exc:
            traceback.print_exc()
            self.send_json(500, {"error": f"Unexpected server error: {exc}"})

    def route(self, method, path, data):
        if method == "GET" and path == "/api/health":
            return {"ok": True, "mock": MOCK}, 200

        if method == "GET" and path == "/api/config":
            cfg = load_config()
            key = cfg.get("api_key", "")
            return {
                "base_url": cfg.get("base_url", DEFAULT_BASE_URL),
                "model": cfg.get("model", DEFAULT_MODEL),
                "has_key": bool(key),
                "key_hint": f"...{key[-4:]}" if len(key) >= 8 else "",
                "source": cfg.get("source", "none"),
                "mock": MOCK,
            }, 200

        if method == "POST" and path == "/api/config":
            updates = {}
            for field in ("base_url", "model", "api_key"):
                if field in data:
                    value = str(data[field]).strip()
                    if field == "api_key" and not value:
                        continue
                    updates[field] = value
            if data.get("clear_key"):
                updates["api_key"] = ""
            if "base_url" in updates:
                updates["base_url"] = updates["base_url"].rstrip("/")
                if not updates["base_url"]:
                    updates.pop("base_url")
                elif not re.match(r"^https?://", updates["base_url"]):
                    raise AppError(400, "Base URL must start with http:// or https://")
            if "model" in updates and not updates["model"]:
                updates.pop("model")
            save_config(updates)
            cfg = load_config()
            return {"ok": True, "has_key": bool(cfg.get("api_key"))}, 200

        if method == "GET" and path == "/api/models":
            cfg = load_config()
            key = cfg.get("api_key", "")
            if not key:
                raise AppError(400, "Add an API key first.")
            url = cfg.get("base_url", DEFAULT_BASE_URL).rstrip("/") + "/models"
            req = urlrequest.Request(
                url,
                headers={
                    "Authorization": f"Bearer {key}",
                    "User-Agent": "study-buddy/1.0",
                    "HTTP-Referer": "http://localhost",
                    "X-Title": "Study Buddy",
                },
            )
            try:
                with urlrequest.urlopen(req, timeout=30, context=SSL_CONTEXT) as resp:
                    payload = json.loads(resp.read().decode())
            except urlerror.HTTPError as exc:
                raise AppError(502, f"Provider error {exc.code} while listing models.")
            except urlerror.URLError as exc:
                raise AppError(502, f"Could not reach the provider: {exc.reason}")
            models = sorted(
                str(item.get("id")) for item in payload.get("data", []) if item.get("id")
            )
            return {"models": models}, 200

        if method == "GET" and path == "/api/notes":
            with db() as conn:
                rows = conn.execute(
                    """
                    SELECT n.*, COUNT(q.id) AS quiz_count
                    FROM notes n
                    LEFT JOIN quizzes q ON q.note_id = n.id
                    GROUP BY n.id
                    ORDER BY n.updated_at DESC
                    """
                ).fetchall()
            notes = []
            for row in rows:
                item = row_to_note(row, False)
                item["quiz_count"] = row["quiz_count"]
                notes.append(item)
            return {"notes": notes}, 200

        if method == "POST" and path == "/api/notes":
            content = str(data.get("content") or "").strip()
            if not content:
                raise AppError(400, "Note content is empty.")
            if len(content) > MAX_NOTE_CHARS:
                raise AppError(413, f"Note is too long (limit {MAX_NOTE_CHARS} characters).")
            title = str(data.get("title") or "").strip()[:120] or derive_title(content)
            stamp = now()
            with db() as conn:
                cursor = conn.execute(
                    "INSERT INTO notes (title, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
                    (title, content, stamp, stamp),
                )
                note_id = cursor.lastrowid
            return get_note(note_id), 201

        note_match = re.fullmatch(r"/api/notes/(\d+)", path)
        if note_match:
            note_id = int(note_match.group(1))
            if method == "GET":
                return get_note(note_id), 200
            if method == "PUT":
                note = get_note(note_id)
                content = str(data.get("content", note["content"])).strip()
                if not content:
                    raise AppError(400, "Note content is empty.")
                if len(content) > MAX_NOTE_CHARS:
                    raise AppError(413, f"Note is too long (limit {MAX_NOTE_CHARS} characters).")
                title = str(data.get("title", note["title"])).strip()[:120] or derive_title(content)
                with db() as conn:
                    conn.execute(
                        "UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?",
                        (title, content, now(), note_id),
                    )
                return get_note(note_id), 200
            if method == "DELETE":
                with db() as conn:
                    conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
                return {"ok": True}, 200

        generate_match = re.fullmatch(r"/api/notes/(\d+)/generate", path)
        if method == "POST" and generate_match:
            note = get_note(int(generate_match.group(1)))
            count = int(data.get("count") or 8)
            difficulty = str(data.get("difficulty") or "medium").lower()
            if difficulty not in ("easy", "medium", "hard"):
                difficulty = "medium"
            types = data.get("types") or list(QUESTION_TYPES)
            if not isinstance(types, list):
                types = list(QUESTION_TYPES)
            quiz = generate_quiz(note, count, difficulty, types)
            with db() as conn:
                cursor = conn.execute(
                    "INSERT INTO quizzes (note_id, title, questions, created_at) VALUES (?, ?, ?, ?)",
                    (note["id"], quiz["title"], json.dumps(quiz["questions"]), now()),
                )
                quiz_id = cursor.lastrowid
            return sanitize_quiz(quiz_id, quiz, note["id"]), 201

        quiz_match = re.fullmatch(r"/api/quizzes/(\d+)", path)
        if method == "GET" and quiz_match:
            quiz = get_quiz(int(quiz_match.group(1)))
            return sanitize_quiz(quiz["id"], quiz, quiz["note_id"]), 200
        if method == "DELETE" and quiz_match:
            with db() as conn:
                conn.execute("DELETE FROM quizzes WHERE id = ?", (int(quiz_match.group(1)),))
            return {"ok": True}, 200

        submit_match = re.fullmatch(r"/api/quizzes/(\d+)/submit", path)
        if method == "POST" and submit_match:
            quiz = get_quiz(int(submit_match.group(1)))
            answers = data.get("answers")
            if not isinstance(answers, list):
                raise AppError(400, "Answers must be a list.")
            results, score = grade_quiz(quiz, answers)
            with db() as conn:
                cursor = conn.execute(
                    "INSERT INTO attempts (quiz_id, score, total, results, created_at) VALUES (?, ?, ?, ?, ?)",
                    (quiz["id"], score, len(results), json.dumps(results), now()),
                )
                attempt_id = cursor.lastrowid
            return {
                "attempt_id": attempt_id,
                "quiz_id": quiz["id"],
                "quiz_title": quiz["title"],
                "note_id": quiz["note_id"],
                "note_title": quiz["note_title"],
                "score": score,
                "total": len(results),
                "results": results,
            }, 200

        if method == "GET" and path == "/api/attempts":
            with db() as conn:
                rows = conn.execute(
                    """
                    SELECT a.id, a.quiz_id, a.score, a.total, a.created_at,
                           q.title AS quiz_title, q.note_id, n.title AS note_title
                    FROM attempts a
                    JOIN quizzes q ON q.id = a.quiz_id
                    JOIN notes n ON n.id = q.note_id
                    ORDER BY a.created_at DESC, a.id DESC
                    LIMIT 100
                    """
                ).fetchall()
            return {"attempts": [dict(row) for row in rows]}, 200

        attempt_match = re.fullmatch(r"/api/attempts/(\d+)", path)
        if method == "GET" and attempt_match:
            with db() as conn:
                row = conn.execute(
                    """
                    SELECT a.*, q.title AS quiz_title, q.note_id, n.title AS note_title
                    FROM attempts a
                    JOIN quizzes q ON q.id = a.quiz_id
                    JOIN notes n ON n.id = q.note_id
                    WHERE a.id = ?
                    """,
                    (int(attempt_match.group(1)),),
                ).fetchone()
            if not row:
                raise AppError(404, "Attempt not found.")
            return {
                "attempt_id": row["id"],
                "quiz_id": row["quiz_id"],
                "quiz_title": row["quiz_title"],
                "note_id": row["note_id"],
                "note_title": row["note_title"],
                "score": row["score"],
                "total": row["total"],
                "results": json.loads(row["results"]),
                "created_at": row["created_at"],
            }, 200

        if method == "POST" and path == "/api/extract":
            encoded = data.get("data") or ""
            if not encoded:
                raise AppError(400, "No file data received.")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except Exception:
                raise AppError(400, "Could not decode the uploaded file.")
            if len(raw) > 15 * 1024 * 1024:
                raise AppError(413, "That file is too large (limit 15 MB).")
            text = extract_text(str(data.get("filename") or ""), raw)
            return {"text": text[:MAX_NOTE_CHARS], "truncated": len(text) > MAX_NOTE_CHARS}, 200

        raise AppError(404, "Not found.")


def main():
    init_db()
    port = int(os.environ.get("PORT", "8765"))
    httpd = None
    for candidate in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        sys.exit("Could not find a free port between 8765 and 8784.")
    url = f"http://127.0.0.1:{port}"
    print(f"Study Buddy running at {url}")
    print("Press Ctrl+C to stop.")
    if "--no-open" not in sys.argv and os.environ.get("NO_OPEN") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
