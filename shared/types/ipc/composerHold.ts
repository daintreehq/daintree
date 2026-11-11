/**
 * A pane composer's send held while its agent works (#16379): typed once the
 * pane next waits at its own prompt, for an agent whose CLI isn't declared to
 * queue input mid-turn. Main holds it, in memory only.
 */

/** How long a held send waits for its pane's prompt before it is dropped. */
export const COMPOSER_HOLD_TTL_MS = 60 * 60_000;

/**
 * Why a held send ended unwritten. `typed`: input reached the terminal after
 * it was held. `restarted`: the agent's run was restarted or replaced.
 * `closed`: the pane was closed. `ended`: its terminal or agent ended.
 * `expired`: its time ran out. `stopped`: the pane's line stopped taking it,
 * such as its notices being stopped. `driven-elsewhere`: another screen took
 * over driving the project. `input-blocked`: it was sent now while the panel
 * couldn't take input. `unconfirmed`: it went to the terminal, but whether it
 * was written is unknown, so it is never sent again.
 */
export type ComposerHoldDropReason =
  | "typed"
  | "restarted"
  | "closed"
  | "ended"
  | "expired"
  | "stopped"
  | "driven-elsewhere"
  | "input-blocked"
  | "unconfirmed";

/** A send held for a pane, as main holds it. */
export interface HeldComposerSend {
  terminalId: string;
  token: string;
  /** The text as the composer sent it, expansions included. */
  text: string;
  imagePaths: string[];
  heldAt: number;
  expiresAt: number;
  /** `sending` is on its way to the terminal and can no longer be withdrawn. */
  status: "held" | "sending";
}

/** How a held send ended. */
export type ComposerHoldOutcome =
  | { kind: "delivered" }
  | { kind: "withdrawn" }
  | { kind: "dropped"; reason: ComposerHoldDropReason };

/**
 * Main's push when a pane's held send changes: `held` is what it holds now,
 * null once nothing is; `ended` says what became of the one that was. A
 * dropped one carries its text and images, so a view that never saw it held
 * can still give them back.
 */
export interface ComposerHoldChange {
  terminalId: string;
  held: HeldComposerSend | null;
  ended?: {
    token: string;
    outcome: ComposerHoldOutcome;
    text?: string;
    imagePaths?: string[];
  };
}

/**
 * The answer to a hold request. `not-busy`: send it as any other.
 * `already-held`: the pane holds one, so this one isn't sent. `unavailable`:
 * it couldn't be held, and isn't sent either, since sending now is what holding
 * it was for.
 */
export type ComposerHoldResult =
  | { held: true; send: HeldComposerSend }
  | { held: false; reason: "not-busy" | "already-held" | "unavailable" };

export interface ComposerHoldWithdrawResult {
  /** False once it is on its way to the terminal or has ended. */
  withdrawn: boolean;
}

/**
 * The answer to sending a held send now. `sending`: it is on its way to the
 * terminal. `already-sending`: the pane's prompt took it first. `dropped`: it
 * couldn't go, and its views hear why. `not-held`: it isn't held any more.
 */
export interface ComposerHoldSendNowResult {
  outcome: "sending" | "already-sending" | "dropped" | "not-held";
}
