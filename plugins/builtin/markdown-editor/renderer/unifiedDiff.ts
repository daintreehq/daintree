/**
 * A unified diff between two texts, line by line, for the draft-versus-disk
 * comparison the conflict banner offers (#12323). Myers' O(ND) shortest-edit
 * script over lines — the same algorithm git uses by default — rendered in
 * the format `DiffViewer` already parses, so the comparison is the app's own
 * diff surface rather than a second one.
 */
type Op = { kind: "equal" | "delete" | "insert"; line: string };

/**
 * Myers keeps one V-array copy per edit-distance step, so two very different
 * buffers cost O(D²) memory. Past this many steps the comparison falls back
 * to a single replace hunk over the differing middle — still correct, just
 * coarser — rather than letting a Compare click eat the renderer.
 */
const MAX_EDIT_STEPS = 1500;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline is a terminator, not an empty final line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Myers' algorithm with the standard V-array; returns the edit script in
 * order, or null when the shortest edit is longer than the budget allows.
 */
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_STEPS) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk the trace backwards to recover the path.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: "insert", line: b[y - 1]! });
        y--;
      } else {
        ops.push({ kind: "delete", line: a[x - 1]! });
        x--;
      }
    }
  }
  ops.reverse();
  return ops;
}

export interface UnifiedDiffOptions {
  /** Path shown in the `---`/`+++` header, the same on both sides. */
  path: string;
  /** Context lines around each change. */
  context?: number;
}

/**
 * The edit script for two line arrays: common prefix and suffix are peeled
 * off first (the shape of every ordinary edit), Myers runs on the middle,
 * and past the budget the middle becomes one delete-all/insert-all pair.
 */
function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const middle =
    myers(middleA, middleB) ??
    ([
      ...middleA.map((line) => ({ kind: "delete", line }) as Op),
      ...middleB.map((line) => ({ kind: "insert", line }) as Op),
    ] as Op[]);
  return [
    ...a.slice(0, start).map((line) => ({ kind: "equal", line }) as Op),
    ...middle,
    ...a.slice(endA).map((line) => ({ kind: "equal", line }) as Op),
  ];
}

const NO_NEWLINE = "\\ No newline at end of file";

/**
 * `before` → `after` as a unified diff. Returns an empty string when the two
 * texts are identical so callers can tell "no diff" from a diff.
 */
export function unifiedDiff(before: string, after: string, options: UnifiedDiffOptions): string {
  if (before === after) return "";
  const context = options.context ?? 3;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffLines(beforeLines, afterLines);
  // A missing final newline is part of the file: mark the last line of each
  // side the way git does, so "a" → "a\n" is a visible change.
  const beforeNoEol = before !== "" && !before.endsWith("\n");
  const afterNoEol = after !== "" && !after.endsWith("\n");

  // Group changes into hunks: a hunk covers every op from `context` lines
  // before the first change to `context` lines after the last, merging
  // hunks whose context windows touch.
  const changeIndexes = ops
    .map((op, i) => {
      if (op.kind !== "equal") return i;
      // The final line is a change when only its newline differs.
      const lastOfBefore = i === ops.length - 1 && beforeNoEol !== afterNoEol;
      return lastOfBefore ? i : -1;
    })
    .filter((i) => i >= 0);
  const hunks: Array<{ start: number; end: number }> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }

  const out: string[] = [
    `diff --git a/${options.path} b/${options.path}`,
    `--- a/${options.path}`,
    `+++ b/${options.path}`,
  ];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const hunk of hunks) {
    for (; cursor < hunk.start; cursor++) {
      const op = ops[cursor]!;
      if (op.kind !== "insert") oldLine++;
      if (op.kind !== "delete") newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    let oldSeen = oldLine - 1;
    let newSeen = newLine - 1;
    for (let i = hunk.start; i <= hunk.end; i++) {
      const op = ops[i]!;
      if (op.kind === "equal") {
        oldSeen++;
        newSeen++;
        const lastOld = oldSeen === beforeLines.length && beforeNoEol;
        const lastNew = newSeen === afterLines.length && afterNoEol;
        if (lastOld !== lastNew) {
          // Same text, different newline state: show it as a replace.
          body.push(`-${op.line}`);
          if (lastOld) body.push(NO_NEWLINE);
          body.push(`+${op.line}`);
          if (lastNew) body.push(NO_NEWLINE);
        } else {
          body.push(` ${op.line}`);
          if (lastOld) body.push(NO_NEWLINE);
        }
        oldCount++;
        newCount++;
      } else if (op.kind === "delete") {
        oldSeen++;
        body.push(`-${op.line}`);
        if (oldSeen === beforeLines.length && beforeNoEol) body.push(NO_NEWLINE);
        oldCount++;
      } else {
        newSeen++;
        body.push(`+${op.line}`);
        if (newSeen === afterLines.length && afterNoEol) body.push(NO_NEWLINE);
        newCount++;
      }
    }
    // An empty side starts at the line before, as git prints it (`-0,0`).
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine;
    const newStart = newCount === 0 ? newLine - 1 : newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
    for (; cursor <= hunk.end; cursor++) {
      const op = ops[cursor]!;
      if (op.kind !== "insert") oldLine++;
      if (op.kind !== "delete") newLine++;
    }
  }
  return out.join("\n") + "\n";
}
