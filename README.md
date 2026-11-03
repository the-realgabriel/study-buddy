# Study Buddy

A local study app: add notes, generate a quiz from them, take the quiz, and get graded with explanations.

## Features

- Notes: paste text or import `.txt`, `.md`, `.docx`, `.pdf`
- Quiz generation from the selected note only, with multiple choice, true/false, and short answer questions
- Adjustable question count (5-20) and difficulty
- Interactive test mode with progress tracking
- Automatic grading, per-question explanations, and feedback on short answers
- Attempt history with scores
- Configurable OpenAI-compatible provider (Groq by default, or a local server such as LM Studio/Ollama)
- Everything stored locally in SQLite

## Requirements

- Python 3.10 or newer (uses only the standard library)
- Optional: `pypdf` for PDF import

```sh
python3 -m pip install --user pypdf
```

## Run

Double-click `run.command`, or:

```sh
cd ~/study-buddy
python3 server.py
```

The app opens at http://127.0.0.1:8765 (it picks the next free port if that one is taken).

## API key

1. Create a free key at https://console.groq.com/keys
2. Open Settings in the app and paste it

The key is stored in `data/config.json` with owner-only permissions. If `GROQ_API_KEY` is set in your environment, it is used automatically.

### OpenRouter

- Base URL: `https://openrouter.ai/api/v1`
- Key: https://openrouter.ai/keys
- Free models end in `:free`, for example `nvidia/nemotron-3.5-super-vl:free`
- Free models are rate-limited and can be temporarily unavailable; if you get a 429, wait a minute or switch models

To run fully local, set the base URL to an OpenAI-compatible server:

- LM Studio: `http://127.0.0.1:1234/v1`
- Ollama: `http://127.0.0.1:11434/v1`

Then set the model name to whatever the server exposes (use Load models).

## Data

- `data/studybuddy.db` - notes, quizzes, attempts
- `data/config.json` - provider settings and API key

Delete the `data` folder to reset the app.

## Notes on long inputs

Notes are capped at 60,000 characters. Very long notes are truncated for question generation; splitting them into chapters produces better quizzes.

## Troubleshooting

- **Invalid API Key**: create a new key at https://console.groq.com/keys and paste it in Settings.
- **SSL certificate verify failed**: run `python3 -m pip install --user certifi`, or run `/Applications/Python 3.14/Install Certificates.command`.
- **Port already in use**: the app tries the next port automatically. To force one, run `PORT=9000 python3 server.py`.
- **Try the interface without a key**: `STUDY_BUDDY_MOCK=1 python3 server.py` uses canned questions and keyword grading.
