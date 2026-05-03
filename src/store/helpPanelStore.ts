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
}

interface HelpPanelActions {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setTerminal: (terminalId: string, agentId: string, sessionId: string | null) => void;
  clearTerminal: () => void;
  clearPreferredAgent: () => void;
}

const initialState: HelpPanelState = {
  isOpen: false,
  width: HELP_PANEL_DEFAULT_WIDTH,
  terminalId: null,
  agentId: null,
  preferredAgentId: null,
  sessionId: null,
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

      clearPreferredAgent: () =>
        set({ terminalId: null, agentId: null, sessionId: null, preferredAgentId: null }),
    }),
    {
      name: "help-panel-storage",
      storage: createSafeJSONStorage(),
      version: 1,
      // v1 clears any persisted `preferredAgentId` for agents that aren't
      // wired for the assistant overlay (issue #6612). Without this, users who
      // previously picked Gemini/Codex would silently fail to auto-launch on
      // first open after upgrade.
      migrate: (persistedState, version) => {
        const persisted = (persistedState ?? {}) as Partial<HelpPanelState>;
        if (version < 1) {
          return {
            ...persisted,
            preferredAgentId: isAssistantSupportedAgentId(persisted.preferredAgentId)
              ? persisted.preferredAgentId
              : null,
          } as HelpPanelState & HelpPanelActions;
        }
        return persisted as HelpPanelState & HelpPanelActions;
      },
      partialize: (state) => ({
        width: state.width,
        preferredAgentId: state.preferredAgentId,
      }),
      merge: (persistedState: unknown, currentState) => {
        const persisted = persistedState as Partial<HelpPanelState>;
        return {
          ...currentState,
          width:
            typeof persisted.width === "number"
              ? Math.min(Math.max(persisted.width, HELP_PANEL_MIN_WIDTH), HELP_PANEL_MAX_WIDTH)
              : currentState.width,
          preferredAgentId: isAssistantSupportedAgentId(persisted.preferredAgentId)
            ? persisted.preferredAgentId
            : null,
        };
      },
    }
  )
);

registerPersistedStore({
  storeId: "helpPanelStore",
  store: useHelpPanelStore,
  persistedStateType: "Pick<HelpPanelState, 'width' | 'preferredAgentId'>",
});
