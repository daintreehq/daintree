import type { TourCaption, TourChapterTiming } from "./tourTypes";

const CUE_PATTERN = /\[\[([a-z0-9-]+)\]\]/g;

export interface ParsedNarration {
  /** Narration with cue markers removed — exactly what the voice reads. */
  text: string;
  words: string[];
  /** Cue id → index of the word it fires on. */
  cueWordIndex: Record<string, number>;
}

export function parseNarration(narration: string): ParsedNarration {
  const cueWordIndex: Record<string, number> = {};
  const words: string[] = [];
  let cursor = 0;
  for (const match of narration.matchAll(CUE_PATTERN)) {
    words.push(...splitWords(narration.slice(cursor, match.index)));
    const id = match[1]!;
    if (id in cueWordIndex) throw new Error(`Duplicate tour cue "${id}"`);
    cueWordIndex[id] = words.length;
    cursor = match.index! + match[0].length;
  }
  words.push(...splitWords(narration.slice(cursor)));
  for (const [id, index] of Object.entries(cueWordIndex)) {
    if (index >= words.length) throw new Error(`Tour cue "${id}" has no word after it`);
  }
  return { text: words.join(" "), words, cueWordIndex };
}

function splitWords(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

/** Stable short hash of the spoken text, so a manifest entry can be detected as stale. */
export function hashNarration(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Fingerprint of everything timing depends on: the spoken words and where each
 * cue sits among them. Moving or renaming a cue without touching a word still
 * invalidates the chapter's generated timing.
 */
export function narrationFingerprint(parsed: ParsedNarration): string {
  const cues = Object.entries(parsed.cueWordIndex)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, index]) => `${id}@${index}`)
    .join(",");
  return hashNarration(`${parsed.text}\n${cues}`);
}

const LEAD_IN = 0.3;
const TAIL = 0.8;

/**
 * Timing estimate used when there is no generated audio for a chapter (a fresh
 * script edit, or offline). Paced to a calm narration rate so scenes still
 * play sensibly on the silent clock.
 */
export function estimateWordStarts(words: string[]): { starts: number[]; duration: number } {
  const starts: number[] = [];
  let t = LEAD_IN;
  for (const word of words) {
    starts.push(t);
    t += 0.14 + 0.058 * word.replace(/[^\p{L}\p{N}]/gu, "").length;
    if (/[.!?]["')]?$/.test(word)) t += 0.45;
    else if (/[,;:]$/.test(word)) t += 0.2;
  }
  return { starts, duration: t + TAIL };
}

export interface WordAlignment {
  words: string[];
  wordStartTimeSeconds: number[];
  wordEndTimeSeconds: number[];
}

const alnum = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

export interface AlignedWords {
  starts: number[];
  /** How many narration words were pinned to a word the voice actually spoke. */
  matched: number;
}

/**
 * Map each narration word to a start time from a word alignment (TTS output or
 * a transcript of a real recording).
 *
 * Matching runs on letters and digits only, so it survives the engine
 * tokenizing punctuation and spacing differently from us. When the texts agree
 * exactly every word is pinned. When they don't — a transcript that heard
 * "weight" for "wait", a number spelled out — a longest-common-subsequence
 * alignment keeps every word that does match on its real timestamp and
 * interpolates only the ones that don't, so one mishearing can't move a cue
 * seconds away from its word.
 */
export function alignWordStarts(words: string[], alignment: WordAlignment): AlignedWords {
  const ours = words.map(alnum);
  const tokens = alignment.words.map(alnum);

  if (tokens.join("") === ours.join("") && ours.join("").length > 0) {
    const tokenAt: number[] = [];
    tokens.forEach((tok, i) => {
      for (let c = 0; c < tok.length; c++) tokenAt.push(i);
    });
    let offset = 0;
    const starts = ours.map((word) => {
      const start = alignment.wordStartTimeSeconds[tokenAt[offset] ?? tokenAt.length - 1] ?? 0;
      offset += word.length;
      return start;
    });
    return { starts, matched: words.length };
  }

  const spoken = tokens
    .map((text, i) => ({
      text,
      start: alignment.wordStartTimeSeconds[i] ?? 0,
      end: alignment.wordEndTimeSeconds[i] ?? 0,
    }))
    .filter((token) => token.text.length > 0);

  // LCS table over whole words.
  const n = ours.length;
  const m = spoken.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        ours[i] && ours[i] === spoken[j]!.text
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pinned: (number | null)[] = new Array<number | null>(n).fill(null);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ours[i] && ours[i] === spoken[j]!.text) {
      pinned[i] = spoken[j]!.start;
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }

  const matched = pinned.filter((t) => t !== null).length;
  const spanStart = spoken[0]?.start ?? 0;
  const spanEnd = spoken[m - 1]?.end ?? spanStart;
  const starts = pinned.map((time, i) => {
    if (time !== null) return time;
    let before = i - 1;
    while (before >= 0 && pinned[before] === null) before--;
    let after = i + 1;
    while (after < n && pinned[after] === null) after++;
    const from = before >= 0 ? pinned[before]! : spanStart;
    const to = after < n ? pinned[after]! : spanEnd;
    const fromIndex = before >= 0 ? before : -1;
    const toIndex = after < n ? after : n;
    return from + ((i - fromIndex) / (toIndex - fromIndex)) * (to - from);
  });
  return { starts, matched };
}

export function buildCaptions(words: string[], starts: number[], duration: number): TourCaption[] {
  const captions: TourCaption[] = [];
  let begin = 0;
  for (let i = 0; i < words.length; i++) {
    const isEnd = /[.!?]["')]?$/.test(words[i]!) || i === words.length - 1;
    if (!isEnd) continue;
    captions.push({ start: starts[begin]!, end: 0, text: words.slice(begin, i + 1).join(" ") });
    begin = i + 1;
  }
  captions.forEach((caption, i) => {
    caption.end = captions[i + 1]?.start ?? duration;
  });
  return captions;
}

export function buildTiming(
  parsed: ParsedNarration,
  starts: number[],
  duration: number,
  audioUrl: string | null
): TourChapterTiming {
  const cues: Record<string, number> = {};
  for (const [id, index] of Object.entries(parsed.cueWordIndex)) {
    cues[id] = starts[index]!;
  }
  return { duration, cues, captions: buildCaptions(parsed.words, starts, duration), audioUrl };
}

export function estimateTiming(narration: string): TourChapterTiming {
  const parsed = parseNarration(narration);
  const { starts, duration } = estimateWordStarts(parsed.words);
  return buildTiming(parsed, starts, duration, null);
}
