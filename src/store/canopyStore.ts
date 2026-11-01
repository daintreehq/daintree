import { create } from "zustand";
import { getViewWorkspaceId } from "./viewWorkspaceId";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import { AGENT_DIRECTORY_ENTRIES_MAX } from "@shared/types/agentDirectory";
import type { CanopyOrder } from "@/components/Canopy/canopyOrder";
import { canopyResumeFresh, type CanopyResume } from "@/components/Canopy/canopyResume";
import {
  isCanopyRoleFilter,
  type AssistantHandbacksSeen,
  type CanopyRoleFilter,
} from "@/components/Canopy/canopyAssistants";
import { clampCanopyListWidth } from "@/components/Canopy/canopyListWidth";
import type { CanopyReplyRow } from "./voiceRecordingStore";
import {
  readsWithHostedService,
  type CanopyMode,
  type CanopySnapshot,
} from "@shared/types/ipc/canopy";

interface CanopyState {
  isOpen: boolean;
  /**
   * Where the user stands on Canopy: from the hydrate payload before main has
   * answered, then from each snapshot. Hidden, nothing opens it.
   */
  mode: CanopyMode;
  /** The mode the view hydrated with; a snapshot already held is newer and wins. */
  seedMode: (mode: CanopyMode) => void;
  /** Null until main has answered once — distinct from "no cards yet". */
  snapshot: CanopySnapshot | null;
  open: () => void;
  close: () => void;
  /**
   * Closes after "Go to terminal", remembering where the panel stood: an
   * opening within `CANOPY_RESUME_MS` lands there, any other close forgets it.
   */
  closeForTerminal: (resume: CanopyResume) => void;
  resume: CanopyResume | null;
  toggle: () => void;
  applySnapshot: (snapshot: CanopySnapshot) => void;
  /**
   * The window's own host runs a Daintree from before Canopy read locally: its
   * snapshot is held inert (no cards, not on) and nothing it read is shown or
   * turned on from here until it is updated.
   */
  outdatedHost: boolean;
  /**
   * The inbox's order as last shown, run ids first to last, and the scan it was
   * ranked after: kept across opens, so the list opens as it was left.
   */
  orders: Partial<Record<CanopyScope, CanopyOrder>>;
  setOrder: (scope: CanopyScope, order: CanopyOrder) => void;
  /**
   * The host the panel shows when it isn't the window's own: picked in the
   * panel's header, and back to the window's own host each time it opens.
   * `ALL_HOSTS_ID` is the one exception, a read scope over every host that is
   * restored on open. Only the panel reads it; the toolbar always counts the
   * window's own host.
   */
  hostId: HostId | null;
  setHostId: (hostId: HostId | null) => void;
  /** Each other host's order for all its projects, kept apart from this host's and each other's. */
  hostOrders: Record<HostId, CanopyOrder>;
  setHostOrder: (hostId: HostId, order: CanopyOrder) => void;
  /** The inbox's "Archived" group is unfolded; kept across opens. */
  archivedExpanded: boolean;
  setArchivedExpanded: (expanded: boolean) => void;
  /** The inbox's "Trash" group is unfolded; kept across opens. */
  trashExpanded: boolean;
  setTrashExpanded: (expanded: boolean) => void;
  /** The inbox shows only unread runs; kept across opens for the session. */
  unreadOnly: boolean;
  setUnreadOnly: (unreadOnly: boolean) => void;
  /** Every project's agents, or only the project this view shows; remembered across launches. */
  scope: CanopyScope;
  setScope: (scope: CanopyScope) => void;
  /** Workers, Daintree Assistants or both; remembered across launches. */
  roleFilter: CanopyRoleFilter;
  setRoleFilter: (roleFilter: CanopyRoleFilter) => void;
  /**
   * "Show its work": the inbox narrowed to the workers one assistant made or
   * was handed (#14166), by its exact run. For this opening only: a closed
   * panel opens on the whole inbox, and no other assistant ever inherits it.
   */
  workOf: CanopyWorkOf | null;
  showWorkOf: (workOf: CanopyWorkOf | null) => void;
  /** Each assistant's newest handback the person has had in front of them. */
  assistantHandbacksSeen: AssistantHandbacksSeen;
  seeAssistantHandback: (assistantId: string, observedAt: number) => void;
  /**
   * The callout offering reading above a listed inbox was put away: for good,
   * on every host and across launches. The status bar's offer stays.
   */
  readingOfferDismissed: boolean;
  dismissReadingOffer: () => void;
  /**
   * The offer an agent pane makes while its agent is stopped on a question or
   * an approval and Canopy is off was put away: for good, on every host and
   * across launches. The panel's own offers stay.
   */
  paneOfferDismissed: boolean;
  dismissPaneOffer: () => void;
  /**
   * The one pane making that offer: the first asking pane to claim it holds it
   * until its agent moves on, so the offer never shows in several panes at
   * once and never jumps between them while one is still asking.
   */
  paneOfferHolder: string | null;
  claimPaneOffer: (panelId: string) => void;
  releasePaneOffer: (panelId: string) => void;
  /**
   * Turning Canopy on from a pane's offer, under way or refused: the offer
   * stays in that pane until it is settled, whatever its agent does meanwhile.
   */
  paneOfferAttempt: { panelId: string; status: "pending" | "failed" } | null;
  startPaneOfferAttempt: (panelId: string) => void;
  /** Settles the pane's attempt, if it is still that pane's: a closed pane hears nothing. */
  finishPaneOfferAttempt: (panelId: string, turnedOn: boolean) => void;
  /** The pane whose offer turned Canopy on: it says so, briefly, where the offer was. */
  paneOfferTurnedOn: string | null;
  closePaneOfferTurnedOn: () => void;
  /** The pane closed: nothing it started is reported anywhere. */
  forgetPaneOffer: (panelId: string) => void;
  /**
   * The inbox list's width in px, as the user last dragged or stepped it: for
   * every project view and across launches. Null keeps the default, which
   * follows the window.
   */
  listWidth: number | null;
  setListWidth: (width: number | null) => void;
  /**
   * The width the list's edge is being dragged to, null when no drag is under
   * way. This view's alone and never saved: the drag's end keeps it, and the
   * open terminal holds its size until then.
   */
  listDrag: number | null;
  setListDrag: (width: number | null) => void;
  /**
   * The row a dictation is writing a reply into, asked for from the recording
   * indicator (#14778): the panel opens on its host and selects it with the
   * keyboard in its reply, then settles the request whether or not it could.
   */
  replyReveal: CanopyReplyReveal | null;
  /** Opens the panel on the row; false when Canopy is hidden and can't open. */
  revealReply: (row: CanopyReplyRow) => boolean;
  /** The request was met or refused; a newer one stands. */
  settleReplyReveal: (id: number) => void;
}

export interface CanopyReplyReveal extends CanopyReplyRow {
  id: number;
}

export type CanopyScope = "all" | "project";

/** The assistant whose work the inbox is narrowed to: its exact run, and its name as shown. */
export interface CanopyWorkOf {
  assistantId: string;
  name: string;
}

export type { CanopyOrder };

/** The panel's "All hosts" scope: not a host, and never a target for anything that writes. */
export const ALL_HOSTS_ID: HostId = "*";

export function isAllHosts(hostId: HostId | null): boolean {
  return hostId === ALL_HOSTS_ID;
}

const SCOPE_STORAGE_KEY = "daintree-canopy-scope";
const ALL_HOSTS_STORAGE_KEY = "daintree-canopy-all-hosts";
/** Read by every project view, so a view opened or reloaded since still opens on the order last shown. */
const ORDER_STORAGE_KEY = "daintree-canopy-order";
export const CANOPY_ROLE_STORAGE_KEY = "daintree-canopy-role";
const HANDBACKS_SEEN_STORAGE_KEY = "daintree-canopy-assistant-handbacks";
const READING_OFFER_DISMISSED_STORAGE_KEY = "daintree-canopy-reading-offer-dismissed";
const PANE_OFFER_DISMISSED_STORAGE_KEY = "daintree-canopy-pane-offer-dismissed";
const LIST_WIDTH_STORAGE_KEY = "daintree-canopy-list-width";
/** Assistants whose seen handback is kept at most, the oldest seen dropped first: as many as one directory names. */
const MAX_HANDBACKS_SEEN = AGENT_DIRECTORY_ENTRIES_MAX;

function loadHostId(): HostId | null {
  try {
    return window.localStorage.getItem(ALL_HOSTS_STORAGE_KEY) === "1" ? ALL_HOSTS_ID : null;
  } catch {
    return null;
  }
}

function saveAllHosts(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(ALL_HOSTS_STORAGE_KEY, "1");
    else window.localStorage.removeItem(ALL_HOSTS_STORAGE_KEY);
  } catch {
    // Best effort: the choice still holds for this session.
  }
}

function loadScope(): CanopyScope {
  try {
    return window.localStorage.getItem(SCOPE_STORAGE_KEY) === "project" ? "project" : "all";
  } catch {
    return "all";
  }
}

function loadRoleFilter(): CanopyRoleFilter {
  try {
    const stored = window.localStorage.getItem(CANOPY_ROLE_STORAGE_KEY);
    return isCanopyRoleFilter(stored) ? stored : "all";
  } catch {
    return "all";
  }
}

function saveRoleFilter(roleFilter: CanopyRoleFilter): void {
  try {
    window.localStorage.setItem(CANOPY_ROLE_STORAGE_KEY, roleFilter);
  } catch {
    // Best effort: the choice still holds for this session.
  }
}

function loadReadingOfferDismissed(): boolean {
  try {
    return window.localStorage.getItem(READING_OFFER_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveReadingOfferDismissed(): void {
  try {
    window.localStorage.setItem(READING_OFFER_DISMISSED_STORAGE_KEY, "1");
  } catch {
    // Best effort: the callout still stays away for this session.
  }
}

function loadPaneOfferDismissed(): boolean {
  try {
    return window.localStorage.getItem(PANE_OFFER_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function savePaneOfferDismissed(): void {
  try {
    window.localStorage.setItem(PANE_OFFER_DISMISSED_STORAGE_KEY, "1");
  } catch {
    // Best effort: the offer still stays away for this session.
  }
}

function loadListWidth(): number | null {
  try {
    const stored = window.localStorage.getItem(LIST_WIDTH_STORAGE_KEY);
    // Number(), not parseFloat: "" and "600px" are no width, never 0 or 600.
    return stored === null || stored.trim() === "" ? null : clampCanopyListWidth(Number(stored));
  } catch {
    return null;
  }
}

function saveListWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(LIST_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(LIST_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Best effort: the width still holds for this session.
  }
}

function readHandbacksSeen(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(HANDBACKS_SEEN_STORAGE_KEY) ?? "null"
    );
    if (!parsed || typeof parsed !== "object") return {};
    const clean: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === "number" && Number.isFinite(at)) clean[id] = at;
    }
    return clean;
  } catch {
    return {};
  }
}

/** Each assistant's newest seen of the two, kept to the cap. */
function mergeHandbacksSeen(
  held: AssistantHandbacksSeen,
  stored: AssistantHandbacksSeen
): Record<string, number> {
  const next: Record<string, number> = { ...held };
  for (const [id, at] of Object.entries(stored)) next[id] = Math.max(next[id] ?? -Infinity, at);
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_HANDBACKS_SEEN))) delete next[id];
  return next;
}

/**
 * Merged over what is stored and what this view holds, since every project
 * view writes the key: the newest seen of each wins, and a failed write still
 * leaves this view's copy right.
 */
function saveHandbackSeen(
  held: AssistantHandbacksSeen,
  assistantId: string,
  observedAt: number
): Record<string, number> {
  const next = mergeHandbacksSeen(held, readHandbacksSeen());
  const newest = Math.max(next[assistantId] ?? -Infinity, observedAt);
  delete next[assistantId];
  next[assistantId] = newest;
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_HANDBACKS_SEEN))) delete next[id];
  try {
    window.localStorage.setItem(HANDBACKS_SEEN_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best effort: this view still keeps it for the session.
  }
  return next;
}

/** Project orders kept at most, the least recently saved dropped first. */
const MAX_PROJECT_ORDERS = 20;

/**
 * The host this view runs on. Read off the window rather than through the host
 * connection hook, which would pull the connection stores in with it.
 */
export function canopyOwnHostId(): HostId {
  const id = typeof window === "undefined" ? undefined : window.__DAINTREE_HOST_ID__?.id;
  return typeof id === "string" && id.length > 0 ? id : LOCAL_HOST_ID;
}

/**
 * Where a host's order for a scope is stored: every project view shares the
 * one for every project's agents on that host, and keeps its own for its
 * project's. Keyed by host, so one host's order never opens another's list.
 */
function orderSlot(hostId: HostId, scope: CanopyScope): string {
  return scope === "all" ? `${hostId}|all` : `${hostId}|project:${getViewWorkspaceId() ?? ""}`;
}

/** Where this machine's orders were kept before they were kept per host. */
function legacyOrderSlot(scope: CanopyScope): string {
  return scope === "all" ? "all" : `project:${getViewWorkspaceId() ?? ""}`;
}

function readStoredOrders(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "null");
  return parsed && typeof parsed === "object" ? { ...parsed } : {};
}

function storedIds(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;
}

/**
 * Ranked for no scan this view has seen, so the open places it afresh by what
 * is known now, starting from the order it was left in — the band too.
 */
function unranked(ids: string[]): CanopyOrder {
  return { ids, rankedFor: null, urgent: [], band: [] };
}

/** Where a host's stored order came from: its own slot, or, for this machine, the old one. */
function storedOrder(
  stored: Record<string, unknown>,
  hostId: HostId,
  scope: CanopyScope
): string[] | null {
  return (
    storedIds(stored[orderSlot(hostId, scope)]) ??
    (hostId === LOCAL_HOST_ID ? storedIds(stored[legacyOrderSlot(scope)]) : null)
  );
}

function loadOrders(): {
  orders: Partial<Record<CanopyScope, CanopyOrder>>;
  hostOrders: Record<HostId, CanopyOrder>;
} {
  try {
    const stored = readStoredOrders();
    const own = canopyOwnHostId();
    const orders: Partial<Record<CanopyScope, CanopyOrder>> = {};
    for (const scope of ["all", "project"] as const) {
      const ids = storedOrder(stored, own, scope);
      if (ids) orders[scope] = unranked(ids);
    }
    const hostOrders: Record<HostId, CanopyOrder> = {};
    const others = new Set(
      Object.keys(stored)
        .filter((slot) => slot.endsWith("|all"))
        .map((slot) => slot.slice(0, -"|all".length))
    );
    others.add(LOCAL_HOST_ID);
    others.delete(own);
    for (const hostId of others) {
      const ids = storedOrder(stored, hostId, "all");
      if (ids) hostOrders[hostId] = unranked(ids);
    }
    return { orders, hostOrders };
  } catch {
    return { orders: {}, hostOrders: {} };
  }
}

/**
 * Saves one host's order for a scope over what is stored, so a project view
 * saving its own never drops what another view saved meanwhile.
 */
function saveOrder(hostId: HostId, scope: CanopyScope, ids: readonly string[]): void {
  try {
    const slot = orderSlot(hostId, scope);
    const stored = readStoredOrders();
    delete stored[slot];
    // Kept per host from here on: the old copy would only go stale.
    if (hostId === LOCAL_HOST_ID) delete stored[legacyOrderSlot(scope)];
    stored[slot] = ids;
    const projects = Object.keys(stored).filter(
      (key) => key.startsWith("project:") || key.includes("|project:")
    );
    for (const key of projects.slice(0, Math.max(0, projects.length - MAX_PROJECT_ORDERS))) {
      delete stored[key];
    }
    window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Best effort: this view still keeps it for the session.
  }
}

function sameIds(was: readonly string[] | undefined, ids: readonly string[]): boolean {
  return was !== undefined && was.length === ids.length && was.every((id, i) => ids[i] === id);
}

function saveScope(scope: CanopyScope): void {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // Best effort: the choice still holds for this session.
  }
}

let replyRevealSeq = 0;

function opened(state: CanopyState): Partial<CanopyState> {
  if (canopyResumeFresh(state.resume, Date.now())) {
    return { isOpen: true, hostId: state.resume!.hostId };
  }
  return {
    isOpen: true,
    resume: null,
    hostId: state.hostId === ALL_HOSTS_ID ? ALL_HOSTS_ID : null,
  };
}

/**
 * Open state for the canopy panel, and the latest cards main pushed.
 *
 * A store for the same reason as `pilotStore`: the panel opens from an action,
 * a keybinding and a toolbar button, and is lazy-mounted only once open. The
 * snapshot is kept across closes so reopening shows the last cards at once,
 * while main rescans in the background.
 */
export const useCanopyStore = create<CanopyState>((set, get) => ({
  isOpen: false,
  mode: "unset",
  seedMode: (mode) => set((state) => (state.snapshot === null ? { mode } : state)),
  snapshot: null,
  ...loadOrders(),
  setOrder: (scope, order) =>
    set((state) => {
      if (!sameIds(state.orders[scope]?.ids, order.ids)) {
        saveOrder(canopyOwnHostId(), scope, order.ids);
      }
      return { orders: { ...state.orders, [scope]: order } };
    }),
  hostId: loadHostId(),
  setHostId: (hostId) => {
    saveAllHosts(hostId === ALL_HOSTS_ID);
    set({ hostId: hostId === canopyOwnHostId() ? null : hostId });
  },
  setHostOrder: (hostId, order) =>
    set((state) => {
      if (!sameIds(state.hostOrders[hostId]?.ids, order.ids)) saveOrder(hostId, "all", order.ids);
      return { hostOrders: { ...state.hostOrders, [hostId]: order } };
    }),
  archivedExpanded: false,
  setArchivedExpanded: (expanded) => set({ archivedExpanded: expanded }),
  trashExpanded: false,
  setTrashExpanded: (expanded) => set({ trashExpanded: expanded }),
  unreadOnly: false,
  setUnreadOnly: (unreadOnly) => set({ unreadOnly }),
  scope: loadScope(),
  setScope: (scope) => {
    saveScope(scope);
    set({ scope });
  },
  roleFilter: loadRoleFilter(),
  setRoleFilter: (roleFilter) => {
    saveRoleFilter(roleFilter);
    set({ roleFilter });
  },
  workOf: null,
  showWorkOf: (workOf) => set({ workOf }),
  assistantHandbacksSeen: readHandbacksSeen(),
  seeAssistantHandback: (assistantId, observedAt) =>
    set((state) =>
      (state.assistantHandbacksSeen[assistantId] ?? -Infinity) >= observedAt
        ? state
        : {
            assistantHandbacksSeen: saveHandbackSeen(
              state.assistantHandbacksSeen,
              assistantId,
              observedAt
            ),
          }
    ),
  readingOfferDismissed: loadReadingOfferDismissed(),
  dismissReadingOffer: () => {
    saveReadingOfferDismissed();
    set({ readingOfferDismissed: true });
  },
  paneOfferDismissed: loadPaneOfferDismissed(),
  dismissPaneOffer: () => {
    savePaneOfferDismissed();
    set({ paneOfferDismissed: true, paneOfferHolder: null, paneOfferAttempt: null });
  },
  paneOfferHolder: null,
  claimPaneOffer: (panelId) =>
    set((state) => (state.paneOfferHolder === null ? { paneOfferHolder: panelId } : state)),
  releasePaneOffer: (panelId) =>
    set((state) => (state.paneOfferHolder === panelId ? { paneOfferHolder: null } : state)),
  paneOfferAttempt: null,
  startPaneOfferAttempt: (panelId) => set({ paneOfferAttempt: { panelId, status: "pending" } }),
  finishPaneOfferAttempt: (panelId, turnedOn) =>
    set((state) => {
      if (state.paneOfferAttempt?.panelId !== panelId) return state;
      return turnedOn
        ? { paneOfferAttempt: null, paneOfferTurnedOn: panelId }
        : { paneOfferAttempt: { panelId, status: "failed" } };
    }),
  paneOfferTurnedOn: null,
  closePaneOfferTurnedOn: () => set({ paneOfferTurnedOn: null }),
  forgetPaneOffer: (panelId) =>
    set((state) => ({
      paneOfferAttempt: state.paneOfferAttempt?.panelId === panelId ? null : state.paneOfferAttempt,
      paneOfferTurnedOn: state.paneOfferTurnedOn === panelId ? null : state.paneOfferTurnedOn,
    })),
  listWidth: loadListWidth(),
  setListWidth: (width) => {
    const next = width === null ? null : clampCanopyListWidth(width);
    if (width !== null && next === null) return;
    // Unchanged only if storage agrees: a sibling's write whose event hasn't
    // landed yet would otherwise outlive a reset made here first.
    if (next === get().listWidth && next === loadListWidth()) return;
    saveListWidth(next);
    set({ listWidth: next });
  },
  listDrag: null,
  setListDrag: (width) => set({ listDrag: width }),
  resume: null,
  // Every opening starts on the window's own host, unless the user chose All
  // hosts or is coming back from "Go to terminal".
  open: () => set((state) => (state.mode === "hidden" || state.isOpen ? state : opened(state))),
  close: () => set({ isOpen: false, workOf: null, resume: null, replyReveal: null }),
  closeForTerminal: (resume) => set({ isOpen: false, workOf: null, resume, replyReveal: null }),
  toggle: () =>
    set((state) =>
      state.isOpen
        ? { isOpen: false, workOf: null, resume: null, replyReveal: null }
        : state.mode === "hidden"
          ? state
          : opened(state)
    ),
  replyReveal: null,
  // On the host the row was listed under, which is where its reply's draft is:
  // All hosts names a run apart from its own host's list. A narrowing to one
  // assistant's work is for the opening it was made in.
  revealReply: (row) => {
    if (get().mode === "hidden") return false;
    set((state) => ({
      isOpen: true,
      resume: null,
      workOf: state.isOpen ? state.workOf : null,
      hostId: row.hostScope,
      replyReveal: { ...row, id: ++replyRevealSeq },
    }));
    return true;
  },
  settleReplyReveal: (id) =>
    set((state) => (state.replyReveal?.id === id ? { replyReveal: null } : state)),
  outdatedHost: false,
  applySnapshot: (received) =>
    set((state) => {
      const outdated = readsWithHostedService(received);
      const snapshot: CanopySnapshot = outdated
        ? { ...received, activated: false, cards: [], glances: [] }
        : received;
      // A pull answered after a newer push is older news.
      const held = state.snapshot?.sequence;
      if (held !== undefined && snapshot.sequence !== undefined && snapshot.sequence < held) {
        return state;
      }
      const mode = snapshot.mode;
      // A pane's refused turn-on stops mattering once Canopy is on or hidden
      // some other way: Settings, another view, the panel.
      const paneOfferAttempt =
        state.paneOfferAttempt?.status === "failed" && mode !== "unset"
          ? null
          : state.paneOfferAttempt;
      // Hidden from another view, or from Settings: a panel this view held open goes too.
      if (mode === "hidden") {
        return {
          snapshot,
          mode,
          outdatedHost: outdated,
          paneOfferAttempt,
          isOpen: false,
          workOf: null,
          resume: null,
          replyReveal: null,
        };
      }
      return { snapshot, mode, outdatedHost: outdated, paneOfferAttempt };
    }),
}));

// What a sibling project view saved, taken up here too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === HANDBACKS_SEEN_STORAGE_KEY) {
      // Merged, never replaced: a sibling's write can have raced this view's own.
      useCanopyStore.setState((state) => ({
        assistantHandbacksSeen: mergeHandbacksSeen(
          state.assistantHandbacksSeen,
          readHandbacksSeen()
        ),
      }));
      return;
    }
    if (event.key === READING_OFFER_DISMISSED_STORAGE_KEY) {
      if (loadReadingOfferDismissed()) useCanopyStore.setState({ readingOfferDismissed: true });
      return;
    }
    // Put away in a sibling project view: it goes from this one's panes too.
    if (event.key === PANE_OFFER_DISMISSED_STORAGE_KEY) {
      if (loadPaneOfferDismissed()) {
        useCanopyStore.setState({
          paneOfferDismissed: true,
          paneOfferHolder: null,
          paneOfferAttempt: null,
        });
      }
      return;
    }
    if (event.key === LIST_WIDTH_STORAGE_KEY) {
      useCanopyStore.setState({ listWidth: loadListWidth() });
    }
  });
}
