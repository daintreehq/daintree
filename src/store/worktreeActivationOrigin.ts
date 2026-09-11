// Identity stamped on the renderer's own `set-active` requests so the host's
// `worktree-activated` echo of a selection this view already applied can be
// told apart from a host-originated activation (auto-switch after a delete,
// topology reconcile, Main-originated IPC, another window on the same
// project) that it must still apply (#12370). Each project view runs in its
// own V8 context, so module scope is per view.
export const RENDERER_ACTIVATION_ORIGIN = `renderer-${crypto.randomUUID()}`;

// The selection the host itself just pushed, if any. The host already holds
// it, so `useActiveWorktreeSync` must not answer with a `set-active` — with
// two windows on one project that answer is the next hop of an echo loop:
// each view applies the other's activation and sends it back under its own
// origin, seq climbing forever. Single-slot: the sync effect consumes it on
// the very next selection change, matching or not.
let hostAppliedWorktreeId: string | null = null;

export function markHostActivationApplied(worktreeId: string): void {
  hostAppliedWorktreeId = worktreeId;
}

export function consumeHostAppliedActivation(worktreeId: string): boolean {
  const matched = hostAppliedWorktreeId === worktreeId;
  hostAppliedWorktreeId = null;
  return matched;
}

export function _resetHostAppliedActivationForTesting(): void {
  hostAppliedWorktreeId = null;
}
