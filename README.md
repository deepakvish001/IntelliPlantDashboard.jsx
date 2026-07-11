# 🪄 Accessibility Copilot

**Any document, in the words you need.**

Forms, notices, announcements, and instructions are often written in ways that are hard to understand — especially for people who need simpler language, another language, or a different presentation. Accessibility Copilot rewrites, explains, translates, summarizes, answers questions about, and reads content aloud **without distorting its meaning**.

> **Demo stat:** the built-in benefits-letter sample drops from **reading grade 21.6 to grade 3.4** while keeping every deadline, amount, and obligation.

## Features

| | |
|---|---|
| **5 actions** | Rewrite simply · Explain · Translate · Summarize · **Ask about this document** (grounded Q&A) |
| **Linguistic control** | 4 reading levels (ages 7–9 → keep original) · 15+ languages + free-text "Other" · 4 output formats (paragraphs / bullets / step-by-step / Q&A) |
| **Impact metrics** | Live Flesch-Kincaid grade **before → after**, word count change, reading time |
| **Compare view** | Original and result side by side |
| **Read aloud** | Web Speech TTS in the output language; RTL rendering for Arabic/Urdu |
| **Input options** | Paste · drag-and-drop / upload `.txt` `.md` · voice dictation |
| **Export** | Copy · download Markdown · print-friendly result page |
| **History** | SQLite-backed, per-device, opt-in, PII-masked at rest, delete one/all |

## Designed to be safe

- **No invented details.** The system prompt forbids adding facts. Unreadable or ambiguous passages are flagged inline as `[unclear: reason]`. If input is too incomplete to transform safely, the copilot says so and lists what is missing. Q&A answers come only from the document — "the document does not say" is a first-class answer.
- **Obligations survive simplification.** Deadlines, amounts, warnings, and required actions are preserved at every reading level; dates and amounts are bolded.
- **Privacy by default.** Emails, phone numbers, ID numbers, and Luhn-validated card numbers are replaced with placeholders like `[EMAIL-1]` *before* text reaches the model (enforced client- **and** server-side), then restored only in the browser. History stores the **masked** source only. The server logs method/path/status — never content.
- **Prompt-injection resistant.** Pasted content is wrapped and treated as material to transform, never as instructions.
- **Consequential-content caution.** Documents that affect benefits, health, housing, or legal status get a closing reminder to confirm critical details with the issuing organization.
- **The tool itself is accessible**: semantic HTML, skip link, keyboard operable, visible focus, `aria-live` streaming, adjustable text size, dark mode, reduced motion, print stylesheet.

## Production hardening

- Per-device rate limiting (sliding window) on all AI endpoints
- Strict security headers: same-origin CSP (no CDNs anywhere), `nosniff`, frame denial, no referrer
- Anonymous per-device identity (HttpOnly cookie) isolating history rows — no accounts, no tracking
- Input length limits, typed Claude API error handling, `refusal` / `max_tokens` stop reasons surfaced as clear messages
- SQLite (Node's built-in `node:sqlite`, WAL mode) — zero native dependencies
- Dockerfile (non-root, volume-mounted data dir)
- 20 unit tests: PII masking, prompt building, readability scoring, history store isolation

## Architecture

```
Browser (public/)                     Server (Node + Express)                Claude API
┌──────────────────────┐   POST      ┌─────────────────────────┐  stream   ┌──────────────┐
│ controls + textarea  ├──/api/─────▶│ rate-limit → validate → │──────────▶│ claude-opus- │
│ SSE consumer         │◀─transform──│ mask PII → build prompt │◀──────────│ 4-8          │
│ markdown renderer    │  /api/ask   │ → stream deltas as SSE  │           └──────────────┘
│ TTS + dictation      │  (SSE)      │ → readability metrics   │
│ compare + metrics    │             │ (no content logging)    │──▶ SQLite (opt-in history,
└──────────────────────┘             └─────────────────────────┘            masked at rest)
```

- **Model:** `claude-opus-4-8` with adaptive thinking, streamed end-to-end (Claude → server → browser as SSE).
- **Prompt caching:** the large fixed system prompts carry `cache_control` breakpoints; only small per-request task blocks vary.

## Run it

```bash
npm install

# With a real API key:
export ANTHROPIC_API_KEY=sk-ant-...
npm start

# Or demo the full UI without a key (canned responses):
npm run demo
```

Open http://localhost:3000. Tests: `npm test`.

### Docker

```bash
docker build -t accessibility-copilot .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... -v copilot-data:/app/data accessibility-copilot
```

## Project layout

```
server.js            Express app: transform/ask (SSE), scan, history CRUD, health
lib/prompt.js        System prompts (transform + grounded Q&A) and task builders
lib/privacy.js       PII detection & reversible masking (email/phone/ID/card)
lib/readability.js   Flesch-Kincaid grade, word counts, reading time
lib/db.js            SQLite history store (per-device isolation, capped, masked)
public/              Self-contained UI (no CDNs): index.html, app.js, styles.css
test/                20 unit tests
Dockerfile           Production container (non-root, persistent volume)
```
