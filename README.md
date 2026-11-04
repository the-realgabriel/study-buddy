# Study Buddy

A local study app: add notes, generate a quiz from them, take the quiz, and get graded with explanations.

## Features

- Notes: paste text or import `.txt`, `.md`, `.csv`, `.docx`, `.pdf`, `.pptx` (multiple at once)
- Uploaded files are stored in Cloudflare R2 (`study-buddy-files`) and can be opened later from the note
- Quiz generation from the selected note only, with multiple choice, true/false, and short answer questions
- Tutor mode: chat with a tutor that answers only from the selected note's content
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

## Deploy to Cloudflare with your own MySQL (optional)

The deployed version is multi-user (register + login), backed by MySQL/MariaDB on your own server. Uploaded files land in Cloudflare R2. The Worker reaches the database through a small PHP bridge served over HTTPS, so MySQL never has to be exposed to the internet. The LLM API key and model live server-side as Worker settings; users never see or change them.

How it works:

```
Browser -> Cloudflare Worker (study-buddy.theopgabrie.workers.dev)
                 |            \
                 |             +--> R2 "study-buddy-files" (uploaded PDFs/PPTX/DOCX)
                 |  HTTPS POST + X-Bridge-Secret
                 v
        Caddy -> Apache/PHP bridge -> MariaDB (127.0.0.1)
```

### 1. Server side (once)

```bash
sudo mariadb < mysql/schema.sql          # creates the database + tables
```

Copy `server/bridge.php` to the web root (e.g. `/opt/lampp/htdocs/studybuddy-db/index.php`), replace the placeholders with the DB user/password and a long random secret, then route it through your reverse proxy. Example Caddy snippet:

```caddy
dev.theogking.site {
    handle /studybuddy-db* {
        reverse_proxy 127.0.0.1:8088
    }
    handle {
        reverse_proxy 127.0.0.1:2000
    }
}
```

Keep MariaDB bound to `127.0.0.1` and give the bridge DB user rights on the `studybuddy` database only.

### 2. Worker side

```bash
npm install
npx wrangler secret put BRIDGE_SECRET   # same value as in bridge.php
npx wrangler secret put LLM_API_KEY     # the OpenRouter (or Groq) key
npx wrangler deploy
```

`wrangler.jsonc` sets `BRIDGE_URL` to the bridge endpoint and the R2 binding `FILES` -> bucket `study-buddy-files`. `REGISTRATION_CODE` is optional: set it with `npx wrangler secret put REGISTRATION_CODE` to require an invite code, or leave it unset for open registration.

Local Python usage is unchanged and still independent of the deployed app.

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
