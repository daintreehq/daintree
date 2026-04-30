// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandHistoryStore, type PromptHistoryEntry } from "../commandHistoryStore";

describe("commandHistoryStore", () => {
  beforeEach(() => {
    useCommandHistoryStore.setState({ history: {} });
  });

  it("records a prompt for a project", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "fix the bug", "claude");
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.prompt).toBe("fix the bug");
    expect(entries[0]!.agentId).toBe("claude");
    expect(entries[0]!.addedAt).toBeGreaterThan(0);
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
    expect(entries[0]!.prompt).toBe("hello");
    expect(entries[1]!.prompt).toBe("world");
  });

  it("caps entries at 100 per project", () => {
    const store = useCommandHistoryStore.getState();
    for (let i = 0; i < 110; i++) {
      store.recordPrompt("proj1", `command ${i}`, null);
    }
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries).toHaveLength(100);
    expect(entries[0]!.prompt).toBe("command 109");
  });

  it("scopes history by project", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "cmd-a", null);
    store.recordPrompt("proj2", "cmd-b", null);
    expect(useCommandHistoryStore.getState().getProjectHistory("proj1")).toHaveLength(1);
    expect(useCommandHistoryStore.getState().getProjectHistory("proj2")).toHaveLength(1);
    expect(useCommandHistoryStore.getState().getProjectHistory("proj1")[0]!.prompt).toBe("cmd-a");
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
    expect(global[0]!.prompt).toBe("shared");
    expect(global[1]!.prompt).toBe("unique");
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
    expect(entries[0]!.prompt).toBe("spaced");
  });

  it("stores agentId as null when not provided", () => {
    const store = useCommandHistoryStore.getState();
    store.recordPrompt("proj1", "test", undefined);
    const entries = useCommandHistoryStore.getState().getProjectHistory("proj1");
    expect(entries[0]!.agentId).toBeNull();
  });
});

describe("commandHistoryStore persistence migration", () => {
  const STORAGE_KEY = "daintree-command-history";
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );

  function installLocalStorage(initial: Record<string, string>): Map<string, string> {
    const backing = new Map<string, string>(Object.entries(initial));
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
          backing.set(key, value);
        },
        removeItem: (key: string) => {
          backing.delete(key);
        },
      },
      configurable: true,
      writable: true,
    });
    return backing;
  }

  function restoreLocalStorage(): void {
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
      return;
    }
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rehydrates a legacy unversioned blob without discarding history", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        history: {
          proj1: [
            {
              id: "legacy-1",
              prompt: "legacy prompt",
              agentId: "claude",
              addedAt: 1_700_000_000_000,
            },
          ],
        },
      },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useCommandHistoryStore: store } = await import("../commandHistoryStore");

    const entries = store.getState().getProjectHistory("proj1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.prompt).toBe("legacy prompt");
    expect(entries[0]!.agentId).toBe("claude");
  });

  it("writes version: 0 on the next persist after rehydration", async () => {
    const legacyBlob = JSON.stringify({
      state: {
        history: {
          proj1: [{ id: "legacy-1", prompt: "old", agentId: null, addedAt: 1_700_000_000_000 }],
        },
      },
    });
    const backing = installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useCommandHistoryStore: store } = await import("../commandHistoryStore");
    store.getState().recordPrompt("proj1", "new", null);

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      version: number;
      state: { history: Record<string, PromptHistoryEntry[]> };
    };
    expect(parsed.version).toBe(0);
    expect(parsed.state.history["proj1"]!.some((e) => e.prompt === "old")).toBe(true);
    expect(parsed.state.history["proj1"]!.some((e) => e.prompt === "new")).toBe(true);
  });
});
