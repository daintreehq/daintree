import { create } from "zustand";
import type { SerializedConsoleRow, CdpConsoleType } from "@shared/types/ipc/webviewConsole";
import { MAX_CONSOLE_ROWS } from "@shared/config/devPreviewConsole";

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

// Shared with the main-process console handler, which mirrors this cap to
// decide when a row's CDP object handles can be released.
const MAX_MESSAGES = MAX_CONSOLE_ROWS;

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

// RAF-flushed ingest buffer, mirroring panelStatusBuffer: one IPC console row
// per setState would notify every subscriber synchronously per row (Zustand 5),
// so a guest page logging in a loop drives hundreds of array-copy + filter
// cycles per second. Rows enqueue here and fold into a single setState per
// frame, applying the MAX_MESSAGES cap once per pane per flush.
const pendingRows = new Map<string, ConsoleMessage[]>();
// Boolean flag rather than a stored rAF id: a synchronous rAF shim (the
// vitest node-env stub runs callbacks inline) would otherwise leave the id
// assigned after the flush already cleared it, wedging the guard closed.
let flushScheduled = false;

function schedule(): void {
  if (flushScheduled) return;
  if (typeof requestAnimationFrame === "undefined") {
    // Non-DOM environments (some test contexts) — flush synchronously to keep
    // semantics observable without a polyfill.
    flushConsoleCaptureBuffer();
    return;
  }
  flushScheduled = true;
  requestAnimationFrame(flushConsoleCaptureBuffer);
}

export function flushConsoleCaptureBuffer(): void {
  flushScheduled = false;
  if (pendingRows.size === 0) return;

  // Snapshot and clear before the setState updater runs so re-entrant
  // enqueues during subscriber callbacks land in a fresh frame.
  const batches = new Map(pendingRows);
  pendingRows.clear();

  useConsoleCaptureStore.setState((state) => {
    const nextMessages = new Map(state.messages);
    let nextCounters: Map<string, ConsoleCounts> | null = null;

    for (const [paneId, batch] of batches) {
      const existing = nextMessages.get(paneId) ?? [];
      let combined = existing.concat(batch);
      let evicted: ConsoleMessage[] = EMPTY_MESSAGES;
      if (combined.length > MAX_MESSAGES) {
        evicted = combined.slice(0, combined.length - MAX_MESSAGES);
        combined = combined.slice(combined.length - MAX_MESSAGES);
      }
      nextMessages.set(paneId, combined);

      let errorDelta = 0;
      let warnDelta = 0;
      for (const msg of batch) {
        if (msg.level === "error") errorDelta += 1;
        else if (msg.level === "warning") warnDelta += 1;
      }
      for (const msg of evicted) {
        if (msg.level === "error") errorDelta -= 1;
        else if (msg.level === "warning") warnDelta -= 1;
      }

      if (errorDelta !== 0 || warnDelta !== 0) {
        if (!nextCounters) nextCounters = new Map(state.counters);
        const current = nextCounters.get(paneId) ?? ZERO_COUNTS;
        nextCounters.set(paneId, {
          errorCount: current.errorCount + errorDelta,
          warnCount: current.warnCount + warnDelta,
        });
      }
    }

    return { messages: nextMessages, counters: nextCounters ?? state.counters };
  });
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

    let batch = pendingRows.get(row.paneId);
    if (!batch) {
      batch = [];
      pendingRows.set(row.paneId, batch);
    }
    batch.push(msg);
    // A log storm can outpace the frame; rows beyond the cap can never
    // survive the flush fold, so drop them here to bound buffer growth.
    if (batch.length > MAX_MESSAGES) batch.splice(0, batch.length - MAX_MESSAGES);
    schedule();
  },

  markStale(paneId: string, navigationGeneration: number) {
    // Commit pending rows first: rows captured before the navigation must be
    // present so this generation sweep marks them stale.
    flushConsoleCaptureBuffer();
    set((state) => {
      const existing = state.messages.get(paneId);
      if (!existing || existing.length === 0) return state;

      let changed = false;
      const updated = existing.map((msg) => {
        if (msg.navigationGeneration < navigationGeneration && !msg.isStale) {
          changed = true;
          return { ...msg, isStale: true };
        }
        return msg;
      });
      if (!changed) return state;
      const next = new Map(state.messages);
      next.set(paneId, updated);
      return { messages: next };
    });
  },

  clearMessages(paneId: string) {
    // Rows enqueued before the clear must not resurrect on the next flush.
    pendingRows.delete(paneId);
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
    pendingRows.delete(paneId);
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
