import { describe, it, expect, beforeEach } from "vitest";
import { useCommandHistoryStore } from "../commandHistoryStore";

describe("commandHistoryStore", () => {
  beforeEach(() => {
    useCommandHistoryStore.setState({ history: {} });
  });

  it("records a prompt for a project", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "fix the bug", "claude");
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries).toHaveLength(1);
    expect(entries[0].prompt).toBe("fix the bug");
    expect(entries[0].agentId).toBe("claude");
    expect(entries[0].addedAt).toBeGreaterThan(0);
  });

  it("ignores blank prompts", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "   ", null);
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries).toHaveLength(0);
  });

  it("deduplicates by prompt text, keeping most recent first", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "hello", null);
    store.recordPrompt("proj1", "world", null);
    store.recordPrompt("proj1", "hello", null);
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries).toHaveLength(2);
    expect(entries[0].prompt).toBe("hello");
    expect(entries[1].prompt).toBe("world");
  });

  it("caps entries at 100 per project", () => {
    const store = useCommandHistoryStore.getState();
    for (let i = 0; i < 110; i++) {
      store.recordPrompt("proj1", `command ${i}`, null);
    }
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries).toHaveLength(100);
    expect(entries[0].prompt).toBe("command 109");
  });

  it("scopes history by project", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "cmd-a", null);
    store.recordPrompt("proj2", "cmd-b", null);
    expect(useCommandHistoryStore.getState().getProjectHistory("proj1")).toHaveLength(1);
    expect(useCommandHistoryStore.getState().getProjectHistory("proj2")).toHaveLength(1);
    expect(useCommandHistoryStore.getState().getProjectHistory("proj1")[0].prompt).toBe("cmd-a");
  });

  it("returns empty array for undefined projectId", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "something", null);
    expect(useCommandHistoryStore.getState().getProjectHistory(undefined)).toHaveLength(0);
  });

  it("returns global history as deduplicated union of all projects", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "shared", null);
    store.recordPrompt("proj2", "unique", null);
    store.recordPrompt("proj2", "shared", null);
    const global = useCommandHistoryStore.getState().getGlobalHistory();
    expect(global).toHaveLength(2);
    expect(global[0].prompt).toBe("shared");
    expect(global[1].prompt).toBe("unique");
  });

  it("removes project history", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "keep", null);
    store.recordPrompt("proj2", "remove", null);
    store.removeProjectHistory("proj2");
    expect(useCommandHistoryStore.getState().getProjectHistory("proj2")).toHaveLength(0);
    expect(useCommandHistoryStore.getState().getProjectHistory("proj1")).toHaveLength(1);
  });

  it("trims whitespace from prompts", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "  spaced  ", null);
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries[0].prompt).toBe("spaced");
  });

  it("stores agentId as null when not provided", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "test", undefined);
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries[0].agentId).toBeNull();
  });
});
