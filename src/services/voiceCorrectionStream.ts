/**
 * Follows a cleanup as it streams back over the passage it rewrites, so the
 * corrected words can be shown in place of the dictated ones they replace,
 * a stretch at a time.
 *
 * The corrected text isn't a word-for-word copy of the dictated one: filler
 * goes, misheard terms change, self-corrections drop whole phrases, lists get
 * laid out and a command can move to the front. So the newest stretch of the
 * stream is aligned against a window of the passage just past what's already
 * been replaced: every streamed word is accounted for, dropped and added words
 * are affine gaps, and a commit happens only on a word both sides share that
 * the alignment around it confirms. A commit is final, so the rewrite only
 * ever moves forward.
 */

/** What the stream has replaced so far: the passage up to `rawTo` shows as `text`. */
export interface StreamedRewrite {
  rawTo: number;
  text: string;
}

interface Unit {
  key: string;
  /** The token the unit came from, as an index into its side's tokens. */
  token: number;
  /** The token's last unit: a commit can only end a whole word. */
  last: boolean;
}

interface Token {
  from: number;
  to: number;
}

/** One step of an alignment: a streamed unit against a dictated one, or either alone. */
type Step =
  | { kind: "pair"; s: number; d: number; score: number }
  | { kind: "added" }
  | { kind: "dropped" };

const MATCH = 2;
const FUZZY = 1;
const MISMATCH = -1.5;
const GAP_OPEN = -2;
const GAP_EXTEND = -0.5;
// The stream's last complete word may still pair better with what follows.
// Main already holds back a word cut off mid-token.
const PROVISIONAL_WORDS = 1;
// Dictated words dropped between two matches with nothing added, the shape of
// removed filler, that still leave the second match confirmed.
const MAX_FILLER_DROPPED = 2;
// Bounds each update's alignment, however long the passage or the stretch.
const MAX_STRETCH_UNITS = 48;
const WINDOW_SLACK = 12;

const CARDINALS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
  first: "1",
  second: "2",
  third: "3",
  fourth: "4",
  fifth: "5",
  sixth: "6",
  seventh: "7",
  eighth: "8",
  ninth: "9",
  tenth: "10",
};

const NEGATED_STEMS: Record<string, string> = { ca: "can", wo: "will", sha: "shall" };

const CONTRACTIONS: Record<string, string> = {
  re: "are",
  ll: "will",
  ve: "have",
  m: "am",
  d: "would",
  s: "is",
};

function expandContraction(piece: string): string[] {
  if (piece === "cannot") return ["can", "not"];
  if (piece === "let's") return ["let", "us"];
  const negated = /^(.+)n't$/.exec(piece);
  if (negated) return [NEGATED_STEMS[negated[1]!] ?? negated[1]!, "not"];
  const suffixed = /^(.+)'([a-z]+)$/.exec(piece);
  const expansion = suffixed ? CONTRACTIONS[suffixed[2]!] : undefined;
  if (suffixed && expansion) return [suffixed[1]!, expansion];
  return [piece];
}

/**
 * The comparison keys for one whitespace-delimited word, the same on both
 * sides: lowercased, punctuation dropped (a hyphen or slash splits), a
 * contraction spelled out, and a number word or ordinal written as digits.
 * Punctuation alone has no keys.
 */
export function wordKeys(word: string): string[] {
  const lower = word.toLowerCase().replace(/[‘’ʼ]/g, "'");
  const keys: string[] = [];
  for (const piece of lower.split(/[^\p{L}\p{N}']+/u)) {
    for (const part of expandContraction(piece.replace(/^'+|'+$/g, ""))) {
      const bare = part.replace(/'/g, "");
      if (!bare) continue;
      const ordinal = /^(\d+)(?:st|nd|rd|th)$/.exec(bare);
      keys.push(ordinal ? ordinal[1]! : (CARDINALS[bare] ?? bare));
    }
  }
  return keys;
}

function tokenize(text: string, from = 0, limit = Infinity): Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+/g;
  pattern.lastIndex = from;
  let match: RegExpExecArray | null;
  while (tokens.length < limit && (match = pattern.exec(text))) {
    tokens.push({ from: match.index, to: match.index + match[0].length });
  }
  return tokens;
}

function unitsOf(text: string, tokens: Token[]): Unit[] {
  const units: Unit[] = [];
  tokens.forEach((token, index) => {
    const keys = wordKeys(text.slice(token.from, token.to));
    keys.forEach((key, i) => units.push({ key, token: index, last: i === keys.length - 1 }));
  });
  return units;
}

function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return false;
    prev = curr;
  }
  return prev[b.length]! <= max;
}

// A misheard term: one edit for words of 5 to 8 letters, two from 9, none
// shorter. Numbers never match loosely.
function fuzzyMatch(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length);
  const max = shorter >= 9 ? 2 : shorter >= 5 ? 1 : 0;
  if (max === 0 || /\d/.test(a) || /\d/.test(b)) return false;
  return withinEdits(a, b, max);
}

function pairScore(a: Unit, b: Unit): number {
  if (a.key === b.key) return MATCH;
  return fuzzyMatch(a.key, b.key) ? FUZZY : MISMATCH;
}

/**
 * The steps, in order, of the best alignment that accounts for every streamed
 * unit. Skipping dictated units at the start costs a gap, since the stream
 * picks up where the last commit left off; dictated units after the
 * alignment's end are free, since the stream hasn't got there. Ties go to the
 * end that consumes least.
 */
function alignStretch(streamed: Unit[], dictated: Unit[]): Step[] {
  const m = streamed.length;
  const n = dictated.length;
  const w = n + 1;
  const size = (m + 1) * w;
  // Ending on a pair, on a streamed unit added, or on a dictated unit dropped.
  const pair = new Float64Array(size).fill(-Infinity);
  const added = new Float64Array(size).fill(-Infinity);
  const dropped = new Float64Array(size).fill(-Infinity);
  pair[0] = 0;
  for (let j = 1; j <= n; j++) dropped[j] = GAP_OPEN + (j - 1) * GAP_EXTEND;
  for (let i = 1; i <= m; i++) {
    added[i * w] = GAP_OPEN + (i - 1) * GAP_EXTEND;
    for (let j = 1; j <= n; j++) {
      const k = i * w + j;
      const diag = k - w - 1;
      const up = k - w;
      const left = k - 1;
      pair[k] =
        Math.max(pair[diag]!, added[diag]!, dropped[diag]!) +
        pairScore(streamed[i - 1]!, dictated[j - 1]!);
      added[k] = Math.max(pair[up]! + GAP_OPEN, added[up]! + GAP_EXTEND, dropped[up]! + GAP_OPEN);
      dropped[k] = Math.max(
        pair[left]! + GAP_OPEN,
        dropped[left]! + GAP_EXTEND,
        added[left]! + GAP_OPEN
      );
    }
  }

  let j = 0;
  let best = -Infinity;
  for (let col = 0; col <= n; col++) {
    const k = m * w + col;
    const score = Math.max(pair[k]!, added[k]!, dropped[k]!);
    if (score > best) {
      best = score;
      j = col;
    }
  }

  // Every score is a multiple of 0.5, so the sums compare exactly.
  const matrices = [pair, added, dropped];
  let i = m;
  let k = i * w + j;
  let state = matrices.findIndex((matrix) => matrix[k] === best);
  const steps: Step[] = [];
  while (i > 0 || j > 0) {
    k = i * w + j;
    const value = matrices[state]![k]!;
    if (state === 0) {
      const score = pairScore(streamed[i - 1]!, dictated[j - 1]!);
      steps.push({ kind: "pair", s: i - 1, d: j - 1, score });
      const diag = k - w - 1;
      state = matrices.findIndex((matrix) => matrix[diag]! + score === value);
      i--;
      j--;
    } else if (state === 1) {
      const up = k - w;
      state = [pair[up]! + GAP_OPEN, added[up]! + GAP_EXTEND, dropped[up]! + GAP_OPEN].indexOf(
        value
      );
      steps.push({ kind: "added" });
      i--;
    } else {
      const left = k - 1;
      state = [pair[left]! + GAP_OPEN, added[left]! + GAP_OPEN, dropped[left]! + GAP_EXTEND].indexOf(
        value
      );
      steps.push({ kind: "dropped" });
      j--;
    }
  }
  return steps.reverse();
}

/**
 * Whether the step at `index` is a match the alignment has confirmed: the
 * match before it (or the last commit, when there's none) sits right behind
 * it, with at most a little filler dropped between them and nothing added. A
 * common word matching on its own across a longer gap is chance until the
 * next word matches too, and a near spelling only counts beside an exact match.
 */
function confirmsMatch(steps: Step[], index: number, originExact: boolean): boolean {
  const step = steps[index]!;
  if (step.kind !== "pair" || step.score <= 0) return false;
  let dropped = 0;
  let k = index - 1;
  for (; k >= 0 && steps[k]!.kind !== "pair"; k--) {
    if (steps[k]!.kind === "added") return false;
    dropped++;
  }
  if (dropped > MAX_FILLER_DROPPED) return false;
  const prev = steps[k];
  if (prev?.kind === "pair" && prev.score <= 0) return false;
  const prevExact = prev?.kind === "pair" ? prev.score === MATCH : originExact;
  return step.score === MATCH || prevExact;
}

/**
 * Tracks one passage's streamed cleanup. Feed it the corrected text so far,
 * each time it grows; it answers with the rewrite committed up to then, which
 * only ever moves forward.
 */
export class CorrectionStreamAligner {
  private readonly tokens: Token[];
  private readonly units: Unit[];
  private unitsDone = 0;
  private streamedDone = 0;
  // Whether the last commit ended on an exact match, which a near spelling
  // straight after it can lean on.
  private committedExact = false;
  private rewrite: StreamedRewrite | null = null;

  constructor(private readonly dictated: string) {
    this.tokens = tokenize(dictated);
    this.units = unitsOf(dictated, this.tokens);
  }

  get current(): StreamedRewrite | null {
    return this.rewrite;
  }

  advance(streamedText: string): StreamedRewrite | null {
    const streamed = streamedText.trimStart();
    // A stream that no longer starts with what was shown is not this one.
    if (this.rewrite && !streamed.startsWith(this.rewrite.text)) return this.rewrite;

    const tokens = tokenize(streamed, this.streamedDone, MAX_STRETCH_UNITS + PROVISIONAL_WORDS);
    const stable = tokens.slice(0, Math.max(0, tokens.length - PROVISIONAL_WORDS));
    const streamedUnits = unitsOf(streamed, stable).slice(0, MAX_STRETCH_UNITS);
    if (streamedUnits.length === 0) return this.rewrite;
    const window = this.units.slice(
      this.unitsDone,
      this.unitsDone + 2 * streamedUnits.length + WINDOW_SLACK
    );
    if (window.length === 0) return this.rewrite;

    const steps = alignStretch(streamedUnits, window);
    let commit: { s: number; d: number; score: number } | null = null;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.kind !== "pair" || !confirmsMatch(steps, i, this.committedExact)) continue;
      if (streamedUnits[step.s]!.last && window[step.d]!.last) commit = step;
    }
    if (!commit) return this.rewrite;

    const { s, d } = commit;
    this.committedExact = commit.score === MATCH;
    const streamedTo = stable[streamedUnits[s]!.token]!.to;
    this.streamedDone = streamedTo;
    this.unitsDone += d + 1;
    this.rewrite = {
      rawTo: this.tokens[window[d]!.token]!.to,
      text: streamed.slice(0, streamedTo),
    };
    return this.rewrite;
  }
}
