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
- 29 unit tests: provider selection, PII masking, prompt building, readability scoring, history store isolation

## AI providers — Gemini **or** Claude

The app works with either **Google Gemini** (Google AI Studio key) or **Anthropic Claude**. It auto-selects based on which key you set — no code change needed. A single provider layer (`lib/ai.js`) streams identical Server-Sent Events to the browser whichever backend runs, so the whole UI is provider-agnostic.

| Env var | Provider | Default model |
|---|---|---|
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Google Gemini | `gemini-2.5-flash` |
| `ANTHROPIC_API_KEY` | Anthropic Claude | `claude-opus-4-8` |

Selection order: `AI_PROVIDER` (explicit `gemini`/`claude`) → a Gemini key → a Claude key. If both keys are set, Gemini wins unless `AI_PROVIDER=claude`. Override models with `GEMINI_MODEL` / `CLAUDE_MODEL`. The header badge shows which backend is live.

## Architecture

```
Browser (public/)                     Server (Node + Express)             AI provider (lib/ai.js)
┌──────────────────────┐   POST      ┌─────────────────────────┐  stream  ┌────────────────────┐
│ controls + textarea  ├──/api/─────▶│ rate-limit → validate → │─────────▶│ Gemini  (AI Studio)│
│ SSE consumer         │◀─transform──│ mask PII → build prompt │◀─────────│   or Claude        │
│ markdown renderer    │  /api/ask   │ → stream deltas as SSE  │          └────────────────────┘
│ TTS + dictation      │  (SSE)      │ → readability metrics   │
│ compare + metrics    │             │ (no content logging)    │──▶ SQLite (opt-in history,
└──────────────────────┘             └─────────────────────────┘            masked at rest)
```

- **Streamed end-to-end** (provider → server → browser as SSE). Stop reasons (refusal, length-limit, normal) are normalized across providers so the UI behaves the same either way.
- On Claude, the fixed system prompts carry `cache_control` breakpoints; on Gemini they become one system instruction with thinking disabled on Flash for low latency.

## Run it

The easiest way — put your key in a `.env` file (loaded automatically on start, works on **Windows, macOS, and Linux** alike):

```bash
npm install

# 1. Create your .env from the template
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env

# 2. Open .env and set ONE key:
#      GEMINI_API_KEY=AIza...        (from https://aistudio.google.com/apikey)
#    …or ANTHROPIC_API_KEY=sk-ant-...

# 3. Start
npm start
```

Open http://localhost:3000 — the header badge shows the active backend ("Powered by Gemini …").

Prefer environment variables instead of a file? They work too:

```bash
# macOS / Linux
export GEMINI_API_KEY=AIza... && npm start
# Windows PowerShell
$env:GEMINI_API_KEY="AIza..."; npm start
```

No key? Demo the full UI with canned responses: `npm run demo`. Tests: `npm test`.

### Docker

```bash
docker build -t accessibility-copilot .
docker run -p 3000:3000 -e GEMINI_API_KEY=AIza... -v copilot-data:/app/data accessibility-copilot
# (or -e ANTHROPIC_API_KEY=sk-ant-...)
```

## Project layout

```
server.js            Express app: transform/ask (SSE), scan, history CRUD, health
lib/ai.js            Provider abstraction — Gemini or Claude, unified streaming
lib/prompt.js        System prompts (transform + grounded Q&A) and task builders
lib/privacy.js       PII detection & reversible masking (email/phone/ID/card)
lib/readability.js   Flesch-Kincaid grade, word counts, reading time
lib/db.js            SQLite history store (per-device isolation, capped, masked)
public/              Self-contained UI (no CDNs): index.html, app.js, styles.css
test/                29 unit tests
Dockerfile           Production container (non-root, persistent volume)
```
