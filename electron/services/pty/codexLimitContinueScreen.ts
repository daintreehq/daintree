import type {
  CodexLimitContinueLine,
  CodexLimitContinueSkipReason,
} from "../../../shared/types/codexLimitContinuation.js";
import { expandCursorForward, stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import {
  inputSuggestionRuleFor,
  observeInputLine,
} from "../../../shared/utils/terminalInputLine.js";
import { locateCodexLimitBanner } from "./CodexUsageLimit.js";

/** The serializer's switch into the alternate screen; only what follows it is on view. */
const ALT_SCREEN_ENTER = "\x1b[?1049h";
/** Codex's composer row (`codex.ts` `inputSuggestion.promptRowPattern`), after its column-0 pad. */
const PROMPT_ROW = /^\s*›(?:\s|$)/;
/** The footer of a `/goal` run stopped by a usage limit (codex-rs `footer.rs`). */
const GOAL_USAGE_LIMITED = "Goal hit usage limits (/goal resume)";
/**
 * Any other goal status, or one clipped at a narrow width: a `/goal` run in a
 * state this doesn't know how to resume.
 */
const GOAL_WORD = /\bgoal\b/i;
/** Plan mode's indicator takes the footer slot a goal status would show in. */
const PLAN_MODE = /\bPlan mode\b/;
/**
 * The narrowest pane whose footer always has room for the goal label: Codex
 * drops a label that doesn't fit its row (`passive_hints.rs`), so below this
 * a footer without one says nothing about whether a goal is running.
 */
const MIN_COLS_FOR_GOAL_LABEL = GOAL_USAGE_LIMITED.length + 4;
/** Codex's Vim mode label, which outranks the goal label for room on its row. */
const VIM_LABEL = /\bVim\b/;
const VIM_LABEL_COLS = "Vim: Insert · ".length;
/**
 * Rows Codex draws below an empty composer: its footer, and room for a status
 * line, each indented as Codex draws them. Anything longer, or a row written
 * from the left edge, is something else printed after it (a shell prompt once
 * Codex has exited).
 */
const MAX_FOOTER_ROWS = 3;
const FOOTER_ROW = /^\s+\S/;

/** History above a stop banner, as text, that tells a redisplay of it from a new stop with the same words. */
const STOP_CONTEXT_ROWS = 8;
const STOP_CONTEXT_CHARS = 80;

/**
 * The history just above the banner at `bannerStart` (#17909): its last
 * characters with every space dropped, so a rewrap at another width reads the
 * same and only other history reads differently.
 */
export function codexStopContext(lines: readonly string[], bannerStart: number): string {
  return lines
    .slice(Math.max(0, bannerStart - STOP_CONTEXT_ROWS), bannerStart)
    .map((line) => stripAnsiCodes(line))
    .join("")
    .replace(/\s+/g, "")
    .slice(-STOP_CONTEXT_CHARS);
}

export type CodexLimitScreenVerdict =
  { line: CodexLimitContinueLine } | { skip: CodexLimitContinueSkipReason };

function plainRows(serialized: string): string[] {
  const switchAt = serialized.lastIndexOf(ALT_SCREEN_ENTER);
  const screen =
    switchAt === -1 ? serialized : serialized.slice(switchAt + ALT_SCREEN_ENTER.length);
  return screen.split("\n").map((row) => stripAnsiCodes(expandCursorForward(row)).trimEnd());
}

/**
 * Whether a Codex pane's screen is still the one its usage limit left (#17909),
 * and the line that continues it: the stop banner `bannerKey` names, the last
 * thing above an empty composer that is the last thing on screen but its
 * footer, and a footer that says which line. A plain turn takes `continue`, a
 * `/goal` run that hit the limit takes `/goal resume`, and anything else is a
 * skip. Nothing of the screen leaves here.
 */
export function judgeCodexLimitScreen(
  serialized: string,
  cols: number | undefined,
  bannerKey: string
): CodexLimitScreenVerdict {
  const rows = plainRows(serialized);
  // The banner reader takes the rows without the blank ones between cells.
  const written = rows.flatMap((row, index) => (row.trim() === "" ? [] : [index]));
  const located = locateCodexLimitBanner(
    written.map((index) => rows[index]!),
    cols
  );
  if (located === null || located.banner.kind === "unreadable") return { skip: "banner-gone" };
  // Another stop drawn since the one the wait was for, which the pane's last
  // look may not have caught up with yet.
  if (JSON.stringify(located.banner) !== bannerKey) return { skip: "banner-changed" };
  const promptAt = located.end + 1;
  if (promptAt >= written.length) return { skip: "no-composer" };
  if (!PROMPT_ROW.test(rows[written[promptAt]!]!)) return { skip: "banner-not-last" };
  const below = written.slice(promptAt + 1).map((index) => rows[index]!);
  if (
    below.length > MAX_FOOTER_ROWS ||
    below.some((row) => PROMPT_ROW.test(row) || !FOOTER_ROW.test(row))
  ) {
    return { skip: "banner-not-last" };
  }
  const inputLine = observeInputLine(serialized, inputSuggestionRuleFor("codex")).inputLine;
  if (inputLine.state === "unknown") return { skip: "no-composer" };
  if (inputLine.state !== "empty") return { skip: "draft" };
  if (below.some((row) => row.includes(GOAL_USAGE_LIMITED))) return { line: "/goal resume" };
  if (below.some((row) => GOAL_WORD.test(row) || PLAN_MODE.test(row))) {
    return { skip: "unrecognized-footer" };
  }
  const roomForGoal =
    MIN_COLS_FOR_GOAL_LABEL + (below.some((row) => VIM_LABEL.test(row)) ? VIM_LABEL_COLS : 0);
  if (cols === undefined || cols < roomForGoal) return { skip: "unrecognized-footer" };
  return { line: "continue" };
}
