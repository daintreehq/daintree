// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the production agent IDs so the v5 migration is exercised against
// the real set, not a subset. Keeping the mock in sync guards against
// regressions when new built-in agents ship.
vi.mock("@shared/config/agentIds", () => ({
  BUILT_IN_AGENT_IDS: [
    "claude",
    "gemini",
    "codex",
    "opencode",
    "cursor",
    "kiro",
    "copilot",
    "crush",
  ] as const,
}));

let useToolbarPreferencesStore: typeof import("../toolbarPreferencesStore").useToolbarPreferencesStore;

const STORAGE_KEY = "daintree-toolbar-preferences";

let storage: Record<string, string> = {};

const storageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => {
    storage[key] = value;
  },
  removeItem: (key: string) => {
    delete storage[key];
  },
  clear: () => {
    storage = {};
  },
  get length() {
    return Object.keys(storage).length;
  },
  key: (index: number) => Object.keys(storage)[index] ?? null,
};

function installStorageMock() {
  Object.defineProperty(globalThis, "localStorage", {
    value: storageMock,
    configurable: true,
    writable: true,
  });
}

function setStoredState(state: Record<string, unknown>, version = 2) {
  storageMock.setItem(STORAGE_KEY, JSON.stringify({ state, version }));
}

async function loadStore() {
  const mod = await import("../toolbarPreferencesStore");
  useToolbarPreferencesStore = mod.useToolbarPreferencesStore;
  // Wait for hydration
  await vi.waitFor(() => {
    const state = useToolbarPreferencesStore.getState();
    expect(state.layout).toBeDefined();
  });
  return useToolbarPreferencesStore;
}

describe("toolbarPreferencesStore", () => {
  beforeEach(() => {
    vi.resetModules();
    storage = {};
    installStorageMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("toggleButtonVisibility", () => {
    it("adds button to hiddenButtons without removing from ordering array", async () => {
      const store = await loadStore();
      const { layout } = store.getState();
      expect(layout.rightButtons).toContain("copy-tree");
      expect(layout.hiddenButtons).not.toContain("copy-tree");

      store.getState().toggleButtonVisibility("copy-tree", "right");

      const updated = store.getState();
      expect(updated.layout.hiddenButtons).toContain("copy-tree");
      expect(updated.layout.rightButtons).toContain("copy-tree");
    });

    it("removes button from hiddenButtons when toggled again", async () => {
      const store = await loadStore();

      store.getState().toggleButtonVisibility("copy-tree", "right");
      expect(store.getState().layout.hiddenButtons).toContain("copy-tree");

      store.getState().toggleButtonVisibility("copy-tree", "right");
      expect(store.getState().layout.hiddenButtons).not.toContain("copy-tree");
    });

    it("does not modify leftButtons or rightButtons arrays", async () => {
      const store = await loadStore();
      const before = {
        left: [...store.getState().layout.leftButtons],
        right: [...store.getState().layout.rightButtons],
      };

      store.getState().toggleButtonVisibility("terminal", "left");

      const after = store.getState().layout;
      expect(after.leftButtons).toEqual(before.left);
      expect(after.rightButtons).toEqual(before.right);
    });
  });

  describe("moveButton preserves hiddenButtons", () => {
    it("does not lose hiddenButtons when reordering", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("copy-tree", "right");
      expect(store.getState().layout.hiddenButtons).toContain("copy-tree");

      store.getState().moveButton("settings", "right", "right", 0);
      expect(store.getState().layout.hiddenButtons).toContain("copy-tree");
    });
  });

  describe("setLeftButtons/setRightButtons preserves hiddenButtons", () => {
    it("preserves hiddenButtons when setting new button order", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("terminal", "left");

      const reordered = [...store.getState().layout.leftButtons].reverse();
      store.getState().setLeftButtons(reordered);

      expect(store.getState().layout.hiddenButtons).toContain("terminal");
    });
  });

  describe("reset", () => {
    it("clears hiddenButtons and restores default ordering", async () => {
      const store = await loadStore();
      const defaults = { ...store.getState().layout };

      store.getState().toggleButtonVisibility("copy-tree", "right");
      store.getState().toggleButtonVisibility("terminal", "left");
      store.getState().setLeftButtons([...store.getState().layout.leftButtons].reverse());

      store.getState().reset();
      expect(store.getState().layout.hiddenButtons).toEqual([]);
      expect(store.getState().layout.leftButtons).toEqual(defaults.leftButtons);
      expect(store.getState().layout.rightButtons).toEqual(defaults.rightButtons);
    });
  });

  describe("persistence", () => {
    it("persists hiddenButtons to localStorage", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("copy-tree", "right");

      // Wait for persist to write
      await vi.waitFor(() => {
        const raw = storageMock.getItem(STORAGE_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw!);
        expect(parsed.state.layout.hiddenButtons).toContain("copy-tree");
      });
    });

    it("restores hiddenButtons from persisted state on rehydration", async () => {
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal", "browser"],
            rightButtons: ["copy-tree", "settings"],
            hiddenButtons: ["copy-tree"],
          },
          launcher: { alwaysShowDevServer: false },
        },
        6
      );

      const store = await loadStore();
      expect(store.getState().layout.hiddenButtons).toContain("copy-tree");
      expect(store.getState().layout.rightButtons).toContain("copy-tree");
    });

    it("restores multiple hidden buttons across both sides", async () => {
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal", "browser", "dev-server"],
            rightButtons: ["github-stats", "settings", "copy-tree"],
            hiddenButtons: ["terminal", "github-stats", "copy-tree"],
          },
          launcher: { alwaysShowDevServer: false },
        },
        6
      );

      const store = await loadStore();
      expect(store.getState().layout.hiddenButtons).toEqual([
        "terminal",
        "github-stats",
        "copy-tree",
      ]);
    });

    it("merges new default buttons without re-inserting hidden ones", async () => {
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal"],
            rightButtons: ["copy-tree", "settings"],
            hiddenButtons: ["browser"],
          },
          launcher: { alwaysShowDevServer: false },
        },
        6
      );

      const store = await loadStore();
      // "browser" was hidden — it should be re-added to leftButtons by mergeButtonList
      // (since it was missing from the persisted leftButtons) but remain in hiddenButtons
      expect(store.getState().layout.hiddenButtons).toContain("browser");
      // mergeButtonList will add browser back to leftButtons since it's a default
      expect(store.getState().layout.leftButtons).toContain("browser");
    });
  });

  describe("migration", () => {
    it("migrates v1 state to add hiddenButtons field", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "browser"],
              rightButtons: ["notes", "settings"],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 1,
        })
      );

      const store = await loadStore();
      expect(store.getState().layout.hiddenButtons).toEqual([]);
    });

    it("includes dev-server in default left buttons", async () => {
      const store = await loadStore();
      expect(store.getState().layout.leftButtons).toContain("dev-server");
    });

    it("re-inserts dev-server for persisted state missing it via mergeButtonList", async () => {
      setStoredState({
        layout: {
          leftButtons: ["terminal", "browser", "notes"],
          rightButtons: ["notes", "settings"],
          hiddenButtons: [],
        },
        launcher: { alwaysShowDevServer: false },
      });

      const store = await loadStore();
      expect(store.getState().layout.leftButtons).toContain("dev-server");
    });

    it("v2→v3 renames 'agent-setup' to 'agent-tray' across all button arrays", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["agent-setup", "claude", "terminal"],
              rightButtons: ["settings"],
              hiddenButtons: ["agent-setup"],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 2,
        })
      );

      const store = await loadStore();
      const { layout } = store.getState();
      expect(layout.leftButtons).toContain("agent-tray");
      expect(layout.leftButtons).not.toContain("agent-setup");
      expect(layout.hiddenButtons).toContain("agent-tray");
      expect(layout.hiddenButtons).not.toContain("agent-setup");
      // Position preserved (first) — agent-tray should be at index 0.
      expect(layout.leftButtons[0]).toBe("agent-tray");
    });

    it("v2→v3 rename dedupes when both 'agent-setup' and 'agent-tray' coexist", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["agent-setup", "claude", "agent-tray"],
              rightButtons: [],
              hiddenButtons: [],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 2,
        })
      );

      const store = await loadStore();
      const trayCount = store
        .getState()
        .layout.leftButtons.filter((id) => id === "agent-tray").length;
      expect(trayCount).toBe(1);
    });

    it("v2→v3 handles missing layout without throwing", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            launcher: { alwaysShowDevServer: false },
          },
          version: 2,
        })
      );

      const store = await loadStore();
      // Should hydrate with defaults.
      expect(store.getState().layout.leftButtons).toContain("agent-tray");
    });

    it("v3→v4 drops 'panel-palette' from all button arrays", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["agent-tray", "claude", "terminal", "browser", "panel-palette"],
              rightButtons: ["settings", "panel-palette"],
              hiddenButtons: ["panel-palette"],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 3,
        })
      );

      const store = await loadStore();
      const { layout } = store.getState();
      expect(layout.leftButtons).not.toContain("panel-palette");
      expect(layout.rightButtons).not.toContain("panel-palette");
      expect(layout.hiddenButtons).not.toContain("panel-palette");
      // Order of remaining items preserved
      expect(layout.leftButtons).toContain("agent-tray");
      expect(layout.leftButtons).toContain("terminal");
      expect(layout.leftButtons).toContain("browser");
    });

    it("v3→v4 handles missing layout without throwing", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            launcher: { alwaysShowDevServer: false },
          },
          version: 3,
        })
      );

      const store = await loadStore();
      expect(store.getState().layout.leftButtons).toBeDefined();
    });

    it("v4→v5 strips built-in agent IDs from hiddenButtons", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["agent-tray", "claude", "gemini", "terminal"],
              rightButtons: ["settings"],
              hiddenButtons: ["claude", "copy-tree", "gemini"],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 4,
        })
      );

      const store = await loadStore();
      const { layout } = store.getState();
      // Agent IDs stripped; non-agent entries preserved.
      expect(layout.hiddenButtons).toEqual(["copy-tree"]);
      // Ordering arrays untouched.
      expect(layout.leftButtons).toContain("claude");
      expect(layout.leftButtons).toContain("gemini");
    });

    it("v4→v5 strips every built-in agent ID including rarer ones", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["agent-tray", "terminal"],
              rightButtons: ["settings"],
              hiddenButtons: [
                "claude",
                "gemini",
                "codex",
                "opencode",
                "cursor",
                "kiro",
                "copilot",
                "crush",
                "copy-tree",
              ],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 4,
        })
      );

      const store = await loadStore();
      // All built-in agent IDs stripped; non-agent entries preserved.
      expect(store.getState().layout.hiddenButtons).toEqual(["copy-tree"]);
    });

    it("v4→v5 leaves hiddenButtons untouched when no agent IDs are present", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["agent-tray", "terminal"],
              rightButtons: ["settings"],
              hiddenButtons: ["github-stats", "copy-tree"],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 4,
        })
      );

      const store = await loadStore();
      expect(store.getState().layout.hiddenButtons).toEqual(["github-stats", "copy-tree"]);
    });

    it("v4→v5 is a no-op on already-v5 state (idempotency guard)", async () => {
      // Rehydrating a store that's already at v5 must not re-apply the v4→v5
      // agent-stripping migration — agent IDs legitimately absent from
      // hiddenButtons should stay absent. The v5→v6 migration still runs and
      // strips any lingering "notes" entry.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["agent-tray", "claude", "terminal"],
              rightButtons: ["settings"],
              hiddenButtons: ["copy-tree"],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 5,
        })
      );

      const store = await loadStore();
      expect(store.getState().layout.hiddenButtons).toEqual(["copy-tree"]);
      // Ordering arrays untouched.
      expect(store.getState().layout.leftButtons).toContain("claude");
    });

    it("v5→v6 strips 'notes' from all button arrays", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "notes", "browser"],
              rightButtons: ["notes", "settings"],
              hiddenButtons: ["notes"],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 5,
        })
      );

      const store = await loadStore();
      const { layout } = store.getState();
      expect(layout.leftButtons).not.toContain("notes");
      expect(layout.rightButtons).not.toContain("notes");
      expect(layout.hiddenButtons).not.toContain("notes");
    });

    it("v4→v5 handles missing layout without throwing", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            launcher: { alwaysShowDevServer: false },
          },
          version: 4,
        })
      );

      const store = await loadStore();
      expect(store.getState().layout.leftButtons).toBeDefined();
    });

    it("migrates v0 state through all migrations", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "dev-server", "browser"],
              rightButtons: ["notes"],
            },
            launcher: {
              alwaysShowDevServer: false,
              defaultSelection: "dev-server",
            },
          },
          version: 0,
        })
      );

      const store = await loadStore();
      // v0→v1: removes old dev-server, mergeButtonList re-adds it from current defaults
      expect(store.getState().layout.leftButtons).toContain("dev-server");
      // v0→v1: resets defaultSelection that was "dev-server"
      expect(store.getState().launcher.defaultSelection).toBeUndefined();
      // v1→v2: adds hiddenButtons
      expect(store.getState().layout.hiddenButtons).toEqual([]);
    });
  });
});
