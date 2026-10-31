import { REPLY_WAIT_DEFAULT_SECONDS, REPLY_WAIT_MAX_SECONDS } from "../types/replyWait.js";

/**
 * How long `agent.launchInNewWorktree` waits for setup when the caller names
 * no budget. The same five minutes a new worktree's first agent waits from the
 * New Worktree dialog: setup scripts routinely outlast a single 25 s
 * `worktree.waitUntilReady`, and this call runs in main, so it waits in slices
 * rather than under one renderer dispatch.
 */
export const LAUNCH_SETUP_WAIT_DEFAULT_MS = 5 * 60_000;
export const LAUNCH_SETUP_WAIT_MAX_MS = 10 * 60_000;

/**
 * Whether a call's setup wait and reply wait together would hold it past
 * {@link REPLY_WAIT_MAX_SECONDS}, the longest any Daintree call is held and
 * what its own sessions' client timeout is sized to. A client that gave up
 * first would see a bare timeout for a call that went on to create a worktree.
 */
export function launchWaitsExceedHold(args: {
  setupTimeoutMs?: number;
  waitForReply?: boolean;
  waitSeconds?: number;
}): boolean {
  if (args.waitForReply !== true) return false;
  const setupMs = args.setupTimeoutMs ?? LAUNCH_SETUP_WAIT_DEFAULT_MS;
  const replyMs = (args.waitSeconds ?? REPLY_WAIT_DEFAULT_SECONDS) * 1_000;
  return setupMs + replyMs > REPLY_WAIT_MAX_SECONDS * 1_000;
}
