import { logError } from "@/utils/logger";

/**
 * Close vetoes for panels that hold unsaved work (#12323).
 *
 * The panel store has no confirm-before-remove hook, and giving it one would
 * make every synchronous close path async. Instead the surfaces that *ask* for
 * a close consult this registry first: the optimistic-close coordinator (grid
 * X, Cmd+W, grid tab close, `terminal.trash`), the docked tab close, and the
 * Alt+click force close. A panel with no guard takes exactly the path it took
 * before — the registry only adds a wait where something registered one.
 *
 * Bulk and teardown paths (the panel-count warning, worktree deletion,
 * project teardown, emptying the trash) deliberately do not consult it: they
 * are not the user closing *this* panel, and a guarded panel's owner keeps its
 * own recovery so nothing is lost on those paths either.
 *
 * Module-local, like the optimistic-close coordinator it sits beside: guards
 * are registered by a panel while it is mounted and dirty, and the register
 * call returns the unregister.
 */
export type PanelCloseVerdict = "proceed" | "cancel";

export type PanelCloseGuard = () => Promise<PanelCloseVerdict>;

const guards = new Map<string, PanelCloseGuard>();

/** Verdicts in flight, so a double-fired close asks once and answers both. */
const pending = new Map<string, Promise<PanelCloseVerdict>>();

export function registerPanelCloseGuard(panelId: string, guard: PanelCloseGuard): () => void {
  guards.set(panelId, guard);
  return () => {
    if (guards.get(panelId) === guard) guards.delete(panelId);
  };
}

export function hasPanelCloseGuard(panelId: string): boolean {
  return guards.has(panelId);
}

/**
 * Whether closing `panelIds` may go ahead. Guards run one at a time, in order,
 * and the first cancel wins — a group close with two dirty panels asks about
 * the first, and a cancel there leaves the second untouched. A guard that
 * throws counts as a cancel: losing work is the failure this exists to
 * prevent, so an unanswerable prompt keeps the panel.
 */
export async function consultPanelCloseGuards(panelIds: readonly string[]): Promise<boolean> {
  for (const panelId of panelIds) {
    const guard = guards.get(panelId);
    if (!guard) continue;
    let verdict = pending.get(panelId);
    if (!verdict) {
      verdict = Promise.resolve()
        .then(guard)
        .catch((error: unknown) => {
          logError("[panelCloseGuard] guard threw; keeping the panel", error);
          return "cancel" as const;
        });
      pending.set(panelId, verdict);
      const settle = () => {
        if (pending.get(panelId) === verdict) pending.delete(panelId);
      };
      verdict.then(settle, settle);
    }
    if ((await verdict) === "cancel") return false;
  }
  return true;
}

export function __resetPanelCloseGuardsForTests(): void {
  guards.clear();
  pending.clear();
}
