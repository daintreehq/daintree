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
    /** The bar for a card's second line, in models with a summary-only card. */
    second?: number;
    /** `summary-only`: no headline, at most two card lines. Absent in older models. */
    card?: string;
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

/**
 * Which weights file an install holds: the precision its manifest records, or
 * failing that whichever file is there (a manifest lost or unreadable must
 * not point a reader at INT8 weights that were never downloaded).
 */
export function chooseWeightsFile(manifest: unknown, files: readonly string[]): string | null {
  const recorded =
    typeof manifest === "object" && manifest !== null && "weights" in manifest
      ? (manifest as { weights?: unknown }).weights
      : undefined;
  for (const precision of recorded === "fp32"
    ? ["fp32", "int8"]
    : recorded === "int8"
      ? ["int8", "fp32"]
      : ["fp32", "int8"]) {
    const name = `model.${precision}.onnx`;
    if (files.includes(name)) return name;
  }
  return null;
}

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
    Array.isArray(t.gate_categories) &&
    // A card mode this build doesn't know is one it can't show.
    (t.card === undefined ||
      t.card === "headline" ||
      (t.card === "summary-only" && typeof t.second === "number"))
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
  /** The best line on screen: a summary-only card's line one, an older model's headline. */
  status_line: number;
  action_line: number;
  task_line: number;
  /** Most important first. */
  summary_lines: number[];
  /** A summary-only card's lines: line one, then line two when it reads over the bar. */
  card_lines: number[];
  /** `summary-only` for models trained for it, else `headline`. */
  card_mode: string;
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
  const first = pick("status_line");
  const cardLines = first >= 0 ? [first] : [];
  if (typeof t.second === "number") {
    const second = t.second;
    const next = ranked.find((j) => idx[j] !== first && pSum[j] >= second);
    if (next !== undefined) cardLines.push(idx[next]);
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
    status_line: first,
    action_line: pick("action_line"),
    task_line: pick("task_line"),
    summary_lines: summary,
    card_lines: cardLines,
    card_mode: t.card ?? "headline",
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
const LEAD = new RegExp(`^(?:[⏺•●✦⎿└├│┃║■✻✶✢✳✽✺·*❯›>▸▶◆◇-](?:[${PY_WS}]+|$))+`, "u");
const BOX_TAIL = new RegExp(`[${PY_WS}]*[│┃║][${PY_WS}]*$`, "u");
const TIMER = new RegExp(
  `[${PY_WS}]*\\((?:\\d[^)]*)?(?:esc to \\w+|thinking|thought for|ctrl\\+\\w to \\w+)[^)]*\\)[${PY_WS}]*$`,
  "iu"
);
const SENTENCE_END = /[.!?:;)"'`]$/u;
const INDENTED = new RegExp(`^[${PY_WS}]{2,}[^${PY_WS}]`, "u");

/** One screen line as card text: glyphs, borders and timers off, words kept. null when nothing is left. */
export function displayText(line: string | undefined): string | null {
  if (line == null) return null;
  const text = strip(strip(line).replace(LEAD, "").replace(BOX_TAIL, "").replace(TIMER, ""));
  return cp(text) >= 2 ? text : null;
}

export interface ReaderCard {
  category: string;
  /** An older model's headline; null on a summary-only card, whose title is the terminal's. */
  headline: string | null;
  /**
   * The card's lines: on a summary-only card at most two, in the order shown;
   * on an older model up to three, most important first. A sentence wrapped
   * over lines is one entry.
   */
  summary: string[];
  question: string | null;
  options: string[];
  action: string | null;
  task: string | null;
}

/** A one-character fragment `displayText` drops for length (a lone "1"), not text the cleanup removed. */
function short(line: string): string | null {
  const t = strip(line);
  return cp(t) === 1 ? t : null;
}

/** Does line `cur` carry on the sentence of `prev`, the agent having wrapped it onto a new row? */
function continuesFrom(prev: string, cur: string): boolean {
  if (!strip(prev) || !strip(cur) || LEAD.test(strip(cur))) return false;
  const before = displayText(prev);
  if (!before || SENTENCE_END.test(before)) return false;
  return INDENTED.test(cur) || /^\p{Lowercase}/u.test(strip(cur)) || /^[([{'"`]/u.test(strip(cur));
}

/**
 * Line `i` as a whole sentence: back to where a wrapped sentence starts and on
 * to where it ends, up to four rows each way. A new bullet is always a new item.
 */
function sentenceAt(
  lines: readonly string[],
  i: number,
  picks: readonly number[],
  used: Set<number>
): string | null {
  let k = i;
  while (k > 0 && i - k < 4 && !used.has(k - 1) && continuesFrom(lines[k - 1]!, lines[k]!)) k--;
  for (let x = k; x <= i; x++) used.add(x);
  let text: string | null =
    lines
      .slice(k, i + 1)
      .map((x, n) => displayText(x) ?? (k + n !== i ? short(x) : null))
      .filter((x): x is string => !!x)
      .join(" ") || null;
  for (
    let j = i + 1;
    text && j <= i + 4 && j < lines.length && !SENTENCE_END.test(text) && !used.has(j);
    j++
  ) {
    const next = lines[j]!;
    if (!strip(next) || LEAD.test(strip(next))) break;
    if (!picks.includes(j) && !continuesFrom(lines[j - 1]!, next)) break;
    used.add(j);
    // A one-character fragment ("1") the sentence carries on into is kept.
    const more = displayText(next) ?? short(next);
    if (more) text += " " + more;
  }
  return text;
}

/** Picks as text, in the order given, each a whole sentence where it wraps. */
function summaryText(
  lines: readonly string[],
  picks: readonly number[],
  used: Set<number>
): string[] {
  const out: string[] = [];
  for (const i of picks) {
    if (used.has(i)) continue;
    const text = sentenceAt(lines, i, picks, used);
    if (text) out.push(text);
  }
  return out;
}

export function readerCard(r: Reading, lines: readonly string[]): ReaderCard {
  const asks = r.category === "approval" || r.category === "question";
  const line = (i: number) => (i >= 0 ? displayText(lines[i]) : null);
  const used = new Set<number>();
  const question = asks ? line(r.question_line) : null;
  const options = asks
    ? r.option_lines.map((i) => displayText(lines[i])).filter((x): x is string => x !== null)
    : [];
  const action = r.category === "approval" ? line(r.action_line) : null;
  const task = line(r.task_line);
  if (r.card_mode === "summary-only") {
    // Two lines within three rows of each other are one paragraph: shown in screen order.
    const picks =
      r.card_lines.length === 2 && Math.abs(r.card_lines[0]! - r.card_lines[1]!) <= 3
        ? [...r.card_lines].sort((a, b) => a - b)
        : r.card_lines;
    return {
      category: r.category,
      headline: null,
      summary: summaryText(lines, picks, used),
      question,
      options,
      action,
      task,
    };
  }
  const headline =
    r.status_line >= 0 ? sentenceAt(lines, r.status_line, r.summary_lines, used) : null;
  return {
    category: r.category,
    headline,
    summary: summaryText(lines, r.summary_lines, used),
    question,
    options,
    action,
    task,
  };
}
