// Identity stamped on the renderer's own `set-active` requests so the host's
// `worktree-activated` echo of a selection this view already applied can be
// told apart from a host-originated activation (auto-switch after a delete,
// topology reconcile, Main-originated IPC, another window on the same
// project) that it must still apply (#12370). Each project view runs in its
// own V8 context, so module scope is per view.
export const RENDERER_ACTIVATION_ORIGIN = `renderer-${crypto.randomUUID()}`;

export interface ActivationRequest {
  worktreeId: string;
  /** The selection was the durable restore target when it was sent. */
  durable: boolean;
}

// The last request this view sent. An own echo is normally redundant, but
// when another window's activation has displaced this view's latest request,
// the echo of that request is the host telling us it holds our pick after
// all — re-applying it locally (never re-sending) brings the views together.
let latestRequest: ActivationRequest | null = null;

export function markActivationRequested(worktreeId: string, durable: boolean): void {
  latestRequest = { worktreeId, durable };
}

export function latestActivationRequest(): ActivationRequest | null {
  return latestRequest;
}

// The selection the host itself just pushed, if any. The host already holds
// it, so `useActiveWorktreeSync` must not answer with a `set-active` — with
// two windows on one project that answer is the next hop of an echo loop:
// each view applies the other's activation and sends it back under its own
// origin, seq climbing forever. Single-slot: the next run of the sync effect
// consumes it, matching or not, so a stale mark never swallows a later pick.
let hostAppliedWorktreeId: string | null = null;

export function markHostActivationApplied(worktreeId: string): void {
  hostAppliedWorktreeId = worktreeId;
}

export function consumeHostAppliedActivation(worktreeId: string): boolean {
  const matched = hostAppliedWorktreeId === worktreeId;
  hostAppliedWorktreeId = null;
  return matched;
}

export function clearHostAppliedActivation(): void {
  hostAppliedWorktreeId = null;
}

export function _resetHostAppliedActivationForTesting(): void {
  hostAppliedWorktreeId = null;
  latestRequest = null;
}
