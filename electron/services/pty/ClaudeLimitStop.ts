import type { CodexLimitContinueSkipReason } from "../../../shared/types/codexLimitContinuation.js";
import type { CodexLimitUnknownReason } from "../../../shared/types/codexLimitReset.js";
import type { ClaudeUsageWindow } from "../../../shared/types/ipc/agentQuota.js";
import { resolveResetsAt } from "./ClaudeUsageWarnings.js";
import { readClaudeLimitScreen } from "./claudeLimitStopScreen.js";

/** Claude prints the reset's minute without its seconds: it has passed once that minute ends. */
const MINUTE_MS = 60_000;
const ESC = "\x1b";

/** An Escape, or the double Escape an assistant's steer sends, alone in a write. */
function isEscapeOnly(data: string): boolean {
  return data === ESC || data === ESC + ESC;
}

/** What has happened to a pane since its stop first showed (#17909). */
export interface LimitStopGuard {
  /** The stop it was for. */
  key: string;
  /** The terminal's input count when it first showed: any later write is input since the stop. */
  inputSeq: number;
  /** A choice dialog was observed since, whatever the screen shows now. */
  dialogSeen: boolean;
}

/** Why a stop is recorded as skipped the moment it is seen, rather than waited on. */
export type ClaudeStopSkip = Extract<
  CodexLimitContinueSkipReason,
  "auto-continue-cancelled" | "input-since"
>;

/** A Claude Code stop Daintree may continue at the reset (#18192). */
export interface ClaudeLimitStop {
  seq: number;
  /** The banner, the history above it, and whether Claude's wait was cancelled. */
  key: string;
  /** The same without the history, as the reset's check compares it. */
  bannerKey: string;
  incarnation: number;
  observedSince: number | null;
  /** When this stop first showed. */
  observedAt: number;
  /** Epoch ms by which the spent window has reset, or why that can't be told. */
  reset: { resetsAt: number } | { reason: CodexLimitUnknownReason };
  /** Set when the stop isn't Daintree's to continue, whatever its reset; arming again lifts it. */
  skipAtStop: ClaudeStopSkip | null;
  guard: LimitStopGuard;
  /** The latest look showed it, with no wait of Claude's own. */
  shown: boolean;
  /** The latest look showed Claude's own wait instead. */
  ownWait: boolean;
}

/** One look at the pane, with what the terminal knew at that moment. */
export interface ClaudeLimitLook {
  now: number;
  cols: number | undefined;
  inputSeq: number;
  incarnation: number;
  observedSince: number | null;
  /** When the pane first showed `window`'s reached limit with `resetText`, if that is known. */
  shownAt(window: ClaudeUsageWindow, resetText: string): number | null;
}

interface InputSinceBanner {
  /** Anyone's input but an assistant's: a person, a broadcast, Daintree's own lane. */
  unowned: boolean;
  assistantEscape: boolean;
  assistantOther: boolean;
}

const NO_INPUT: InputSinceBanner = {
  unowned: false,
  assistantEscape: false,
  assistantOther: false,
};

/**
 * The stop of an armed Claude Code pane (#18192). Claude waits out a usage
 * limit by itself while its "continuing automatically" line shows, so that
 * screen is never a stop. Once that wait is gone (cancelled, or never drawn)
 * the banner above an idle composer is one, guarded from the moment it first
 * showed, so the Escape that cancelled the wait isn't input since it.
 *
 * Who cancelled the wait decides whether Daintree may continue it at all: a
 * person's Escape means leave it. Every write since the banner came up is
 * what can have cancelled it, kept until a look shows no live banner (a
 * sample in flight can show a frame drawn before a key, so a look that still
 * shows the banner never clears them). Only an assistant's own Escape there
 * (an assistant clearing a menu) leaves the stop Daintree's. A cancellation
 * nothing explains is a person's too, unless the pane was armed with nothing
 * typed since: arming it is the ask.
 */
export class ClaudeLimitStopTracker {
  private stop: ClaudeLimitStop | null = null;
  private sinceBanner: InputSinceBanner = { ...NO_INPUT };
  /** Armed, with no input and no look without a live banner since. */
  private armExplains = false;

  constructor(private readonly nextSeq: () => number) {}

  held(): ClaudeLimitStop | null {
    return this.stop;
  }

  /** Forget everything: the agent gone or replaced, or the pane torn down. */
  clear(): void {
    this.stop = null;
    this.sinceBanner = { ...NO_INPUT };
    this.armExplains = false;
  }

  /**
   * The pane was armed. A stop still held from an earlier arming keeps what
   * happened since it showed, but arming is the ask to continue it, which
   * lifts a verdict that it was a person's.
   */
  arm(): void {
    this.sinceBanner = { ...NO_INPUT };
    this.armExplains = true;
    if (this.stop) this.stop.skipAtStop = null;
  }

  /** A write of input, as the pty host took it; `owner` names the assistant it was written for. */
  noteInput(data: string, owner: string | undefined): void {
    this.armExplains = false;
    if (owner === undefined) this.sinceBanner.unowned = true;
    else if (isEscapeOnly(data)) this.sinceBanner.assistantEscape = true;
    else this.sinceBanner.assistantOther = true;
  }

  noteDialog(): void {
    if (this.stop) this.stop.guard.dialogSeen = true;
  }

  observe(lines: readonly string[], look: ClaudeLimitLook): void {
    const screen = readClaudeLimitScreen(lines, look.cols);
    // A banner with no composer drawn under it (half drawn, a dialog in its
    // place) says nothing either way.
    if (screen === "no-composer") return;
    const held = this.stop;
    if (screen === null || !screen.last) {
      // No live banner: what was typed before it can't be what cancels its
      // wait, and an arming has nothing on screen to answer for.
      this.sinceBanner = { ...NO_INPUT };
      this.armExplains = false;
      if (held === null) return;
      // A turn printed after the banner ends that stop. One only out of view
      // (a transcript open over it) may come back as it was.
      if (screen !== null) {
        this.stop = null;
        return;
      }
      held.shown = false;
      held.ownWait = false;
      return;
    }
    if (screen.countdown) {
      if (held) {
        held.shown = false;
        held.ownWait = true;
      }
      return;
    }
    if (
      held &&
      held.key === screen.key &&
      held.incarnation === look.incarnation &&
      held.observedSince === look.observedSince
    ) {
      held.shown = true;
      held.ownWait = false;
      return;
    }
    // The same stop seen again after a gap in the read, or under a new run of
    // the agent, keeps what happened since it first showed.
    const kept = held?.key === screen.key ? held : null;
    this.stop = {
      seq: this.nextSeq(),
      key: screen.key,
      bannerKey: screen.bannerKey,
      incarnation: look.incarnation,
      observedSince: look.observedSince,
      observedAt: kept?.observedAt ?? look.now,
      reset: kept?.reset ?? resetOf(screen.window, screen.resetText, look),
      skipAtStop: kept ? kept.skipAtStop : screen.cancelled ? this.cancelledVerdict() : null,
      guard: kept?.guard ?? { key: screen.key, inputSeq: look.inputSeq, dialogSeen: false },
      shown: true,
      ownWait: false,
    };
  }

  /** Whether a cancelled wait is Daintree's to continue: null when it is, else why not. */
  private cancelledVerdict(): ClaudeStopSkip | null {
    const input = this.sinceBanner;
    if (input.unowned) return "auto-continue-cancelled";
    if (input.assistantOther) return "input-since";
    if (input.assistantEscape || this.armExplains) return null;
    return "auto-continue-cancelled";
  }
}

function resetOf(
  window: ClaudeUsageWindow,
  resetText: string | null,
  look: ClaudeLimitLook
): ClaudeLimitStop["reset"] {
  if (resetText === null) return { reason: "no-reset-stated" };
  // Read against when the pane first showed it, so a bare time seen at 2:59
  // and looked at again after 3:00 is still today's.
  const resetsAt = resolveResetsAt(resetText, look.shownAt(window, resetText) ?? look.now);
  return resetsAt === null ? { reason: "unreadable-time" } : { resetsAt: resetsAt + MINUTE_MS };
}
