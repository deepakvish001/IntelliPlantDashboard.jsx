# 🪄 Accessibility Copilot

**Any document, in the words you need.**

Forms, notices, announcements, and instructions are often written in ways that are hard to understand — especially for people who need simpler language, another language, or a different presentation. Accessibility Copilot rewrites, explains, translates, summarizes, and reads content aloud **without distorting its meaning**.

## What it does

| Control | Options |
|---|---|
| **Action** | Rewrite simply · Explain it · Translate · Summarize |
| **Reading level** | Very easy (ages 7–9) · Simple (ages 10–13) · Plain language (adult) · Keep original |
| **Language** | 15 built-in languages (Hindi, Spanish, Arabic, Tamil, …) plus free-text "Other" |
| **Output format** | Paragraphs · Bullet points · Step-by-step · Questions & answers |
| **Read aloud** | Browser text-to-speech in the output language, with RTL support for Arabic/Urdu |

## Designed to be safe

- **No invented details.** The system prompt forbids adding facts. Unreadable or ambiguous passages are flagged inline as `[unclear: reason]` instead of being papered over. If the input is too incomplete to transform safely, the copilot says so and lists what is missing.
- **Obligations survive simplification.** Deadlines, amounts, warnings, and required actions are preserved at every reading level, and dates/amounts are bolded.
- **Privacy by default.** Emails, phone numbers, ID numbers, and card numbers (Luhn-validated) are detected and replaced with placeholders like `[EMAIL-1]` *before* the text is sent to the AI, then restored locally in your browser. Masking runs on both client and server so raw identifiers never reach the model when enabled. The server logs only method/path/status — never content.
- **Prompt-injection resistant.** Pasted content is wrapped and treated as material to transform, never as instructions.
- **Consequential-content caution.** For documents that affect benefits, health, housing, or legal status, the output ends with a short reminder to confirm critical details with the issuing organization.
- **The tool itself is accessible**: semantic HTML, keyboard operable, visible focus, `aria-live` streaming output, adjustable text size, dark mode, reduced-motion support.

## Architecture

```
Browser (public/)                    Server (Node + Express)              Claude API
┌─────────────────────┐   POST      ┌───────────────────────┐  stream   ┌──────────────┐
│ controls + textarea ├───/api/────▶│ validate → mask PII → │──────────▶│ claude-opus- │
│ SSE consumer        │◀──transform─│ build prompt → stream │◀──────────│ 4-8          │
│ markdown renderer   │   (SSE)     │ deltas as SSE         │           └──────────────┘
│ TTS (Web Speech)    │             │ (no content logging)  │
└─────────────────────┘             └───────────────────────┘
```

- **Model:** `claude-opus-4-8` with adaptive thinking, streamed end-to-end (server → browser as Server-Sent Events).
- **Prompt caching:** the large fixed system prompt carries a `cache_control` breakpoint; only the small per-request task block varies.
- **Refusal & limits handled:** `refusal` and `max_tokens` stop reasons surface as clear user-facing messages, as do auth/rate-limit/network errors.

## Run it

```bash
npm install

# With a real API key:
export ANTHROPIC_API_KEY=sk-ant-...
npm start

# Or demo the full UI without a key (canned responses):
npm run demo
```

Open http://localhost:3000. Run the test suite with `npm test`.

## Project layout

```
server.js            Express app: /api/health, /api/scan, /api/transform (SSE)
lib/prompt.js        System prompt core + per-request task block builder
lib/privacy.js       PII detection & reversible masking (email/phone/ID/card)
public/index.html    Single-page UI
public/app.js        SSE consumer, markdown renderer, TTS, PII warnings
public/styles.css    Theme (light/dark), responsive layout
test/                Unit tests for privacy masking and prompt building
```
