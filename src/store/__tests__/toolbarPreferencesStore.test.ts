// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/config/agentIds", () => ({
  BUILT_IN_AGENT_IDS: ["claude", "gemini", "codex", "opencode", "cursor"] as const,
}));

let useToolbarPreferencesStore: typeof import("../toolbarPreferencesStore").useToolbarPreferencesStore;

const STORAGE_KEY = "canopy-toolbar-preferences";

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
      expect(layout.rightButtons).toContain("notes");
      expect(layout.hiddenButtons).not.toContain("notes");

      store.getState().toggleButtonVisibility("notes", "right");

      const updated = store.getState();
      expect(updated.layout.hiddenButtons).toContain("notes");
      expect(updated.layout.rightButtons).toContain("notes");
    });

    it("removes button from hiddenButtons when toggled again", async () => {
      const store = await loadStore();

      store.getState().toggleButtonVisibility("notes", "right");
      expect(store.getState().layout.hiddenButtons).toContain("notes");

      store.getState().toggleButtonVisibility("notes", "right");
      expect(store.getState().layout.hiddenButtons).not.toContain("notes");
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
      store.getState().toggleButtonVisibility("notes", "right");
      expect(store.getState().layout.hiddenButtons).toContain("notes");

      store.getState().moveButton("settings", "right", "right", 0);
      expect(store.getState().layout.hiddenButtons).toContain("notes");
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

      store.getState().toggleButtonVisibility("notes", "right");
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
      store.getState().toggleButtonVisibility("notes", "right");

      // Wait for persist to write
      await vi.waitFor(() => {
        const raw = storageMock.getItem(STORAGE_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw!);
        expect(parsed.state.layout.hiddenButtons).toContain("notes");
      });
    });

    it("restores hiddenButtons from persisted state on rehydration", async () => {
      setStoredState({
        layout: {
          leftButtons: ["terminal", "browser"],
          rightButtons: ["notes", "settings"],
          hiddenButtons: ["notes"],
        },
        launcher: { alwaysShowDevServer: false },
      });

      const store = await loadStore();
      expect(store.getState().layout.hiddenButtons).toContain("notes");
      expect(store.getState().layout.rightButtons).toContain("notes");
    });

    it("restores multiple hidden buttons across both sides", async () => {
      setStoredState({
        layout: {
          leftButtons: ["terminal", "browser", "panel-palette"],
          rightButtons: ["notes", "settings", "copy-tree"],
          hiddenButtons: ["terminal", "notes", "copy-tree"],
        },
        launcher: { alwaysShowDevServer: false },
      });

      const store = await loadStore();
      expect(store.getState().layout.hiddenButtons).toEqual(["terminal", "notes", "copy-tree"]);
    });

    it("merges new default buttons without re-inserting hidden ones", async () => {
      setStoredState({
        layout: {
          leftButtons: ["terminal"],
          rightButtons: ["notes", "settings"],
          hiddenButtons: ["browser"],
        },
        launcher: { alwaysShowDevServer: false },
      });

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

    it("migrates v0 state through both migrations", async () => {
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
      // v0→v1: removes dev-server
      expect(store.getState().layout.leftButtons).not.toContain("dev-server");
      // v1→v2: adds hiddenButtons
      expect(store.getState().layout.hiddenButtons).toEqual([]);
    });
  });
});
