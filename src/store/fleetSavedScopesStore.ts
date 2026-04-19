import { create } from "zustand";
import type { FleetSavedScope } from "@shared/types/project";
import { fleetScopesController } from "@/controllers";
import { useProjectStore } from "./projectStore";

const MAX_SAVED_SCOPES = 50;

interface FleetSavedScopesState {
  scopes: FleetSavedScope[];
  isLoaded: boolean;
  requestId: number;

  load: (projectId: string) => Promise<void>;
  saveScope: (projectId: string, scope: Omit<FleetSavedScope, "id" | "createdAt">) => Promise<void>;
  recallScope: (scopeId: string) => FleetSavedScope | undefined;
  deleteScope: (projectId: string, scopeId: string) => Promise<void>;
}

export const useFleetSavedScopesStore = create<FleetSavedScopesState>()((set, get) => ({
  scopes: [],
  isLoaded: false,
  requestId: 0,

  load: async (projectId) => {
    const req = ++get().requestId;
    try {
      const scopes = await fleetScopesController.loadScopes(projectId);
      if (req !== get().requestId) return;
      set({ scopes, isLoaded: true });
    } catch {
      if (req !== get().requestId) return;
      set({ isLoaded: true });
    }
  },

  saveScope: async (projectId, scopeData) => {
    const req = ++get().requestId;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newScope: FleetSavedScope = { ...scopeData, id, createdAt: Date.now() };
    const prev = get().scopes;
    const next = [newScope, ...prev.filter((s) => s.name !== newScope.name)].slice(
      0,
      MAX_SAVED_SCOPES
    );
    set({ scopes: next });

    try {
      await fleetScopesController.saveScopes(projectId, next);
    } catch {
      if (req === get().requestId) set({ scopes: prev });
    }
  },

  recallScope: (scopeId) => {
    return get().scopes.find((s) => s.id === scopeId);
  },

  deleteScope: async (projectId, scopeId) => {
    const req = ++get().requestId;
    const prev = get().scopes;
    const next = prev.filter((s) => s.id !== scopeId);
    set({ scopes: next });

    try {
      await fleetScopesController.saveScopes(projectId, next);
    } catch {
      if (req === get().requestId) set({ scopes: prev });
    }
  },
}));

function getCurrentProjectId(): string | undefined {
  return useProjectStore.getState().currentProject?.id;
}

interface FleetSavedScopesSubscriptionState {
  registered: boolean;
  lastProjectId: string | undefined;
}

const SUBSCRIPTION_KEY = "__daintreeFleetSavedScopesSubscription";

function getSubscriptionState(): FleetSavedScopesSubscriptionState {
  const target = globalThis as typeof globalThis & {
    [SUBSCRIPTION_KEY]?: FleetSavedScopesSubscriptionState;
  };
  const existing = target[SUBSCRIPTION_KEY];
  if (existing) return existing;
  const created: FleetSavedScopesSubscriptionState = {
    registered: false,
    lastProjectId: getCurrentProjectId(),
  };
  target[SUBSCRIPTION_KEY] = created;
  return created;
}

if (typeof useProjectStore.subscribe === "function") {
  const sub = getSubscriptionState();
  if (!sub.registered) {
    sub.registered = true;
    const initialId = getCurrentProjectId();
    if (initialId) void useFleetSavedScopesStore.getState().load(initialId);

    useProjectStore.subscribe((state) => {
      const nextId = state.currentProject?.id;
      if (nextId === sub.lastProjectId) return;
      sub.lastProjectId = nextId;
      if (nextId) {
        void useFleetSavedScopesStore.getState().load(nextId);
      } else {
        useFleetSavedScopesStore.setState({ scopes: [], isLoaded: false });
      }
    });
  }
}
