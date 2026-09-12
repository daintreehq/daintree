// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("agentPreferencesStore persistence migration", () => {
  const STORAGE_KEY = "daintree-agent-preferences";
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

  it("rehydrates a legacy unversioned blob with a valid defaultAgent", async () => {
    const legacyBlob = JSON.stringify({
      state: { defaultAgent: "claude" },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useAgentPreferencesStore: store } = await import("../agentPreferencesStore");

    expect(store.getState().defaultAgent).toBe("claude");
  });

  it("drops a persisted assistant-only agent on rehydration", async () => {
    // `daintree-assistant` used to be a selectable default here, from when it was an
    // installable CLI. It is now a headless engine with no PTY form — `useAgentLauncher`
    // refuses it — so a stored one is a default every launch path quietly declines.
    // Dropping it to undefined falls back to "first available", which can actually run.
    const legacyBlob = JSON.stringify({
      state: { defaultAgent: "daintree-assistant" },
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useAgentPreferencesStore: store } = await import("../agentPreferencesStore");

    expect(store.getState().defaultAgent).toBeUndefined();
  });

  it("preserves an explicit undefined defaultAgent from a legacy blob", async () => {
    const legacyBlob = JSON.stringify({
      state: {},
    });
    installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useAgentPreferencesStore: store } = await import("../agentPreferencesStore");

    expect(store.getState().defaultAgent).toBeUndefined();
  });

  it("writes version: 0 on the next persist after rehydration", async () => {
    const legacyBlob = JSON.stringify({ state: { defaultAgent: "claude" } });
    const backing = installLocalStorage({ [STORAGE_KEY]: legacyBlob });

    const { useAgentPreferencesStore: store } = await import("../agentPreferencesStore");
    store.getState().setDefaultAgent("gemini");

    const written = backing.get(STORAGE_KEY);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as {
      version: number;
      state: { defaultAgent?: string };
    };
    expect(parsed.version).toBe(0);
    expect(parsed.state.defaultAgent).toBe("gemini");
  });
});
