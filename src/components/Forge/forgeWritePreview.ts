/**
 * Content previews for the two forge writes that publish something a person
 * cannot retract (#12118).
 *
 * `forge.createIssue` and `forge.addIssueComment` are `danger:"confirm"`, and
 * for an agent dispatch the only surface a human sees is `McpConfirmDialog`.
 * Its collapsed arguments disclosure cannot stand in for a preview here:
 * `summarizeMcpArgs` replaces any string over
 * `MCP_ARGS_INLINE_STRING_LIMIT` with `<string: N chars>`, so the issue body
 * or comment text — the whole of what is about to be published — is exactly
 * the part that never reaches the approver. That is the D2 "preview the actual
 * content, a count is insufficient" rule failing on the one field that matters.
 *
 * Pure formatting over already-resolved values. The bridge reads them from the
 * dispatch arguments (which for these two actions ARE the content) and pins the
 * worktree it resolved, so what is previewed is what `run()` publishes.
 */

import { MCP_PREVIEW_CAUTION_PREFIX } from "@/lib/mcpPreviewLines";

/**
 * How much authored text the card shows before it says so.
 *
 * An issue body is arbitrary-length text that, at system tier, may have come
 * from an issue or file this repository does not control — so it is bounded
 * rather than pasted whole into a modal. The bound is generous: the card
 * scrolls, and a preview that elides most of a body is barely better than the
 * `<string: N chars>` it replaces.
 */
const MAX_BODY_CHARS = 1500;
const MAX_BODY_LINES = 30;
/** Forges cap titles well below this; the bound is for a caller that ignores that. */
const MAX_TITLE_CHARS = 200;
const MAX_LABELS = 20;

/**
 * Two spaces in front of every line of caller-supplied text, and it is load
 * bearing rather than cosmetic.
 *
 * `McpConfirmDialog` reads a leading `MCP_PREVIEW_CAUTION_PREFIX` as "this line
 * is a warning" and renders it with a warning icon and status tone. The body
 * previewed here is authored by whoever asked for the write, so an unindented
 * body line starting with that marker would render as though the host had
 * emitted it — a forged warning inside the dialog that gates the write. An
 * indent no content can remove makes that unreachable.
 */
const CONTENT_INDENT = "  ";

function indent(text: string): string[] {
  return text.split("\n").map((line) => `${CONTENT_INDENT}${line}`);
}

/** The text as it will be shown, plus how many characters that leaves out. */
function boundText(text: string, maxChars: number, maxLines: number) {
  let shown = text;
  if (shown.length > maxChars) shown = shown.slice(0, maxChars);
  const lines = shown.split("\n");
  if (lines.length > maxLines) shown = lines.slice(0, maxLines).join("\n");
  return { shown, omitted: text.length - shown.length };
}

/**
 * Render bounded authored text under a heading, with a caution naming what was
 * left out.
 *
 * The caution is not decoration. Truncating silently would show an approver
 * part of a body and take their approval for the whole of it — the same defect
 * as previewing a count instead of content, one level down.
 */
function contentSection(heading: string, text: string, maxChars: number, maxLines: number) {
  const { shown, omitted } = boundText(text, maxChars, maxLines);
  const lines = [`${heading}:`, ...indent(shown)];
  if (omitted > 0) {
    lines.push(
      `${MCP_PREVIEW_CAUTION_PREFIX}Shown in part — ${omitted} more character${
        omitted === 1 ? "" : "s"
      } will be published than appear above.`
    );
  }
  return lines;
}

export interface ForgeCreateIssuePreview {
  /** The worktree whose forge remote the issue is filed against. */
  worktreePath: string;
  title: string;
  body: string | undefined;
  labels: readonly string[] | undefined;
}

export interface ForgeIssueCommentPreview {
  worktreePath: string;
  issueNumber: number;
  body: string;
}

/**
 * The worktree line leads every preview here because it answers the question
 * the arguments do not: `forge.createIssue` takes no repository, it files
 * against whatever repository the resolved worktree points at. Filing into the
 * wrong one — the user's own project rather than the one being discussed — is
 * the failure this action's own guidance warns about, and until #12118 nothing
 * put it in front of a human.
 */
function worktreeLine(worktreePath: string): string {
  return `Worktree: ${worktreePath}`;
}

export function formatForgeCreateIssuePreviewLines(preview: ForgeCreateIssuePreview): string[] {
  const lines = [worktreeLine(preview.worktreePath)];
  lines.push(...contentSection("Title", preview.title, MAX_TITLE_CHARS, 1));
  lines.push(
    ...(preview.body === undefined || preview.body.length === 0
      ? ["Body:", `${CONTENT_INDENT}(none)`]
      : contentSection("Body", preview.body, MAX_BODY_CHARS, MAX_BODY_LINES))
  );

  const labels = preview.labels ?? [];
  if (labels.length === 0) {
    lines.push("Labels: (none)");
  } else {
    const shown = labels.slice(0, MAX_LABELS);
    const rest = labels.length - shown.length;
    lines.push(`Labels: ${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`);
  }
  return lines;
}

export function formatForgeIssueCommentPreviewLines(preview: ForgeIssueCommentPreview): string[] {
  return [
    worktreeLine(preview.worktreePath),
    `Issue: #${preview.issueNumber}`,
    ...contentSection("Comment", preview.body, MAX_BODY_CHARS, MAX_BODY_LINES),
  ];
}
