/**
 * Git's own hunks of a single-file patch, and the patch that stages a subset of
 * them the way `git add -p` does (#17331).
 *
 * Lines are framed on `\n` only and kept verbatim, so a CRLF file's `\r` and
 * git's `\ No newline at end of file` markers survive a round trip byte for
 * byte. The one rewrite is an empty line inside a hunk, which
 * `diff.suppressBlankEmpty` prints for a blank context line: it becomes the
 * `" "` git prints otherwise, so two reads under either setting compare equal.
 * A hunk's extent comes from the counts in its header, never from the prefix
 * of the next line, which is how git itself reads a patch.
 *
 * Renderer-safe: no Node.js built-ins, no Electron deps.
 */

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What follows the closing `@@`: git's function context, leading space included. */
  section: string;
  /** Every line after the header, verbatim but for blank context, `\` markers included. */
  lines: string[];
}

export interface FilePatch {
  /** The lines before the first hunk: `diff --git`, `index`, `---`, `+++` and any mode lines. */
  header: string[];
  hunks: PatchHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const MODE_LINE = /^(?:old|new) mode /;

/**
 * Parse one file's patch, or a run of bare hunks with no header. Null for
 * anything else: a second file, a hunk whose lines don't add up to its header,
 * or a line no hunk can hold.
 */
export function parseFilePatch(text: string): FilePatch | null {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let i = 0;
  const header: string[] = [];
  let fileHeaders = 0;
  while (i < lines.length && !lines[i]!.startsWith("@@ ")) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ") && ++fileHeaders > 1) return null;
    header.push(line);
    i++;
  }

  const hunks: PatchHunk[] = [];
  while (i < lines.length) {
    const match = HUNK_HEADER.exec(lines[i]!);
    if (!match) return null;
    const hunk: PatchHunk = {
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      section: match[5] ?? "",
      lines: [],
    };
    i++;
    let oldLeft = hunk.oldLines;
    let newLeft = hunk.newLines;
    while (oldLeft > 0 || newLeft > 0) {
      const raw = lines[i];
      if (raw === undefined) return null;
      const line = raw === "" ? " " : raw;
      const prefix = line[0];
      if (prefix === " ") {
        oldLeft--;
        newLeft--;
      } else if (prefix === "-") {
        oldLeft--;
      } else if (prefix === "+") {
        newLeft--;
      } else if (prefix !== "\\") {
        return null;
      }
      if (oldLeft < 0 || newLeft < 0) return null;
      hunk.lines.push(line);
      i++;
    }
    // The marker for a last line with no newline follows the line it describes.
    while (i < lines.length && lines[i]!.startsWith("\\")) {
      hunk.lines.push(lines[i]!);
      i++;
    }
    hunks.push(hunk);
  }

  return { header, hunks };
}

/**
 * Whether two hunks change the same lines with the same context. Positions are
 * left out: the caller decides which of them may have moved.
 */
export function sameHunkBody(a: PatchHunk, b: PatchHunk): boolean {
  if (a.oldLines !== b.oldLines || a.newLines !== b.newLines) return false;
  if (a.lines.length !== b.lines.length) return false;
  return a.lines.every((line, index) => line === b.lines[index]);
}

/**
 * The hunk of `patch` that is `read`: the same lines, at the same old start.
 *
 * The old side is what the hunk applies to (the index for an unstaged hunk,
 * HEAD for a staged one), so an edit elsewhere on the new side moves only the
 * new start, and the hunk is still found. A body that turns up at another old
 * start is never taken for it: when the hunk the user read was rewritten, an
 * identical one elsewhere in the file is a different change, and staging it
 * would put in lines nobody chose.
 */
export function findHunk(
  patch: FilePatch,
  read: PatchHunk,
  taken: ReadonlySet<number> = new Set()
): number | null {
  const index = patch.hunks.findIndex(
    (hunk, i) => !taken.has(i) && hunk.oldStart === read.oldStart && sameHunkBody(hunk, read)
  );
  return index === -1 ? null : index;
}

function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/**
 * The patch that applies only the `selected` hunks, for `git apply --cached`
 * (`forward`) or `git apply --cached -R` (`reverse`).
 *
 * `git apply` looks for a hunk starting at its new-side line, which assumes
 * every hunk above it is applied too. Each skipped hunk shifts that line by
 * what it would have added or removed, so the shift is taken back out, exactly
 * as `git add -p` does (add-patch.c `reassemble_patch`): forward patches move
 * their new start, reverse ones their old start, which `-R` makes the new side.
 *
 * Mode lines are dropped. A hunk carries content only, the way declining the
 * mode change in `git add -p` leaves the index's mode alone.
 */
export function buildHunkPatch(
  patch: FilePatch,
  selected: ReadonlySet<number>,
  direction: "forward" | "reverse"
): string {
  const out = patch.header.filter((line) => !MODE_LINE.test(line));
  let delta = 0;
  patch.hunks.forEach((hunk, index) => {
    if (!selected.has(index)) {
      delta += hunk.oldLines - hunk.newLines;
      return;
    }
    const oldStart = direction === "reverse" ? hunk.oldStart - delta : hunk.oldStart;
    const newStart = direction === "forward" ? hunk.newStart + delta : hunk.newStart;
    if (oldStart < 0 || newStart < 0) throw new Error("Hunk offset fell before the file start");
    out.push(
      `@@ -${formatRange(oldStart, hunk.oldLines)} +${formatRange(newStart, hunk.newLines)} @@${hunk.section}`
    );
    // One push per line: spreading a hunk of many short lines into one call
    // can pass the engine's argument limit.
    for (const line of hunk.lines) out.push(line);
  });
  return `${out.join("\n")}\n`;
}

const REGULAR_MODE = "(?:100644|100755)";
const PLAIN_HEADER_RULES: ReadonlyArray<{ pattern: RegExp; required: boolean }> = [
  { pattern: /^diff --git /, required: true },
  { pattern: new RegExp(`^index [0-9a-f]+\\.\\.[0-9a-f]+(?: ${REGULAR_MODE})?$`), required: true },
  { pattern: new RegExp(`^old mode ${REGULAR_MODE}$`), required: false },
  { pattern: new RegExp(`^new mode ${REGULAR_MODE}$`), required: false },
  { pattern: /^--- (?!\/dev\/null$)/, required: true },
  { pattern: /^\+\+\+ (?!\/dev\/null$)/, required: true },
];

/**
 * Whether a patch header describes a regular text file changed in place, the
 * only shape that stages by hunk. Each line must be one of these, at most
 * once: a new, deleted, renamed, copied, binary, symlink or submodule entry
 * carries a line or a mode that isn't.
 */
export function isPlainModification(header: readonly string[]): boolean {
  const seen = new Set<number>();
  for (const line of header) {
    const rule = PLAIN_HEADER_RULES.findIndex(({ pattern }) => pattern.test(line));
    if (rule === -1 || seen.has(rule)) return false;
    seen.add(rule);
  }
  return PLAIN_HEADER_RULES.every(({ required }, rule) => !required || seen.has(rule));
}

/** Whether a hunk changes lines with none of the file around them, as `-U0` prints. */
export function hasNoContext(hunk: PatchHunk): boolean {
  return !hunk.lines.some((line) => line.startsWith(" "));
}

/** One hunk as text, header line first, the form a renderer sends back to Main. */
export function formatHunk(hunk: PatchHunk): string {
  return [
    `@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@${hunk.section}`,
    ...hunk.lines,
  ].join("\n");
}

/** A line range on one side of a diff, as a hunk header states it. */
export interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

// A zero count names the line before the change, so the empty range sits one later.
function span(start: number, count: number): [number, number] {
  return count === 0 ? [start + 1, start + 1] : [start, start + count];
}

function within(inner: [number, number], outer: [number, number]): boolean {
  return inner[0] >= outer[0] && inner[1] <= outer[1];
}

/**
 * The indices of git's hunks a rendered hunk holds. Expanding context, or the
 * full-file view, merges neighbouring hunks into one on screen; git's hunks
 * are what can be staged, so a rendered hunk stands for every one inside it.
 */
export function hunksWithin(patch: FilePatch, rendered: HunkRange): number[] {
  const oldOuter = span(rendered.oldStart, rendered.oldLines);
  const newOuter = span(rendered.newStart, rendered.newLines);
  const inside: number[] = [];
  patch.hunks.forEach((hunk, index) => {
    if (
      within(span(hunk.oldStart, hunk.oldLines), oldOuter) &&
      within(span(hunk.newStart, hunk.newLines), newOuter)
    ) {
      inside.push(index);
    }
  });
  return inside;
}
