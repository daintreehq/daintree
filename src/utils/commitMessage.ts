export interface CommitPerson {
  name: string;
  email: string;
}

export interface ParsedCommitBody {
  /** Body prose with the trailer block removed; empty when nothing else remains. */
  text: string;
  /** `Co-authored-by:` people, in order, de-duplicated by email. */
  coAuthors: CommitPerson[];
}

// git's own trailer shape: a token, a colon, a value. Tokens are
// letters/digits/hyphens (`Co-authored-by`, `Signed-off-by`, `Change-Id`).
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*:\s+\S/;
const CO_AUTHOR = /^co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/i;
// A paragraph only counts as a trailer block when git (or a forge) plainly
// wrote it: at least one attribution trailer (`*-by`) or a Change-Id. Without
// that anchor, "Note: requires restarting the worker" is prose that merely
// looks like a trailer, and dropping it would lose what the author wrote.
const TRAILER_ANCHOR = /^(?:[A-Za-z0-9-]+-by|change-id):/i;

/**
 * Split a commit body into its prose and the trailer block git appends to it.
 *
 * The trailer block is the last paragraph, and only when every line in it is a
 * `Token: value` trailer and at least one is an attribution trailer or a
 * Change-Id. That keeps a closing "Note: …" in the body, while
 * `Co-authored-by` / `Signed-off-by` are lifted out so they are not read twice.
 */
export function parseCommitBody(body: string | null | undefined): ParsedCommitBody {
  const normalized = (body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return { text: "", coAuthors: [] };

  const paragraphs = normalized.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1]!;
  const lines = last.split("\n").map((l) => l.trim());
  const isTrailerBlock =
    lines.length > 0 &&
    lines.every((l) => TRAILER_LINE.test(l)) &&
    lines.some((l) => TRAILER_ANCHOR.test(l));
  if (!isTrailerBlock) return { text: normalized, coAuthors: [] };

  const coAuthors: CommitPerson[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = CO_AUTHOR.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    const email = match[2]!.trim();
    const key = (email || name).toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    coAuthors.push({ name, email });
  }

  return { text: paragraphs.slice(0, -1).join("\n\n").trim(), coAuthors };
}
