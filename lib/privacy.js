// PII detection and masking.
//
// Runs on the server as a backstop even though the UI offers client-side
// masking, so raw identifiers never reach the model when masking is on.
// Regex-based detection is intentionally conservative: it targets patterns
// that are almost always sensitive (emails, phone numbers, government ID
// shapes, card numbers) and leaves ordinary numbers alone.

const PATTERNS = [
  { label: "EMAIL", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // Card numbers: 13-19 digits allowing space/dash separators, validated with Luhn below.
  { label: "CARD", re: /\b(?:\d[ -]?){13,19}\b/g, validate: luhnValid },
  // US SSN shape 123-45-6789 (dashes required, to avoid matching plain 9-digit numbers).
  { label: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Aadhaar shape: 4-4-4 digits with space or dash separators.
  { label: "ID_NUMBER", re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g },
  // Phone numbers: international or local, at least 8 digits total.
  {
    label: "PHONE",
    re: /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]?\d{3,4}(?:[ -]?\d{2,4})?/g,
    validate: (s) => s.replace(/\D/g, "").length >= 8 && s.replace(/\D/g, "").length <= 15,
  },
];

function luhnValid(s) {
  const digits = s.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Find PII spans in `text`. Returns [{label, start, end, match}] sorted by start,
 * with overlapping spans merged (first pattern wins).
 */
export function detectPII(text) {
  const found = [];
  for (const { label, re, validate } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].trim().length === 0) continue;
      if (validate && !validate(m[0])) continue;
      found.push({ label, start: m.index, end: m.index + m[0].length, match: m[0] });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  let lastEnd = -1;
  for (const span of found) {
    if (span.start >= lastEnd) {
      merged.push(span);
      lastEnd = span.end;
    }
  }
  return merged;
}

/**
 * Replace detected PII with numbered placeholders like [EMAIL-1].
 * Returns {masked, replacements} where replacements maps placeholder -> original,
 * so the UI can restore the values locally after the model responds.
 */
export function maskPII(text) {
  const spans = detectPII(text);
  if (spans.length === 0) return { masked: text, replacements: {} };

  const counters = {};
  const replacements = {};
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    counters[span.label] = (counters[span.label] || 0) + 1;
    const placeholder = `[${span.label}-${counters[span.label]}]`;
    replacements[placeholder] = span.match;
    out += text.slice(cursor, span.start) + placeholder;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { masked: out, replacements };
}
