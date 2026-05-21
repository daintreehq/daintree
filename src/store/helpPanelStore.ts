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

export interface HelpHibernateSession {
  /** Captured agent session ID (e.g. Claude resume token) */
  sessionId: string;
  /** Working directory the resumed agent must launch from to find its transcript */
  cwd: string;
  /**
   * Agent that produced this session. Resume only fires when the next launch
   * targets the same agent — guards against agent switches between sleeps.
   */
  agentId: string;
}

interface HelpPanelState {
  isOpen: boolean;
  width: number;
  terminalId: string | null;
  agentId: string | null;
  preferredAgentId: string | null;
  sessionId: string | null;
  introDismissed: boolean;
  conversationTouched: boolean;
  /**
   * Per-project captured resume sessions, keyed by projectId. helpPanelStore
   * is shared across all project views (single localStorage partition), so
   * the assistant session for project A must not leak into project B.
   */
  hibernateSessions: Record<string, HelpHibernateSession>;
  /** Monotonic counter bumped by requestFocus() so repeated Cmd+L presses re-trigger the focus effect. */
  focusRequest: number;
}

interface HelpPanelActions {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setTerminal: (terminalId: string, agentId: string, sessionId: string | null) => void;
  clearTerminal: () => void;
  setPreferredAgent: (agentId: string | null) => void;
  dismissIntro: () => void;
  markConversationStarted: () => void;
  requestFocus: () => void;
  setHibernateSession: (
    projectId: string,
    entry: { sessionId: string; cwd: string; agentId: string }
  ) => void;
  clearHibernateSession: (projectId: string) => void;
}

const initialState: HelpPanelState = {
  isOpen: false,
  width: HELP_PANEL_DEFAULT_WIDTH,
  terminalId: null,
  agentId: null,
  preferredAgentId: null,
  sessionId: null,
  introDismissed: false,
  conversationTouched: false,
  hibernateSessions: {},
  focusRequest: 0,
};

function isRecordOfUnknown(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function sanitizeHibernateSessions(value: unknown): Record<string, HelpHibernateSession> {
  if (!isRecordOfUnknown(value)) return {};
  const out: Record<string, HelpHibernateSession> = {};
  for (const [projectId, entry] of Object.entries(value)) {
    if (!projectId) continue;
    if (!isRecordOfUnknown(entry)) continue;
    const sessionId = entry.sessionId;
    const cwd = entry.cwd;
    const agentId = entry.agentId;
    if (typeof sessionId !== "string" || !sessionId) continue;
    if (typeof cwd !== "string" || !cwd) continue;
    if (typeof agentId !== "string" || !agentId) continue;
    out[projectId] = { sessionId, cwd, agentId };
  }
  return out;
}

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
        set((s) => ({
          terminalId,
          agentId,
          sessionId,
          // Only initialize the preference on first launch. An explicit user
          // choice (made via Settings) must survive terminal re-binds —
          // overwriting it here is what made #8353's agent switch a no-op.
          preferredAgentId: s.preferredAgentId ?? agentId,
          conversationTouched: false,
        })),

      clearTerminal: () =>
        set({ terminalId: null, agentId: null, sessionId: null, conversationTouched: false }),

      setPreferredAgent: (agentId) => set({ preferredAgentId: agentId }),

      dismissIntro: () => set({ introDismissed: true }),

      markConversationStarted: () => set({ conversationTouched: true }),

      requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),

      setHibernateSession: (projectId, entry) =>
        set((s) => ({
          hibernateSessions: {
            ...s.hibernateSessions,
            [projectId]: { sessionId: entry.sessionId, cwd: entry.cwd, agentId: entry.agentId },
          },
        })),

      clearHibernateSession: (projectId) =>
        set((s) => {
          if (!(projectId in s.hibernateSessions)) return s;
          const next = { ...s.hibernateSessions };
          delete next[projectId];
          return { hibernateSessions: next };
        }),
    }),
    {
      name: "help-panel-storage",
      storage: createSafeJSONStorage(),
      version: 4,
      migrate: (persistedState) => persistedState as HelpPanelState & HelpPanelActions,
      partialize: (state) => ({
        width: state.width,
        preferredAgentId: state.preferredAgentId,
        introDismissed: state.introDismissed,
        hibernateSessions: state.hibernateSessions,
      }),
      merge: (persistedState: unknown, currentState) => {
        const persisted = persistedState as Partial<HelpPanelState>;
        return {
          ...currentState,
          // The assistant can auto-launch as soon as it opens. Starting every
          // app boot hidden avoids launching from stale restart timing before
          // MCP readiness has settled.
          isOpen: false,
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
          hibernateSessions: sanitizeHibernateSessions(persisted.hibernateSessions),
        };
      },
    }
  )
);

registerPersistedStore({
  storeId: "helpPanelStore",
  store: useHelpPanelStore,
  persistedStateType:
    "Pick<HelpPanelState, 'width' | 'preferredAgentId' | 'introDismissed' | 'hibernateSessions'>",
});
