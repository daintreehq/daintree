/**
 * The Canopy reader on one screen: the published ONNX model's encoding and
 * decoding, ported from the reference `node/reader.ts` that ships with every
 * `daintreehq/canopy-reader-*` model and matched to it token for token. Pure:
 * the tokenizer and the ONNX session are handed in, so this runs in the
 * reader's utility process and in tests alike.
 */

export interface ReaderMeta {
  max_len: number;
  header_tokens: number;
  line_tokens: number;
  question_candidate_rows: number;
  status_candidate_rows: number;
  inputs: string[];
  outputs: string[];
  categories: string[];
  classes: Record<string, string[]>;
  thresholds: {
    summary_first: number;
    summary_more: number;
    option: number;
    gate: number;
    gate_categories: string[];
  };
}

/** Every input and output the reader is read through; a model missing any is refused. */
export const READER_INPUTS = [
  "input_ids",
  "attention_mask",
  "line_pos",
  "line_mask",
  "q_mask",
  "s_mask",
] as const;
export const READER_OUTPUTS = [
  "category",
  "needs_attention",
  "blocked_on_user",
  "notable",
  "tests",
  "changes",
  "risk",
  "instruction",
  "progress",
  "failure_repeats",
  "score",
  "question_line",
  "status_line",
  "summary_lines",
  "option_lines",
  "action_line",
  "task_line",
] as const;
const CLASS_HEADS = [
  "tests",
  "changes",
  "risk",
  "instruction",
  "progress",
  "failure_repeats",
  "score",
] as const;

/** Whether a model's `reader.json` is one this build can read. */
export function isReaderMeta(value: unknown): value is ReaderMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<ReaderMeta>;
  const numbers = [
    meta.max_len,
    meta.header_tokens,
    meta.line_tokens,
    meta.question_candidate_rows,
    meta.status_candidate_rows,
  ];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)) return false;
  if (!Array.isArray(meta.inputs) || !READER_INPUTS.every((i) => meta.inputs!.includes(i))) {
    return false;
  }
  if (!Array.isArray(meta.outputs) || !READER_OUTPUTS.every((o) => meta.outputs!.includes(o))) {
    return false;
  }
  if (!Array.isArray(meta.categories) || meta.categories.length === 0) return false;
  const classes = meta.classes;
  if (typeof classes !== "object" || classes === null) return false;
  if (!CLASS_HEADS.every((h) => Array.isArray(classes[h]) && classes[h].length > 0)) return false;
  const t = meta.thresholds;
  return (
    typeof t === "object" &&
    t !== null &&
    [t.summary_first, t.summary_more, t.option, t.gate].every((n) => typeof n === "number") &&
    Array.isArray(t.gate_categories)
  );
}

export interface Reading {
  category: string;
  category_probs: number[];
  /** Gated and rescaled: 0.5 and over means the screen needs the user. */
  needs_attention: number;
  needs_attention_raw: number;
  blocked_on_user: number;
  notable: number;
  /** Line indices into the screen's lines, -1 for none. */
  question_line: number;
  /** The headline. */
  status_line: number;
  action_line: number;
  task_line: number;
  /** Most important first. */
  summary_lines: number[];
  /** Screen order. */
  option_lines: number[];
  tests: string;
  changes: string;
  risk: string;
  instruction: string;
  progress: string;
  failure_repeats: string;
  score: string;
}

/** What the reader needs of a tokenizer: ids without special tokens, and a special token's id. */
export interface ReaderTokenizer {
  ids(text: string): number[];
  tokenId(token: string): number;
}

/** The encoded screen, as the model's six inputs take it. */
export interface ReaderFeeds {
  ids: number[];
  lineIndex: number[];
  linePos: number[];
  qMask: boolean[];
  sMask: boolean[];
}

/** The state header the model reads above the screen. */
export interface ReaderState {
  agent_program: string;
  terminal_title?: string;
  daintree_observed?: {
    agent_state?: string;
    waiting_reason?: string;
    seconds_in_state?: number;
  };
}

/** Python's len(): code points, not UTF-16 units. */
const cp = (s: string) => [...s].length;
/**
 * Python's str.strip() whitespace, which differs from JS `\s`: it includes
 * \x1c-\x1f and \x85 and excludes \ufeff. The model was trained in Python, so
 * blank-line skipping and candidate rows use the same set.
 */
const PY_WS =
  "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");
const strip = (s: string) => s.replace(STRIP, "");
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function softmax(xs: number[]): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

function argmax(xs: number[]): number {
  return xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);
}

export function lineCandidates(lines: readonly string[], rows: number): number[] {
  const start = Math.max(0, lines.length - rows);
  const out: number[] = [];
  for (let i = start; i < lines.length; i++) if (cp(strip(lines[i])) > 3) out.push(i);
  return out;
}

/** `[CLS] state-json [SEP]`, then `[i] line\n` pieces filled from the bottom up, then `[SEP]`. */
export function encodeScreen(
  meta: ReaderMeta,
  tok: ReaderTokenizer,
  state: ReaderState,
  lines: readonly string[]
): ReaderFeeds {
  const cls = tok.tokenId("[CLS]");
  const sep = tok.tokenId("[SEP]");
  const header = tok.ids(JSON.stringify(state)).slice(0, meta.header_tokens);
  let budget = meta.max_len - header.length - 3;
  const pieces: [number, number[]][] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!strip(lines[i])) continue;
    const piece = tok.ids(`[${i}] ${lines[i]}\n`).slice(0, meta.line_tokens);
    if (piece.length > budget) break;
    budget -= piece.length;
    pieces.push([i, piece]);
  }
  pieces.reverse();
  const ids = [cls, ...header, sep];
  const lineIndex: number[] = [];
  const linePos: number[] = [];
  for (const [i, piece] of pieces) {
    lineIndex.push(i);
    linePos.push(ids.length);
    for (const id of piece) ids.push(id);
  }
  ids.push(sep);
  const q = new Set(lineCandidates(lines, meta.question_candidate_rows));
  const s = new Set(lineCandidates(lines, meta.status_candidate_rows));
  return {
    ids,
    lineIndex,
    linePos,
    qMask: lineIndex.map((i) => q.has(i)),
    sMask: lineIndex.map((i) => s.has(i)),
  };
}

/** The model's outputs, by name, as plain numbers. */
export type ReaderOutputs = (name: string) => number[];

export function decodeReading(
  meta: ReaderMeta,
  arr: ReaderOutputs,
  idx: readonly number[],
  qMask: readonly boolean[]
): Reading {
  const m = idx.length;
  const t = meta.thresholds;
  const pick = (name: string) => {
    const scores = arr(name);
    const cand = [...scores.slice(0, m), scores[scores.length - 1]];
    const j = argmax(cand);
    return j === m ? -1 : idx[j];
  };
  const logit = arr("summary_lines").slice(0, m);
  const pSum = logit.map(sigmoid);
  // By logit: probabilities saturate and tie.
  const ranked = [...logit.keys()].sort((a, b) => logit[b] - logit[a] || a - b);
  const summary: number[] = [];
  for (const j of ranked.slice(0, 3)) {
    if (pSum[j] >= (summary.length ? t.summary_more : t.summary_first)) summary.push(idx[j]);
    else break;
  }
  const pOpt = arr("option_lines").slice(0, m).map(sigmoid);
  const probs = softmax(arr("category"));
  const raw = sigmoid(arr("needs_attention")[0]);
  const needs = t.gate_categories.reduce((a, c) => a + (probs[meta.categories.indexOf(c)] ?? 0), 0);
  const g = Math.max(raw, needs);
  const cls = (name: string) => meta.classes[name][argmax(arr(name))];
  return {
    category: meta.categories[argmax(probs)],
    category_probs: probs,
    needs_attention: g < t.gate ? (0.5 * g) / t.gate : 0.5 + (0.5 * (g - t.gate)) / (1 - t.gate),
    needs_attention_raw: raw,
    blocked_on_user: sigmoid(arr("blocked_on_user")[0]),
    notable: sigmoid(arr("notable")[0]),
    question_line: pick("question_line"),
    status_line: pick("status_line"),
    action_line: pick("action_line"),
    task_line: pick("task_line"),
    summary_lines: summary,
    option_lines: idx.filter((_, j) => qMask[j] && pOpt[j] >= t.option),
    tests: cls("tests"),
    changes: cls("changes"),
    risk: cls("risk"),
    instruction: cls("instruction"),
    progress: cls("progress"),
    failure_repeats: cls("failure_repeats"),
    score: cls("score"),
  };
}

// The card as Canopy shows it: line picks turned into clean text.

/** Bullets, tree and box glyphs, spinners, prompt markers, only with a space after: `**bold**` and `>file` survive. */
const LEAD = /^(?:[⏺•●✦⎿└├│┃║■✻✶✢✳✽✺·*❯›>▸▶◆◇](?:\s+|$))+/u;
const BOX_TAIL = /\s*[│┃║]\s*$/u;
const TIMER = /\s*\((?:\d[^)]*)?(?:esc to \w+|thinking|thought for|ctrl\+\w to \w+)[^)]*\)\s*$/iu;
const SENTENCE_END = /[.!?:;)"'`]$/u;

/** One screen line as card text: glyphs, borders and timers off, words kept. null when nothing is left. */
export function displayText(line: string | undefined): string | null {
  if (line == null) return null;
  const text = strip(line).replace(LEAD, "").replace(BOX_TAIL, "").replace(TIMER, "").trim();
  return cp(text) >= 2 ? text : null;
}

export interface ReaderCard {
  category: string;
  headline: string | null;
  /** Up to three, most important first; a sentence wrapped over lines is one entry. */
  summary: string[];
  question: string | null;
  options: string[];
  action: string | null;
  task: string | null;
}

/**
 * Does screen line `j` carry on the sentence of the line above it? Yes when it
 * was picked with it, or when it has no bullet of its own and starts in
 * lowercase or indented: an agent's own line break.
 */
function continues(lines: readonly string[], j: number, picks: readonly number[]): boolean {
  const next = lines[j];
  if (next == null || !strip(next)) return false;
  // A new bullet is a new item, even when it was picked too.
  if (LEAD.test(strip(next))) return false;
  if (picks.includes(j)) return true;
  return /^\s{2,}\S/u.test(next) || /^\p{Ll}/u.test(strip(next));
}

/** Line `i` as text, with up to two following lines joined when the sentence carries on over them. */
function sentenceAt(
  lines: readonly string[],
  i: number,
  picks: readonly number[],
  used: Set<number>
): string | null {
  let text = displayText(lines[i]);
  used.add(i);
  for (
    let j = i + 1;
    text && j <= i + 2 && !SENTENCE_END.test(text) && !used.has(j) && continues(lines, j, picks);
    j++
  ) {
    used.add(j);
    const more = displayText(lines[j]);
    if (more) text += " " + more;
  }
  return text;
}

export function readerCard(r: Reading, lines: readonly string[]): ReaderCard {
  const asks = r.category === "approval" || r.category === "question";
  const line = (i: number) => (i >= 0 ? displayText(lines[i]) : null);
  const used = new Set<number>();
  const headline =
    r.status_line >= 0 ? sentenceAt(lines, r.status_line, r.summary_lines, used) : null;
  const summary: string[] = [];
  for (const i of r.summary_lines) {
    if (used.has(i)) continue;
    const text = sentenceAt(lines, i, r.summary_lines, used);
    if (text) summary.push(text);
  }
  return {
    category: r.category,
    headline,
    summary,
    question: asks ? line(r.question_line) : null,
    options: asks
      ? r.option_lines.map((i) => displayText(lines[i])).filter((x): x is string => x !== null)
      : [],
    action: r.category === "approval" ? line(r.action_line) : null,
    task: line(r.task_line),
  };
}
