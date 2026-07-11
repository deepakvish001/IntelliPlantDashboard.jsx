import { test } from "node:test";
import assert from "node:assert/strict";
import { score } from "../lib/readability.js";

test("simple text scores a lower grade than bureaucratic text", () => {
  const hard = score(
    "Pursuant to the aforementioned regulations, continued disbursement of assistance payments is contingent upon expeditious submission of documentation verifying household income for the preceding period."
  );
  const easy = score(
    "You got this letter about your housing help. Send us proof of what you earn. Send it soon. If you do not, your payments may stop."
  );
  assert.ok(hard.gradeLevel > easy.gradeLevel, `${hard.gradeLevel} should be > ${easy.gradeLevel}`);
});

test("returns word counts and reading time", () => {
  const s = score("One two three four five six seven eight nine ten eleven twelve.");
  assert.equal(s.words, 12);
  assert.equal(s.readingTimeMin, 1);
});

test("no grade level for non-Latin text, but counts still work", () => {
  const s = score("यह पत्र आपके आवास लाभ के बारे में है। कृपया अपनी आय का प्रमाण भेजें। समय सीमा तीन मई है।");
  assert.equal(s.gradeLevel, null);
  assert.ok(s.words > 5);
});

test("handles empty and markdown input", () => {
  assert.equal(score("").words, 0);
  const s = score("## Heading\n\n- **Bold** point one here today\n- Point two is also here now");
  assert.ok(s.words >= 10);
});
