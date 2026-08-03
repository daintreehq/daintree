import { create } from "zustand";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { AgentState } from "@/types";
import { isAgentFleetActionEligible, isTerminalFleetEligible } from "./fleetEligibility";

// Carrier shape sourced from `getNarrowPanel`'s parameter so this file doesn't
// have to name the legacy carrier type directly — auto-tracks the carrier flip
// in step 5 of #8957.
type PanelCarrierMap = Parameters<typeof getNarrowPanel>[0];

export {
  isAgentFleetActionEligible,
  isFleetInterruptAgentEligible,
  isFleetRestartAgentEligible,
  isFleetWaitingAgentEligible,
  isTerminalErrorClusterEligible,
  isTerminalFleetEligible,
  resolveFleetAgentCapabilityId,
} from "./fleetEligibility";

export type FleetArmStatePreset = "working" | "waiting" | "finished";
export type FleetArmScope = "current" | "all";

interface FleetArmingState {
  armedIds: Set<string>;
  armOrder: string[];
  armOrderById: Record<string, number>;
  lastArmedId: string | null;

  // Monotonic counter incremented every time fleet broadcast actually fans out
  // a chunk of input. Renderer components watch this to fire a one-shot CSS
  // pulse on the broadcast bar's input edge. Increments only — never resets.
  broadcastSignal: number;

  // Transient hover/focus preview from the selection menu. Not persisted, not
  // part of the broadcast set — purely a UX hint so panes glow before the
  // user commits to the menu item.
  previewArmedIds: Set<string>;

  armId: (id: string) => void;
  disarmId: (id: string) => void;
  toggleId: (id: string) => void;
  armIds: (ids: string[]) => void;
  addToFleet: (ids: string[]) => void;
  armByState: (state: FleetArmStatePreset, scope: FleetArmScope, extend: boolean) => void;
  armAll: (scope: FleetArmScope) => void;
  armMatchingFilter: (worktreeIds: string[]) => void;
  clear: () => void;
  prune: (validIds: Set<string>) => void;
  noteBroadcastCommit: () => void;
  setPreviewArmedIds: (ids: Set<string>) => void;
  clearPreviewArmedIds: () => void;
}

function rebuildOrderById(order: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < order.length; i++) {
    out[order[i]!] = i + 1;
  }
  return out;
}

function matchesPreset(state: AgentState | null | undefined, preset: FleetArmStatePreset): boolean {
  switch (preset) {
    case "working":
      return state === "working";
    case "waiting":
      return state === "waiting";
    case "finished":
      return state === "completed" || state === "exited";
  }
}

export function isFleetArmEligible(
  t: PanelInstance | PanelCarrierMap[string] | undefined
): t is PtyPanelData {
  return isTerminalFleetEligible(t);
}

/**
 * Collect eligible terminal ids, ordered by panelIds (DOM/sidebar order),
 * optionally scoped to the currently active worktree.
 */
export function collectEligibleIds(
  scope: FleetArmScope,
  activeWorktreeId: string | null
): string[] {
  const state = usePanelStore.getState();
  const ids: string[] = [];
  for (const id of state.panelIds) {
    const t = getNarrowPanel(state.panelsById, id);
    if (!isFleetArmEligible(t)) continue;
    if (scope === "current") {
      if (!activeWorktreeId || t.worktreeId !== activeWorktreeId) continue;
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Pure dry-run of `armByState` — returns the ids that would be armed without
 * mutating the store. Used by the selection menu's hover/focus preview so the
 * panes that *would* be selected glow ahead of the click.
 */
export function computeArmByStateIds(
  preset: FleetArmStatePreset,
  scope: FleetArmScope,
  activeWorktreeId: string | null
): string[] {
  const state = usePanelStore.getState();
  const ids: string[] = [];
  for (const id of state.panelIds) {
    const t = getNarrowPanel(state.panelsById, id);
    if (!isAgentFleetActionEligible(t)) continue;
    if (scope === "current") {
      if (!activeWorktreeId || t.worktreeId !== activeWorktreeId) continue;
    }
    if (matchesPreset(t.agentState ?? null, preset)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Pure collector: agent terminal ids whose worktree is in `worktreeIds`, in
 * panelIds (sidebar) order. Backs `armMatchingFilter` (the store mutation)
 * behind the sidebar's arm-matching affordance. Agent-scoped, not
 * terminal-scoped, so bulk arming from the quick-filter bar matches the
 * state-filter presets beside it and leaves plain shells alone (#11637) —
 * shells stay armable one at a time, and `armAll` still takes everything live.
 *
 * The sidebar derives its own count reactively via
 * `selectSidebarFleetEligibleWorktreeById` rather than calling this; the two
 * must apply the same predicate or the tooltip count drifts from what a click
 * actually arms. Takes `panelIds`/`panelsById` explicitly so callers can pass
 * reactive selector values rather than reaching into `usePanelStore.getState()`.
 */
export function collectFilterArmEligibleIds(
  worktreeIds: readonly string[],
  panelIds: readonly string[],
  panelsById: PanelCarrierMap
): string[] {
  if (worktreeIds.length === 0) return [];
  const worktreeIdSet = new Set(worktreeIds);
  const ids: string[] = [];
  for (const id of panelIds) {
    const t = getNarrowPanel(panelsById, id);
    if (!isAgentFleetActionEligible(t)) continue;
    if (!t.worktreeId || !worktreeIdSet.has(t.worktreeId)) continue;
    ids.push(id);
  }
  return ids;
}

export const useFleetArmingStore = create<FleetArmingState>()((set, get) => ({
  armedIds: new Set<string>(),
  armOrder: [],
  armOrderById: {},
  lastArmedId: null,
  broadcastSignal: 0,
  previewArmedIds: new Set<string>(),

  armId: (id) =>
    set((s) => {
      if (s.armedIds.has(id)) {
        return { lastArmedId: id };
      }
      const nextArmed = new Set(s.armedIds);
      nextArmed.add(id);
      const nextOrder = [...s.armOrder, id];
      return {
        armedIds: nextArmed,
        armOrder: nextOrder,
        armOrderById: rebuildOrderById(nextOrder),
        lastArmedId: id,
      };
    }),

  disarmId: (id) =>
    set((s) => {
      if (!s.armedIds.has(id)) return {};
      const nextArmed = new Set(s.armedIds);
      nextArmed.delete(id);
      const nextOrder = s.armOrder.filter((x) => x !== id);
      const nextLast =
        s.lastArmedId === id ? (nextOrder[nextOrder.length - 1] ?? null) : s.lastArmedId;
      return {
        armedIds: nextArmed,
        armOrder: nextOrder,
        armOrderById: rebuildOrderById(nextOrder),
        lastArmedId: nextLast,
      };
    }),

  toggleId: (id) => {
    if (get().armedIds.has(id)) {
      get().disarmId(id);
    } else {
      get().armId(id);
    }
  },

  armIds: (ids) => {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    set({
      armedIds: new Set(unique),
      armOrder: unique,
      armOrderById: rebuildOrderById(unique),
      lastArmedId: unique[unique.length - 1] ?? null,
    });
  },

  // Append-only counterpart to armIds. Used by the ribbon's "+ Add panes…"
  // flow where the picker's intent is to extend the current fleet, not replace
  // it. Filters out ineligible and already-armed ids; no-ops (preserving
  // lastArmedId) when nothing new survives, so the focus-restore target on
  // Exit doesn't shift just because the user opened and closed the picker
  // without picking anything new.
  addToFleet: (ids) => {
    if (ids.length === 0) return;
    const panels = usePanelStore.getState().panelsById;
    set((s) => {
      const nextArmed = new Set(s.armedIds);
      const nextOrder = [...s.armOrder];
      const seenInBatch = new Set<string>();
      let lastAdded: string | null = null;
      for (const id of ids) {
        if (seenInBatch.has(id)) continue;
        seenInBatch.add(id);
        if (nextArmed.has(id)) continue;
        if (!isFleetArmEligible(getNarrowPanel(panels, id))) continue;
        nextArmed.add(id);
        nextOrder.push(id);
        lastAdded = id;
      }
      if (lastAdded === null) return {};
      return {
        armedIds: nextArmed,
        armOrder: nextOrder,
        armOrderById: rebuildOrderById(nextOrder),
        lastArmedId: lastAdded,
      };
    });
  },

  armByState: (preset, scope, extend) => {
    const ids = computeArmByStateIds(preset, scope, getActiveWorktreeId());
    if (extend) {
      set((s) => {
        const nextArmed = new Set(s.armedIds);
        const nextOrder = [...s.armOrder];
        let lastAdded: string | null = null;
        for (const id of ids) {
          if (!nextArmed.has(id)) {
            nextArmed.add(id);
            nextOrder.push(id);
            lastAdded = id;
          }
        }
        if (lastAdded === null) return {};
        return {
          armedIds: nextArmed,
          armOrder: nextOrder,
          armOrderById: rebuildOrderById(nextOrder),
          lastArmedId: lastAdded,
        };
      });
    } else {
      get().armIds(ids);
    }
  },

  armAll: (scope) => {
    const ids = collectEligibleIds(scope, getActiveWorktreeId());
    get().armIds(ids);
  },

  armMatchingFilter: (worktreeIds) => {
    const panelState = usePanelStore.getState();
    const ids = collectFilterArmEligibleIds(
      worktreeIds,
      panelState.panelIds,
      panelState.panelsById
    );
    // No eligible terminals — leave the existing armed set alone rather than
    // silently clearing it. The affordance stays present whenever any
    // worktrees match the filter; triggering it must not destroy the user's
    // prior selection when the filtered subset has no arm-eligible terminals.
    if (ids.length === 0) return;
    if (get().armedIds.size === 0) {
      get().armIds(ids);
    } else {
      set((s) => {
        const nextArmed = new Set(s.armedIds);
        const nextOrder = [...s.armOrder];
        let lastAdded: string | null = null;
        for (const id of ids) {
          if (!nextArmed.has(id)) {
            nextArmed.add(id);
            nextOrder.push(id);
            lastAdded = id;
          }
        }
        if (lastAdded === null) return {};
        return {
          armedIds: nextArmed,
          armOrder: nextOrder,
          armOrderById: rebuildOrderById(nextOrder),
          lastArmedId: lastAdded,
        };
      });
    }
  },

  clear: () =>
    set({
      armedIds: new Set<string>(),
      armOrder: [],
      armOrderById: {},
      lastArmedId: null,
      previewArmedIds: new Set<string>(),
    }),

  prune: (validIds) =>
    set((s) => {
      let changed = false;
      const nextOrder: string[] = [];
      for (const id of s.armOrder) {
        if (validIds.has(id)) {
          nextOrder.push(id);
        } else {
          changed = true;
        }
      }
      if (!changed) return {};
      const nextArmed = new Set(nextOrder);
      const nextLast =
        s.lastArmedId && nextArmed.has(s.lastArmedId)
          ? s.lastArmedId
          : (nextOrder[nextOrder.length - 1] ?? null);
      return {
        armedIds: nextArmed,
        armOrder: nextOrder,
        armOrderById: rebuildOrderById(nextOrder),
        lastArmedId: nextLast,
      };
    }),

  noteBroadcastCommit: () => set((s) => ({ broadcastSignal: s.broadcastSignal + 1 })),

  setPreviewArmedIds: (ids) => {
    const current = get().previewArmedIds;
    if (current.size === ids.size) {
      let same = true;
      for (const id of ids) {
        if (!current.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    set({ previewArmedIds: new Set(ids) });
  },

  clearPreviewArmedIds: () => {
    if (get().previewArmedIds.size === 0) return;
    set({ previewArmedIds: new Set<string>() });
  },
}));

function getActiveWorktreeId(): string | null {
  return useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
}

/**
 * Panel-removal pruning subscription. Wires `usePanelStore` changes into the
 * fleet-arming store so removed/trashed/backgrounded/ineligible panels drop
 * out of the armed set automatically. Registered by `initStoreOrchestrator()`
 * so the subscription is scoped to the renderer lifecycle (HMR-safe via the
 * orchestrator's `DisposableStore`) rather than module evaluation.
 *
 * Runs an initial reconciliation pass before subscribing so any armed ids
 * that became ineligible while the subscription was torn down (test
 * destroy → mutate panels → re-init) get pruned on re-registration.
 */
export function subscribeFleetArmingPanelPruning(): () => void {
  function reconcileAgainst(currentIds: readonly string[], currentById: PanelCarrierMap): void {
    const armed = useFleetArmingStore.getState().armedIds;
    if (armed.size === 0) return;

    const validIds = new Set<string>();
    for (const id of currentIds) {
      const t = getNarrowPanel(currentById, id);
      if (isFleetArmEligible(t)) validIds.add(id);
    }

    for (const id of armed) {
      if (!validIds.has(id)) {
        useFleetArmingStore.getState().prune(validIds);
        return;
      }
    }
  }

  let lastIds = usePanelStore.getState().panelIds;
  let lastPanelsById = usePanelStore.getState().panelsById;
  reconcileAgainst(lastIds, lastPanelsById);

  return usePanelStore.subscribe((state) => {
    const currentIds = state.panelIds;
    const currentById = state.panelsById;

    if (currentIds === lastIds && currentById === lastPanelsById) return;

    lastIds = currentIds;
    lastPanelsById = currentById;

    reconcileAgainst(currentIds, currentById);
  });
}
