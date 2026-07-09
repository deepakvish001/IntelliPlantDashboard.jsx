"use strict";

const $ = (id) => document.getElementById(id);

const sourceText = $("source-text");
const charCount = $("char-count");
const piiWarning = $("pii-warning");
const maskPiiBox = $("mask-pii");
const languageSelect = $("language");
const languageOther = $("language-other");
const languageLabel = $("language-label");
const levelSelect = $("level");
const formatSelect = $("format");
const goBtn = $("go");
const statusEl = $("status");
const outputEl = $("output");
const speakBtn = $("speak");
const copyBtn = $("copy");
const clearBtn = $("clear");
const modeBadge = $("mode-badge");

const LANG_TO_BCP47 = {
  "english": "en", "hindi": "hi", "spanish": "es", "french": "fr", "arabic": "ar",
  "bengali": "bn", "portuguese": "pt", "chinese (simplified)": "zh-CN", "chinese": "zh-CN",
  "tamil": "ta", "telugu": "te", "marathi": "mr", "urdu": "ur", "german": "de",
  "japanese": "ja", "swahili": "sw",
};
const RTL_LANGS = new Set(["ar", "ur"]);

const SAMPLES = {
  benefits: `NOTICE OF PROPOSED ADVERSE ACTION — CASE #HB-2291-448
Pursuant to Section 12(b) of the Housing Assistance Regulations, the Authority hereby notifies the above-referenced beneficiary that continued disbursement of monthly assistance payments is contingent upon submission of the following documentation no later than May 3, 2026: (i) verification of household income for the preceding six-month period; (ii) an executed copy of the current lease agreement. Failure to furnish said documentation within the prescribed period shall result in suspension of benefits effective the first day of the month following the deadline. Beneficiaries may request an administrative review within ten (10) business days of receipt of this notice by contacting the Office of Hearings at hearings@housing.example.gov or (555) 013-2244.`,
  school: `Dear Parents/Guardians: Please be advised that in accordance with the district's revised inclement weather protocol, dismissal procedures have been modified effective immediately. In the event of a Tier-2 weather advisory, students enrolled in after-school programming will be relocated to the main gymnasium pending guardian pickup, which must occur no later than 4:45 PM. Guardians are required to update their emergency contact designations via the ParentPortal by Friday. Students without updated designations may not be released to unlisted individuals under any circumstances.`,
  medical: `AMOXICILLIN 500MG CAPSULES. Take one (1) capsule by mouth three times daily for ten (10) days until finished, with or without food. Complete the full course of therapy even if symptoms improve. Discontinue use and contact your prescriber immediately if you experience rash, difficulty breathing, or swelling of the face or throat. May decrease the efficacy of oral contraceptives. Store at room temperature away from moisture. Refills: 0.`,
};

let rawMarkdown = "";
let replacements = {};
let isRunning = false;
let currentUtterances = [];

// ---------- init ----------

fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    if (h.mode === "demo") {
      modeBadge.textContent = "Demo mode — responses are canned examples";
      modeBadge.hidden = false;
    }
  })
  .catch(() => {});

// ---------- input helpers ----------

document.querySelectorAll(".chip[data-sample]").forEach((btn) => {
  btn.addEventListener("click", () => {
    sourceText.value = SAMPLES[btn.dataset.sample] || "";
    sourceText.dispatchEvent(new Event("input"));
    sourceText.focus();
  });
});

let scanTimer = null;
sourceText.addEventListener("input", () => {
  const len = sourceText.value.length;
  charCount.textContent = `${len.toLocaleString()} character${len === 1 ? "" : "s"}`;
  clearTimeout(scanTimer);
  if (!len) {
    piiWarning.hidden = true;
    return;
  }
  scanTimer = setTimeout(scanForPII, 500);
});

async function scanForPII() {
  try {
    const r = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sourceText.value }),
    });
    if (!r.ok) return;
    const data = await r.json();
    if (data.count > 0) {
      const what = data.labels.map(labelName).join(", ");
      piiWarning.textContent = maskPiiBox.checked
        ? `🔒 ${data.count} personal detail${data.count === 1 ? "" : "s"} found (${what}) — will be hidden before sending`
        : `⚠️ ${data.count} personal detail${data.count === 1 ? "" : "s"} found (${what}) — masking is OFF`;
      piiWarning.hidden = false;
    } else {
      piiWarning.hidden = true;
    }
  } catch { /* scan is advisory only */ }
}

maskPiiBox.addEventListener("change", () => { if (sourceText.value) scanForPII(); });

function labelName(label) {
  return { EMAIL: "email", PHONE: "phone number", SSN: "ID number", ID_NUMBER: "ID number", CARD: "card number" }[label] || label.toLowerCase();
}

// Language select: show free-text input for "Other…"
languageSelect.addEventListener("change", () => {
  languageOther.hidden = languageSelect.value !== "__other__";
  if (!languageOther.hidden) languageOther.focus();
});

// Mode changes tweak the language label so translate feels first-class.
document.getElementById("mode-group").addEventListener("change", () => {
  const mode = getMode();
  languageLabel.textContent = mode === "translate" ? "Translate into" : "Language";
});

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function getLanguage() {
  return languageSelect.value === "__other__" ? languageOther.value.trim() : languageSelect.value;
}

// ---------- transform ----------

goBtn.addEventListener("click", transform);

async function transform() {
  if (isRunning) return;
  const text = sourceText.value.trim();
  if (!text) {
    setStatus("Paste some content first — or click one of the samples above.", true);
    sourceText.focus();
    return;
  }
  const mode = getMode();
  const language = getLanguage();
  if (mode === "translate" && !language) {
    setStatus("Choose a language to translate into.", true);
    languageOther.focus();
    return;
  }

  stopSpeaking();
  isRunning = true;
  rawMarkdown = "";
  replacements = {};
  goBtn.disabled = true;
  $("go-label").textContent = "Working…";
  outputEl.setAttribute("aria-busy", "true");
  outputEl.innerHTML = "";
  setStatus("Transforming your content…");
  setOutputDirection(language);
  setToolButtons(false);

  try {
    const resp = await fetch("/api/transform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        mode,
        level: levelSelect.value,
        language,
        format: formatSelect.value,
        maskPii: maskPiiBox.checked,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${resp.status})`);
    }

    await consumeSSE(resp.body, {
      meta(data) {
        replacements = data.replacements || {};
        if (data.piiMasked > 0) {
          setStatus(`Transforming… (${data.piiMasked} personal detail${data.piiMasked === 1 ? "" : "s"} hidden from the AI)`);
        }
      },
      delta(data) {
        rawMarkdown += data.text;
        renderOutput(true);
      },
      done() {
        rawMarkdown = restorePlaceholders(rawMarkdown);
        renderOutput(false);
        const restored = Object.keys(replacements).length;
        setStatus(restored > 0
          ? `Done. ${restored} personal detail${restored === 1 ? "" : "s"} were hidden from the AI and restored on your device.`
          : "Done.");
        setToolButtons(true);
      },
      error(data) {
        renderOutput(false);
        setStatus(data.message || "Something went wrong.", true);
        if (rawMarkdown) setToolButtons(true);
      },
    });
  } catch (err) {
    setStatus(err.message || "Could not reach the server.", true);
  } finally {
    isRunning = false;
    goBtn.disabled = false;
    $("go-label").textContent = "Transform";
    outputEl.setAttribute("aria-busy", "false");
  }
}

async function consumeSSE(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data && handlers[event]) {
        try { handlers[event](JSON.parse(data)); } catch { /* skip malformed frame */ }
      }
    }
  }
}

function restorePlaceholders(text) {
  let out = text;
  for (const [placeholder, original] of Object.entries(replacements)) {
    out = out.split(placeholder).join(original);
  }
  return out;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function setToolButtons(enabled) {
  speakBtn.disabled = !enabled;
  copyBtn.disabled = !enabled;
  clearBtn.disabled = !enabled;
}

function setOutputDirection(language) {
  const bcp = LANG_TO_BCP47[(language || "").toLowerCase()] || "";
  outputEl.dir = RTL_LANGS.has(bcp) ? "rtl" : "ltr";
  outputEl.lang = bcp || "en";
}

// ---------- markdown rendering (minimal, XSS-safe) ----------

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s) {
  return s
    .replace(/\[unclear:([^\]]*)\]/gi, '<span class="unclear-flag">⚠ unclear:$1</span>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, "$1<em>$2</em>");
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  const html = [];
  let list = null; // "ul" | "ol" | null

  const closeList = () => {
    if (list) { html.push(`</${list}>`); list = null; }
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    // Input is already HTML-escaped, so blockquote markers arrive as "&gt;".
    const bq = line.match(/^&gt;\s?(.*)/);

    if (h) {
      closeList();
      const tag = `h${Math.min(h[1].length + 1, 4)}`;
      html.push(`<${tag}>${inlineMd(h[2])}</${tag}>`);
    } else if (ul) {
      if (list !== "ul") { closeList(); html.push("<ul>"); list = "ul"; }
      html.push(`<li>${inlineMd(ul[1])}</li>`);
    } else if (ol) {
      if (list !== "ol") { closeList(); html.push("<ol>"); list = "ol"; }
      html.push(`<li>${inlineMd(ol[1])}</li>`);
    } else if (bq) {
      closeList();
      html.push(`<blockquote>${inlineMd(bq[1])}</blockquote>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  closeList();
  return html.join("\n");
}

function renderOutput(streaming) {
  outputEl.innerHTML = renderMarkdown(rawMarkdown) + (streaming ? '<span class="cursor" aria-hidden="true"></span>' : "");
}

// ---------- read aloud ----------

speakBtn.addEventListener("click", () => {
  if (speakBtn.getAttribute("aria-pressed") === "true") {
    stopSpeaking();
    return;
  }
  const plain = outputEl.innerText.trim();
  if (!plain || !("speechSynthesis" in window)) {
    setStatus("Read aloud is not supported in this browser.", true);
    return;
  }
  const lang = outputEl.lang || "en";
  const voice = pickVoice(lang);

  // Chunk by sentence groups — long single utterances get cut off in some browsers.
  const sentences = plain.match(/[^.!?\n]+[.!?]?\s*/g) || [plain];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > 200 && cur) { chunks.push(cur); cur = s; }
    else cur += s;
  }
  if (cur) chunks.push(cur);

  currentUtterances = chunks.map((chunk) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.lang = voice ? voice.lang : lang;
    if (voice) u.voice = voice;
    u.rate = 0.95;
    return u;
  });
  const last = currentUtterances[currentUtterances.length - 1];
  last.onend = stopSpeaking;
  last.onerror = stopSpeaking;

  speakBtn.setAttribute("aria-pressed", "true");
  speakBtn.textContent = "⏹ Stop reading";
  currentUtterances.forEach((u) => speechSynthesis.speak(u));
});

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === lang)
    || voices.find((v) => v.lang.startsWith(lang.split("-")[0]))
    || null;
}
// Some browsers populate voices asynchronously.
if ("speechSynthesis" in window) speechSynthesis.getVoices();

function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  currentUtterances = [];
  speakBtn.setAttribute("aria-pressed", "false");
  speakBtn.textContent = "🔊 Read aloud";
}

// ---------- copy & clear ----------

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(outputEl.innerText);
    setStatus("Copied to clipboard.");
  } catch {
    setStatus("Could not copy — select the text and copy manually.", true);
  }
});

clearBtn.addEventListener("click", () => {
  stopSpeaking();
  rawMarkdown = "";
  replacements = {};
  outputEl.innerHTML = '<p class="placeholder">The transformed version of your content will appear here.</p>';
  setStatus("");
  setToolButtons(false);
});

// ---------- font size ----------

let baseSize = 16;
$("font-inc").addEventListener("click", () => setFontSize(baseSize + 2));
$("font-dec").addEventListener("click", () => setFontSize(baseSize - 2));
function setFontSize(px) {
  baseSize = Math.min(24, Math.max(12, px));
  document.documentElement.style.setProperty("--base-size", baseSize + "px");
}

// Ctrl/Cmd+Enter submits from the textarea.
sourceText.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") transform();
});
