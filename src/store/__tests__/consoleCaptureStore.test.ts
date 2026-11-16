import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useConsoleCaptureStore,
  flushConsoleCaptureBuffer,
  ZERO_COUNTS,
} from "../consoleCaptureStore";
import type { SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";
import { MAX_CONSOLE_ROWS, MAX_LIVE_OBJECT_ROWS } from "@shared/config/devPreviewConsole";

function makeRow(overrides: Partial<SerializedConsoleRow> = {}): SerializedConsoleRow {
  return {
    id: 0,
    paneId: "pane1",
    level: "log",
    cdpType: "log",
    args: [{ type: "primitive", kind: "string", value: "test message" }],
    summaryText: "test message",
    groupDepth: 0,
    timestamp: Date.now(),
    navigationGeneration: 0,
    ...overrides,
  };
}

// Ingest is RAF-coalesced; flush synchronously so each assertion sees the row.
function addRow(row: SerializedConsoleRow) {
  useConsoleCaptureStore.getState().addStructuredMessage(row);
  flushConsoleCaptureBuffer();
}

describe("consoleCaptureStore", () => {
  beforeEach(() => {
    useConsoleCaptureStore.setState({ messages: new Map(), counters: new Map() });
  });

  it("adds a structured message with correct level", () => {
    addRow(makeRow({ id: 1, level: "log" }));
    addRow(makeRow({ id: 2, level: "info" }));
    addRow(makeRow({ id: 3, level: "warning" }));
    addRow(makeRow({ id: 4, level: "error" }));

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(4);
    expect(messages[0]!.level).toBe("log");
    expect(messages[1]!.level).toBe("info");
    expect(messages[2]!.level).toBe("warning");
    expect(messages[3]!.level).toBe("error");
  });

  it("isolates messages per pane id", () => {
    addRow(makeRow({ id: 1, paneId: "pane1", summaryText: "from pane1" }));
    addRow(makeRow({ id: 2, paneId: "pane2", summaryText: "from pane2" }));

    const pane1 = useConsoleCaptureStore.getState().getMessages("pane1");
    const pane2 = useConsoleCaptureStore.getState().getMessages("pane2");

    expect(pane1).toHaveLength(1);
    expect(pane1[0]!.summaryText).toBe("from pane1");
    expect(pane2).toHaveLength(1);
    expect(pane2[0]!.summaryText).toBe("from pane2");
  });

  it("caps messages at MAX_MESSAGES (500)", () => {
    for (let i = 0; i < 510; i++) {
      addRow(makeRow({ id: i, summaryText: `msg ${i}` }));
    }
    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(500);
    expect(messages[0]!.summaryText).toBe("msg 10");
    expect(messages[499]!.summaryText).toBe("msg 509");
  });

  it("clears messages for a specific pane", () => {
    addRow(makeRow({ id: 1, paneId: "pane1" }));
    addRow(makeRow({ id: 2, paneId: "pane1" }));
    addRow(makeRow({ id: 3, paneId: "pane2" }));

    useConsoleCaptureStore.getState().clearMessages("pane1");

    expect(useConsoleCaptureStore.getState().getMessages("pane1")).toHaveLength(0);
    expect(useConsoleCaptureStore.getState().getMessages("pane2")).toHaveLength(1);
  });

  it("removes pane from state entirely on removePane", () => {
    addRow(makeRow({ id: 1, paneId: "pane1" }));
    addRow(makeRow({ id: 2, paneId: "pane2" }));

    useConsoleCaptureStore.getState().removePane("pane1");

    const state = useConsoleCaptureStore.getState();
    expect(state.messages.has("pane1")).toBe(false);
    expect(state.messages.has("pane2")).toBe(true);
  });

  it("filters out endGroup messages", () => {
    addRow(makeRow({ id: 1, cdpType: "startGroup" }));
    addRow(makeRow({ id: 2, cdpType: "log" }));
    addRow(makeRow({ id: 3, cdpType: "endGroup" }));

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.cdpType).toBe("startGroup");
    expect(messages[1]!.cdpType).toBe("log");
  });

  it("markStale marks older messages as stale", () => {
    addRow(makeRow({ id: 1, navigationGeneration: 0 }));
    addRow(makeRow({ id: 2, navigationGeneration: 0 }));
    addRow(makeRow({ id: 3, navigationGeneration: 1 }));

    useConsoleCaptureStore.getState().markStale("pane1", 1);

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages[0]!.isStale).toBe(true);
    expect(messages[1]!.isStale).toBe(true);
    expect(messages[2]!.isStale).toBe(false);
  });

  describe("precomputed fields", () => {
    it("precomputes timeLabel as HH:MM:SS.mmm at insert time", () => {
      // 2024-06-15 14:30:25.123 in UTC; rendered using local time
      const ts = new Date(2024, 5, 15, 14, 30, 25, 123).getTime();
      addRow(makeRow({ id: 1, timestamp: ts }));

      const [msg] = useConsoleCaptureStore.getState().getMessages("pane1");
      expect(msg!.timeLabel).toBe("14:30:25.123");
    });

    it("sets isGroupHeader true for startGroup and startGroupCollapsed, false otherwise", () => {
      addRow(makeRow({ id: 1, cdpType: "startGroup" }));
      addRow(makeRow({ id: 2, cdpType: "startGroupCollapsed" }));
      addRow(makeRow({ id: 3, cdpType: "log" }));
      addRow(makeRow({ id: 4, cdpType: "error", level: "error" }));

      const messages = useConsoleCaptureStore.getState().getMessages("pane1");
      expect(messages[0]!.isGroupHeader).toBe(true);
      expect(messages[1]!.isGroupHeader).toBe(true);
      expect(messages[2]!.isGroupHeader).toBe(false);
      expect(messages[3]!.isGroupHeader).toBe(false);
    });
  });

  describe("error/warn counters", () => {
    it("returns ZERO_COUNTS for an unknown pane", () => {
      const counts = useConsoleCaptureStore.getState().getCounts("nope");
      expect(counts).toBe(ZERO_COUNTS);
      expect(counts).toEqual({ errorCount: 0, warnCount: 0 });
    });

    it("increments counts for error and warning levels only", () => {
      addRow(makeRow({ id: 1, level: "log" }));
      addRow(makeRow({ id: 2, level: "info" }));
      addRow(makeRow({ id: 3, level: "warning" }));
      addRow(makeRow({ id: 4, level: "error" }));
      addRow(makeRow({ id: 5, level: "error" }));

      const counts = useConsoleCaptureStore.getState().getCounts("pane1");
      expect(counts.errorCount).toBe(2);
      expect(counts.warnCount).toBe(1);
    });

    it("keeps counts isolated per pane", () => {
      addRow(makeRow({ id: 1, paneId: "pane1", level: "error" }));
      addRow(makeRow({ id: 2, paneId: "pane2", level: "warning" }));

      expect(useConsoleCaptureStore.getState().getCounts("pane1")).toEqual({
        errorCount: 1,
        warnCount: 0,
      });
      expect(useConsoleCaptureStore.getState().getCounts("pane2")).toEqual({
        errorCount: 0,
        warnCount: 1,
      });
    });

    it("decrements counts when an error/warning message is evicted by the cap", () => {
      // First 100 messages are errors; the rest are logs that will push them out
      for (let i = 0; i < 100; i++) {
        addRow(makeRow({ id: i, level: "error" }));
      }
      expect(useConsoleCaptureStore.getState().getCounts("pane1").errorCount).toBe(100);

      // Add 500 logs to push every error message out of the 500-cap window
      for (let i = 100; i < 600; i++) {
        addRow(makeRow({ id: i, level: "log" }));
      }

      const counts = useConsoleCaptureStore.getState().getCounts("pane1");
      const messages = useConsoleCaptureStore.getState().getMessages("pane1");
      expect(messages).toHaveLength(500);
      expect(counts.errorCount).toBe(0);
      expect(counts.warnCount).toBe(0);
    });

    it("does not decrement counts when an evicted message was log/info", () => {
      // Start with a log that will be the first to be evicted
      addRow(makeRow({ id: 0, level: "log" }));
      // Then add 500 errors to fill the cap and evict the leading log
      for (let i = 1; i <= 500; i++) {
        addRow(makeRow({ id: i, level: "error" }));
      }

      const counts = useConsoleCaptureStore.getState().getCounts("pane1");
      const messages = useConsoleCaptureStore.getState().getMessages("pane1");
      expect(messages).toHaveLength(500);
      expect(counts.errorCount).toBe(500);
    });

    it("resets counts to zero after clearMessages and leaves other panes untouched", () => {
      addRow(makeRow({ id: 1, paneId: "pane1", level: "error" }));
      addRow(makeRow({ id: 2, paneId: "pane2", level: "warning" }));

      useConsoleCaptureStore.getState().clearMessages("pane1");

      expect(useConsoleCaptureStore.getState().getCounts("pane1")).toBe(ZERO_COUNTS);
      expect(useConsoleCaptureStore.getState().getCounts("pane2")).toEqual({
        errorCount: 0,
        warnCount: 1,
      });
    });

    it("drops the counter entry on removePane", () => {
      addRow(makeRow({ id: 1, paneId: "pane1", level: "error" }));
      useConsoleCaptureStore.getState().removePane("pane1");

      const state = useConsoleCaptureStore.getState();
      expect(state.counters.has("pane1")).toBe(false);
      expect(state.getCounts("pane1")).toBe(ZERO_COUNTS);
    });

    it("keeps the counters Map reference stable across non-counting inserts (selector-stability)", () => {
      // Establish a baseline counters entry
      addRow(makeRow({ id: 1, level: "error" }));
      const beforeCounters = useConsoleCaptureStore.getState().counters;
      const beforeCounts = beforeCounters.get("pane1");

      // Adding only log/info messages should NOT churn the counters Map reference
      addRow(makeRow({ id: 2, level: "log" }));
      addRow(makeRow({ id: 3, level: "info" }));

      const afterCounters = useConsoleCaptureStore.getState().counters;
      expect(afterCounters).toBe(beforeCounters);
      expect(afterCounters.get("pane1")).toBe(beforeCounts);
    });

    it("keeps the counters Map reference stable on log-evicts-log inserts at the cap", () => {
      // Fill exactly to the 500-cap with log messages — no counter activity
      for (let i = 0; i < 500; i++) {
        addRow(makeRow({ id: i, level: "log" }));
      }
      const beforeCounters = useConsoleCaptureStore.getState().counters;

      // Eviction: this insert pushes one log out and adds one log; net delta is zero
      addRow(makeRow({ id: 500, level: "log" }));

      const afterCounters = useConsoleCaptureStore.getState().counters;
      expect(afterCounters).toBe(beforeCounters);
    });

    it("handles mixed eviction deltas correctly under realistic sequences", () => {
      // 498 logs + 1 warning + 1 error = 500 total, in that order
      for (let i = 0; i < 498; i++) {
        addRow(makeRow({ id: i, level: "log" }));
      }
      addRow(makeRow({ id: 498, level: "warning" }));
      addRow(makeRow({ id: 499, level: "error" }));
      expect(useConsoleCaptureStore.getState().getCounts("pane1")).toEqual({
        errorCount: 1,
        warnCount: 1,
      });

      // Add an error (evicts log 0): error+1, no decrement
      addRow(makeRow({ id: 500, level: "error" }));
      expect(useConsoleCaptureStore.getState().getCounts("pane1")).toEqual({
        errorCount: 2,
        warnCount: 1,
      });

      // Add a warning (evicts log 1): warning+1, no decrement
      addRow(makeRow({ id: 501, level: "warning" }));
      expect(useConsoleCaptureStore.getState().getCounts("pane1")).toEqual({
        errorCount: 2,
        warnCount: 2,
      });

      // Add 497 more logs to push every log out — eventually evicts the original warning at id 498
      for (let i = 502; i < 502 + 497; i++) {
        addRow(makeRow({ id: i, level: "log" }));
      }
      expect(useConsoleCaptureStore.getState().getCounts("pane1")).toEqual({
        errorCount: 2,
        warnCount: 1,
      });
    });
  });

  describe("ingest coalescing", () => {
    // The node-env setup stubs requestAnimationFrame to run callbacks inline,
    // which would flush per add. Use a no-op rAF so batching is observable,
    // with flushConsoleCaptureBuffer() standing in for the frame callback.
    beforeEach(() => {
      vi.stubGlobal("requestAnimationFrame", () => 0);
    });
    afterEach(() => {
      flushConsoleCaptureBuffer();
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      });
    });

    it("folds all rows enqueued before a flush into a single store notification", () => {
      const store = useConsoleCaptureStore.getState();
      let notifications = 0;
      const unsubscribe = useConsoleCaptureStore.subscribe(() => {
        notifications += 1;
      });

      for (let i = 0; i < 50; i++) {
        store.addStructuredMessage(makeRow({ id: i, level: i % 2 === 0 ? "log" : "error" }));
      }
      expect(notifications).toBe(0);

      flushConsoleCaptureBuffer();
      expect(notifications).toBe(1);
      expect(useConsoleCaptureStore.getState().getMessages("pane1")).toHaveLength(50);
      expect(useConsoleCaptureStore.getState().getCounts("pane1").errorCount).toBe(25);

      unsubscribe();
    });

    it("applies the cap and counter deltas across a flushed batch", () => {
      const store = useConsoleCaptureStore.getState();
      // Pre-existing committed rows: 499 logs + 1 error
      for (let i = 0; i < 499; i++) {
        store.addStructuredMessage(makeRow({ id: i, level: "log" }));
      }
      store.addStructuredMessage(makeRow({ id: 499, level: "error" }));
      flushConsoleCaptureBuffer();

      // Batch of 10 warnings evicts 10 of the oldest logs in one flush
      for (let i = 500; i < 510; i++) {
        store.addStructuredMessage(makeRow({ id: i, level: "warning" }));
      }
      flushConsoleCaptureBuffer();

      const messages = useConsoleCaptureStore.getState().getMessages("pane1");
      expect(messages).toHaveLength(500);
      expect(messages[0]!.id).toBe(10);
      expect(useConsoleCaptureStore.getState().getCounts("pane1")).toEqual({
        errorCount: 1,
        warnCount: 10,
      });
    });

    it("does not resurrect pre-clear rows enqueued before clearMessages", () => {
      const store = useConsoleCaptureStore.getState();
      store.addStructuredMessage(makeRow({ id: 1 }));
      store.clearMessages("pane1");
      flushConsoleCaptureBuffer();
      expect(useConsoleCaptureStore.getState().getMessages("pane1")).toHaveLength(0);
    });
  });
});

describe("consoleCaptureStore live object window (#17067)", () => {
  function objectRow(id: number, paneId = "pane1"): SerializedConsoleRow {
    return makeRow({
      id,
      paneId,
      args: [
        { type: "object", objectId: `obj-${id}`, preview: `{id: ${id}}` },
        { type: "primitive", kind: "number", value: id },
      ],
      summaryText: `{id: ${id}}`,
    });
  }

  function objectIdOf(paneId: string, rowId: number): string | undefined {
    const row = useConsoleCaptureStore
      .getState()
      .getMessages(paneId)
      .find((msg) => msg.id === rowId);
    const arg = row?.args[0];
    return arg && arg.type === "object" ? arg.objectId : undefined;
  }

  beforeEach(() => {
    useConsoleCaptureStore.getState().removePane("pane1");
    useConsoleCaptureStore.getState().removePane("pane2");
    useConsoleCaptureStore.setState({ messages: new Map(), counters: new Map() });
  });

  it("blanks the object ids of rows that age out of the live window, keeping their previews", () => {
    for (let id = 0; id < MAX_LIVE_OBJECT_ROWS + 2; id++) addRow(objectRow(id));

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(MAX_LIVE_OBJECT_ROWS + 2);
    expect(objectIdOf("pane1", 0)).toBe("");
    expect(objectIdOf("pane1", 1)).toBe("");
    expect(objectIdOf("pane1", 2)).toBe("obj-2");
    expect(messages[0]!.args[0]).toMatchObject({ preview: "{id: 0}" });
    expect(messages[0]!.args[1]).toEqual({ type: "primitive", kind: "number", value: 0 });
  });

  it("applies the window once per row however rows are batched into frames", () => {
    // The node setup runs rAF inline, which would flush per add; hold the frame
    // so one flush takes the whole burst, as a log storm's frame does.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    try {
      for (let id = 0; id < 10; id++) addRow(objectRow(id));
      // More than the row cap in one frame: the rows that never got to be live
      // in the store still lost their handles in main.
      const burst = MAX_CONSOLE_ROWS + MAX_LIVE_OBJECT_ROWS;
      for (let id = 10; id < 10 + burst; id++) {
        useConsoleCaptureStore.getState().addStructuredMessage(objectRow(id));
      }
      expect(useConsoleCaptureStore.getState().getMessages("pane1")).toHaveLength(10);
      flushConsoleCaptureBuffer();
    } finally {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      });
    }

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    const live = messages.filter(
      (msg) => msg.args[0]?.type === "object" && msg.args[0].objectId !== ""
    );
    expect(messages).toHaveLength(MAX_CONSOLE_ROWS);
    expect(live).toHaveLength(MAX_LIVE_OBJECT_ROWS);
    expect(live[0]!.id).toBe(messages.at(-MAX_LIVE_OBJECT_ROWS)!.id);
  });

  it("keeps an expanded row's object ids past the window until the row is dropped", () => {
    addRow(objectRow(0));
    useConsoleCaptureStore.getState().markInspected("pane1", 0);
    for (let id = 1; id <= MAX_LIVE_OBJECT_ROWS + 5; id++) addRow(objectRow(id));

    expect(objectIdOf("pane1", 0)).toBe("obj-0");
    expect(objectIdOf("pane1", 1)).toBe("");

    for (let id = 1000; id < 1000 + MAX_CONSOLE_ROWS; id++) addRow(objectRow(id));
    expect(objectIdOf("pane1", 0)).toBeUndefined();
  });

  it("blanks one row's object ids when main reports them released", () => {
    addRow(objectRow(0));
    addRow(objectRow(1));
    useConsoleCaptureStore.getState().markInspected("pane1", 0);

    useConsoleCaptureStore.getState().releaseRowHandles("pane1", 0);

    expect(objectIdOf("pane1", 0)).toBe("");
    expect(objectIdOf("pane1", 1)).toBe("obj-1");
  });

  it("blanks the rows a stopped capture delivered, and no other pane's", () => {
    addRow(objectRow(0, "pane1"));
    addRow(objectRow(1, "pane2"));
    useConsoleCaptureStore.getState().markInspected("pane1", 0);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    try {
      // Still in the ingest buffer when capture stops.
      useConsoleCaptureStore.getState().addStructuredMessage(objectRow(2, "pane1"));
      useConsoleCaptureStore.getState().releaseHandles("pane1", 2);
    } finally {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      });
    }

    expect(objectIdOf("pane1", 0)).toBe("");
    expect(objectIdOf("pane1", 2)).toBe("");
    expect(objectIdOf("pane2", 1)).toBe("obj-1");
    expect(useConsoleCaptureStore.getState().getMessages("pane1")).toHaveLength(2);
  });

  it("leaves the rows a later capture of the pane delivered as they are", () => {
    addRow(objectRow(0));
    addRow(objectRow(5));
    useConsoleCaptureStore.getState().markInspected("pane1", 5);

    useConsoleCaptureStore.getState().releaseHandles("pane1", 0);
    for (let id = 6; id < 6 + MAX_LIVE_OBJECT_ROWS + 1; id++) addRow(objectRow(id));

    expect(objectIdOf("pane1", 0)).toBe("");
    // Still the later capture's, and still pinned.
    expect(objectIdOf("pane1", 5)).toBe("obj-5");
  });

  it("leaves the pane's array untouched when nothing it holds has a handle", () => {
    addRow(makeRow({ id: 0 }));
    const before = useConsoleCaptureStore.getState().getMessages("pane1");

    useConsoleCaptureStore.getState().releaseHandles("pane1", 0);

    expect(useConsoleCaptureStore.getState().getMessages("pane1")).toBe(before);
  });
});
