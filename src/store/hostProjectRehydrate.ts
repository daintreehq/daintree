import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { HydrateResult } from "@shared/types/ipc/app";
import type { TabGroup } from "@shared/types/panel";
import { getWorktreeIdSet, getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { logWarn } from "@/utils/logger";

export interface HostProjectRehydrateOptions {
  /**
   * False once a newer rehydrate was requested or the view moved on. Checked
   * after every await, so an obsolete answer is never applied over a newer one.
   */
  isCurrent: () => boolean;
  /**
   * The host's saved layout wins over this view's: after this view takes the
   * project over, or while another screen drives it (this view's own layout
   * writes are refused then, so the host holds the driver's). Otherwise, as
   * for the driver coming back on a fresh session, this view's own state wins
   * where both have something and the host's only fills what is missing,
   * because writes made while the link was down never reached the host.
   */
  authoritative: boolean;
}

/**
 * Bring this view's host-owned project UI in line with what the host saved:
 * the panel list and its order, tab groups, the active worktree and drafts.
 * Read through `app:hydrate`, so a remote view gets the host's half through
 * the hydrate split exactly as it did at boot.
 *
 * Nothing live is torn down. Terminals are left to the terminal resync, which
 * adopts the ones the host runs; a saved terminal that isn't running is not
 * started here. Panels this view has and the host's save lacks are kept.
 */
export async function rehydrateHostProjectState(
  projectId: string,
  options: HostProjectRehydrateOptions
): Promise<void> {
  // Drafts as they stood before asking: one typed into since is newer than
  // anything the host's answer can carry, so it is left alone.
  const draftsBefore = (await import("@/store/terminalInputStore")).useTerminalInputStore
    .getState()
    .getProjectDraftInputs(projectId);
  const hydrate: HydrateResult = await window.electron.app.hydrate();
  if (!options.isCurrent()) return;
  const workspaceId = hydrate.workspaceId ?? hydrate.project?.id ?? null;
  if (workspaceId !== projectId) return;

  const [
    { usePanelStore },
    { buildArgsForNonPtyRecreation, inferKind },
    drafts,
    { draftInputPersistence },
  ] = await Promise.all([
    import("@/store/panelStore"),
    import("@/utils/stateHydration/statePatcher"),
    import("@/store/terminalInputStore"),
    import("@/store/persistence/draftInputPersistence"),
  ]);
  if (!options.isCurrent()) return;

  type Saved = Parameters<typeof inferKind>[0];
  type PanelState = ReturnType<typeof usePanelStore.getState>;
  const saved = ((hydrate.appState?.terminals ?? []) as unknown as Saved[]).filter(
    (entry): entry is Saved =>
      !!entry &&
      typeof entry.id === "string" &&
      entry.id.trim() !== "" &&
      entry.location !== "trash"
  );
  const projectRoot = hydrate.project?.path ?? "";
  const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;

  for (const entry of saved) {
    if (usePanelStore.getState().panelsById[entry.id]) continue;
    const kind = inferKind(entry, projectId);
    if (panelKindHasPty(kind)) continue;
    try {
      const args = buildArgsForNonPtyRecreation(entry, kind, projectRoot, activeWorktreeId);
      // Built for this kind by the same builder the boot restore uses.
      await usePanelStore
        .getState()
        .addPanel({ ...args, bypassLimits: true } as Parameters<PanelState["addPanel"]>[0]);
    } catch (error) {
      logWarn("[HostRehydrate] Couldn't show a panel the host saved", { error });
    }
    if (!options.isCurrent()) return;
  }

  if (options.authoritative) {
    const store = usePanelStore.getState();
    store.restoreTerminalOrder(saved.map((entry) => entry.id));
    const tabGroups: TabGroup[] | undefined = hydrate.tabGroups;
    if (tabGroups) store.hydrateTabGroups(tabGroups, { skipPersist: true });
    await applyActiveWorktree(hydrate.appState?.activeWorktreeId ?? null, options);
    if (!options.isCurrent()) return;
  }

  const hostDrafts = hydrate.draftInputs ?? {};
  const input = drafts.useTerminalInputStore.getState();
  const local = input.getProjectDraftInputs(projectId);
  const incoming: Record<string, string> = {};
  for (const [terminalId, text] of Object.entries(hostDrafts)) {
    if (typeof text !== "string" || text === "") continue;
    if (!options.authoritative && local[terminalId]) continue;
    if ((local[terminalId] ?? "") !== (draftsBefore[terminalId] ?? "")) continue;
    incoming[terminalId] = text;
  }
  if (Object.keys(incoming).length > 0) input.restoreProjectDraftInputs(projectId, incoming);
  // The host holds exactly its snapshot now, so the next flush diffs against
  // it: a restored draft that is then sent gets its tombstone, and an edit
  // made here during hydration (kept above) goes up as a change.
  const hostRecord: Record<string, string> = {};
  for (const [terminalId, text] of Object.entries(hostDrafts)) {
    if (typeof text === "string") hostRecord[terminalId] = text;
  }
  draftInputPersistence.rebaseProject(projectId, hostRecord);
}

async function applyActiveWorktree(
  worktreeId: string | null | undefined,
  options: HostProjectRehydrateOptions
): Promise<void> {
  if (!worktreeId) return;
  if (getWorktreeSelectionSnapshot()?.activeWorktreeId === worktreeId) return;
  // Only a worktree this view knows; the host's list arrives by its own resync.
  if (!getWorktreeIdSet()?.has(worktreeId)) return;
  const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
  if (!options.isCurrent()) return;
  useWorktreeSelectionStore.getState().setActiveWorktree(worktreeId, { persist: false });
}
