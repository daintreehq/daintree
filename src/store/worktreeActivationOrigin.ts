// Identity stamped on the renderer's own `set-active` requests so the host's
// `worktree-activated` echo of a selection this view already applied can be
// told apart from a host-originated activation (auto-switch after a delete,
// topology reconcile, Main-originated IPC) that it must still apply (#12370).
// Each project view runs in its own V8 context, so module scope is per view.
export const RENDERER_ACTIVATION_ORIGIN = `renderer-${crypto.randomUUID()}`;
