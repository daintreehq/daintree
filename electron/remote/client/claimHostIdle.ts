import { IdleClaimAnswerSchema, LinkMethod } from "../host/linkMethods.js";
import type { LinkSession } from "../link/session.js";

/** The host reads afresh before it answers, behind any read already under way. */
const CLAIM_TIMEOUT_MS = 30_000;

/** What came of asking a host for its ended idle time; `act` ran only when `claimed`. */
export type HostIdleClaimOutcome<T> =
  | { kind: "claimed"; result: T }
  /** The host saw work, its idle time hadn't ended, or someone claimed it first. */
  | { kind: "refused" }
  /** A host from before the claim, which counts as none. */
  | { kind: "unsupported" }
  /** The link asked on closed, or is no longer the host's: nothing may act on it. */
  | { kind: "superseded" };

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/**
 * Right before this Shell acts on a host's idleness (#17922): asks the host,
 * over `session`, to read afresh and grant this link the idle time that ended,
 * and runs `act` in the same turn the grant arrives, only while `session` is
 * still open and still the host's (`current`). Nothing holds the claim past
 * that turn, so whatever acts on it starts in `act`, before its first await.
 *
 * A call that fails or times out throws and claims nothing here, though the
 * host may have granted it with the answer lost: that idle time is spent, and
 * nobody acts on it until new work restarts the host's clock.
 */
export async function withHostIdleClaim<T>(
  session: LinkSession,
  current: () => LinkSession | null,
  act: () => T
): Promise<HostIdleClaimOutcome<T>> {
  const reaches = () => session.isOpen && current() === session;
  if (!reaches()) return { kind: "superseded" };
  let answer: unknown;
  try {
    answer = await session.call(LinkMethod.CLAIM_IDLE, null, { timeoutMs: CLAIM_TIMEOUT_MS });
  } catch (error) {
    if (errorCode(error) === "UNSUPPORTED") return { kind: "unsupported" };
    throw error;
  }
  const { granted } = IdleClaimAnswerSchema.parse(answer);
  if (!reaches()) return { kind: "superseded" };
  if (!granted) return { kind: "refused" };
  return { kind: "claimed", result: act() };
}
