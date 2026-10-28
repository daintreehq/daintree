/** A whitespace-separated word and where it sits in its text. */
export interface WordToken {
  text: string;
  from: number;
  to: number;
}

export function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    tokens.push({ text: match[0], from: match.index, to: match.index + match[0].length });
  }
  return tokens;
}

// Past this many word pairs, only the common head and tail are aligned.
const MAX_ALIGNMENT_CELLS = 250_000;

/**
 * The words both sides keep, as index pairs in order: a longest common
 * subsequence under `same`, framed by the common head and tail. A stretch too
 * long to align word by word keeps only its head and tail.
 */
export function alignWords(
  a: readonly WordToken[],
  b: readonly WordToken[],
  same: (x: WordToken, y: WordToken) => boolean
): [number, number][] {
  let head = 0;
  while (head < a.length && head < b.length && same(a[head]!, b[head]!)) head++;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && same(a[endA - 1]!, b[endB - 1]!)) {
    endA--;
    endB--;
  }

  const kept: [number, number][] = [];
  for (let i = 0; i < head; i++) kept.push([i, i]);
  const m = endA - head;
  const n = endB - head;
  if (m > 0 && n > 0 && m * n <= MAX_ALIGNMENT_CELLS) {
    const width = n + 1;
    const lcs = new Uint32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i * width + j] = same(a[head + i]!, b[head + j]!)
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (same(a[head + i]!, b[head + j]!)) {
        kept.push([head + i, head + j]);
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        i++;
      } else {
        j++;
      }
    }
  }
  for (let k = 0; endA + k < a.length; k++) kept.push([endA + k, endB + k]);
  return kept;
}

// Case and punctuation aside, so a word the rewrite capitalised or punctuated
// still reads as the same word.
function wordKey(token: WordToken): string {
  return token.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Where each cut between two runs of `before` falls in `after`, a rewrite of
 * it: `end` where the earlier run's words stop, `start` where the later run's
 * begin. Words the rewrite replaced or dropped stay on the side of the cut
 * they came from, so a cut holds wherever at least one of the words beside it
 * survived; where neither did (a self-correction across it, a word rewritten
 * across it), or the rewrite put words of its own between them, it is null
 * and the two runs can no longer be told apart.
 */
export function mapWordCuts(
  before: string,
  after: string,
  cuts: ReadonlyArray<{ end: number; start: number }>
): Array<{ end: number; start: number } | null> {
  if (cuts.length === 0) return [];
  const words = (text: string) => tokenizeWords(text).filter((token) => wordKey(token) !== "");
  const a = words(before);
  const b = words(after);
  const partner = new Int32Array(a.length).fill(-1);
  for (const [i, j] of alignWords(a, b, (x, y) => wordKey(x) === wordKey(y))) partner[i] = j;
  // Where the kept word nearest `i` on that side went: -1 or b.length past the ends.
  const keptBefore = (i: number) => {
    for (let k = i; k >= 0; k--) if (partner[k]! >= 0) return partner[k]!;
    return -1;
  };
  const keptAfter = (i: number) => {
    for (let k = i; k < a.length; k++) if (partner[k]! >= 0) return partner[k]!;
    return b.length;
  };
  return cuts.map(({ end, start }) => {
    let last = -1;
    while (last + 1 < a.length && a[last + 1]!.to <= end) last++;
    let next = last + 1;
    while (next < a.length && a[next]!.from < start) next++;
    if (last < 0 || next >= a.length) return null;
    const left = partner[last]!;
    const right = partner[next]!;
    if (left >= 0 && right >= 0) {
      return right === left + 1 ? { end: b[left]!.to, start: b[right]!.from } : null;
    }
    // The words the rewrite wrote between the kept ones either side are the
    // replaced side's own.
    if (right >= 0) {
      const lastWritten = right - 1;
      return lastWritten >= 0 && lastWritten >= keptBefore(last)
        ? { end: b[lastWritten]!.to, start: b[right]!.from }
        : null;
    }
    if (left >= 0) {
      const firstWritten = left + 1;
      return firstWritten < b.length && firstWritten <= keptAfter(next)
        ? { end: b[left]!.to, start: b[firstWritten]!.from }
        : null;
    }
    return null;
  });
}
