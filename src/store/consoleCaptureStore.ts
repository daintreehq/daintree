import { create } from "zustand";
import type { SerializedConsoleRow, CdpConsoleType } from "@shared/types/ipc/webviewConsole";

export type ConsoleLevel = "log" | "info" | "warning" | "error";

export interface ConsoleMessage extends SerializedConsoleRow {
  isStale: boolean;
}

// Stable empty array to prevent unnecessary selector rerenders for panes with no messages
export const EMPTY_MESSAGES: ConsoleMessage[] = [];

const MAX_MESSAGES = 500;

interface ConsoleCaptureState {
  messages: Map<string, ConsoleMessage[]>;
  addStructuredMessage(row: SerializedConsoleRow): void;
  markStale(paneId: string, navigationGeneration: number): void;
  clearMessages(paneId: string): void;
  getMessages(paneId: string): ConsoleMessage[];
  removePane(paneId: string): void;
}

// Types that should not be rendered as visible rows
const HIDDEN_TYPES: Set<CdpConsoleType> = new Set(["endGroup"]);

export const useConsoleCaptureStore = create<ConsoleCaptureState>()((set, get) => ({
  messages: new Map(),

  addStructuredMessage(row: SerializedConsoleRow) {
    if (HIDDEN_TYPES.has(row.cdpType)) return;

    const msg: ConsoleMessage = {
      ...row,
      isStale: false,
    };

    set((state) => {
      const existing = state.messages.get(row.paneId) ?? [];
      const updated = [...existing, msg].slice(-MAX_MESSAGES);
      const next = new Map(state.messages);
      next.set(row.paneId, updated);
      return { messages: next };
    });
  },

  markStale(paneId: string, navigationGeneration: number) {
    set((state) => {
      const existing = state.messages.get(paneId);
      if (!existing || existing.length === 0) return state;

      const updated = existing.map((msg) =>
        msg.navigationGeneration < navigationGeneration && !msg.isStale
          ? { ...msg, isStale: true }
          : msg
      );
      const next = new Map(state.messages);
      next.set(paneId, updated);
      return { messages: next };
    });
  },

  clearMessages(paneId: string) {
    set((state) => {
      const next = new Map(state.messages);
      next.set(paneId, []);
      return { messages: next };
    });
  },

  getMessages(paneId: string) {
    return get().messages.get(paneId) ?? [];
  },

  removePane(paneId: string) {
    set((state) => {
      const next = new Map(state.messages);
      next.delete(paneId);
      return { messages: next };
    });
  },
}));
