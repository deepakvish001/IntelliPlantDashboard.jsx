// Readability metrics — used to show the judge-friendly "grade 14 → grade 5"
// improvement between the source document and the transformed output.
//
// Flesch-Kincaid is only meaningful for Latin-script languages with roughly
// English-like syllable structure, so score() returns null metrics for text
// that is mostly non-Latin (Hindi, Arabic, Chinese, ...). Word counts and
// reading time are still returned for every language.

const AVG_WPM = 200; // adult silent-reading speed

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function isMostlyLatin(text) {
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  const latin = text.match(/[A-Za-zÀ-ɏ]/g) || [];
  return latin.length / letters.length > 0.7;
}

/**
 * Compute readability metrics for a piece of text (markdown allowed —
 * structural characters are stripped first).
 *
 * Returns { words, sentences, readingTimeMin, gradeLevel|null }.
 */
export function score(text) {
  const plain = String(text || "")
    .replace(/\[unclear:[^\]]*\]/gi, " ")
    .replace(/[#*_`>|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = plain ? plain.split(" ").filter(Boolean) : [];
  const sentenceCount = Math.max(1, (plain.match(/[.!?။。۔]+(\s|$)/g) || []).length || (words.length ? 1 : 0));
  const readingTimeMin = words.length ? Math.max(1, Math.round(words.length / AVG_WPM)) : 0;

  let gradeLevel = null;
  if (words.length >= 10 && isMostlyLatin(plain)) {
    const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
    // Flesch-Kincaid grade level
    const fk = 0.39 * (words.length / sentenceCount) + 11.8 * (syllables / words.length) - 15.59;
    gradeLevel = Math.max(0, Math.round(fk * 10) / 10);
  }

  return { words: words.length, sentences: sentenceCount, readingTimeMin, gradeLevel };
}
