import { create } from "zustand";

export type ConsoleLevel = "log" | "info" | "warning" | "error";

// Electron webview console-message event level mapping:
// 0 = verbose/log, 1 = info, 2 = warning, 3 = error
const LEVEL_MAP: Record<number, ConsoleLevel> = {
  0: "log",
  1: "info",
  2: "warning",
  3: "error",
};

export interface ConsoleMessage {
  id: number;
  level: ConsoleLevel;
  message: string;
  timestamp: number;
  line?: number;
  sourceId?: string;
}

// Stable empty array to prevent unnecessary selector rerenders for panes with no messages
export const EMPTY_MESSAGES: ConsoleMessage[] = [];

const MAX_MESSAGES = 500;
let _nextId = 0;

interface ConsoleCaptureState {
  messages: Map<string, ConsoleMessage[]>;
  addMessage(
    paneId: string,
    level: number,
    message: string,
    line?: number,
    sourceId?: string
  ): void;
  clearMessages(paneId: string): void;
  getMessages(paneId: string): ConsoleMessage[];
  removePane(paneId: string): void;
}

export const useConsoleCaptureStore = create<ConsoleCaptureState>()((set, get) => ({
  messages: new Map(),

  addMessage(paneId, level, message, line, sourceId) {
    const msg: ConsoleMessage = {
      id: _nextId++,
      level: LEVEL_MAP[level] ?? "log",
      message,
      timestamp: Date.now(),
      line,
      sourceId,
    };
    set((state) => {
      const existing = state.messages.get(paneId) ?? [];
      const updated = [...existing, msg].slice(-MAX_MESSAGES);
      const next = new Map(state.messages);
      next.set(paneId, updated);
      return { messages: next };
    });
  },

  clearMessages(paneId) {
    set((state) => {
      const next = new Map(state.messages);
      next.set(paneId, []);
      return { messages: next };
    });
  },

  getMessages(paneId) {
    return get().messages.get(paneId) ?? [];
  },

  removePane(paneId) {
    set((state) => {
      const next = new Map(state.messages);
      next.delete(paneId);
      return { messages: next };
    });
  },
}));
