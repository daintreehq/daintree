/** Tree mode git records a submodule reference under. */
const GITLINK_MODE = "160000";

/** The mode a header line declares, or null when it names none. */
function modeAfter(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  return line.slice(prefix.length).trim() || null;
}

/**
 * Whether a unified diff describes a gitlink — a submodule reference recorded
 * in the tree as mode 160000 — rather than a file (issue #12309).
 *
 * Read from the patch's own mode headers, never from its body. The
 * `Subproject commit …` line pair is the visible symptom, but a file that
 * documents submodules contains the same text; the mode is git's own statement
 * of what the entry is.
 *
 * The NEW side decides, because that is the side a whole-file read would go
 * looking for on disk. Git spells a type change as two records — a
 * `deleted file mode 160000` followed by a `new file mode 100644` — so a
 * submodule replaced by a regular file must come out false even though a
 * gitlink mode appears in the patch. Only when no record declares a new side
 * (a plain deletion) does the old side answer.
 *
 * Deliberately derived from the patch the pane already holds rather than
 * carried alongside the file's status: every read this gates is downstream of
 * `hasDiff`, so the patch is always on hand by the time the answer is needed —
 * for a restored panel and a direct open just as much as a live one.
 */
export function isGitlinkPatch(diffText: string | undefined): boolean {
  if (!diffText) return false;

  let newSide: boolean | null = null;
  let oldSideGitlink = false;
  // Body lines carry a +/-/space prefix, so an unprefixed `index …` or
  // `new file mode …` can only be a header. Tracking the section anyway keeps a
  // diff-of-a-diff from mattering at all.
  let inHeader = false;

  for (const rawLine of diffText.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      inHeader = true;
      continue;
    }
    if (line.startsWith("@@")) {
      inHeader = false;
      continue;
    }
    if (!inHeader) continue;

    const created = modeAfter(line, "new file mode ");
    if (created !== null) {
      newSide = created === GITLINK_MODE;
      continue;
    }
    const removed = modeAfter(line, "deleted file mode ");
    if (removed !== null) {
      oldSideGitlink ||= removed === GITLINK_MODE;
      continue;
    }
    // A permission change spells both modes out instead of one on `index`.
    const replacement = modeAfter(line, "new mode ");
    if (replacement !== null) {
      newSide = replacement === GITLINK_MODE;
      continue;
    }
    // `index <old>..<new> <mode>` — git prints the trailing mode only when both
    // sides share it, and omits it entirely on a create or delete record, so an
    // absent one must not overwrite the verdict those already gave.
    if (line.startsWith("index ")) {
      const mode = line.slice("index ".length).split(" ")[1];
      if (mode) newSide = mode === GITLINK_MODE;
    }
  }

  return newSide ?? oldSideGitlink;
}
