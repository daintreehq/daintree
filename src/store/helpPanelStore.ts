import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { getAssistantSupportedAgentIds } from "../../shared/config/agentRegistry";

function isAssistantSupportedAgentId(value: unknown): value is string {
  return typeof value === "string" && getAssistantSupportedAgentIds().includes(value);
}

export const HELP_PANEL_MIN_WIDTH = 320;
export const HELP_PANEL_MAX_WIDTH = 800;
export const HELP_PANEL_DEFAULT_WIDTH = 380;

interface HelpPanelState {
  isOpen: boolean;
  width: number;
  terminalId: string | null;
  agentId: string | null;
  preferredAgentId: string | null;
  sessionId: string | null;
  introDismissed: boolean;
}

interface HelpPanelActions {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setTerminal: (terminalId: string, agentId: string, sessionId: string | null) => void;
  clearTerminal: () => void;
  setPreferredAgent: (agentId: string | null) => void;
  dismissIntro: () => void;
}

const initialState: HelpPanelState = {
  isOpen: false,
  width: HELP_PANEL_DEFAULT_WIDTH,
  terminalId: null,
  agentId: null,
  preferredAgentId: null,
  sessionId: null,
  introDismissed: false,
};

export const useHelpPanelStore = create<HelpPanelState & HelpPanelActions>()(
  persist(
    (set) => ({
      ...initialState,

      toggle: () => set((s) => ({ isOpen: !s.isOpen })),

      setOpen: (open) => set({ isOpen: open }),

      setWidth: (width) =>
        set({
          width: Math.min(Math.max(width, HELP_PANEL_MIN_WIDTH), HELP_PANEL_MAX_WIDTH),
        }),

      setTerminal: (terminalId, agentId, sessionId) =>
        set({ terminalId, agentId, sessionId, preferredAgentId: agentId }),

      clearTerminal: () => set({ terminalId: null, agentId: null, sessionId: null }),

      setPreferredAgent: (agentId) => set({ preferredAgentId: agentId }),

      dismissIntro: () => set({ introDismissed: true }),
    }),
    {
      name: "help-panel-storage",
      storage: createSafeJSONStorage(),
      version: 2,
      migrate: (persistedState) => persistedState as HelpPanelState & HelpPanelActions,
      partialize: (state) => ({
        isOpen: state.isOpen,
        width: state.width,
        preferredAgentId: state.preferredAgentId,
        introDismissed: state.introDismissed,
      }),
      merge: (persistedState: unknown, currentState) => {
        const persisted = persistedState as Partial<HelpPanelState>;
        return {
          ...currentState,
          isOpen: typeof persisted.isOpen === "boolean" ? persisted.isOpen : currentState.isOpen,
          width:
            typeof persisted.width === "number"
              ? Math.min(Math.max(persisted.width, HELP_PANEL_MIN_WIDTH), HELP_PANEL_MAX_WIDTH)
              : currentState.width,
          preferredAgentId: isAssistantSupportedAgentId(persisted.preferredAgentId)
            ? persisted.preferredAgentId
            : null,
          introDismissed:
            typeof persisted.introDismissed === "boolean"
              ? persisted.introDismissed
              : currentState.introDismissed,
        };
      },
    }
  )
);

registerPersistedStore({
  storeId: "helpPanelStore",
  store: useHelpPanelStore,
  persistedStateType:
    "Pick<HelpPanelState, 'isOpen' | 'width' | 'preferredAgentId' | 'introDismissed'>",
});
