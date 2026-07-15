import type { StateCreator } from "zustand";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isRuntimeAgentTerminal } from "@/utils/terminalType";
import { isTerminalVisible } from "@/lib/terminalVisibility";
import {
  isVisibleGridPanel,
  pickDockCloseFocusId,
  type GetPanelGroupInfo,
} from "@/store/panelFocusFallback";
import type { TerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

export type NavigationDirection = "up" | "down" | "left" | "right";

// Walk the visible terminal list from the currently focused position, advancing
// in `direction` and returning the first terminal that satisfies `predicate`.
// Anchoring on the *visible* list (not the predicate-filtered subset) preserves
// spatial memory: if focus is on a non-matching terminal between matches,
// "next" lands on the next match after that position rather than resetting to
// index 0 — and stays robust when an agent's state changes between presses.
function cycleToMatch(
  terminals: CarrierPanel[],
  focusedId: string | null,
  isInTrash: (id: string) => boolean,
  validWorktreeIds: Set<string>,
  predicate: (t: CarrierPanel) => boolean,
  direction: "next" | "prev"
): CarrierPanel | undefined {
  const visibleList = terminals.filter((t) => isTerminalVisible(t, isInTrash, validWorktreeIds));
  const len = visibleList.length;
  if (len === 0) return undefined;

  const focusedIndex = focusedId ? visibleList.findIndex((t) => t.id === focusedId) : -1;
  const step = direction === "next" ? 1 : -1;
  const start =
    focusedIndex === -1 ? (direction === "next" ? 0 : len - 1) : (focusedIndex + step + len) % len;

  for (let i = 0; i < len; i++) {
    const idx = (start + i * step + len) % len;
    const candidate = visibleList[idx]!;
    if (predicate(candidate)) return candidate;
  }
  return undefined;
}

function isOpenableDockTerminal(terminal: CarrierPanel | undefined): terminal is CarrierPanel {
  if (!terminal) return false;
  if (terminal.location !== "dock") return false;
  return true;
}

interface PreMaximizeLayoutSnapshot {
  gridCols: number;
  gridItemCount: number;
  worktreeId: string | undefined;
}

export type MaximizeTarget = { type: "panel"; id: string } | { type: "group"; id: string } | null;

export interface TerminalFocusSlice {
  focusedId: string | null;
  /**
   * Most recent panel that held focus before `focusedId`. Used by
   * `focusAlternate` for tmux-style A↔B toggling. Updated atomically alongside
   * `focusedId` only when the focused panel actually changes — re-focusing the
   * already-active panel must not corrupt the toggle. Cleared when the
   * referenced panel is removed or when focus state is reset.
   */
  previousFocusedId: string | null;
  /**
   * Session-wide preference for which sub-element of an agent pane should
   * receive focus on panel activation. Updated by clicks and focus events on
   * xterm vs the hybrid input. Cmd-Opt-Arrow navigation reads this so the user
   * stays in the same "mode" as they move between panes. Treat as preference,
   * not DOM truth — disabled inputs, missing hybrid bars, and hibernated
   * xterms still resolve to xterm via the availability resolver.
   */
  preferredTerminalFocusTarget: TerminalFocusTarget;
  setPreferredTerminalFocusTarget: (target: TerminalFocusTarget) => void;
  maximizedId: string | null;
  /** Tracks whether maximize is for a single panel or a tab group */
  maximizeTarget: MaximizeTarget;
  activeDockTerminalId: string | null;
  pingedId: string | null;
  /**
   * Monotonically increases on every `pingTerminal` call. Lets consumers
   * distinguish back-to-back pings of the same terminal — a Zustand `set` with
   * the same `pingedId` value is `Object.is`-equal and emits no update, so
   * `pingedId` alone can't drive a one-shot animation when the same row is
   * tapped twice within the 1.6s clear window.
   */
  pingSeq: number;
  preMaximizeLayout: PreMaximizeLayoutSnapshot | null;
  setFocused: (id: string | null, shouldPing?: boolean) => void;
  /**
   * Synthetic boot-time focus: lands an initial `focusedId` without
   * corrupting persistence. Mirrors the grid branch of `setFocused` (the
   * post-hydration picker only ever targets grid panels) but skips
   * `stampLastActive` (which would overwrite the per-panel recency that
   * `panelRestorePhase` uses to promote each worktree's most-recently-
   * focused panel) and skips `terminalInstanceService.wake` (the panel
   * is already woken by the restore pipeline). The orchestrator's
   * `trackTerminalFocus` and `selectWorktree({ source: "focus" })`
   * subscriptions still fire — `lastFocusedTerminalByWorktree` is
   * runtime-only and has no other writer, so the boot pick must seed it
   * for future worktree switches to restore last-focus. Callers MUST wrap
   * this in `suppressMruRecording(true)/(false)` if the MRU subscription
   * should not re-prepend the boot pick to `mruList` (see
   * `useAppHydration`).
   */
  setBootFocus: (id: string) => void;
  pingTerminal: (id: string) => void;
  toggleMaximize: (
    id: string,
    currentGridCols?: number,
    currentGridItemCount?: number,
    getPanelGroup?: (panelId: string) => { id: string; panelIds: string[] } | undefined
  ) => void;
  setMaximizedId: (id: string | null) => void;
  /** Get the maximize target (panel or group) */
  getMaximizeTarget: () => MaximizeTarget;
  /** Validate and cleanup maximize state if target is invalid */
  validateMaximizeTarget: (
    getPanelGroup: (panelId: string) => { id: string; panelIds: string[] } | undefined,
    getTerminal: (id: string) => CarrierPanel | undefined
  ) => void;
  /**
   * Atomically clear `maximizedId`, `maximizeTarget`, and `preMaximizeLayout`.
   * Use this when the underlying panel (or the whole panel grid) is being
   * removed — trash, group trash, reset, project switch, fleet scope exit.
   * The three fields must move together in those paths: dropping only the
   * id strands a stale target and the next `toggleMaximize` treats the
   * target as an unmaximize request (#9935). Plain `toggleMaximize`
   * unmaximize is intentionally NOT routed through this — it preserves
   * `preMaximizeLayout` so the next maximize can reuse the snapshot.
   */
  clearMaximize: () => void;
  /**
   * Leave fullscreen and return to the grid, unconditionally. Preserves
   * `preMaximizeLayout` so the column count restores exactly as a manual
   * unmaximize would — the sibling of `clearMaximize`: the user is going back to
   * the grid, not losing the panel.
   *
   * Prefer this over `toggleMaximize` wherever the exit is not a user toggle of a
   * known target. `toggleMaximize` only unmaximizes when it can resolve the
   * target (a group target needs `getPanelGroup(maximizedId)` to still return
   * that group); if the group has dissolved it falls through and *maximizes*
   * instead. That misfire is harmless for a hotkey but not for the panel-creation
   * paths, which must always end up in the grid (#11060).
   */
  exitMaximize: () => void;
  clearPreMaximizeLayout: () => void;
  focusNext: () => void;
  focusPrevious: () => void;
  /**
   * Toggles focus between the current panel and the previously focused panel
   * (tmux `last-pane` semantics). No-op when no valid alternate exists.
   */
  focusAlternate: () => void;
  focusDirection: (
    direction: NavigationDirection,
    findNearest: (id: string, dir: NavigationDirection) => string | null
  ) => void;
  focusByIndex: (index: number, findByIndex: (idx: number) => string | null) => void;
  /**
   * Stateless "press-again-to-fullscreen" for the index hotkeys (Cmd+1..9).
   * While a panel is fullscreen: pressing the shown (maximized) cell's index
   * restores the grid; pressing any other index restores the grid and reveals
   * that panel in it — so a panel opened in the background while fullscreen
   * shows in the grid first, and only goes fullscreen on a second press. The
   * shown cell is the maximized one, which may differ from the focused panel.
   * When nothing is fullscreen: pressing the focused cell's index (or a sibling
   * tab of the focused group) maximizes it; pressing any other index focuses
   * that panel.
   */
  focusOrMaximizeByIndex: (
    index: number,
    findByIndex: (idx: number) => string | null,
    getPanelGroup?: (panelId: string) => { id: string; panelIds: string[] } | undefined
  ) => void;
  focusDockDirection: (
    direction: "left" | "right",
    findDockByIndex: (id: string, dir: "left" | "right") => string | null
  ) => void;

  // Dock terminal activation
  openDockTerminal: (id: string) => void;
  /** `expectedId` names the pane being dismissed; a stale close is ignored. */
  closeDockTerminal: (expectedId: string) => void;
  activateTerminal: (id: string | null) => void;

  // Agent state navigation
  focusNextWaiting: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;
  focusNextWorking: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;
  // Agent cycling (any state)
  focusNextAgent: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;
  focusPreviousAgent: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;

  // Dock-specific blocked agent cycling (waiting agents)
  focusNextBlockedDock: (
    activeWorktreeId: string | undefined,
    getPanelGroup?: (panelId: string) => { id: string; panelIds: string[] } | undefined
  ) => void;

  handleTerminalRemoved: (
    removedId: string,
    terminals: CarrierPanel[],
    removedIndex: number
  ) => void;
}

export const createTerminalFocusSlice =
  (
    getTerminals: () => CarrierPanel[],
    getActiveWorktreeId: () => string | null,
    stampLastActive: (id: string) => void,
    getPanelGroupInfo: GetPanelGroupInfo
  ): StateCreator<TerminalFocusSlice, [], [], TerminalFocusSlice> =>
  (set, get) => {
    let pingTimeout: ReturnType<typeof setTimeout> | null = null;

    return {
      focusedId: null,
      previousFocusedId: null,
      preferredTerminalFocusTarget: "hybridInput",
      setPreferredTerminalFocusTarget: (target) => {
        // Idempotent: skip the set when the value is unchanged so DOM focus
        // listeners don't cause notification storms or feedback loops with the
        // TerminalPane focus useEffect.
        if (get().preferredTerminalFocusTarget === target) return;
        set({ preferredTerminalFocusTarget: target });
      },
      maximizedId: null,
      maximizeTarget: null,
      activeDockTerminalId: null,
      pingedId: null,
      pingSeq: 0,
      preMaximizeLayout: null,
      setFocused: (id, shouldPing = false) => {
        if (id) {
          const previousFocusedId = get().focusedId;
          const focusActuallyChanged = id !== previousFocusedId;
          const terminal = getTerminals().find((t) => t.id === id);
          // Snapshot BEFORE the set() below flips activeDockTerminalId to `id`: a
          // dock pane that was already the active dock terminal is live (popover
          // open), like a grid re-focus; a dock pane that was NOT active is a
          // first reveal from the parked/offscreen dock and needs a genuine wake.
          const wasActiveDockTerminal =
            terminal?.location === "dock" && get().activeDockTerminalId === id;
          if (terminal?.location === "dock") {
            set({
              focusedId: id,
              activeDockTerminalId: id,
              ...(focusActuallyChanged && { previousFocusedId }),
            });
          } else {
            set({
              focusedId: id,
              activeDockTerminalId: null,
              ...(focusActuallyChanged && { previousFocusedId }),
            });
          }
          if (terminal) {
            stampLastActive(id);
          }
          // Wake-on-focus: recover this pane's renderer when focus MOVES to it.
          // Skip when re-focusing the already-focused terminal (#10800). Use
          // `wakeForFocus`, NOT `wake`: a live foreground pane is fed by the live
          // PTY stream and is already current, so the full wake's reset()+replay
          // is unnecessary and, for an alt-screen TUI (OpenCode), destructive —
          // it duplicates/collapses the frame (the "click a settled OpenCode and
          // it goes weird" corruption; the host noChange skip can't catch it
          // because the TUI redraws continuously). wakeForFocus still full-wakes
          // main-buffer and genuinely-stale panes. A first reveal of a parked
          // dock tab keeps the full wake; an already-open dock tab and any grid
          // pane take wakeForFocus. Skip non-PTY panels.
          if (focusActuallyChanged && terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
            if (terminal.location === "dock" && !wasActiveDockTerminal) {
              terminalInstanceService.wake(id);
            } else {
              terminalInstanceService.wakeForFocus(id);
            }
          }
          // Only ping when selection actually changes — re-focusing the already
          // selected terminal should be a no-op visually (no 1.6s ping loop).
          if (shouldPing && focusActuallyChanged) {
            get().pingTerminal(id);
          }
        } else {
          set({ focusedId: null, activeDockTerminalId: null });
        }
      },

      setBootFocus: (id) => {
        // Bare focus commit — the boot pick is always a grid panel (the picker
        // in `useAppHydration` filters `location === "grid"`), so the dock
        // branch of `setFocused` is unreachable here. Skips `stampLastActive`
        // (no disk write to per-panel recency), `terminalInstanceService.wake`
        // (the restore pipeline already woke it), and `pingTerminal` (no
        // user intent to visualize). `previousFocusedId` only moves when focus
        // actually changes — the `null → bootPick` transition preserves the
        // existing `previousFocusedId: null` (no real prior focus existed).
        const previousFocusedId = get().focusedId;
        const focusActuallyChanged = id !== previousFocusedId;
        set({
          focusedId: id,
          activeDockTerminalId: null,
          ...(focusActuallyChanged && { previousFocusedId }),
        });
      },

      pingTerminal: (id) => {
        if (pingTimeout) clearTimeout(pingTimeout);
        set((state) => ({ pingedId: id, pingSeq: state.pingSeq + 1 }));
        pingTimeout = setTimeout(() => {
          if (get().pingedId === id) {
            set({ pingedId: null });
          }
          pingTimeout = null;
        }, 1600);
      },

      toggleMaximize: (id, currentGridCols, currentGridItemCount, getPanelGroup) =>
        set((state) => {
          const activeWorktreeId = getActiveWorktreeId();

          // Check if we're unmaximizing
          // Unmaximize if:
          // 1. The maximized panel/group contains this panel
          // 2. We're clicking on a panel that's already maximized (same panel)
          // 3. We're clicking on any panel while a group is maximized that contains this panel
          let shouldUnmaximize = false;
          if (state.maximizeTarget) {
            if (state.maximizeTarget.type === "panel" && state.maximizeTarget.id === id) {
              shouldUnmaximize = true;
            } else if (state.maximizeTarget.type === "group") {
              if (getPanelGroup) {
                const group = getPanelGroup(id);
                if (group && group.id === state.maximizeTarget.id) {
                  shouldUnmaximize = true;
                }
              } else {
                // Backwards compatibility: if getPanelGroup not provided, fall back to panel ID check
                if (state.maximizedId === id) {
                  shouldUnmaximize = true;
                }
              }
            }
          } else if (state.maximizedId === id) {
            // Backwards compatibility: old behavior when no maximizeTarget
            shouldUnmaximize = true;
          }

          if (shouldUnmaximize) {
            return {
              maximizedId: null,
              maximizeTarget: null,
            };
          }

          // Maximizing - check if panel is in a group
          const group = getPanelGroup?.(id);
          const layoutSnapshot =
            currentGridCols !== undefined && currentGridItemCount !== undefined
              ? {
                  gridCols: currentGridCols,
                  gridItemCount: currentGridItemCount,
                  worktreeId: activeWorktreeId ?? undefined,
                }
              : null;

          if (group && group.panelIds.length > 1) {
            // Panel is in a group with multiple panels - maximize the entire group
            return {
              maximizedId: id, // Keep track of which panel triggered maximize for backwards compatibility
              maximizeTarget: { type: "group", id: group.id },
              preMaximizeLayout: layoutSnapshot,
            };
          } else {
            // Single panel (not in a group or group has only 1 panel) - maximize just the panel
            return {
              maximizedId: id,
              maximizeTarget: { type: "panel", id },
              preMaximizeLayout: layoutSnapshot,
            };
          }
        }),

      setMaximizedId: (id) =>
        set({
          maximizedId: id,
        }),

      getMaximizeTarget: () => get().maximizeTarget,

      validateMaximizeTarget: (getPanelGroup, getTerminal) => {
        const state = get();
        // Only skip when the target itself is null — a dangling target with a
        // null id is exactly the case #9935 asks us to self-heal. The
        // group-shrink downgrade and the trash/removed clear both run below.
        if (!state.maximizeTarget) return;
        if (!state.maximizedId) {
          // Dangling target without a backing id — the trio can no longer
          // resolve to a real panel, so clear all three defensively. The
          // wrapper-level fix in `trashPanel` / `trashPanelGroup` covers the
          // common case; this is a safety net for any future path that
          // nulls `maximizedId` without touching `maximizeTarget`.
          set({
            maximizedId: null,
            maximizeTarget: null,
            preMaximizeLayout: null,
          });
          return;
        }

        let shouldClear = false;

        if (state.maximizeTarget.type === "panel") {
          // Check if the panel still exists
          const terminal = getTerminal(state.maximizedId);
          if (!terminal || terminal.location === "trash") {
            shouldClear = true;
          }
        } else if (state.maximizeTarget.type === "group") {
          // Check if the group still exists and contains the maximized panel
          const group = getPanelGroup(state.maximizedId);
          if (!group || group.id !== state.maximizeTarget.id) {
            // Group is gone or panel moved out - clear maximize
            shouldClear = true;
          } else if (group.panelIds.length === 1) {
            // Group shrunk to single panel - downgrade to panel maximize
            set({
              maximizeTarget: { type: "panel", id: state.maximizedId },
            });
            return;
          }
        }

        if (shouldClear) {
          set({
            maximizedId: null,
            maximizeTarget: null,
            preMaximizeLayout: null,
          });
        }
      },

      clearPreMaximizeLayout: () =>
        set({
          preMaximizeLayout: null,
        }),

      clearMaximize: () =>
        set({
          maximizedId: null,
          maximizeTarget: null,
          preMaximizeLayout: null,
        }),

      exitMaximize: () => {
        if (!get().maximizedId && !get().maximizeTarget) return;
        set({
          maximizedId: null,
          maximizeTarget: null,
        });
      },

      focusNext: () => {
        const terminals = getTerminals();
        const activeWorktreeId = getActiveWorktreeId();
        const worktreeMatch = (t: CarrierPanel) =>
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined);

        const gridTerminals = terminals.filter(
          (t) => (t.location === "grid" || !t.location) && worktreeMatch(t)
        );
        const dockTerminals = terminals.filter((t) => t.location === "dock" && worktreeMatch(t));
        const cycleList = [...gridTerminals, ...dockTerminals];
        if (cycleList.length === 0) return;

        const { focusedId, activateTerminal } = get();
        const currentIndex = focusedId ? cycleList.findIndex((t) => t.id === focusedId) : -1;
        const nextIndex = (currentIndex + 1) % cycleList.length;
        activateTerminal(cycleList[nextIndex]!.id);
      },

      focusPrevious: () => {
        const terminals = getTerminals();
        const activeWorktreeId = getActiveWorktreeId();
        const worktreeMatch = (t: CarrierPanel) =>
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined);

        const gridTerminals = terminals.filter(
          (t) => (t.location === "grid" || !t.location) && worktreeMatch(t)
        );
        const dockTerminals = terminals.filter((t) => t.location === "dock" && worktreeMatch(t));
        const cycleList = [...gridTerminals, ...dockTerminals];
        if (cycleList.length === 0) return;

        const { focusedId, activateTerminal } = get();
        const currentIndex = focusedId ? cycleList.findIndex((t) => t.id === focusedId) : 0;
        const prevIndex = currentIndex <= 0 ? cycleList.length - 1 : currentIndex - 1;
        activateTerminal(cycleList[prevIndex]!.id);
      },

      focusDirection: (direction, findNearest) => {
        const { focusedId, activateTerminal } = get();
        if (!focusedId) return;
        const nextId = findNearest(focusedId, direction);
        if (nextId) {
          activateTerminal(nextId);
        }
      },

      focusByIndex: (index, findByIndex) => {
        const nextId = findByIndex(index);
        if (nextId) {
          get().activateTerminal(nextId);
        }
      },

      focusOrMaximizeByIndex: (index, findByIndex, getPanelGroup) => {
        const targetId = findByIndex(index);
        if (!targetId) return;
        const {
          focusedId,
          maximizedId,
          maximizeTarget,
          toggleMaximize,
          exitMaximize,
          activateTerminal,
        } = get();

        if (maximizedId) {
          // A panel/group is fullscreen. The cell actually *shown* is the
          // maximized one — which may differ from focusedId when a panel was
          // focused in the background without being displayed. Anchor on the
          // maximized cell (not focus) so re-pressing the shown cell just
          // restores the grid, while any other index also focuses that panel.
          const targetIsMaximizedCell =
            maximizedId === targetId ||
            (maximizeTarget?.type === "group" &&
              getPanelGroup?.(targetId)?.id === maximizeTarget.id);
          exitMaximize();
          if (!targetIsMaximizedCell) {
            activateTerminal(targetId);
          }
          return;
        }

        // Nothing is fullscreen. Re-pressing the focused cell goes fullscreen.
        // findByIndex resolves a tab group to its active-tab representative, so
        // a focused *sibling* tab of the same group still counts as the same
        // cell — re-pressing it should maximize the group, not switch+focus.
        const focusedGroupId = focusedId ? getPanelGroup?.(focusedId)?.id : undefined;
        const inSameCell =
          focusedId === targetId ||
          (focusedGroupId !== undefined && focusedGroupId === getPanelGroup?.(targetId)?.id);

        if (inSameCell) {
          // Re-pressing the focused cell goes fullscreen (group-aware:
          // maximizes the whole tab group when grouped).
          toggleMaximize(targetId, undefined, undefined, getPanelGroup);
          return;
        }

        // A different cell with nothing maximized: just focus it.
        activateTerminal(targetId);
      },

      focusDockDirection: (direction, findDockByIndex) => {
        const { focusedId, activateTerminal } = get();
        if (!focusedId) return;
        const nextId = findDockByIndex(focusedId, direction);
        if (nextId) {
          activateTerminal(nextId);
        }
      },

      openDockTerminal: (id) => {
        // Skip wake for non-PTY panels - they don't have backend PTY processes.
        const terminal = getTerminals().find((t) => t.id === id);
        if (!isOpenableDockTerminal(terminal)) {
          set((state) => {
            if (state.activeDockTerminalId === null && state.focusedId !== id) return state;
            return {
              activeDockTerminalId: null,
              focusedId: state.focusedId === id ? null : state.focusedId,
            };
          });
          return;
        }
        if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
          // Re-focusing the already-open dock pane is live (like a grid click) —
          // wakeForFocus avoids the alt-screen clobber; a first reveal from the
          // parked/offscreen dock is a genuine wake.
          if (get().activeDockTerminalId === id) {
            terminalInstanceService.wakeForFocus(id);
          } else {
            terminalInstanceService.wake(id);
          }
        }
        if (isPtyPanel(terminal) && terminal.agentState === "waiting") {
          window.electron?.notification?.acknowledgeWaiting(id);
        }
        if (isPtyPanel(terminal) && terminal.agentState === "working") {
          window.electron?.notification?.acknowledgeWorkingPulse(id);
        }
        const previousFocusedId = get().focusedId;
        const focusActuallyChanged = id !== previousFocusedId;
        set({
          activeDockTerminalId: id,
          focusedId: id,
          ...(focusActuallyChanged && { previousFocusedId }),
        });
        stampLastActive(id);
      },

      closeDockTerminal: (expectedId) =>
        set((state) => {
          // A close is always *for* a pane. Dock popovers open and close from
          // several places (chip click, drag start, Escape, the phantom-panel
          // watchdog), and a stale close firing after another pane has already
          // opened would otherwise tear focus out of the pane that just won it.
          if (state.activeDockTerminalId !== expectedId) return state;

          if (state.focusedId !== expectedId) {
            return { activeDockTerminalId: null };
          }

          // The pane being hidden owns the keyboard. Leaving `focusedId` on it
          // parks focus in a pane the user can no longer see, and every
          // keystroke keeps flowing into it (#11133).
          const nextFocusedId = pickDockCloseFocusId({
            panels: getTerminals(),
            activeWorktreeId: getActiveWorktreeId(),
            previousFocusedId: state.previousFocusedId,
            maximizedId: state.maximizedId,
            maximizeTarget: state.maximizeTarget,
            getPanelGroupInfo,
          });

          return {
            activeDockTerminalId: null,
            focusedId: nextFocusedId,
            // The round-trip pointer only means something between two panes the
            // user chose. This hand-back is automatic, so it has no alternate.
            previousFocusedId: null,
          };
        }),

      activateTerminal: (id) => {
        if (!id) {
          set({ focusedId: null });
          return;
        }
        const terminals = getTerminals();
        const terminal = terminals.find((t) => t.id === id);
        if (!terminal) return;

        // Wake-on-focus: recover this pane's renderer when activated. A first
        // reveal of a parked dock pane takes the full wake; a grid pane and an
        // already-open dock pane (activeDockTerminalId === id) are live, so they
        // take wakeForFocus — which never reset+replays a live alt-screen TUI.
        // Skip non-PTY panels (no backend PTY).
        if (panelKindHasPty(terminal.kind ?? "terminal")) {
          const isFirstDockReveal =
            terminal.location === "dock" && get().activeDockTerminalId !== id;
          if (isFirstDockReveal) {
            terminalInstanceService.wake(id);
          } else {
            terminalInstanceService.wakeForFocus(id);
          }
        }

        const previousFocusedId = get().focusedId;
        const focusActuallyChanged = id !== previousFocusedId;

        if (terminal.location === "dock") {
          if (isPtyPanel(terminal) && terminal.agentState === "waiting") {
            window.electron?.notification?.acknowledgeWaiting(id);
          }
          if (isPtyPanel(terminal) && terminal.agentState === "working") {
            window.electron?.notification?.acknowledgeWorkingPulse(id);
          }
          set({
            activeDockTerminalId: id,
            focusedId: id,
            ...(focusActuallyChanged && { previousFocusedId }),
          });
        } else {
          set({
            focusedId: id,
            activeDockTerminalId: null,
            ...(focusActuallyChanged && { previousFocusedId }),
          });
        }
        stampLastActive(id);
      },

      focusAlternate: () => {
        const { previousFocusedId, focusedId, activateTerminal } = get();
        if (!previousFocusedId || previousFocusedId === focusedId) return;
        const target = getTerminals().find((t) => t.id === previousFocusedId);
        if (!target) return;
        // Skip targets that are no longer reachable: trashed panels are
        // pending TTL cleanup and background panels are hibernated mirrors,
        // not user-visible. Activating either would surface a panel the user
        // didn't expect or fail outright.
        if (target.location === "trash" || target.location === "background") return;
        activateTerminal(previousFocusedId);
      },

      focusNextWaiting: (isInTrash, validWorktreeIds) => {
        const { focusedId, activateTerminal, pingTerminal } = get();
        const next = cycleToMatch(
          getTerminals(),
          focusedId,
          isInTrash,
          validWorktreeIds,
          (t) => isPtyPanel(t) && t.agentState === "waiting",
          "next"
        );
        if (!next) return;
        activateTerminal(next.id);
        pingTerminal(next.id);
      },

      focusNextWorking: (isInTrash, validWorktreeIds) => {
        const { focusedId, activateTerminal, pingTerminal } = get();
        const next = cycleToMatch(
          getTerminals(),
          focusedId,
          isInTrash,
          validWorktreeIds,
          (t) => isPtyPanel(t) && t.agentState === "working",
          "next"
        );
        if (!next) return;
        activateTerminal(next.id);
        pingTerminal(next.id);
      },

      focusNextAgent: (isInTrash, validWorktreeIds) => {
        // Uses runtime identity so ex-agent panels are excluded and promoted shells
        // with a detected agent are included.
        const { focusedId, activateTerminal, pingTerminal } = get();
        const next = cycleToMatch(
          getTerminals(),
          focusedId,
          isInTrash,
          validWorktreeIds,
          (t) => isRuntimeAgentTerminal(t),
          "next"
        );
        if (!next) return;
        activateTerminal(next.id);
        pingTerminal(next.id);
      },

      focusPreviousAgent: (isInTrash, validWorktreeIds) => {
        // Uses runtime identity so ex-agent panels are excluded and promoted shells
        // with a detected agent are included.
        const { focusedId, activateTerminal, pingTerminal } = get();
        const prev = cycleToMatch(
          getTerminals(),
          focusedId,
          isInTrash,
          validWorktreeIds,
          (t) => isRuntimeAgentTerminal(t),
          "prev"
        );
        if (!prev) return;
        activateTerminal(prev.id);
        pingTerminal(prev.id);
      },

      focusNextBlockedDock: (activeWorktreeId, getPanelGroup) => {
        const terminals = getTerminals();
        const { activeDockTerminalId, openDockTerminal, pingTerminal } = get();
        // setActiveTab lives on PanelRegistrySlice; accessed via composed store at runtime
        const setActiveTab = (get() as unknown as { setActiveTab: (g: string, p: string) => void })
          .setActiveTab;

        const dockTerminals = terminals.filter(
          (t): t is PanelInstance =>
            t.location === "dock" &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined) &&
            isPtyPanel(t) &&
            t.excludeFromPersistence !== true &&
            t.agentState === "waiting"
        );

        if (dockTerminals.length === 0) return;

        const sorted = dockTerminals;

        const currentIndex = sorted.findIndex((t) => t.id === activeDockTerminalId);
        const nextIndex = (currentIndex + 1) % sorted.length;
        const nextTerminal = sorted[nextIndex]!;

        // Activate the correct tab in the group before opening the dock popover
        if (getPanelGroup) {
          const group = getPanelGroup(nextTerminal.id);
          if (group) {
            setActiveTab(group.id, nextTerminal.id);
          }
        }

        openDockTerminal(nextTerminal.id);
        pingTerminal(nextTerminal.id);
      },

      handleTerminalRemoved: (removedId, remainingTerminals, removedIndex) => {
        const state = get();
        if (state.pingedId === removedId && pingTimeout) {
          clearTimeout(pingTimeout);
          pingTimeout = null;
        }

        set((state) => {
          const updates: Partial<TerminalFocusSlice> = {};

          if (state.pingedId === removedId) {
            updates.pingedId = null;
          }

          if (state.focusedId === removedId) {
            const activeWorktreeId = getActiveWorktreeId();
            const gridTerminals = remainingTerminals.filter((t) =>
              isVisibleGridPanel(t, activeWorktreeId)
            );

            if (gridTerminals.length > 0) {
              const boundedIndex = Math.max(0, removedIndex);
              const precedingCount = remainingTerminals
                .slice(0, boundedIndex)
                .filter((t) => isVisibleGridPanel(t, activeWorktreeId)).length;
              const nextIndex = Math.min(precedingCount, gridTerminals.length - 1);
              updates.focusedId = gridTerminals[nextIndex]?.id || null;
            } else {
              updates.focusedId = null;
            }
            // Auto-fallback focus is not a user navigation event, so the round-
            // trip semantic doesn't apply — clear the alternate pointer rather
            // than letting it point at a panel that wasn't the user's previous.
            updates.previousFocusedId = null;
          } else if (state.previousFocusedId === removedId) {
            updates.previousFocusedId = null;
          }

          // Clear maximize state if the removed panel was maximized, or if it was in a maximized group
          if (state.maximizedId === removedId) {
            updates.maximizedId = null;
            updates.maximizeTarget = null;
            updates.preMaximizeLayout = null;
          } else if (state.maximizeTarget?.type === "group") {
            // Check if the removed panel was part of the maximized group
            // We need to validate the group still exists and is valid
            // This will be handled by the group cleanup logic in the registry slice
            // For now, we mark that validation is needed by checking in the next render
            // The ContentGrid will handle the fallback when it can't find the group
          }

          if (state.activeDockTerminalId === removedId) {
            updates.activeDockTerminalId = null;
          }

          return Object.keys(updates).length > 0 ? updates : state;
        });
      },
    };
  };
