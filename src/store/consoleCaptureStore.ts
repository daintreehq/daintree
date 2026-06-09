import { create } from "zustand";
import type { SerializedConsoleRow, CdpConsoleType } from "@shared/types/ipc/webviewConsole";

export type ConsoleLevel = "log" | "info" | "warning" | "error";

export interface ConsoleMessage extends SerializedConsoleRow {
  isStale: boolean;
  timeLabel: string;
  isGroupHeader: boolean;
}

export interface ConsoleCounts {
  errorCount: number;
  warnCount: number;
}

// Stable empty array to prevent unnecessary selector rerenders for panes with no messages
export const EMPTY_MESSAGES: ConsoleMessage[] = [];

// Stable zero counts to prevent unnecessary selector rerenders for panes with no counts
export const ZERO_COUNTS: ConsoleCounts = Object.freeze({
  errorCount: 0,
  warnCount: 0,
}) as ConsoleCounts;

const MAX_MESSAGES = 500;

interface ConsoleCaptureState {
  messages: Map<string, ConsoleMessage[]>;
  counters: Map<string, ConsoleCounts>;
  addStructuredMessage(row: SerializedConsoleRow): void;
  markStale(paneId: string, navigationGeneration: number): void;
  clearMessages(paneId: string): void;
  getMessages(paneId: string): ConsoleMessage[];
  getCounts(paneId: string): ConsoleCounts;
  removePane(paneId: string): void;
}

// Types that should not be rendered as visible rows
const HIDDEN_TYPES: Set<CdpConsoleType> = new Set(["endGroup"]);

// Group types that act as headers
const GROUP_HEADER_TYPES: Set<CdpConsoleType> = new Set(["startGroup", "startGroupCollapsed"]);

function formatConsoleTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export const useConsoleCaptureStore = create<ConsoleCaptureState>()((set, get) => ({
  messages: new Map(),
  counters: new Map(),

  addStructuredMessage(row: SerializedConsoleRow) {
    if (HIDDEN_TYPES.has(row.cdpType)) return;

    const msg: ConsoleMessage = {
      ...row,
      isStale: false,
      timeLabel: formatConsoleTime(row.timestamp),
      isGroupHeader: GROUP_HEADER_TYPES.has(row.cdpType),
    };

    set((state) => {
      const existing = state.messages.get(row.paneId) ?? [];
      const willEvict = existing.length >= MAX_MESSAGES;
      // `slice` already yields a fresh, unshared array — push into it in place
      // to avoid a second copy from spreading the slice back out.
      let updated: ConsoleMessage[];
      if (willEvict) {
        updated = existing.slice(1);
        updated.push(msg);
      } else {
        updated = existing.slice();
        updated.push(msg);
      }

      const nextMessages = new Map(state.messages);
      nextMessages.set(row.paneId, updated);

      let errorDelta = msg.level === "error" ? 1 : 0;
      let warnDelta = msg.level === "warning" ? 1 : 0;
      if (willEvict) {
        const evicted = existing[0]!;
        if (evicted.level === "error") errorDelta -= 1;
        if (evicted.level === "warning") warnDelta -= 1;
      }

      let nextCounters = state.counters;
      if (errorDelta !== 0 || warnDelta !== 0) {
        const current = state.counters.get(row.paneId) ?? ZERO_COUNTS;
        const updatedCounts: ConsoleCounts = {
          errorCount: current.errorCount + errorDelta,
          warnCount: current.warnCount + warnDelta,
        };
        nextCounters = new Map(state.counters);
        nextCounters.set(row.paneId, updatedCounts);
      }

      return { messages: nextMessages, counters: nextCounters };
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
      const nextMessages = new Map(state.messages);
      nextMessages.set(paneId, []);

      let nextCounters = state.counters;
      if (state.counters.has(paneId)) {
        nextCounters = new Map(state.counters);
        nextCounters.delete(paneId);
      }

      return { messages: nextMessages, counters: nextCounters };
    });
  },

  getMessages(paneId: string) {
    return get().messages.get(paneId) ?? [];
  },

  getCounts(paneId: string) {
    return get().counters.get(paneId) ?? ZERO_COUNTS;
  },

  removePane(paneId: string) {
    set((state) => {
      const nextMessages = new Map(state.messages);
      nextMessages.delete(paneId);

      let nextCounters = state.counters;
      if (state.counters.has(paneId)) {
        nextCounters = new Map(state.counters);
        nextCounters.delete(paneId);
      }

      return { messages: nextMessages, counters: nextCounters };
    });
  },
}));
