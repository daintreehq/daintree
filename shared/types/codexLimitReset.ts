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
  buckets: CodexLimitBucketEvidence[];
}

export type CodexLimitUnknownReason =
  /** No Codex stop banner is on screen, or the pane is gone. */
  | "no-banner"
  /** Nothing has read the pane's output continuously since the banner was last seen. */
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
  /** `Try again later.` with no reading showing this pane's window spent. */
  | "no-reset-stated"
  | "quota-disagrees"
  /** The reading holds a window it couldn't read or a spent one with no reset. */
  | "quota-incomplete"
  /** More than one bucket the banner could mean gives a different answer. */
  | "ambiguous-bucket"
  /** The banner changed between the two reads; asking again reads the new one. */
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
  observedAt: number;
}

/** What `get-terminal` answers when asked about the pane's Codex limit. */
export type CodexLimitAnswer = { stamp: CodexLimitStamp } | { reset: CodexLimitReset };

/** The question: a first read, or a resolve of a stamped banner against a reading. */
export type CodexLimitQuery =
  { seq?: undefined } | { seq: number; evidence: CodexLimitEvidence | null };
