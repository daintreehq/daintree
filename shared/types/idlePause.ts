/**
 * Pausing a resource environment's box once the Remote Host made for it has
 * gone idle (#17925). Off until the person turns it on for an environment on
 * this device, and only for an environment that comes from their own files.
 */

/**
 * What a pause right now was checked against, handed back when the pause is
 * asked for so a change in between refuses it.
 */
export interface IdlePauseGuard {
  /** Which resource block the pause resolved to, e.g. `settings:gpu`. */
  selector: string;
  /** The confirmed pause commands and the file they came from. */
  fingerprint: string;
  /** The ssh target the environment's status last reported for its box. */
  sshTarget: string;
  /** Mutating resource actions this worktree had started when checked. */
  generation: number;
  environmentEpoch: number;
}

export type IdlePauseCheck = { ok: true; guard: IdlePauseGuard } | { ok: false; reason: string };

/** How an idle pause ended; `ran` is false when it was refused before any command started. */
export type IdlePauseRunOutcome =
  | { ran: false; reason: string }
  | { ran: true; success: boolean; error?: string };

/** An idle pause checked on the worktree's workspace host, ready to send to that same host. */
export type IdlePausePreparation =
  | {
      ok: true;
      guard: IdlePauseGuard;
      /** Posts the pause before it returns, so a claim's grant can start it in its own turn. */
      run(): Promise<IdlePauseRunOutcome>;
    }
  | { ok: false; reason: string };

export type IdlePauseUnavailableReason = "no-environment" | "repository" | "no-pause";

/** What the worktree card's idle pause dialog shows for the worktree's environment. */
export type IdlePausePolicy =
  | {
      status: "unavailable";
      reason: IdlePauseUnavailableReason;
      /** The file the environment resolved from, when one did. */
      sourcePath?: string;
    }
  | {
      status: "available";
      /** The environment's name as the person knows it. */
      environment: string;
      sourcePath: string;
      /** The pause commands as written, before worktree variables are filled in. */
      commands: string[];
      /** Sent back to turn it on, so commands changed meanwhile are never confirmed unseen. */
      fingerprint: string;
      enabled: boolean;
      /** It was on, and the commands changed since, which turned it off. */
      changed: boolean;
    };
