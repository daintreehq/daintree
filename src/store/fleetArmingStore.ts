import { create } from "zustand";
import { usePanelStore } from "@/store/panelStore";
import {
  useWorktreeSelectionStore,
  setFleetArmedIdsGetter,
  setFleetLastArmedIdGetter,
} from "@/store/worktreeStore";
import { setFleetArmingClear } from "@/store/projectStore";
import type { TerminalInstance } from "@shared/types";
import type { AgentState } from "@/types";
import { isAgentFleetActionEligible, isTerminalFleetEligible } from "./fleetEligibility";

export {
  isAgentFleetActionEligible,
  isFleetInterruptAgentEligible,
  isFleetRestartAgentEligible,
  isFleetWaitingAgentEligible,
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

export function isFleetArmEligible(t: TerminalInstance | undefined): t is TerminalInstance {
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
    const t = state.panelsById[id];
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
    const t = state.panelsById[id];
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
    if (worktreeIds.length === 0) return;
    const worktreeIdSet = new Set(worktreeIds);
    const state = usePanelStore.getState();
    const ids: string[] = [];
    for (const id of state.panelIds) {
      const t = state.panelsById[id];
      if (!isFleetArmEligible(t)) continue;
      if (!t.worktreeId || !worktreeIdSet.has(t.worktreeId)) continue;
      ids.push(id);
    }
    // No eligible terminals — leave the existing armed set alone rather than
    // silently clearing it. The button is still visible whenever any
    // worktrees match the filter; clicking it must not destroy the user's
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

// Register the clear callback so projectStore.switchProject() can drop armed
// selections synchronously on project switch.
setFleetArmingClear(() => {
  useFleetArmingStore.getState().clear();
});

// Expose the armed-id set to worktreeStore so its terminal-streaming policy
// can keep armed cross-worktree terminals at VISIBLE during fleet scope.
// Using a getter-injection pattern (identical to `setFleetArmingClear`)
// avoids an otherwise cyclic module import.
setFleetArmedIdsGetter(() => useFleetArmingStore.getState().armedIds);
setFleetLastArmedIdGetter(() => useFleetArmingStore.getState().lastArmedId);

/**
 * Module-scope subscription: when panels are removed, relocated to trash/background,
 * or become ineligible, prune them from the armed set.
 *
 * HMR and test re-imports would otherwise stack subscribers on every module
 * reload. We store registration state on `globalThis` so a subsequent module
 * instance reuses the existing subscription but drives the *current* store —
 * mirroring the pattern in `projectStore.ts`.
 */
interface FleetArmingSubscriptionState {
  registered: boolean;
  lastSnapshot: { ids: string[]; panelsById: Record<string, TerminalInstance> } | null;
}

const FLEET_ARMING_SUBSCRIPTION_KEY = "__daintreeFleetArmingSubscription";

function getFleetArmingSubscriptionState(): FleetArmingSubscriptionState {
  const target = globalThis as typeof globalThis & {
    [FLEET_ARMING_SUBSCRIPTION_KEY]?: FleetArmingSubscriptionState;
  };
  const existing = target[FLEET_ARMING_SUBSCRIPTION_KEY];
  if (existing) return existing;
  const created: FleetArmingSubscriptionState = { registered: false, lastSnapshot: null };
  target[FLEET_ARMING_SUBSCRIPTION_KEY] = created;
  return created;
}

if (typeof usePanelStore.subscribe === "function") {
  const subState = getFleetArmingSubscriptionState();
  if (!subState.registered) {
    subState.registered = true;
    subState.lastSnapshot = {
      ids: usePanelStore.getState().panelIds,
      panelsById: usePanelStore.getState().panelsById,
    };

    usePanelStore.subscribe((state) => {
      const prev = subState.lastSnapshot;
      const currentIds = state.panelIds;
      const currentById = state.panelsById;

      if (prev && currentIds === prev.ids && currentById === prev.panelsById) return;

      subState.lastSnapshot = { ids: currentIds, panelsById: currentById };

      const armed = useFleetArmingStore.getState().armedIds;
      if (armed.size === 0) return;

      const validIds = new Set<string>();
      for (const id of currentIds) {
        const t = currentById[id];
        if (isFleetArmEligible(t)) validIds.add(id);
      }

      for (const id of armed) {
        if (!validIds.has(id)) {
          useFleetArmingStore.getState().prune(validIds);
          return;
        }
      }
    });
  }
}
