/**
 * The confirm preview for a `terminal.new` dispatch that names a launch target
 * (#12216).
 *
 * `terminal.new` is statically `safe`; an agent- or plugin-sourced dispatch
 * carrying `command` or `cwd` is elevated per-dispatch, and the modal that
 * elevation raises is the ONLY gate on that shell execution. The dialog's
 * collapsed argument summary cannot stand in for a preview here:
 * `summarizeMcpArgs` replaces any string over `MCP_ARGS_INLINE_STRING_LIMIT`
 * (50) with `<string: N chars>`, which is every realistic command and most
 * absolute paths — so without this card the approver reads a character count
 * where the command should be.
 *
 * Pure formatting over the dispatch arguments, on the `forgeWritePreview` model:
 * for this action the arguments ARE the content, so there is nothing to fetch
 * and nothing that can change between the preview and `run()`.
 */

import { MCP_PREVIEW_CAUTION_PREFIX } from "@/lib/mcpPreviewLines";

export interface TerminalLaunchPreview {
  /** The command the new terminal runs on start, or undefined for a bare shell. */
  command: string | undefined;
  /** The directory the terminal opens in, or undefined for the active worktree. */
  cwd: string | undefined;
}

/**
 * Generous bounds: the card scrolls, and a command elided to its first clause
 * is barely better than the `<string: N chars>` it replaces. A command can
 * still be a pasted heredoc, so both a character and a line ceiling apply.
 */
const MAX_COMMAND_CHARS = 1000;
const MAX_COMMAND_LINES = 20;
/** Long enough for any real path, short enough that one cannot flood the card. */
const MAX_PATH_CHARS = 200;

/**
 * Two spaces in front of every line of caller-supplied text, load-bearing
 * rather than cosmetic. `McpConfirmDialog` renders a line starting with
 * `MCP_PREVIEW_CAUTION_PREFIX` as a warning in the host's own voice, so an
 * unindented command beginning with that marker would forge one inside the
 * dialog that gates it. Same defence as `forgeWritePreview`'s content indent.
 */
const CONTENT_INDENT = "  ";

/** Every line terminator a caller can send, not just `\n`. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Bound by CODE POINT rather than UTF-16 unit: slicing on a unit index bisects
 * a surrogate pair, so an emoji on the boundary renders as a replacement glyph
 * and the omitted count is in units nobody typed.
 */
function boundPath(path: string): string {
  const points = Array.from(path);
  return points.length > MAX_PATH_CHARS ? `${points.slice(0, MAX_PATH_CHARS - 1).join("")}…` : path;
}

/**
 * The command verbatim, with a caution naming whatever was cut.
 *
 * Truncating silently would show an approver part of a command and take their
 * approval for the whole of it — the same defect as previewing a count instead
 * of content, one level down.
 */
function commandSection(command: string): string[] {
  const points = Array.from(command);
  let shown =
    points.length > MAX_COMMAND_CHARS ? points.slice(0, MAX_COMMAND_CHARS).join("") : command;
  const lines = splitLines(shown);
  if (lines.length > MAX_COMMAND_LINES) shown = lines.slice(0, MAX_COMMAND_LINES).join("\n");
  const omitted = points.length - Array.from(shown).length;
  const section = ["Runs:", ...splitLines(shown).map((line) => `${CONTENT_INDENT}${line}`)];
  if (omitted > 0) {
    section.push(
      `${MCP_PREVIEW_CAUTION_PREFIX}Shown in part — ${omitted} more character${omitted === 1 ? "" : "s"} will run than appear above.`
    );
  }
  return section;
}

/**
 * Directory first, then what runs in it. The directory is the line an approver
 * can least infer from the command, and a login shell starting there is itself
 * the reason a `cwd` alone is gated.
 */
export function formatTerminalLaunchPreviewLines(preview: TerminalLaunchPreview): string[] {
  return [
    preview.cwd === undefined
      ? "Directory: the active worktree"
      : `Directory: ${boundPath(preview.cwd)}`,
    ...(preview.command === undefined
      ? ["Runs: nothing — the shell opens at a prompt and waits"]
      : commandSection(preview.command)),
  ];
}
