import type { CodexLimitContinueSkipReason } from "../../../shared/types/codexLimitContinuation.js";
import type { ClaudeUsageWindow } from "../../../shared/types/ipc/agentQuota.js";
import { expandCursorForward, stripAnsiCodes } from "../../../shared/utils/artifactParser.js";
import {
  inputSuggestionRuleFor,
  observeInputLine,
} from "../../../shared/utils/terminalInputLine.js";
import { locateClaudeUsageMessages } from "./ClaudeUsageWarnings.js";
import { codexStopContext } from "./codexLimitContinueScreen.js";

/** The serializer's switch into the alternate screen; only what follows it is on view. */
const ALT_SCREEN_ENTER = "\x1b[?1049h";
// The composer's first row: its prompt glyph, inside a box edge on older builds.
const PROMPT_ROW = /^\s*(?:[│┃]\s*)?[❯>](?:\s|$)/;
// A rule or box edge across the pane. Two single-class tests, each linear.
const RULE_RUN = /[─━═]{8}/;
const RULE_ONLY = /^[\s─━═╭╮╰╯]+$/;
/** Rows a multi-line draft may take between the composer's edges. */
const MAX_INPUT_ROWS = 8;
/**
 * Claude Code's own wait for the reset (2.1.x), drawn under the composer:
 * "Usage limit reached · continuing automatically at 10am · esc to cancel".
 */
const COUNTDOWN = /\bcontinuing\s+automatically\b/i;
/** The notice once Escape cancels that wait, behind the tool-result gutter. */
const CANCELLED = /^\s*(?:⎿\s*)?Automatic continue cancelled\b/i;
/**
 * A row carrying on the message above it: indented text that opens no new
 * transcript entry (an assistant bullet, a tool result, a prompt echo, a
 * spinner).
 */
const CARRIED = /^\s+[^\s●⎿❯>│┃✻✶✳✢·*]/;

function isRule(row: string): boolean {
  return RULE_RUN.test(row) && RULE_ONLY.test(row);
}

/**
 * A Claude Code pane's screen at a usage limit (#18192): the limit banner
 * last in the transcript, whether Claude's own wait for the reset is on
 * screen or was cancelled, and the history above it. The banner's text stays
 * in the pty host.
 */
export interface ClaudeLimitScreen {
  window: ClaudeUsageWindow;
  resetText: string | null;
  /** Names the stop: the banner, the history above it, and whether its wait was cancelled. */
  key: string;
  /**
   * The banner and whether its wait was cancelled, without the history: a
   * sample reads the viewport and the reset's check the whole buffer, which
   * can cut that history differently.
   */
  bannerKey: string;
  /** Claude's own "continuing automatically" wait is on screen. */
  countdown: boolean;
  /** Claude's notice that Escape cancelled that wait sits under the banner. */
  cancelled: boolean;
  /** Only the banner's own rows and the cancel notice come between it and the composer. */
  last: boolean;
}

/**
 * Read `lines` for Claude's stop banner (#18192): null when no reached-limit
 * banner sits above the composer, `no-composer` when one is drawn but the
 * composer under it isn't (a half-drawn frame, a dialog in its place), which
 * says nothing either way.
 */
export function readClaudeLimitScreen(
  lines: readonly string[],
  cols: number | undefined
): ClaudeLimitScreen | "no-composer" | null {
  // Blank rows dropped, as a viewport read drops them, so a sample and the
  // serialized screen read the same.
  const rows = lines
    .map((line) => stripAnsiCodes(expandCursorForward(line)).trimEnd())
    .filter((row) => row.trim() !== "");
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isRule(rows[i]!)) {
      bottom = i;
      break;
    }
  }
  let top = -1;
  for (let i = bottom - 1; i >= 1 && bottom - i <= MAX_INPUT_ROWS; i--) {
    if (PROMPT_ROW.test(rows[i]!) && isRule(rows[i - 1]!)) {
      top = i - 1;
      break;
    }
  }
  const reached = (from: readonly string[]) =>
    locateClaudeUsageMessages(from, cols)
      .filter((message) => message.statement === "reached")
      .at(-1);
  if (top === -1) return reached(rows) === undefined ? null : "no-composer";
  const transcript = rows.slice(0, top);
  const banner = reached(transcript);
  if (banner === undefined) return null;
  const after = transcript.slice(banner.row + 1);
  const footer = rows.slice(bottom + 1).join(" ");
  const cancelled = after.some((row) => CANCELLED.test(row));
  const context = codexStopContext(transcript, banner.row);
  return {
    window: banner.window,
    resetText: banner.resetText,
    key: JSON.stringify([banner.window, banner.resetText, cancelled, context]),
    bannerKey: JSON.stringify([banner.window, banner.resetText, cancelled]),
    countdown: COUNTDOWN.test(footer) || after.some((row) => COUNTDOWN.test(row)),
    cancelled,
    last: after.every((row) => CANCELLED.test(row) || CARRIED.test(row)),
  };
}

function viewRows(serialized: string): string[] {
  const switchAt = serialized.lastIndexOf(ALT_SCREEN_ENTER);
  const screen =
    switchAt === -1 ? serialized : serialized.slice(switchAt + ALT_SCREEN_ENTER.length);
  return screen.split("\n");
}

export type ClaudeLimitScreenVerdict =
  { line: "continue" } | { skip: CodexLimitContinueSkipReason };

/**
 * Whether a Claude Code pane's screen is still the one its stop left
 * (#18192): the banner `bannerKey` names, with no wait of Claude's own on
 * screen, the last thing above an empty composer. Claude takes `continue`.
 */
export function judgeClaudeLimitScreen(
  serialized: string,
  cols: number | undefined,
  bannerKey: string
): ClaudeLimitScreenVerdict {
  const screen = readClaudeLimitScreen(viewRows(serialized), cols);
  if (screen === null) return { skip: "banner-gone" };
  if (screen === "no-composer") return { skip: "no-composer" };
  if (screen.bannerKey !== bannerKey) return { skip: "banner-changed" };
  if (screen.countdown) return { skip: "own-wait" };
  if (!screen.last) return { skip: "banner-not-last" };
  const inputLine = observeInputLine(serialized, inputSuggestionRuleFor("claude")).inputLine;
  if (inputLine.state === "unknown") return { skip: "no-composer" };
  // A suggestion is Claude's dim offer, not text in the box: typing replaces it.
  if (inputLine.state === "typed") return { skip: "draft" };
  return { line: "continue" };
}
