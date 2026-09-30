import { getPanelStoreSnapshot } from "@/store/storeAccessors";

export interface PanelNotificationAddress {
  panelId: string;
  worktreeId?: string;
}

/**
 * The `notify()` context address for a panel: the panel itself plus the
 * worktree it lives in, so the inbox row groups under that worktree. Resolve
 * it when the event happens, not when a deferred toast fires — the panel may
 * have moved or closed by then.
 */
export function panelNotificationAddress(panelId: string): PanelNotificationAddress {
  const worktreeId = getPanelStoreSnapshot()?.panelsById[panelId]?.worktreeId ?? undefined;
  return worktreeId ? { panelId, worktreeId } : { panelId };
}
