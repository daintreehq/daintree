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
 * and the line that continues it: the stop banner the last thing above an
 * empty composer, and a footer that says which line. A plain turn takes
 * `continue`, a `/goal` run that hit the limit takes `/goal resume`, and
 * anything else is a skip. Nothing of the screen leaves here.
 */
export function judgeCodexLimitScreen(
  serialized: string,
  cols: number | undefined
): CodexLimitScreenVerdict {
  const rows = plainRows(serialized);
  // The banner reader takes the rows without the blank ones between cells.
  const written = rows.flatMap((row, index) => (row.trim() === "" ? [] : [index]));
  const located = locateCodexLimitBanner(
    written.map((index) => rows[index]!),
    cols
  );
  if (located === null || located.banner.kind === "unreadable") return { skip: "banner-gone" };
  const promptAt = located.end + 1;
  if (promptAt >= written.length) return { skip: "no-composer" };
  if (!PROMPT_ROW.test(rows[written[promptAt]!]!)) return { skip: "banner-not-last" };
  const inputLine = observeInputLine(serialized, inputSuggestionRuleFor("codex")).inputLine;
  if (inputLine.state === "unknown") return { skip: "no-composer" };
  if (inputLine.state !== "empty") return { skip: "draft" };
  const footer = written.slice(promptAt + 1).map((index) => rows[index]!);
  if (footer.some((row) => row.includes(GOAL_USAGE_LIMITED))) return { line: "/goal resume" };
  if (footer.some((row) => GOAL_WORD.test(row) || PLAN_MODE.test(row))) {
    return { skip: "unrecognized-footer" };
  }
  return { line: "continue" };
}
