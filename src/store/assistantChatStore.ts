import { create, type StateCreator } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
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
    set((s) => {
      const { [panelId]: _, ...rest } = s.conversations;
      return { conversations: rest };
    });
  },

  reset: () => set(initialState),
});

const assistantChatStoreCreator: StateCreator<
  AssistantChatState & AssistantChatActions,
  [],
  [["zustand/persist", Partial<AssistantChatState>]]
> = persist(createAssistantChatStore, {
  name: "assistant-chat-storage",
  storage: createJSONStorage(() => {
    return typeof window !== "undefined" ? localStorage : (undefined as never);
  }),
  partialize: (state) => ({
    conversations: Object.fromEntries(
      Object.entries(state.conversations).map(([id, conv]) => [
        id,
        {
          messages: conv.messages,
          sessionId: conv.sessionId,
          // Don't persist transient state
          isLoading: false,
          error: null,
        },
      ])
    ),
  }),
});

export const useAssistantChatStore = create<AssistantChatState & AssistantChatActions>()(
  assistantChatStoreCreator
);
