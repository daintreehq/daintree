import { foldTicking } from "./canopyScreen.js";

/**
 * How long after a terminal is resized its screen is left alone: the agent
 * redraws for the new size (Claude Code repaints its live area, Codex replays
 * its whole transcript), and a screen read mid-redraw is neither the old screen
 * nor the new one.
 */
export const CANOPY_REFLOW_MS = 2_500;

/** A line cut off at the pane's edge, in a print: what follows it there depends on the width. */
const CUT = "\u0000";
/** The most of a screen's tail a print keeps. */
const PRINT_CHARS = 2_000;
/**
 * How much more of the top the longer print keeps than the shorter one has in
 * all, before the two are compared: enough for its first rows to be found in
 * the longer, which a taller pane shows any amount more of.
 */
const TOP_SLACK = 200;
/** The most edits two prints may differ by before they are simply different screens. */
const MAX_EDITS = TOP_SLACK + 300;
/** A match shorter than this is chance, not the same text: it counts with the gap around it. */
const MIN_MATCH = 8;

/**
 * What a screen says, independent of the size it is drawn at: its words in
 * order, one space between each, with rules, frames and line breaks gone, so
 * text the agent re-wraps for a new width reads the same — while `cat a b`
 * still reads apart from `cat ab` — and with each line the agent cut short at
 * the pane's edge marked, since how much of it shows is the width's doing.
 * Ticking timers are folded, as for the screen's hash.
 */
export function reflowPrint(text: string): string {
  const print = foldTicking(text)
    .split("\n")
    .map((line) =>
      line
        .replace(/…[)\]"'`]*\s*$/, CUT)
        .replace(/[─-▟]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((line) => line !== "")
    .join(" ");
  return print.length > PRINT_CHARS ? print.slice(-PRINT_CHARS) : print;
}

/**
 * Whether `after` is the screen `before` was, drawn again at another size.
 * Two prints match when they differ only at the top — a taller pane shows more
 * of what came before, a shorter one less — and where a line cut at the pane's
 * edge shows more or less of itself. Anything else that differs, however
 * small, is a change: a dialog asking to run `npm build` where it asked to run
 * `npm test` is a new prompt, and so is one whose first word changed.
 */
export function sameAfterReflow(whole: string, redrawn: string): boolean {
  if (whole === redrawn) return true;
  if (Math.min(whole.length, redrawn.length) === 0) return false;
  // Where both prints were cut to their last PRINT_CHARS, where each begins is
  // arbitrary; otherwise the shorter begins at its screen's real top, which
  // the longer must show too.
  const capped = whole.length >= PRINT_CHARS && redrawn.length >= PRINT_CHARS;
  const before =
    whole.length > redrawn.length + TOP_SLACK ? whole.slice(-(redrawn.length + TOP_SLACK)) : whole;
  const after =
    redrawn.length > whole.length + TOP_SLACK
      ? redrawn.slice(-(whole.length + TOP_SLACK))
      : redrawn;
  const shorter = Math.min(before.length, after.length);
  const matches = commonRuns(before, after);
  if (matches === null) return false;
  const kept = matches.filter((run) => run.length >= MIN_MATCH);
  let matched = 0;
  for (const run of kept) matched += run.length;
  // Mostly the same words: a small screen that happens to share a few runs
  // with a large one is not a redraw of it.
  if (matched < shorter * 0.6) return false;
  const first = kept[0]!;
  // More, or less, of the top: one print starts where the other's words are
  // already under way, so what comes before the first shared run on the
  // shorter side ends what comes before it on the longer. Both starting on
  // words of their own is a change there.
  const lostTop = before.slice(0, first.a);
  const gainedTop = after.slice(0, first.b);
  if (!capped && !lostTop.endsWith(gainedTop) && !gainedTop.endsWith(lostTop)) return false;
  const last = kept[kept.length - 1]!;
  // The bottom is where an agent asks; it must match to the end.
  if (last.a + last.length !== before.length || last.b + last.length !== after.length) {
    return false;
  }
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1]!;
    const next = kept[i]!;
    const lost = before.slice(prev.a + prev.length, next.a);
    const gained = after.slice(prev.b + prev.length, next.b);
    // A cut line shows more or less of itself: one side lost or gained text
    // at the cut, and nothing was put in its place but the cut itself (and the
    // space the line ended with).
    const atCut = lost.includes(CUT) || gained.includes(CUT) || before[next.a] === CUT;
    const bare = (side: string) => side.replace(/[\0\s]/g, "") === "";
    const oneSided = bare(lost) || bare(gained);
    if (!atCut || !oneSided) return false;
  }
  return true;
}

interface Run {
  a: number;
  b: number;
  length: number;
}

/**
 * The runs `a` and `b` share, in order, from a shortest edit script (Myers);
 * null when the two differ by more than `MAX_EDITS` edits.
 */
function commonRuns(a: string, b: string): Run[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], offset: number, n: number, m: number): Run[] {
  const runs: Run[] = [];
  let x = n;
  let y = m;
  const snake = (fromX: number, fromY: number) => {
    if (x > fromX && y > fromY) {
      const length = Math.min(x - fromX, y - fromY);
      runs.push({ a: x - length, b: y - length, length });
      x -= length;
      y -= length;
    }
  };
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    // The diagonal after the edit, back to the point the edit left from.
    snake(down ? prevX : prevX + 1, down ? prevY + 1 : prevY);
    x = prevX;
    y = prevY;
  }
  snake(0, 0);
  runs.reverse();
  // Adjacent runs (split by the walk, not by an edit) are one.
  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.a + prev.length === run.a && prev.b + prev.length === run.b) {
      prev.length += run.length;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}
