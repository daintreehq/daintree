import type {
  CodexLimitUnknownReason,
  CodexLimitStopSkip,
} from "../../../shared/types/codexLimitReset.js";
import type { ClaudeUsageWindow } from "../../../shared/types/ipc/agentQuota.js";
import { resolveResetsAt } from "./ClaudeUsageWarnings.js";
import { readClaudeLimitScreen } from "./claudeLimitStopScreen.js";
import { limitStopIdentity } from "./limitStopIdentity.js";

/** Claude prints the reset's minute without its seconds: it has passed once that minute ends. */
const MINUTE_MS = 60_000;
/**
 * How long before a look first showed the banner an Escape still counts
 * toward cancelling its wait: a sample in flight can show a frame drawn
 * before the key, and so place the banner's first look after it.
 */
export const ESCAPE_GRACE_MS = 2_000;
/** Escapes remembered while armed: enough for the keys around one cancel. */
const MAX_ESCAPES = 16;
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

/** A Claude Code stop Daintree may continue at the reset (#18192). */
export interface ClaudeLimitStop {
  seq: number;
  /** The banner and whether Claude's wait was cancelled, as the reset's check compares it. */
  bannerKey: string;
  /**
   * The banner alone, whether or not a wait of Claude's was drawn with it, as
   * a digest: what a stop saved before a cold restart is matched on (#18193).
   */
  identity: string;
  /**
   * First seen by a restored process before any input reached it, so a
   * redraw of the conversation it resumed rather than a limit it hit (#18193).
   */
  replay: boolean;
  /** The history above the banner, the most of it any look showed. */
  context: string;
  incarnation: number;
  observedSince: number | null;
  /** When this stop first showed. */
  observedAt: number;
  /** Epoch ms by which the spent window has reset, or why that can't be told. */
  reset: { resetsAt: number } | { reason: CodexLimitUnknownReason };
  /** Set when the stop isn't Daintree's to continue, whatever its reset; arming again lifts it. */
  skipAtStop: CodexLimitStopSkip | null;
  guard: LimitStopGuard;
  /** The latest look showed it, with no wait of Claude's own. */
  shown: boolean;
  /** The latest look showed Claude's own wait instead. */
  ownWait: boolean;
  /** A turn was printed after it: the same words seen again are another stop. */
  ended: boolean;
}

/** One look at the pane, with what the terminal knew at that moment. */
export interface ClaudeLimitLook {
  now: number;
  /** A monotonic clock, which orders the look against keys and an arming. */
  tick: number;
  cols: number | undefined;
  inputSeq: number;
  incarnation: number;
  observedSince: number | null;
  /** When the pane first showed `window`'s reached limit with `resetText`, if that is known. */
  shownAt(window: ClaudeUsageWindow, resetText: string): number | null;
  /** A restored process that has taken no input yet: what it shows is its resumed history (#18193). */
  replay?: boolean;
}

/**
 * Claude Code's own wait for the reset, on screen in an armed pane (#18193). It
 * is a timer inside the CLI's process, so a cold restart loses it; Daintree
 * saves it as Daintree quits, and never acts on it while it runs.
 */
export interface ClaudeOwnWait {
  identity: string;
  incarnation: number;
  reset: ClaudeLimitStop["reset"];
  /** The terminal's input count when it first showed. */
  inputSeq: number;
}

interface EscapeNote {
  /** On the monotonic clock. */
  at: number;
  /** Written for an assistant, rather than a person's (or nobody's) key. */
  assistant: boolean;
}

/**
 * The stop of an armed Claude Code pane (#18192). Claude waits out a usage
 * limit by itself while its "continuing automatically" line shows, so that
 * screen is never a stop. Once that wait is gone (cancelled, or never drawn)
 * the banner above an idle composer is one, guarded from the moment it first
 * showed, so the Escape that cancelled the wait isn't input since it.
 *
 * Who cancelled the wait decides whether Daintree may continue it at all: a
 * person's Escape means leave it. The Escapes that can have cancelled it are
 * those written since the banner came up (allowing for a sample that placed
 * it late), or since the pane was armed if that was later: arming is the ask
 * to continue it. Only an assistant's own Escape there (an assistant clearing
 * a menu) leaves the stop Daintree's; with none, an arming made while the
 * banner showed does. Anything else is the person's to resume.
 */
export class ClaudeLimitStopTracker {
  private stop: ClaudeLimitStop | null = null;
  private countdown: ClaudeOwnWait | null = null;
  private escapes: EscapeNote[] = [];
  /** When a look first showed a live banner, since the last that showed none (monotonic). */
  private bannerSince: number | null = null;
  /** When the pane was armed (monotonic). */
  private armedAt: number | null = null;

  constructor(private readonly nextSeq: () => number) {}

  held(): ClaudeLimitStop | null {
    return this.stop;
  }

  /** Claude's own wait as the latest look showed it, or null. */
  ownWait(): ClaudeOwnWait | null {
    return this.countdown;
  }

  /** Forget everything: the pane torn down. */
  clear(): void {
    this.stop = null;
    this.countdown = null;
    if (this.escapes.length > 0) this.escapes = [];
    this.bannerSince = null;
    this.armedAt = null;
  }

  /**
   * Claude isn't what the pane shows now (another agent detected, or none).
   * The stop is kept out of view rather than forgotten: Claude back under the
   * same run brings it back with what happened since it showed.
   */
  hide(): void {
    this.bannerSince = null;
    this.countdown = null;
    if (this.stop) {
      this.stop.shown = false;
      this.stop.ownWait = false;
    }
  }

  /**
   * The pane was armed at `tick`. A stop still held from an earlier arming
   * keeps what happened since it showed, but arming is the ask to continue
   * it, which lifts a verdict that it was a person's.
   */
  arm(tick: number): void {
    this.armedAt = tick;
    if (this.stop) this.stop.skipAtStop = null;
  }

  /** A write of input at monotonic `at`, as the pty host took it; `owner` names the assistant it was written for. */
  noteInput(data: string, owner: string | undefined, at: number): void {
    if (!isEscapeOnly(data)) return;
    this.escapes.push({ at, assistant: owner !== undefined });
    if (this.escapes.length > MAX_ESCAPES) this.escapes.shift();
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
    if (screen === null || !screen.last || !screen.countdown) this.countdown = null;
    if (screen === null || !screen.last) {
      this.bannerSince = null;
      if (held) {
        held.shown = false;
        held.ownWait = false;
        // Something printed after the banner. A turn ends the stop; a row
        // drawn only for a moment brings the same stop back, guarded as it was.
        if (screen !== null) held.ended = true;
      }
      return;
    }
    this.bannerSince ??= look.tick;
    const identity = limitStopIdentity("claude", JSON.stringify([screen.window, screen.resetText]));
    if (screen.countdown) {
      if (held) {
        held.shown = false;
        held.ownWait = true;
      }
      const seen = this.countdown;
      if (seen === null || seen.identity !== identity || seen.incarnation !== look.incarnation) {
        this.countdown = {
          identity,
          incarnation: look.incarnation,
          reset: resetOf(screen.window, screen.resetText, look),
          inputSeq: look.inputSeq,
        };
      }
      return;
    }
    const same =
      held !== null &&
      held.bannerKey === screen.bannerKey &&
      held.incarnation === look.incarnation &&
      sameHistory(held.context, screen.context);
    const context =
      same && held.context.length > screen.context.length ? held.context : screen.context;
    if (same && !held.ended && held.observedSince === look.observedSince) {
      held.shown = true;
      held.ownWait = false;
      held.context = context;
      return;
    }
    // The same stop of the same run seen again keeps its guard: input since
    // it first showed still counts. After a gap in the read it is the stop it
    // was; after a turn ran past it, its sighting and verdict start afresh.
    const kept = same ? held : null;
    const resumed = kept !== null && !kept.ended;
    this.stop = {
      seq: this.nextSeq(),
      bannerKey: screen.bannerKey,
      identity,
      replay: resumed ? kept.replay : look.replay === true,
      context,
      incarnation: look.incarnation,
      observedSince: look.observedSince,
      observedAt: resumed ? kept.observedAt : look.now,
      reset: resumed ? kept.reset : resetOf(screen.window, screen.resetText, look),
      skipAtStop: resumed
        ? kept.skipAtStop
        : screen.cancelled
          ? this.cancelledVerdict(this.bannerSince)
          : null,
      guard: kept?.guard ?? { key: screen.key, inputSeq: look.inputSeq, dialogSeen: false },
      shown: true,
      ownWait: false,
      ended: false,
    };
  }

  /** Whether a cancelled wait is Daintree's to continue: null when it is. */
  private cancelledVerdict(bannerSince: number): CodexLimitStopSkip | null {
    const armedAt = this.armedAt;
    const since = Math.max(bannerSince - ESCAPE_GRACE_MS, armedAt ?? -Infinity);
    const escapes = this.escapes.filter((escape) => escape.at >= since);
    if (escapes.some((escape) => !escape.assistant)) return "auto-continue-cancelled";
    if (escapes.length > 0) return null;
    return armedAt !== null && armedAt >= bannerSince ? null : "auto-continue-cancelled";
  }
}

/**
 * Whether two looks show the same history above a banner: one pane cut
 * shorter than the other shows the end of it. None at all (the banner at the
 * top of the pane) matches only none.
 */
function sameHistory(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "" || b === "") return false;
  return a.endsWith(b) || b.endsWith(a);
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
