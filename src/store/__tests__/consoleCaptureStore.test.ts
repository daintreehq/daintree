import { describe, it, expect, beforeEach } from "vitest";
import { useConsoleCaptureStore, EMPTY_MESSAGES } from "../consoleCaptureStore";

describe("consoleCaptureStore", () => {
  beforeEach(() => {
    useConsoleCaptureStore.setState({ messages: new Map() });
  });

  it("adds a message with correct level mapping", () => {
    const store = useConsoleCaptureStore.getState();
    store.addMessage("pane1", 0, "debug message");
    store.addMessage("pane1", 1, "info message");
    store.addMessage("pane1", 2, "warning message");
    store.addMessage("pane1", 3, "error message");

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(4);
    expect(messages[0].level).toBe("log");
    expect(messages[1].level).toBe("info");
    expect(messages[2].level).toBe("warning");
    expect(messages[3].level).toBe("error");
  });

  it("falls back to log for unknown level numbers", () => {
    const store = useConsoleCaptureStore.getState();
    store.addMessage("pane1", 99, "unknown level");
    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages[0].level).toBe("log");
  });

  it("EMPTY_MESSAGES is a stable reference (same array each access)", () => {
    expect(EMPTY_MESSAGES).toBe(EMPTY_MESSAGES);
    expect(EMPTY_MESSAGES).toHaveLength(0);
  });

  it("stores message text, timestamp, line and sourceId", () => {
    const before = Date.now();
    const store = useConsoleCaptureStore.getState();
    store.addMessage("pane1", 3, "test error", 42, "http://localhost/app.js");
    const after = Date.now();

    const [msg] = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(msg.message).toBe("test error");
    expect(msg.line).toBe(42);
    expect(msg.sourceId).toBe("http://localhost/app.js");
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it("assigns unique sequential ids", () => {
    const store = useConsoleCaptureStore.getState();
    store.addMessage("pane1", 0, "a");
    store.addMessage("pane1", 0, "b");
    store.addMessage("pane1", 0, "c");

    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    const ids = messages.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);
    expect(ids[0]).toBeLessThan(ids[1]);
    expect(ids[1]).toBeLessThan(ids[2]);
  });

  it("isolates messages per pane id", () => {
    const store = useConsoleCaptureStore.getState();
    store.addMessage("pane1", 0, "from pane1");
    store.addMessage("pane2", 3, "from pane2");

    const pane1 = useConsoleCaptureStore.getState().getMessages("pane1");
    const pane2 = useConsoleCaptureStore.getState().getMessages("pane2");

    expect(pane1).toHaveLength(1);
    expect(pane1[0].message).toBe("from pane1");
    expect(pane2).toHaveLength(1);
    expect(pane2[0].message).toBe("from pane2");
  });

  it("returns empty array for unknown pane", () => {
    const store = useConsoleCaptureStore.getState();
    expect(store.getMessages("unknown-pane")).toEqual([]);
  });

  it("caps messages at MAX_MESSAGES (500)", () => {
    const store = useConsoleCaptureStore.getState();
    for (let i = 0; i < 510; i++) {
      store.addMessage("pane1", 0, `msg ${i}`);
    }
    const messages = useConsoleCaptureStore.getState().getMessages("pane1");
    expect(messages).toHaveLength(500);
    // Should keep the most recent 500 (messages 10-509)
    expect(messages[0].message).toBe("msg 10");
    expect(messages[499].message).toBe("msg 509");
  });

  it("clears messages for a specific pane", () => {
    const store = useConsoleCaptureStore.getState();
    store.addMessage("pane1", 0, "a");
    store.addMessage("pane1", 0, "b");
    store.addMessage("pane2", 0, "c");

    useConsoleCaptureStore.getState().clearMessages("pane1");

    expect(useConsoleCaptureStore.getState().getMessages("pane1")).toHaveLength(0);
    expect(useConsoleCaptureStore.getState().getMessages("pane2")).toHaveLength(1);
  });

  it("removes pane from state entirely on removePane", () => {
    const store = useConsoleCaptureStore.getState();
    store.addMessage("pane1", 0, "a");
    store.addMessage("pane2", 0, "b");

    useConsoleCaptureStore.getState().removePane("pane1");

    const state = useConsoleCaptureStore.getState();
    expect(state.messages.has("pane1")).toBe(false);
    expect(state.messages.has("pane2")).toBe(true);
  });

  it("clearMessages leaves an empty array (not removes the key)", () => {
    const store = useConsoleCaptureStore.getState();
    store.addMessage("pane1", 0, "a");
    useConsoleCaptureStore.getState().clearMessages("pane1");

    const state = useConsoleCaptureStore.getState();
    // After clear, key exists with empty array
    expect(state.messages.get("pane1")).toEqual([]);
  });
});
