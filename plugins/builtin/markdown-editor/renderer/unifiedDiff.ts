/**
 * A unified diff between two texts, line by line, for the draft-versus-disk
 * comparison the conflict banner offers (#12323). Myers' O(ND) shortest-edit
 * script over lines — the same algorithm git uses by default — rendered in
 * the format `DiffViewer` already parses, so the comparison is the app's own
 * diff surface rather than a second one.
 */
type Op = { kind: "equal" | "delete" | "insert"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline is a terminator, not an empty final line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers' algorithm with the standard V-array; returns the edit script in order. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
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
 * `before` → `after` as a unified diff. Returns an empty string when the two
 * texts are identical so callers can tell "no diff" from a diff.
 */
export function unifiedDiff(before: string, after: string, options: UnifiedDiffOptions): string {
  if (before === after) return "";
  const context = options.context ?? 3;
  const ops = myers(splitLines(before), splitLines(after));

  // Group changes into hunks: a hunk covers every op from `context` lines
  // before the first change to `context` lines after the last, merging
  // hunks whose context windows touch.
  const changeIndexes = ops.map((op, i) => (op.kind === "equal" ? -1 : i)).filter((i) => i >= 0);
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
    for (let i = hunk.start; i <= hunk.end; i++) {
      const op = ops[i]!;
      if (op.kind === "equal") {
        body.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.kind === "delete") {
        body.push(`-${op.line}`);
        oldCount++;
      } else {
        body.push(`+${op.line}`);
        newCount++;
      }
    }
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`, ...body);
    for (; cursor <= hunk.end; cursor++) {
      const op = ops[cursor]!;
      if (op.kind !== "insert") oldLine++;
      if (op.kind !== "delete") newLine++;
    }
  }
  return out.join("\n") + "\n";
}
