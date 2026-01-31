import { create, type StateCreator } from "zustand";
import type { AssistantMessage } from "@/components/Assistant/types";
import type { ActionContext } from "@shared/types/actions";

export interface ConversationState {
  messages: AssistantMessage[];
  sessionId: string;
  isLoading: boolean;
  error: string | null;
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

interface StreamingState {
  content: string;
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: "pending" | "success" | "error";
    result?: unknown;
    error?: string;
  }>;
}

interface AssistantChatState {
  conversation: ConversationState;
  isOpen: boolean;
  displayMode: "popup" | "docked";
  currentContext: ActionContext | null;
  streamingState: StreamingState | null;
  streamingMessageId: string | null;
}

interface AssistantChatActions {
  addMessage: (message: AssistantMessage) => void;
  updateMessage: (messageId: string, updates: Partial<AssistantMessage>) => void;
  updateLastMessage: (updates: Partial<AssistantMessage>) => void;
  setMessages: (messages: AssistantMessage[]) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  clearConversation: () => void;
  reset: () => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setDisplayMode: (mode: "popup" | "docked") => void;
  setCurrentContext: (context: ActionContext | null) => void;
  setStreamingState: (state: StreamingState | null, messageId: string | null) => void;
}

const initialState: AssistantChatState = {
  conversation: createInitialConversation(),
  isOpen: false,
  displayMode: "popup",
  currentContext: null,
  streamingState: null,
  streamingMessageId: null,
};

const createAssistantChatStore: StateCreator<AssistantChatState & AssistantChatActions> = (
  set,
  get
) => ({
  ...initialState,

  addMessage: (message) => {
    set((s) => ({
      conversation: {
        ...s.conversation,
        messages: [...s.conversation.messages, message],
      },
    }));
  },

  updateMessage: (messageId, updates) => {
    set((s) => {
      const messages = s.conversation.messages.map((msg) =>
        msg.id === messageId ? { ...msg, ...updates } : msg
      );

      return {
        conversation: { ...s.conversation, messages },
      };
    });
  },

  updateLastMessage: (updates) => {
    set((s) => {
      const messages = [...s.conversation.messages];
      if (messages.length === 0) return s;

      const lastIndex = messages.length - 1;
      messages[lastIndex] = { ...messages[lastIndex], ...updates };

      return {
        conversation: { ...s.conversation, messages },
      };
    });
  },

  setMessages: (messages) => {
    set((s) => ({
      conversation: { ...s.conversation, messages },
    }));
  },

  setLoading: (isLoading) => {
    set((s) => ({
      conversation: { ...s.conversation, isLoading },
    }));
  },

  setError: (error) => {
    set((s) => ({
      conversation: { ...s.conversation, error },
    }));
  },

  clearConversation: () => {
    const sessionId = get().conversation.sessionId;
    if (sessionId) {
      window.electron.assistant.clearSession(sessionId).catch((err) => {
        console.error("[AssistantChatStore] Failed to clear session:", err);
      });
    }

    set({
      conversation: createInitialConversation(),
      streamingState: null,
      streamingMessageId: null,
    });
  },

  reset: () =>
    set({
      conversation: createInitialConversation(),
      streamingState: null,
      streamingMessageId: null,
    }),

  open: () => set({ isOpen: true }),

  close: () => set({ isOpen: false }),

  toggle: () => set((s) => ({ isOpen: !s.isOpen })),

  setDisplayMode: (mode) => set({ displayMode: mode }),

  setCurrentContext: (context) => set({ currentContext: context }),

  setStreamingState: (state, messageId) =>
    set({ streamingState: state, streamingMessageId: messageId }),
});

export const useAssistantChatStore = create<AssistantChatState & AssistantChatActions>()(
  createAssistantChatStore
);
