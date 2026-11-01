import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { HydrateResult } from "@shared/types/ipc/app";
import {
  isDevPreviewPanel,
  isPtyPanel,
  type PanelLocation,
  type TabGroup,
} from "@shared/types/panel";
import { hydratedSettingsOf, type HydratedSettings } from "@/store/hostResyncSignal";
import { getWorktreeIdSet, getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { logWarn } from "@/utils/logger";

/**
 * Each read of the host's drafts, numbered as it is asked. The host answers in
 * order, so a later read holds newer drafts: a full rehydrate and a draft-only
 * refresh run side by side, and the older answer, landing after the newer
 * one, would put back a draft the newer one cleared and rebase onto it.
 */
let draftReadTicket = 0;
/** The newest authoritative read applied so far. */
let appliedDraftRead = 0;

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
  /**
   * This view watches while another screen drives, so beyond taking the
   * host's order and groups it follows the driver's panels: a panel the
   * host's save files elsewhere moves there, and one the save no longer has
   * leaves this view. Terminals are the terminal resync's to remove.
   */
  follow?: boolean;
  /**
   * The driver's live navigation names the worktree, so the saved one (which
   * may predate it) is left alone.
   */
  keepActiveWorktree?: boolean;
  /**
   * Handed the settings the hydrate answer carried, as soon as the answer is
   * known to be this view's and current, so a caller that would otherwise
   * read them again can take them from here.
   */
  onHydrated?: (settings: HydratedSettings) => void;
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
  const [{ useTerminalInputStore }, { draftInputPersistence: persistence }] = await Promise.all([
    import("@/store/terminalInputStore"),
    import("@/store/persistence/draftInputPersistence"),
  ]);
  const draftsBefore = useTerminalInputStore.getState().getProjectDraftInputs(projectId);
  // What this view last knew the host held, read before asking, so a write of
  // ours acknowledged while the answer travels can't pass for a host deletion.
  const baselineBefore = persistence.getBaseline(projectId) ?? {};
  const draftRead = ++draftReadTicket;
  const hydrate: HydrateResult = await window.electron.app.hydrate();
  if (!options.isCurrent()) return;
  const workspaceId = hydrate.workspaceId ?? hydrate.project?.id ?? null;
  if (workspaceId !== projectId) return;
  options.onHydrated?.(hydratedSettingsOf(hydrate));

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
  const terminals: readonly unknown[] = hydrate.appState?.terminals ?? [];
  const saved = terminals.filter(
    (entry): entry is Saved =>
      entry !== null &&
      typeof entry === "object" &&
      "id" in entry &&
      typeof entry.id === "string" &&
      entry.id.trim() !== "" &&
      (!("location" in entry) || entry.location !== "trash")
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

  let followDeps: FollowDeps | null = null;
  if (options.follow) {
    const [
      { transferBetweenWorktreeIndex },
      { saveNormalized, saveTabGroups },
      { followsHostLayout },
    ] = await Promise.all([
      import("@/store/slices/panelRegistry/worktreeIndex"),
      import("@/store/slices/panelRegistry/persistence"),
      import("@/store/hostTerminalResync"),
    ]);
    if (!options.isCurrent()) return;
    followDeps = { transferBetweenWorktreeIndex, saveNormalized, saveTabGroups, followsHostLayout };
    followSavedPanels(saved, usePanelStore, followDeps);
  }

  if (options.authoritative) {
    const store = usePanelStore.getState();
    store.restoreTerminalOrder(saved.map((entry) => entry.id));
    const tabGroups: TabGroup[] | undefined = hydrate.tabGroups;
    if (tabGroups) {
      store.hydrateTabGroups(tabGroups, { skipPersist: true });
      // A removal above queued the groups as they stood before; queued again,
      // the save that goes out (from a view that has just taken over) is the
      // host's own, not a stale one written over it.
      if (followDeps) followDeps.saveTabGroups(usePanelStore.getState().tabGroups);
    }
    if (!options.keepActiveWorktree) {
      await applyActiveWorktree(hydrate.appState?.activeWorktreeId ?? null, options);
      if (!options.isCurrent()) return;
    }
  }

  applyHostDrafts(projectId, hydrate.draftInputs ?? {}, {
    read: draftRead,
    authoritative: options.authoritative,
    draftsBefore,
    baselineBefore,
    useTerminalInputStore: drafts.useTerminalInputStore,
    draftInputPersistence,
  });
}

/**
 * Show the drafts the driver last saved, without the panel pass: what a view
 * that watches does each time the host says the driver's drafts changed
 * (#13283). Read through the draft read alone, so nothing else is refetched
 * per keystroke burst, and merged as an authoritative rehydrate merges them.
 */
export async function refreshHostDrafts(
  projectId: string,
  options: Pick<HostProjectRehydrateOptions, "isCurrent">
): Promise<void> {
  const [{ useTerminalInputStore }, { draftInputPersistence }] = await Promise.all([
    import("@/store/terminalInputStore"),
    import("@/store/persistence/draftInputPersistence"),
  ]);
  if (!options.isCurrent()) return;
  const draftsBefore = useTerminalInputStore.getState().getProjectDraftInputs(projectId);
  const baselineBefore = draftInputPersistence.getBaseline(projectId) ?? {};
  const draftRead = ++draftReadTicket;
  const hostDrafts = await window.electron.project.getDraftInputs(projectId);
  if (!options.isCurrent()) return;
  applyHostDrafts(projectId, hostDrafts ?? {}, {
    read: draftRead,
    authoritative: true,
    draftsBefore,
    baselineBefore,
    useTerminalInputStore,
    draftInputPersistence,
  });
}

interface ApplyHostDraftsContext {
  /** This answer's {@link draftReadTicket}. */
  read: number;
  authoritative: boolean;
  /** This view's drafts before the host was asked: one typed into since is newer. */
  draftsBefore: Record<string, string>;
  /** What this view last knew the host held, read before asking. */
  baselineBefore: Record<string, string>;
  useTerminalInputStore: typeof import("@/store/terminalInputStore").useTerminalInputStore;
  draftInputPersistence: typeof import("@/store/persistence/draftInputPersistence").draftInputPersistence;
}

function applyHostDrafts(
  projectId: string,
  hostDrafts: Record<string, unknown>,
  context: ApplyHostDraftsContext
): void {
  if (context.read < appliedDraftRead) return;
  // Only an authoritative answer takes the host's drafts whole: a merge-style
  // one (a fresh session's resync) mustn't keep a takeover's answer, asked
  // before it, from landing.
  if (context.authoritative) appliedDraftRead = context.read;
  const { draftsBefore, baselineBefore, draftInputPersistence } = context;
  const input = context.useTerminalInputStore.getState();
  const local = input.getProjectDraftInputs(projectId);
  const incoming: Record<string, string> = {};
  for (const [terminalId, text] of Object.entries(hostDrafts)) {
    if (typeof text !== "string" || text === "") continue;
    if (!context.authoritative && local[terminalId]) continue;
    if ((local[terminalId] ?? "") !== (draftsBefore[terminalId] ?? "")) continue;
    if (local[terminalId] === text) continue;
    incoming[terminalId] = text;
  }
  let draftsChanged = Object.keys(incoming).length > 0;
  if (draftsChanged) input.restoreProjectDraftInputs(projectId, incoming);
  // A draft the host held at our baseline and no longer holds was sent or
  // cleared by another driver. Kept here, the rebase below would make the next
  // flush write it back as new; one edited here since the baseline is ours and
  // stays.
  for (const [terminalId, text] of Object.entries(baselineBefore)) {
    if (typeof hostDrafts[terminalId] === "string" && hostDrafts[terminalId] !== "") continue;
    if (local[terminalId] === undefined) continue;
    if (local[terminalId] !== text || (draftsBefore[terminalId] ?? "") !== text) continue;
    input.clearDraftInput(terminalId, projectId);
    draftsChanged = true;
  }
  // A mounted editor holds its own copy of the text: without this it keeps
  // showing a cleared draft, and its next keystroke writes it back.
  if (draftsChanged) input.bumpExternalDraftRevision();
  // The host holds exactly its snapshot now, so the next flush diffs against
  // it: a restored draft that is then sent gets its tombstone, and an edit
  // made here during hydration (kept above) goes up as a change.
  const hostRecord: Record<string, string> = {};
  for (const [terminalId, text] of Object.entries(hostDrafts)) {
    if (typeof text === "string") hostRecord[terminalId] = text;
  }
  draftInputPersistence.rebaseProject(projectId, hostRecord);
}

type PanelStore = typeof import("@/store/panelStore").usePanelStore;
type PanelState = ReturnType<PanelStore["getState"]>;

interface FollowDeps {
  transferBetweenWorktreeIndex: typeof import("@/store/slices/panelRegistry/worktreeIndex").transferBetweenWorktreeIndex;
  saveNormalized: typeof import("@/store/slices/panelRegistry/persistence").saveNormalized;
  saveTabGroups: typeof import("@/store/slices/panelRegistry/persistence").saveTabGroups;
  followsHostLayout: typeof import("@/store/hostTerminalResync").followsHostLayout;
}

const FOLLOWED_LOCATIONS: ReadonlySet<unknown> = new Set<PanelLocation>(["grid", "dock"]);

function isFollowedLocation(location: unknown): location is "grid" | "dock" {
  return FOLLOWED_LOCATIONS.has(location);
}

/**
 * Lay this view's panels out as the host's save files them, and drop the ones
 * the driver closed. Visibility is left to the panes' own observers, which
 * see the move and set it, with the renderer policy that follows from it.
 */
function followSavedPanels(
  saved: ReadonlyArray<{ id: string; location?: unknown; worktreeId?: unknown }>,
  store: PanelStore,
  deps: FollowDeps
): void {
  const savedIds = new Set(saved.map((entry) => entry.id));
  const ownedByScreen = (panel: PanelState["panelsById"][string]) =>
    !FOLLOWED_LOCATIONS.has(panel.location) || panel.excludeFromPersistence === true;
  let moved = false;
  store.setState((state) => {
    let panelsById = state.panelsById;
    let panelIdsByWorktreeId = state.panelIdsByWorktreeId;
    for (const entry of saved) {
      const panel = panelsById[entry.id];
      if (!panel || ownedByScreen(panel)) continue;
      const location = isFollowedLocation(entry.location) ? entry.location : panel.location;
      // An absent worktree is the save's own answer: the panel is filed globally.
      const worktreeId = typeof entry.worktreeId === "string" ? entry.worktreeId : undefined;
      if (location === panel.location && worktreeId === panel.worktreeId) continue;
      panelsById = { ...panelsById, [entry.id]: { ...panel, location, worktreeId } };
      panelIdsByWorktreeId = deps.transferBetweenWorktreeIndex(
        panelIdsByWorktreeId,
        panel.worktreeId,
        worktreeId,
        entry.id
      );
    }
    if (panelsById === state.panelsById) return state;
    moved = true;
    return { panelsById, panelIdsByWorktreeId };
  });
  if (moved) {
    // Queued like any other layout change: a watcher's save is skipped, and a
    // view that has just taken the project over sends the host's placement
    // rather than one an adoption queued a moment ago.
    const state = store.getState();
    deps.saveNormalized(state.panelsById, state.panelIds);
  }
  // Closed or trashed by the driver. A terminal goes once it shows exited
  // here (a running one may be in a save still on its way); a dev preview
  // stays, since removing it would ask the host to stop a server only the
  // driver may stop.
  const state = store.getState();
  for (const id of [...state.panelIds]) {
    const panel = state.panelsById[id];
    if (!panel || savedIds.has(id) || ownedByScreen(panel)) continue;
    if (panelKindHasPty(panel.kind ?? "terminal")) {
      if (!isPtyPanel(panel) || !deps.followsHostLayout(panel) || panel.isRestarting) continue;
      if (panel.exitCode === undefined && panel.runtimeStatus !== "exited") continue;
      state.removePanel(id, { backendAlreadyClosed: true });
    } else if (!isDevPreviewPanel(panel)) {
      state.removePanel(id);
    }
  }
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
