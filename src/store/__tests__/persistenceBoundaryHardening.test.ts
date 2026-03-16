// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

type StorageMock = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear?: () => void;
};

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installLocalStorage(value: StorageMock): void {
  Object.defineProperty(globalThis, "localStorage", {
    value,
    configurable: true,
    writable: true,
  });
}

function installThrowingLocalStorageGetter(error: Error): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw error;
    },
  });
}

function restoreLocalStorage(): void {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }

  delete (globalThis as Partial<typeof globalThis>).localStorage;
}

function createStorageMock(overrides: Partial<StorageMock> = {}): StorageMock {
  const storage = new Map<string, string>();

  return {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    ...overrides,
  };
}

afterEach(() => {
  restoreLocalStorage();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("persistence boundary hardening", () => {
  it("urlHistoryStore keeps recording visits when storage writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { useUrlHistoryStore } = await import("../urlHistoryStore");

    expect(() => {
      useUrlHistoryStore.getState().recordVisit("proj-1", "https://example.com", "Example");
    }).not.toThrow();

    expect(useUrlHistoryStore.getState().entries["proj-1"]).toEqual([
      expect.objectContaining({
        url: "https://example.com",
        title: "Example",
        visitCount: 1,
      }),
    ]);
  });

  it("preferencesStore falls back cleanly when the localStorage getter throws", async () => {
    installThrowingLocalStorageGetter(new Error("SecurityError"));

    const { usePreferencesStore } = await import("../preferencesStore");

    expect(() => {
      usePreferencesStore.getState().setShowDeveloperTools(true);
    }).not.toThrow();

    expect(usePreferencesStore.getState().showDeveloperTools).toBe(true);
  });

  it("agentPreferencesStore survives migration reads when localStorage access throws", async () => {
    installThrowingLocalStorageGetter(new Error("blocked"));

    const { useAgentPreferencesStore } = await import("../agentPreferencesStore");

    expect(() => {
      useAgentPreferencesStore.getState().setDefaultAgent("codex");
    }).not.toThrow();

    expect(useAgentPreferencesStore.getState().defaultAgent).toBe("codex");
  });

  it("toolbarPreferencesStore updates state when storage writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { useToolbarPreferencesStore } = await import("../toolbarPreferencesStore");

    expect(() => {
      useToolbarPreferencesStore.getState().setAlwaysShowDevServer(true);
    }).not.toThrow();

    expect(useToolbarPreferencesStore.getState().launcher.alwaysShowDevServer).toBe(true);
  });

  it("twoPaneSplitStore still commits ratios when persistence writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { useTwoPaneSplitStore } = await import("../twoPaneSplitStore");

    expect(() => {
      useTwoPaneSplitStore.getState().commitRatioIfChanged("wt-1", 0.67, ["panel-a", "panel-b"]);
    }).not.toThrow();

    expect(useTwoPaneSplitStore.getState().ratioByWorktreeId["wt-1"]).toEqual({
      ratio: 0.67,
      panels: ["panel-a", "panel-b"],
    });
  });

  it("worktreeFilterStore remains usable when hydration reads throw", async () => {
    installLocalStorage(
      createStorageMock({
        getItem: () => {
          throw new Error("SecurityError");
        },
      })
    );

    const { useWorktreeFilterStore } = await import("../worktreeFilterStore");

    expect(() => {
      useWorktreeFilterStore.getState().pinWorktree("wt-1");
    }).not.toThrow();

    expect(useWorktreeFilterStore.getState().pinnedWorktrees).toEqual(["wt-1"]);
  });

  it("sidecarStore still updates persisted fields when storage writes fail", async () => {
    installLocalStorage(
      createStorageMock({
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      })
    );

    const { useSidecarStore } = await import("../sidecarStore");

    expect(() => {
      useSidecarStore.getState().setWidth(600);
    }).not.toThrow();

    expect(useSidecarStore.getState().width).toBe(600);
  });
});
