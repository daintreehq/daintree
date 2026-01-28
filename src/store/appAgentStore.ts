import { create } from "zustand";
import type {
  AppAgentConfig,
  OneShotRunResult,
  AgentDecision,
  OneShotRunRequest,
} from "@shared/types";
import type { ActionManifestEntry, ActionContext } from "@shared/types";

export type CommandBarStatus = "idle" | "loading" | "success" | "error" | "confirm" | "ask";

interface AppAgentState {
  isOpen: boolean;
  input: string;
  status: CommandBarStatus;
  pendingDecision: AgentDecision | null;
  pendingAction: ActionManifestEntry | null;
  lastResult: OneShotRunResult | null;
  error: string | null;
  hasApiKey: boolean;
  config: Omit<AppAgentConfig, "apiKey"> | null;
  isInitialized: boolean;
  currentRequestId: number | null;
}

interface AppAgentActions {
  open: () => void;
  close: () => void;
  setInput: (input: string) => void;
  runOneShot: (
    actions: ActionManifestEntry[],
    context: ActionContext,
    executeAction: (actionId: string, args?: Record<string, unknown>) => Promise<void>
  ) => Promise<void>;
  confirmAction: (
    executeAction: (actionId: string, args?: Record<string, unknown>) => Promise<void>
  ) => Promise<void>;
  cancelConfirm: () => void;
  selectChoice: (
    choice: string,
    actions: ActionManifestEntry[],
    context: ActionContext,
    executeAction: (actionId: string, args?: Record<string, unknown>) => Promise<void>
  ) => Promise<void>;
  initialize: () => Promise<void>;
  setApiKey: (apiKey: string) => Promise<void>;
  clearError: () => void;
}

type AppAgentStore = AppAgentState & AppAgentActions;

let initPromise: Promise<void> | null = null;
let nextRequestId = 0;

export const useAppAgentStore = create<AppAgentStore>()((set, get) => ({
  isOpen: false,
  input: "",
  status: "idle",
  pendingDecision: null,
  pendingAction: null,
  lastResult: null,
  error: null,
  hasApiKey: false,
  config: null,
  isInitialized: false,
  currentRequestId: null,

  open: () => {
    set({ isOpen: true });
  },

  close: () => {
    const { status } = get();
    if (status === "loading") {
      window.electron.appAgent.cancel();
    }
    set({
      isOpen: false,
      input: "",
      status: "idle",
      pendingDecision: null,
      pendingAction: null,
      error: null,
    });
  },

  setInput: (input: string) => {
    set({ input, error: null });
  },

  runOneShot: async (actions, context, executeAction) => {
    const { input, hasApiKey } = get();

    if (!input.trim()) {
      return;
    }

    if (!hasApiKey) {
      set({ error: "Please configure your Fireworks API key in Settings first." });
      return;
    }

    const requestId = ++nextRequestId;
    set({
      status: "loading",
      error: null,
      pendingDecision: null,
      pendingAction: null,
      currentRequestId: requestId,
    });

    try {
      const request: OneShotRunRequest = { prompt: input };
      const result = await window.electron.appAgent.runOneShot({
        request,
        actions,
        context,
      });

      if (get().currentRequestId !== requestId) {
        return;
      }

      set({ lastResult: result });

      if (!result.success) {
        set({ status: "error", error: result.error || "Request failed" });
        return;
      }

      const decision = result.decision;
      if (!decision) {
        set({ status: "error", error: "No decision from agent" });
        return;
      }

      switch (decision.type) {
        case "dispatch": {
          const action = actions.find((a) => a.id === decision.id);

          if (action && action.danger === "confirm") {
            set({
              status: "confirm",
              pendingDecision: decision,
              pendingAction: action,
            });
          } else {
            await executeAction(decision.id, decision.args);
            set({
              status: "success",
              input: "",
              isOpen: false,
            });
          }
          break;
        }

        case "ask": {
          set({
            status: "ask",
            pendingDecision: decision,
          });
          break;
        }

        case "reply": {
          set({
            status: "success",
            error: decision.text,
          });
          break;
        }
      }
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Unknown error occurred",
      });
    }
  },

  confirmAction: async (executeAction) => {
    const { pendingDecision } = get();
    if (!pendingDecision || pendingDecision.type !== "dispatch") {
      return;
    }

    try {
      await executeAction(pendingDecision.id, pendingDecision.args);
      set({
        status: "success",
        input: "",
        isOpen: false,
        pendingDecision: null,
        pendingAction: null,
      });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Action execution failed",
        pendingDecision: null,
        pendingAction: null,
      });
    }
  },

  cancelConfirm: () => {
    set({
      status: "idle",
      pendingDecision: null,
      pendingAction: null,
    });
  },

  selectChoice: async (choice, actions, context, executeAction) => {
    const { input, hasApiKey } = get();

    if (!hasApiKey) {
      set({ error: "Please configure your Fireworks API key in Settings first." });
      return;
    }

    const requestId = ++nextRequestId;
    set({ status: "loading", error: null, pendingDecision: null, currentRequestId: requestId });

    try {
      const request: OneShotRunRequest = {
        prompt: input,
        clarificationChoice: choice,
      };
      const result = await window.electron.appAgent.runOneShot({
        request,
        actions,
        context,
      });

      if (get().currentRequestId !== requestId) {
        return;
      }

      set({ lastResult: result });

      if (!result.success) {
        set({ status: "error", error: result.error || "Request failed" });
        return;
      }

      const decision = result.decision;
      if (!decision) {
        set({ status: "error", error: "No decision from agent" });
        return;
      }

      if (decision.type === "dispatch") {
        const action = actions.find((a) => a.id === decision.id);

        if (action && action.danger === "confirm") {
          set({
            status: "confirm",
            pendingDecision: decision,
            pendingAction: action,
          });
        } else {
          await executeAction(decision.id, decision.args);
          set({
            status: "success",
            input: "",
            isOpen: false,
          });
        }
      } else if (decision.type === "reply") {
        set({
          status: "success",
          error: decision.text,
        });
      }
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "Unknown error occurred",
      });
    }
  },

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const [hasApiKey, config] = await Promise.all([
          window.electron.appAgent.hasApiKey(),
          window.electron.appAgent.getConfig(),
        ]);
        set({ hasApiKey, config, isInitialized: true });
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to initialize app agent",
          isInitialized: true,
        });
      }
    })();

    return initPromise;
  },

  setApiKey: async (apiKey: string) => {
    try {
      const config = await window.electron.appAgent.setConfig({ apiKey });
      const hasApiKey = await window.electron.appAgent.hasApiKey();
      set({ config, hasApiKey, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to set API key" });
      throw e;
    }
  },

  clearError: () => {
    set({ error: null });
  },
}));

export function cleanupAppAgentStore() {
  initPromise = null;
  nextRequestId = 0;
  useAppAgentStore.setState({
    isOpen: false,
    input: "",
    status: "idle",
    pendingDecision: null,
    pendingAction: null,
    lastResult: null,
    error: null,
    hasApiKey: false,
    config: null,
    isInitialized: false,
    currentRequestId: null,
  });
}
