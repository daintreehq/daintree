import { findProtectedRanges } from "./voiceProtectedSpans.js";
import type { VoiceTextEdit } from "./voiceUncertainWords.js";

const WORD = "[\\p{L}\\p{N}\\p{M}_]";
// Characters that join two words into one token: "um-hm", "um.js", "um/foo".
const JOINER = "[-'’./\\\\]";
const BEFORE = `(?<!${WORD})(?<!${WORD}${JOINER})`;
const AFTER = `(?!${WORD})(?!${JOINER}${WORD})`;
// um, umm, uh, uhh, uhm and erm, with any stretch of the vowel or the hum.
// "hmm" and "mm" can answer a question, so they are left for cleanup.
const SOUND = "(?:u+[hm]+|e+rm+)";
const HESITATION = `${BEFORE}${SOUND}${AFTER}`;
// What a run of hesitations may be strung together with: "Uh, um, so".
const BETWEEN = "(?:[^\\S\\r\\n]|[,;:.!?…—–])+";
const CLUSTER_RE = new RegExp(`${HESITATION}(?:${BETWEEN}${HESITATION})*`, "giu");

const PAUSE_RE = /[,;:—–]/u;
const TERMINATOR_RE = /[.!?…]/u;
const RUN_CHAR_RE = /[,;:.!?…—–]/u;
const OPENER_RE = /[(["'“‘{]/u;
const HORIZONTAL_SPACE_RE = /[^\S\r\n]/u;
const LINE_BREAK_RE = /[\r\n]/u;
// "iPhone", "eBay": capitalising the first letter would misspell the word.
const INTERNAL_CAPITAL_RE = /^\p{Ll}\S*\p{Lu}/u;
// "UM" and "UH" are as likely to be an acronym as a sound.
const ACRONYMS = new Set(["UM", "UH"]);

/**
 * Drops hesitation sounds from dictated text and tidies what they leave
 * behind: the comma a pause left, the space either side, and the capital the
 * next word takes when "Um," opened the sentence. Whole words only, so "umbrella",
 * "um-hm" and `um.js` stay, as does anything in code, a path, a URL or a flag.
 * Words that can carry meaning ("like", "so", "you know") are not touched.
 * With `edits`, each change is pushed onto it in order, in the coordinates of
 * `text`.
 */
export function stripHesitations(text: string, edits?: VoiceTextEdit[]): string {
  let ranges: ReturnType<typeof findProtectedRanges> | null = null;
  let out = "";
  let copied = 0;
  CLUSTER_RE.lastIndex = 0;
  for (let match = CLUSTER_RE.exec(text); match; match = CLUSTER_RE.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (ACRONYMS.has(/^\p{L}+/u.exec(match[0])![0])) continue;
    ranges ??= findProtectedRanges(text);
    if (ranges.some((range) => range.start < end && range.end > start)) continue;

    let runEnd = end;
    while (runEnd < text.length && RUN_CHAR_RE.test(text[runEnd]!)) runEnd++;
    const run = text.slice(end, runEnd);
    let next = runEnd;
    while (next < text.length && HORIZONTAL_SPACE_RE.test(text[next]!)) next++;
    const atEnd = next >= text.length || LINE_BREAK_RE.test(text[next]!);

    let spaceStart = start;
    while (spaceStart > 0 && HORIZONTAL_SPACE_RE.test(text[spaceStart - 1]!)) spaceStart--;
    const prev = spaceStart > 0 ? text[spaceStart - 1]! : "";
    const atStart = prev === "" || LINE_BREAK_RE.test(prev);
    const opens = spaceStart === start && OPENER_RE.test(prev);
    const afterPause = PAUSE_RE.test(prev);
    const terminators = run.replace(/[,;:—–]/gu, "");

    let from = start;
    let to = next;
    let insert = "";
    let capitalise = false;
    if (atStart || opens || TERMINATOR_RE.test(prev)) {
      // Opens a sentence, so what follows takes its place.
      if (atEnd && !atStart) from = spaceStart;
      capitalise = !atEnd && /^\p{Lu}/u.test(match[0]);
    } else if (atEnd) {
      from = afterPause ? spaceStart - 1 : spaceStart;
      insert = terminators;
    } else if (terminators) {
      from = afterPause ? spaceStart - 1 : spaceStart;
      to = runEnd;
      insert = terminators;
    } else if (!afterPause && run) {
      from = spaceStart;
      to = end;
    }
    from = Math.max(from, copied);

    if (capitalise) {
      const upper = upperFirst(text, next, ranges);
      if (upper) {
        to = next + upper.length;
        insert = upper.text;
      }
    }
    out += text.slice(copied, from) + insert;
    edits?.push({ from, to, insert });
    copied = to;
    CLUSTER_RE.lastIndex = Math.max(CLUSTER_RE.lastIndex, to);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

function upperFirst(
  text: string,
  at: number,
  ranges: readonly { start: number; end: number }[]
): { text: string; length: number } | null {
  const first = String.fromCodePoint(text.codePointAt(at) ?? 0x20);
  if (!/^\p{Ll}$/u.test(first)) return null;
  if (INTERNAL_CAPITAL_RE.test(text.slice(at, at + 64).split(/\s/u, 1)[0]!)) return null;
  if (ranges.some((range) => range.start <= at && range.end > at)) return null;
  return { text: first.toUpperCase(), length: first.length };
}
