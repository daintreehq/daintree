import type { CodexLimitContinueSkipReason } from "./codexLimitContinuation.js";

/**
 * When a Codex pane's spent usage window resets (#17906). The banner it is
 * read from stays in the pty host: only these shapes cross a process.
 */

/** One quota window as the app-server reported it. `resetsAt` is epoch ms. */
export interface CodexLimitWindowEvidence {
  usedPercent: number;
  resetsAt: number | null;
}

/** One metered bucket of `account/rateLimits/read` (`rateLimitsByLimitId`). */
export interface CodexLimitBucketEvidence {
  limitId: string | null;
  limitName: string | null;
  windows: CodexLimitWindowEvidence[];
  /** The server sent a window here that couldn't be read. */
  unreadable: boolean;
}

/** A quota reading of the pane's own Codex home, handed to the pty host to judge the banner by. */
export interface CodexLimitEvidence {
  /** When the quota request was sent: a reading asked for before the stop says nothing about it. */
  requestedAt: number;
  /** When its reply came back: the server took the reading somewhere in between. */
  receivedAt: number;
  buckets: CodexLimitBucketEvidence[];
}

export type CodexLimitUnknownReason =
  /** No Codex stop banner is on screen, or the pane is gone. */
  | "no-banner"
  /** Nothing has read the pane's output continuously since the banner showed, or the host didn't answer. */
  | "not-observed"
  /** A workspace credit or spend-cap stop: Codex names no reset. */
  | "no-reset"
  | "unreadable-banner"
  /** The Codex process wasn't launched by Daintree, so its zone and home aren't known. */
  | "unattributed"
  /** The launch names a `TZ` that can't be read here. */
  | "zone-unknown"
  /** The printed time names no instant in the zone, or one already past when it printed. */
  | "unreadable-time"
  /** The printed time names more than one instant (a fold, midnight) and no reading picks one. */
  | "ambiguous-time"
  /** The printed reset's minute had begun before the question was answered: what was spent at the stop can't be told. */
  | "late-reading"
  /** `Try again later.` with no reading showing this pane's window spent. */
  | "no-reset-stated"
  | "quota-disagrees"
  /** The reading holds a window it couldn't read or a spent one with no reset. */
  | "quota-incomplete"
  /** More than one bucket the banner could mean gives a different answer. */
  | "ambiguous-bucket"
  /** The banner, or the pane's process, changed between the two reads; asking again reads the new one. */
  | "banner-changed";

export type CodexLimitReset =
  | {
      status: "known";
      /**
       * Epoch ms by which the spent window has reset. From the banner alone it
       * is the end of the minute Codex printed, as Codex drops the seconds.
       */
      resetsAt: number;
      precision: "second" | "minute";
      source: "banner" | "quota";
      /** When the pane first showed the banner. */
      observedAt: number;
    }
  | { status: "unknown"; reason: CodexLimitUnknownReason; observedAt?: number };

/** The banner the pty host holds, named for a second read that resolves it against a reading. */
export interface CodexLimitStamp {
  seq: number;
  /** The pane process that holds it: a sequence alone repeats in a replacement. */
  run: string;
  observedAt: number;
  /**
   * The banner's identity, as a digest the pty host makes of what it parsed
   * (#18193): a restored pane is matched against it, and nothing of the screen
   * leaves the host.
   */
  identity?: string;
}

/**
 * What `get-terminal` answers when asked about the pane's Codex limit. An
 * answer about a held banner names it, so a wait can be tied to that sighting
 * (#17909).
 */
export type CodexLimitAnswer =
  | { stamp: CodexLimitStamp }
  | {
      reset: CodexLimitReset;
      stamp?: CodexLimitStamp;
      skipAtStop?: CodexLimitStopSkip;
      /**
       * The stamped stop is the restored process's redraw of the stop saved
       * before a cold restart (#18193): its reset is the saved one, never what
       * this banner reads as now.
       */
      restored?: true;
    }
  | { checkpoint: CodexLimitCheckpoint | null };

/**
 * What an armed pane holds as Daintree quits (#18193), for a cold restore to
 * pick up: the stop it is still at, untouched since it showed, or Claude Code's
 * own wait for the reset, which dies with its process, or a restore still
 * owed its saved stop. Null when it is at none of these.
 */
export type CodexLimitCheckpoint =
  | { kind: "stop"; seq: number; run: string; identity: string }
  /** A restored process still owed the redraw of its saved stop, with nothing written to it since its launch. */
  | { kind: "replaying" }
  | {
      kind: "own-wait";
      identity: string;
      /** Epoch ms by which the window resets, read off the pane's own first sighting. */
      resetsAt: number;
    };

/**
 * Why the stamped stop isn't Daintree's to continue, whatever its reset says
 * (#18192): Claude Code's own wait was cancelled, and not by an assistant's
 * Escape alone.
 */
export type CodexLimitStopSkip = Extract<CodexLimitContinueSkipReason, "auto-continue-cancelled">;

/** The question: a first read, or a resolve of a stamped banner against a reading. */
export type CodexLimitQuery =
  | { seq?: undefined; checkpoint?: undefined }
  | { seq: number; run: string; evidence: CodexLimitEvidence | null; checkpoint?: undefined }
  /** What the pane holds for a cold restore, as Daintree quits (#18193). */
  | { seq?: undefined; checkpoint: true };
