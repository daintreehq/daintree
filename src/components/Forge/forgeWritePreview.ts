/**
 * Content previews for the forge writes that publish something a person cannot
 * retract (#12118).
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
/** Long enough for any real label or path, short enough that neither can flood the card. */
const MAX_LABEL_CHARS = 80;
const MAX_PATH_CHARS = 200;
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

/** A caution line, in the host's own voice. */
function caution(text: string): string {
  return `${MCP_PREVIEW_CAUTION_PREFIX}${text}`;
}

/**
 * Split on every line terminator a caller can send, not just `\n`.
 *
 * A body using lone `\r` breaks would otherwise count as one line and slip the
 * whole of itself past the line bound while still rendering as many rows.
 */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function indent(text: string): string[] {
  return splitLines(text).map((line) => `${CONTENT_INDENT}${line}`);
}

/**
 * Bound `text`, counting and cutting by CODE POINT rather than UTF-16 unit.
 *
 * `slice()` on a unit index bisects a surrogate pair, so an emoji on the
 * boundary renders as a replacement glyph and the "N more characters" count
 * describes units nobody typed. Neither is a safety hole on its own, but a
 * preview whose whole job is to show exactly what gets published should not
 * mangle it, and the count an approver reads should be in the units they think
 * in.
 */
function boundText(
  text: string,
  maxChars: number,
  maxLines: number
): { shown: string; omitted: number } {
  const points = Array.from(text);
  let shown = points.length > maxChars ? points.slice(0, maxChars).join("") : text;
  const lines = splitLines(shown);
  if (lines.length > maxLines) shown = lines.slice(0, maxLines).join("\n");
  return { shown, omitted: points.length - Array.from(shown).length };
}

/** One bounded value on a single line, for a label or a path. */
function boundValue(text: string, maxChars: number): string {
  const points = Array.from(text);
  return points.length > maxChars ? `${points.slice(0, maxChars - 1).join("")}…` : text;
}

/**
 * Render bounded authored text under a heading, with a caution naming what was
 * left out.
 *
 * The caution is not decoration. Truncating silently would show an approver
 * part of a body and take their approval for the whole of it — the same defect
 * as previewing a count instead of content, one level down.
 */
function contentSection(
  heading: string,
  text: string,
  maxChars: number,
  maxLines: number
): string[] {
  const { shown, omitted } = boundText(text, maxChars, maxLines);
  const lines = [`${heading}:`, ...indent(shown)];
  if (omitted > 0) {
    lines.push(
      caution(
        `Shown in part — ${omitted} more character${omitted === 1 ? "" : "s"} will be published than appear above.`
      )
    );
  }
  return lines;
}

export interface ForgeCreateIssuePreview {
  /**
   * The worktree whose forge remote the issue is filed against, or `undefined`
   * when the dispatch named one this view cannot resolve.
   *
   * Optional on purpose. Withholding the whole preview because the repository
   * could not be identified would hand the approver the redacted argument
   * summary for the one action whose content is the point — so the content is
   * always shown and the unresolved target is stated as a caution instead.
   */
  worktreePath: string | undefined;
  title: string;
  body: string | undefined;
  labels: readonly string[] | undefined;
}

export interface ForgeIssueCommentPreview {
  worktreePath: string | undefined;
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
function worktreeLine(worktreePath: string | undefined): string {
  return worktreePath === undefined
    ? caution(
        "Couldn't identify the repository this would be published to. Approve only if you already know which one the dispatch targets."
      )
    : `Worktree: ${boundValue(worktreePath, MAX_PATH_CHARS)}`;
}

/**
 * Labels one per line rather than joined.
 *
 * A comma-joined list cannot be read back unambiguously — `["a, b"]` and
 * `["a", "b"]` render identically — and a bare `(+N more)` tail is the count
 * the D2 rule calls insufficient. Every label that will be applied is either
 * shown on its own line or accounted for by a caution in the host's voice.
 */
function labelSection(labels: readonly string[] | undefined): string[] {
  const list = labels ?? [];
  if (list.length === 0) return ["Labels: (none)"];
  const shown = list.slice(0, MAX_LABELS);
  const lines = [
    "Labels:",
    ...shown.map((l) => `${CONTENT_INDENT}${boundValue(l, MAX_LABEL_CHARS)}`),
  ];
  const rest = list.length - shown.length;
  if (rest > 0) {
    lines.push(
      caution(`${rest} further label${rest === 1 ? "" : "s"} will be applied but are not listed.`)
    );
  }
  return lines;
}

export function formatForgeCreateIssuePreviewLines(preview: ForgeCreateIssuePreview): string[] {
  const lines = [worktreeLine(preview.worktreePath)];
  lines.push(...contentSection("Title", preview.title, MAX_TITLE_CHARS, 1));
  lines.push(
    ...(preview.body === undefined || preview.body.length === 0
      ? ["Body:", `${CONTENT_INDENT}(none)`]
      : contentSection("Body", preview.body, MAX_BODY_CHARS, MAX_BODY_LINES))
  );
  lines.push(...labelSection(preview.labels));
  return lines;
}

export function formatForgeIssueCommentPreviewLines(preview: ForgeIssueCommentPreview): string[] {
  return [
    worktreeLine(preview.worktreePath),
    `Issue: #${preview.issueNumber}`,
    ...contentSection("Comment", preview.body, MAX_BODY_CHARS, MAX_BODY_LINES),
  ];
}
