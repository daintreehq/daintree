/**
 * Where a long dictation may be cut, so the part before the cut is cleaned up
 * while the speaker goes on (#14772). A cut sits at a natural break, a spoken
 * paragraph break or a pause, and is only taken once what was said after it
 * shows the speaker isn't reaching back over it: a self-correction ("no wait,
 * the other one"), a counted list carried on across the break, and a list's
 * introduction with its first item have to reach cleanup in one piece.
 */

// Openings that take back what came before the break.
const RETRACTION_OPENING_RE =
  /^(?:no|nope|nah|wait|actually|sorry|oops|rather|or|instead|correction|i mean|i meant|scratch that|strike that|make that|not that|never ?mind|hold on|hang on|let me rephrase|change that)\b/u;

// Openings that carry on a list, or a thought the break cut in two.
const CONTINUATION_OPENING_RE =
  /^(?:and|also|then|next|plus|another|first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth|sixth|seventh|eighth|ninth|tenth|finally|lastly|last|two|three|four|five|six|seven|eight|nine|ten|number|step|item|point|bullet|\d+)\b/u;

// A last sentence that counts out an item: the list may still go on.
const COUNTED_ITEM_RE =
  /^(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|then|one|two|three|four|five|six|seven|eight|nine|ten|step|number|item|point|bullet|\d+)\b/u;

// A last sentence that says how many things are coming, so the first of them
// follows even without a counting word: "we need three things."
const ANNOUNCED_COUNT_RE =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|[2-9]|[1-9]\d+|a couple(?: of)?)\b(?: [\p{L}][\p{L}'’-]*){0,2} (?:things|problems|issues|bugs|reasons|steps|options|questions|items|points|tasks|changes|requirements|ways|ideas|goals|topics|concerns|features)\b/u;

const SENTENCE_END_RE = /[.!?…]["'”’)\]]*$/u;

/** The words as a cue is matched: lower case, from the first letter or digit, single-spaced. */
function opening(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ");
}

function lastSentence(text: string): string {
  const body = text.trim().replace(SENTENCE_END_RE, "");
  const sentences = body.split(/[.!?…]["'”’)\]]*\s+|\n+/u);
  return sentences[sentences.length - 1] ?? "";
}

/**
 * Whether enough has been said after a break to judge it: a few words, or a
 * whole sentence. A cue split across two of the transcriber's segments ("I" /
 * "mean…") is read once both are in.
 */
export function chunkFollowUpDecides(after: string): boolean {
  const text = after.trim();
  return text.split(/\s+/).length >= 3 || SENTENCE_END_RE.test(text);
}

/**
 * Whether the dictation may be cut between `before`, the passage that ends at
 * the break, and `after`, what was said next. A pause has to come after a
 * finished sentence; a spoken paragraph break already ends one.
 */
export function mayCutChunk(before: string, after: string, paragraph: boolean): boolean {
  const text = before.trim();
  if (!text || text.endsWith(":")) return false;
  if (!paragraph && !SENTENCE_END_RE.test(text)) return false;
  const last = opening(lastSentence(text));
  if (COUNTED_ITEM_RE.test(last) || ANNOUNCED_COUNT_RE.test(last)) return false;
  const next = opening(after);
  if (!next) return false;
  return !RETRACTION_OPENING_RE.test(next) && !CONTINUATION_OPENING_RE.test(next);
}
