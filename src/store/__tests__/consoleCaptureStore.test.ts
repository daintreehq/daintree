import { describe, it, expect, beforeEach } from "vitest";
import { useConsoleCaptureStore, EMPTY_MESSAGES } from "../consoleCaptureStore";
import type { SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";

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

describe("consoleCaptureStore", () => {
  beforeEach(() => {
    useConsoleCaptureStore.setState({ messages: new Map() });
  });

  it("adds a structured message with correct level", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1, level: "log" }));
    store.addStructuredMessage(makeRow({ id: 2, level: "info" }));
    store.addStructuredMessage(makeRow({ id: 3, level: "warning" }));
    store.addStructuredMessage(makeRow({ id: 4, level: "error" }));

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(4);
    expect(messages[0].level).toBe("log");
    expect(messages[1].level).toBe("info");
    expect(messages[2].level).toBe("warning");
    expect(messages[3].level).toBe("error");
  });

  it("EMPTY_MESSAGES is a stable reference (same array each access)", () => {
    expect(EMPTY_MESSAGES).toBe(EMPTY_MESSAGES);
    expect(EMPTY_MESSAGES).toHaveLength(0);
  });

  it("stores structured args and summaryText", () => {
    const before = Date.now();
    const store = useConsoleCaptureStore.getState();
    const args = [
      { type: "primitive" as const, kind: "string" as const, value: "hello" },
      { type: "primitive" as const, kind: "number" as const, value: 42 },
    ];
    store.addStructuredMessage(
      makeRow({ id: 1, args, summaryText: "hello 42", timestamp: before })
    );
    const after = Date.now();

    const [msg] = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(msg.args).toHaveLength(2);
    expect(msg.args[0]).toEqual({ type: "primitive", kind: "string", value: "hello" });
    expect(msg.args[1]).toEqual({ type: "primitive", kind: "number", value: 42 });
    expect(msg.summaryText).toBe("hello 42");
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it("assigns isStale: false on add", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1 }));
    const [msg] = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(msg.isStale).toBe(false);
  });

  it("isolates messages per pane id", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1, paneId: "pane1", summaryText: "from pane1" }));
    store.addStructuredMessage(makeRow({ id: 2, paneId: "pane2", summaryText: "from pane2" }));

    const pane1 = useConsoleCaptureStore.getState().getMessages("pane1");
    const pane2 = useConsoleCaptureStore.getState().getMessages("pane2");

    expect(pane1).toHaveLength(1);
    expect(pane1[0].summaryText).toBe("from pane1");
    expect(pane2).toHaveLength(1);
    expect(pane2[0].summaryText).toBe("from pane2");
  });

  it("returns empty array for unknown pane", () => {
    const store = useConsoleCaptureStore.getState();
    expect(store.getMessages("unknown-pane")).toEqual([]);
  });

  it("caps messages at MAX_MESSAGES (500)", () => {
    const store = useConsoleCaptureStore.getState();
    for (let i = 0; i < 510; i++) {
      store.addStructuredMessage(makeRow({ id: i, summaryText: `msg ${i}` }));
    }
    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(500);
    expect(messages[0].summaryText).toBe("msg 10");
    expect(messages[499].summaryText).toBe("msg 509");
  });

  it("clears messages for a specific pane", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1, paneId: "pane1" }));
    store.addStructuredMessage(makeRow({ id: 2, paneId: "pane1" }));
    store.addStructuredMessage(makeRow({ id: 3, paneId: "pane2" }));

    useConsoleCaptureStore.getState().clearMessages("pane1");

    expect(useConsoleCaptureStore.getState().getMessages("pane1")).toHaveLength(0);
    expect(useConsoleCaptureStore.getState().getMessages("pane2")).toHaveLength(1);
  });

  it("removes pane from state entirely on removePane", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1, paneId: "pane1" }));
    store.addStructuredMessage(makeRow({ id: 2, paneId: "pane2" }));

    useConsoleCaptureStore.getState().removePane("pane1");

    const state = useConsoleCaptureStore.getState();
    expect(state.messages.has("pane1")).toBe(false);
    expect(state.messages.has("pane2")).toBe(true);
  });

  it("clearMessages leaves an empty array (not removes the key)", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1, paneId: "pane1" }));
    useConsoleCaptureStore.getState().clearMessages("pane1");

    const state = useConsoleCaptureStore.getState();
    expect(state.messages.get("pane1")).toEqual([]);
  });

  it("filters out endGroup messages", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1, cdpType: "startGroup" }));
    store.addStructuredMessage(makeRow({ id: 2, cdpType: "log" }));
    store.addStructuredMessage(makeRow({ id: 3, cdpType: "endGroup" }));

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(2);
    expect(messages[0].cdpType).toBe("startGroup");
    expect(messages[1].cdpType).toBe("log");
  });

  it("markStale marks older messages as stale", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1, navigationGeneration: 0 }));
    store.addStructuredMessage(makeRow({ id: 2, navigationGeneration: 0 }));
    store.addStructuredMessage(makeRow({ id: 3, navigationGeneration: 1 }));

    useConsoleCaptureStore.getState().markStale("pane1", 1);

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages[0].isStale).toBe(true);
    expect(messages[1].isStale).toBe(true);
    expect(messages[2].isStale).toBe(false);
  });

  it("preserves group depth in messages", () => {
    const store = useConsoleCaptureStore.getState();
    store.addStructuredMessage(makeRow({ id: 1, cdpType: "startGroup", groupDepth: 0 }));
    store.addStructuredMessage(makeRow({ id: 2, cdpType: "log", groupDepth: 1 }));

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages[0].groupDepth).toBe(0);
    expect(messages[1].groupDepth).toBe(1);
  });

  it("stores stack trace when present", () => {
    const store = useConsoleCaptureStore.getState();
    const stackTrace = {
      callFrames: [
        { functionName: "foo", url: "http://localhost/app.js", lineNumber: 10, columnNumber: 5 },
      ],
    };
    store.addStructuredMessage(makeRow({ id: 1, level: "error", stackTrace }));

    const [msg] = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(msg.stackTrace).toBeDefined();
    expect(msg.stackTrace!.callFrames).toHaveLength(1);
    expect(msg.stackTrace!.callFrames[0].functionName).toBe("foo");
  });
});
