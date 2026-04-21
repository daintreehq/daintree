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
