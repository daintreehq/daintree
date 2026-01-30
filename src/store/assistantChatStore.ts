import { create, type StateCreator } from "zustand";
import type { AssistantMessage } from "@/components/Assistant/types";

export interface ConversationState {
  messages: AssistantMessage[];
  sessionId: string;
  isLoading: boolean;
  error: string | null;
}

interface AssistantChatState {
  conversations: Record<string, ConversationState>;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createInitialConversation(): ConversationState {
  return {
    messages: [],
    sessionId: generateId(),
    isLoading: false,
    error: null,
  };
}

interface AssistantChatActions {
  getConversation: (panelId: string) => ConversationState;
  ensureConversation: (panelId: string) => void;
  updateConversation: (panelId: string, updates: Partial<ConversationState>) => void;
  addMessage: (panelId: string, message: AssistantMessage) => void;
  updateLastMessage: (panelId: string, updates: Partial<AssistantMessage>) => void;
  setMessages: (panelId: string, messages: AssistantMessage[]) => void;
  setLoading: (panelId: string, isLoading: boolean) => void;
  setError: (panelId: string, error: string | null) => void;
  clearConversation: (panelId: string) => void;
  removeConversation: (panelId: string) => void;
  reset: () => void;
}

const initialState: AssistantChatState = {
  conversations: {},
};

const createAssistantChatStore: StateCreator<AssistantChatState & AssistantChatActions> = (
  set,
  get
) => ({
  ...initialState,

  getConversation: (panelId) => {
    return get().conversations[panelId] ?? createInitialConversation();
  },

  ensureConversation: (panelId) => {
    const existing = get().conversations[panelId];
    if (!existing) {
      set((s) => ({
        conversations: {
          ...s.conversations,
          [panelId]: createInitialConversation(),
        },
      }));
    }
  },

  updateConversation: (panelId, updates) => {
    set((s) => {
      const existing = s.conversations[panelId] ?? createInitialConversation();
      return {
        conversations: {
          ...s.conversations,
          [panelId]: { ...existing, ...updates },
        },
      };
    });
  },

  addMessage: (panelId, message) => {
    set((s) => {
      const existing = s.conversations[panelId] ?? createInitialConversation();
      return {
        conversations: {
          ...s.conversations,
          [panelId]: {
            ...existing,
            messages: [...existing.messages, message],
          },
        },
      };
    });
  },

  updateLastMessage: (panelId, updates) => {
    set((s) => {
      const existing = s.conversations[panelId];
      if (!existing || existing.messages.length === 0) return s;

      const messages = [...existing.messages];
      const lastIndex = messages.length - 1;
      messages[lastIndex] = { ...messages[lastIndex], ...updates };

      return {
        conversations: {
          ...s.conversations,
          [panelId]: { ...existing, messages },
        },
      };
    });
  },

  setMessages: (panelId, messages) => {
    set((s) => {
      const existing = s.conversations[panelId] ?? createInitialConversation();
      return {
        conversations: {
          ...s.conversations,
          [panelId]: { ...existing, messages },
        },
      };
    });
  },

  setLoading: (panelId, isLoading) => {
    set((s) => {
      const existing = s.conversations[panelId] ?? createInitialConversation();
      return {
        conversations: {
          ...s.conversations,
          [panelId]: { ...existing, isLoading },
        },
      };
    });
  },

  setError: (panelId, error) => {
    set((s) => {
      const existing = s.conversations[panelId] ?? createInitialConversation();
      return {
        conversations: {
          ...s.conversations,
          [panelId]: { ...existing, error },
        },
      };
    });
  },

  clearConversation: (panelId) => {
    const existing = get().conversations[panelId];
    if (existing?.sessionId) {
      window.electron.assistant.clearSession(existing.sessionId).catch((err) => {
        console.error("[AssistantChatStore] Failed to clear session:", err);
      });
    }

    set((s) => {
      const existing = s.conversations[panelId];
      if (!existing) return s;

      return {
        conversations: {
          ...s.conversations,
          [panelId]: {
            messages: [],
            sessionId: generateId(),
            isLoading: false,
            error: null,
          },
        },
      };
    });
  },

  removeConversation: (panelId) => {
    const existing = get().conversations[panelId];
    if (existing?.sessionId) {
      window.electron.assistant.clearSession(existing.sessionId).catch((err) => {
        console.error("[AssistantChatStore] Failed to clear session:", err);
      });
    }

    set((s) => {
      const { [panelId]: _, ...rest } = s.conversations;
      return { conversations: rest };
    });
  },

  reset: () => set(initialState),
});

export const useAssistantChatStore = create<AssistantChatState & AssistantChatActions>()(
  createAssistantChatStore
);
