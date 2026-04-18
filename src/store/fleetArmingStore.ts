import { create } from "zustand";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { setFleetArmingClear } from "@/store/projectStore";
import { isAgentTerminal } from "@/utils/terminalType";
import type { TerminalInstance } from "@shared/types";
import type { AgentState } from "@/types";

export type FleetArmStatePreset = "working" | "waiting" | "finished";
export type FleetArmScope = "current" | "all";

interface FleetArmingState {
  armedIds: Set<string>;
  armOrder: string[];
  armOrderById: Record<string, number>;
  lastArmedId: string | null;

  armId: (id: string) => void;
  disarmId: (id: string) => void;
  toggleId: (id: string) => void;
  armIds: (ids: string[]) => void;
  extendTo: (id: string, orderedEligibleIds: string[]) => void;
  armByState: (state: FleetArmStatePreset, scope: FleetArmScope, extend: boolean) => void;
  armAll: (scope: FleetArmScope) => void;
  clear: () => void;
  prune: (validIds: Set<string>) => void;
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
      return state === "working" || state === "running";
    case "waiting":
      return state === "waiting";
    case "finished":
      return state === "completed" || state === "exited";
  }
}

export function isFleetArmEligible(t: TerminalInstance | undefined): t is TerminalInstance {
  if (!t) return false;
  if (t.location === "trash" || t.location === "background") return false;
  if (t.hasPty === false) return false;
  return isAgentTerminal(t.kind ?? t.type, t.agentId);
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

export const useFleetArmingStore = create<FleetArmingState>()((set, get) => ({
  armedIds: new Set<string>(),
  armOrder: [],
  armOrderById: {},
  lastArmedId: null,

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

  extendTo: (id, orderedEligibleIds) => {
    const { lastArmedId } = get();
    const anchor = lastArmedId ?? id;
    const startIdx = orderedEligibleIds.indexOf(anchor);
    const endIdx = orderedEligibleIds.indexOf(id);
    if (startIdx === -1 || endIdx === -1) {
      // Fall back to arming just the target
      get().armId(id);
      return;
    }
    const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
    const range = orderedEligibleIds.slice(lo, hi + 1);
    set((s) => {
      const nextArmed = new Set(s.armedIds);
      const nextOrder = [...s.armOrder];
      for (const rid of range) {
        if (!nextArmed.has(rid)) {
          nextArmed.add(rid);
          nextOrder.push(rid);
        }
      }
      return {
        armedIds: nextArmed,
        armOrder: nextOrder,
        armOrderById: rebuildOrderById(nextOrder),
        lastArmedId: id,
      };
    });
  },

  armByState: (preset, scope, extend) => {
    const state = usePanelStore.getState();
    const activeWorktreeId = getActiveWorktreeId();
    const ids: string[] = [];
    for (const id of state.panelIds) {
      const t = state.panelsById[id];
      if (!isFleetArmEligible(t)) continue;
      if (scope === "current") {
        if (!activeWorktreeId || t.worktreeId !== activeWorktreeId) continue;
      }
      if (matchesPreset(t.agentState ?? null, preset)) {
        ids.push(id);
      }
    }
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

  clear: () =>
    set({
      armedIds: new Set<string>(),
      armOrder: [],
      armOrderById: {},
      lastArmedId: null,
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
}));

function getActiveWorktreeId(): string | null {
  return useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
}

// Register the clear callback so projectStore.switchProject() can drop armed
// selections synchronously on project switch.
setFleetArmingClear(() => {
  useFleetArmingStore.getState().clear();
});

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
