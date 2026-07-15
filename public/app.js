"use strict";

const $ = (id) => document.getElementById(id);

const sourceText = $("source-text");
const charCount = $("char-count");
const piiWarning = $("pii-warning");
const maskPiiBox = $("mask-pii");
const saveHistoryBox = $("save-history");
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
const compareBtn = $("compare");
const downloadBtn = $("download");
const printBtn = $("print");
const modeBadge = $("mode-badge");
const metricsEl = $("metrics");
const compareWrap = $("compare-wrap");
const originalCol = $("original-col");
const originalView = $("original-view");
const resultColTitle = $("result-col-title");
const askBox = $("ask-box");
const askInput = $("ask-input");
const askBtn = $("ask-btn");
const askOutput = $("ask-output");
const historyDrawer = $("history-drawer");
const historyToggle = $("history-toggle");
const historyList = $("history-list");
const historyEmpty = $("history-empty");
const toastEl = $("toast");

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
let lastSourceText = "";
let isRunning = false;
let currentUtterances = [];
let toastTimer = null;

// ---------- init ----------

fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    // Always surface which backend is running (demo / Gemini / Claude / unconfigured).
    if (h.providerLabel) {
      modeBadge.textContent = h.providerLabel;
      modeBadge.hidden = false;
      modeBadge.classList.toggle("badge-ok", h.mode === "live");
    }
  })
  .catch(() => {});

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

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

// File upload + drag & drop (.txt/.md)
$("file-input").addEventListener("change", (e) => loadFile(e.target.files[0]));
const dropZone = $("drop-zone");
["dragenter", "dragover"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); }));
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag-over"); }));
dropZone.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

function loadFile(file) {
  if (!file) return;
  if (file.size > 300_000) { toast("File too large — 300 KB max."); return; }
  if (!/\.(txt|md)$/i.test(file.name) && !file.type.startsWith("text/")) {
    toast("Only plain-text files (.txt, .md) are supported.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    sourceText.value = String(reader.result);
    sourceText.dispatchEvent(new Event("input"));
    toast(`Loaded ${file.name}`);
  };
  reader.readAsText(file);
}

// Voice input (dictation)
const micBtn = $("mic-btn");
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
if (!SR) micBtn.hidden = true;
micBtn.addEventListener("click", () => {
  if (recognizer) { recognizer.stop(); return; }
  recognizer = new SR();
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        sourceText.value += (sourceText.value && !sourceText.value.endsWith(" ") ? " " : "") + e.results[i][0].transcript;
      }
    }
    sourceText.dispatchEvent(new Event("input"));
  };
  recognizer.onend = () => {
    recognizer = null;
    micBtn.setAttribute("aria-pressed", "false");
    micBtn.textContent = "🎤 Speak";
  };
  recognizer.onerror = () => toast("Voice input is not available right now.");
  recognizer.start();
  micBtn.setAttribute("aria-pressed", "true");
  micBtn.textContent = "⏹ Stop";
});

// Language select: show free-text input for "Other…"
languageSelect.addEventListener("change", () => {
  languageOther.hidden = languageSelect.value !== "__other__";
  if (!languageOther.hidden) languageOther.focus();
});

document.getElementById("mode-group").addEventListener("change", () => {
  languageLabel.textContent = getMode() === "translate" ? "Translate into" : "Language";
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
  lastSourceText = text;
  goBtn.disabled = true;
  $("go-label").textContent = "Working…";
  outputEl.setAttribute("aria-busy", "true");
  outputEl.innerHTML = "";
  askOutput.hidden = true;
  metricsEl.hidden = true;
  ["metric-grade", "metric-time", "metric-words", "metric-privacy"].forEach((id) => { $(id).hidden = true; });
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
        saveHistory: saveHistoryBox.checked,
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
      metrics(data) {
        showMetrics(data);
        if (data.historyId) loadHistory();
      },
      done(data) {
        rawMarkdown = restorePlaceholders(rawMarkdown);
        renderOutput(false);
        const restored = Object.keys(replacements).length;
        setStatus(restored > 0
          ? `Done. ${restored} personal detail${restored === 1 ? "" : "s"} were hidden from the AI and restored on your device.`
          : "Done.");
        setToolButtons(true);
        askBox.hidden = false;
        if (data && data.truncated) toast("Output reached the length limit — it may be slightly cut off.");
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

function showMetrics({ before, after }) {
  let any = false;
  if (before?.gradeLevel != null && after?.gradeLevel != null) {
    const dir = after.gradeLevel <= before.gradeLevel ? "↓" : "↑";
    $("metric-grade").textContent = `📖 Reading level: grade ${before.gradeLevel} → grade ${after.gradeLevel} ${dir}`;
    $("metric-grade").hidden = false;
    any = true;
  }
  if (after?.readingTimeMin) {
    $("metric-time").textContent = `⏱ ${after.readingTimeMin} min read`;
    $("metric-time").hidden = false;
    any = true;
  }
  if (before?.words && after?.words) {
    $("metric-words").textContent = `✂ ${before.words.toLocaleString()} → ${after.words.toLocaleString()} words`;
    $("metric-words").hidden = false;
    any = true;
  }
  const masked = Object.keys(replacements).length;
  if (masked > 0) {
    $("metric-privacy").textContent = `🔒 ${masked} detail${masked === 1 ? "" : "s"} kept private`;
    $("metric-privacy").hidden = false;
    any = true;
  }
  metricsEl.hidden = !any;
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
  [speakBtn, copyBtn, clearBtn, compareBtn, downloadBtn, printBtn].forEach((b) => { b.disabled = !enabled; });
}

function setOutputDirection(language) {
  const bcp = LANG_TO_BCP47[(language || "").toLowerCase()] || "";
  outputEl.dir = RTL_LANGS.has(bcp) ? "rtl" : "ltr";
  outputEl.lang = bcp || "en";
  askOutput.dir = outputEl.dir;
  askOutput.lang = outputEl.lang;
}

// ---------- ask about this document ----------

askBtn.addEventListener("click", ask);
askInput.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });

let askRunning = false;
async function ask() {
  if (askRunning) return;
  const question = askInput.value.trim();
  if (!question) { askInput.focus(); return; }
  if (!lastSourceText) return;

  askRunning = true;
  askBtn.disabled = true;
  askOutput.hidden = false;
  askOutput.innerHTML = "";
  let askMd = "";
  let askRepl = {};

  try {
    const resp = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: lastSourceText,
        question,
        language: getLanguage(),
        maskPii: maskPiiBox.checked,
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${resp.status})`);
    }
    await consumeSSE(resp.body, {
      meta(data) { askRepl = data.replacements || {}; },
      delta(data) {
        askMd += data.text;
        askOutput.innerHTML = renderMarkdown(askMd) + '<span class="cursor" aria-hidden="true"></span>';
      },
      done() {
        for (const [ph, orig] of Object.entries(askRepl)) askMd = askMd.split(ph).join(orig);
        askOutput.innerHTML = renderMarkdown(askMd);
      },
      error(data) {
        askOutput.innerHTML = renderMarkdown(askMd);
        toast(data.message || "Could not answer.");
      },
    });
  } catch (err) {
    toast(err.message || "Could not reach the server.");
  } finally {
    askRunning = false;
    askBtn.disabled = false;
  }
}

// ---------- compare view ----------

compareBtn.addEventListener("click", () => {
  const on = compareBtn.getAttribute("aria-pressed") !== "true";
  compareBtn.setAttribute("aria-pressed", String(on));
  compareWrap.classList.toggle("split", on);
  originalCol.hidden = !on;
  resultColTitle.hidden = !on;
  if (on) originalView.textContent = lastSourceText;
});

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
if ("speechSynthesis" in window) speechSynthesis.getVoices();

function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  currentUtterances = [];
  speakBtn.setAttribute("aria-pressed", "false");
  speakBtn.textContent = "🔊 Read aloud";
}

// ---------- copy / download / print / clear ----------

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(outputEl.innerText);
    toast("Copied to clipboard.");
  } catch {
    toast("Could not copy — select the text and copy manually.");
  }
});

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([rawMarkdown], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "accessible-version.md";
  a.click();
  URL.revokeObjectURL(a.href);
});

printBtn.addEventListener("click", () => window.print());

clearBtn.addEventListener("click", () => {
  stopSpeaking();
  rawMarkdown = "";
  replacements = {};
  outputEl.innerHTML = '<p class="placeholder">The transformed version of your content will appear here.</p>';
  metricsEl.hidden = true;
  askBox.hidden = true;
  askOutput.hidden = true;
  if (compareBtn.getAttribute("aria-pressed") === "true") compareBtn.click();
  setStatus("");
  setToolButtons(false);
});

// ---------- history ----------

historyToggle.addEventListener("click", () => {
  const open = historyDrawer.hidden;
  historyDrawer.hidden = !open;
  historyToggle.setAttribute("aria-expanded", String(open));
  if (open) loadHistory();
});
$("history-close").addEventListener("click", () => {
  historyDrawer.hidden = true;
  historyToggle.setAttribute("aria-expanded", "false");
});
$("history-clear").addEventListener("click", async () => {
  if (!confirm("Delete all saved history on this device?")) return;
  await fetch("/api/history", { method: "DELETE" });
  loadHistory();
  toast("History deleted.");
});

async function loadHistory() {
  try {
    const r = await fetch("/api/history");
    const { items } = await r.json();
    historyList.innerHTML = "";
    historyEmpty.hidden = items.length > 0;
    for (const item of items) {
      historyList.appendChild(renderHistoryItem(item));
    }
  } catch { /* drawer is best-effort */ }
}

function renderHistoryItem(item) {
  const li = document.createElement("li");
  li.className = "history-item";

  const meta = document.createElement("div");
  meta.className = "h-meta";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = item.mode;
  meta.appendChild(tag);
  const when = document.createElement("span");
  when.textContent = new Date(item.created_at).toLocaleString();
  meta.appendChild(when);
  if (item.grade_before != null && item.grade_after != null) {
    const g = document.createElement("span");
    g.textContent = `grade ${item.grade_before} → ${item.grade_after}`;
    meta.appendChild(g);
  }

  const preview = document.createElement("p");
  preview.className = "h-preview";
  preview.textContent = item.preview;

  const actions = document.createElement("div");
  actions.className = "h-actions";
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "tool-btn";
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", () => openHistoryItem(item.id));
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "tool-btn danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", async () => {
    await fetch(`/api/history/${item.id}`, { method: "DELETE" });
    loadHistory();
  });
  actions.append(openBtn, delBtn);

  li.append(meta, preview, actions);
  return li;
}

async function openHistoryItem(id) {
  const r = await fetch(`/api/history/${id}`);
  if (!r.ok) return;
  const row = await r.json();
  // Stored source is the masked version — that is what we restore (privacy-preserving).
  sourceText.value = row.source_masked;
  sourceText.dispatchEvent(new Event("input"));
  lastSourceText = row.source_masked;
  rawMarkdown = row.output;
  replacements = {};
  setOutputDirection(row.language);
  renderOutput(false);
  showMetrics({
    before: { gradeLevel: row.grade_before, words: row.words_before, readingTimeMin: 0 },
    after: { gradeLevel: row.grade_after, words: row.words_after, readingTimeMin: row.words_after ? Math.max(1, Math.round(row.words_after / 200)) : 0 },
  });
  setToolButtons(true);
  askBox.hidden = false;
  historyDrawer.hidden = true;
  historyToggle.setAttribute("aria-expanded", "false");
  setStatus("Loaded from history (personal details stay masked in saved copies).");
  document.querySelector(".output-panel").scrollIntoView({ behavior: "smooth" });
}

// ---------- font size / shortcuts ----------

let baseSize = 16;
$("font-inc").addEventListener("click", () => setFontSize(baseSize + 2));
$("font-dec").addEventListener("click", () => setFontSize(baseSize - 2));
function setFontSize(px) {
  baseSize = Math.min(24, Math.max(12, px));
  document.documentElement.style.setProperty("--base-size", baseSize + "px");
}

sourceText.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") transform();
});
