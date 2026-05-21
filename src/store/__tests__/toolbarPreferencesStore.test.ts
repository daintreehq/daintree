// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";

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
    "amp",
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
    it("hides button via pinnedButtons map without removing from ordering array", async () => {
      const store = await loadStore();
      const { layout } = store.getState();
      expect(layout.rightButtons).toContain("copy-tree");
      expect(layout.pinnedButtons["copy-tree"]).toBeUndefined();

      store.getState().toggleButtonVisibility("copy-tree", "right");

      const updated = store.getState();
      expect(updated.layout.pinnedButtons["copy-tree"]).toBe(false);
      expect(updated.layout.rightButtons).toContain("copy-tree");
    });

    it("removes button from pinnedButtons when toggled again", async () => {
      const store = await loadStore();

      store.getState().toggleButtonVisibility("copy-tree", "right");
      expect(store.getState().layout.pinnedButtons["copy-tree"]).toBe(false);

      store.getState().toggleButtonVisibility("copy-tree", "right");
      expect(store.getState().layout.pinnedButtons["copy-tree"]).toBeUndefined();
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

    it("round-trips a pre-seeded `pinnedButtons[id] = true` through false → undefined", async () => {
      // Seeds the forward-compat case where a downgrade-then-upgrade or a
      // future explicit-pin write leaves `true` in the map — the toggle must
      // still flip cleanly to `false` and then to omission.
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal"],
            rightButtons: ["settings"],
            pinnedButtons: { terminal: true },
          },
          launcher: { alwaysShowDevServer: false },
        },
        8
      );

      const store = await loadStore();
      expect(store.getState().layout.pinnedButtons["terminal"]).toBe(true);

      store.getState().toggleButtonVisibility("terminal", "left");
      expect(store.getState().layout.pinnedButtons["terminal"]).toBe(false);

      store.getState().toggleButtonVisibility("terminal", "left");
      expect(store.getState().layout.pinnedButtons["terminal"]).toBeUndefined();
    });

    it("does not mutate launcher.defaultSelection when toggling a plugin button", async () => {
      const store = await loadStore();
      store.getState().setDefaultSelection("terminal");
      const before = store.getState().launcher.defaultSelection;

      store.getState().toggleButtonVisibility("plugin.acme.foo" as AnyToolbarButtonId, "right");

      expect(store.getState().launcher.defaultSelection).toBe(before);
      expect(store.getState().layout.pinnedButtons["plugin.acme.foo"]).toBe(false);
    });
  });

  describe("sweepStalePluginPinnedButtons", () => {
    it("removes plugin entries absent from the valid id set", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("plugin.acme.old" as AnyToolbarButtonId, "right");
      store.getState().toggleButtonVisibility("plugin.acme.active" as AnyToolbarButtonId, "right");

      store.getState().sweepStalePluginPinnedButtons(["plugin.acme.active"]);

      const { pinnedButtons } = store.getState().layout;
      expect(pinnedButtons["plugin.acme.old"]).toBeUndefined();
      expect(pinnedButtons["plugin.acme.active"]).toBe(false);
    });

    it("never touches built-in (non-plugin) keys", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("copy-tree", "right");
      store.getState().toggleButtonVisibility("plugin.acme.gone" as AnyToolbarButtonId, "right");

      store.getState().sweepStalePluginPinnedButtons([]);

      const { pinnedButtons } = store.getState().layout;
      expect(pinnedButtons["copy-tree"]).toBe(false);
      expect(pinnedButtons["plugin.acme.gone"]).toBeUndefined();
    });

    it("is a no-op (preserves layout reference) when nothing is stale", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("copy-tree", "right");
      const layoutBefore = store.getState().layout;

      store.getState().sweepStalePluginPinnedButtons([]);

      expect(store.getState().layout).toBe(layoutBefore);
    });
  });

  describe("moveButton preserves pinnedButtons", () => {
    it("does not lose pinnedButtons when reordering", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("copy-tree", "right");
      expect(store.getState().layout.pinnedButtons["copy-tree"]).toBe(false);

      store.getState().moveButton("settings", "right", "right", 0);
      expect(store.getState().layout.pinnedButtons["copy-tree"]).toBe(false);
    });
  });

  describe("setLeftButtons/setRightButtons preserves pinnedButtons", () => {
    it("preserves pinnedButtons when setting new button order", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("terminal", "left");

      const reordered = [...store.getState().layout.leftButtons].reverse();
      store.getState().setLeftButtons(reordered);

      expect(store.getState().layout.pinnedButtons["terminal"]).toBe(false);
    });
  });

  describe("reset", () => {
    it("clears pinnedButtons and restores default ordering", async () => {
      const store = await loadStore();
      const defaults = { ...store.getState().layout };

      store.getState().toggleButtonVisibility("copy-tree", "right");
      store.getState().toggleButtonVisibility("terminal", "left");
      store.getState().setLeftButtons([...store.getState().layout.leftButtons].reverse());

      store.getState().reset();
      expect(store.getState().layout.pinnedButtons).toEqual({});
      expect(store.getState().layout.leftButtons).toEqual(defaults.leftButtons);
      expect(store.getState().layout.rightButtons).toEqual(defaults.rightButtons);
    });
  });

  describe("persistence", () => {
    it("persists pinnedButtons to localStorage", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("copy-tree", "right");

      // Wait for persist to write
      await vi.waitFor(() => {
        const raw = storageMock.getItem(STORAGE_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw!);
        expect(parsed.state.layout.pinnedButtons["copy-tree"]).toBe(false);
      });
    });

    it("restores hiddenButtons from persisted v6 state on rehydration", async () => {
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
      // v7→v8 converts hiddenButtons to pinnedButtons.
      expect(store.getState().layout.pinnedButtons["copy-tree"]).toBe(false);
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
      expect(store.getState().layout.pinnedButtons).toEqual({
        terminal: false,
        "github-stats": false,
        "copy-tree": false,
      });
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
      // (since it was missing from the persisted leftButtons) but its hide-state
      // is preserved as `pinnedButtons.browser === false`.
      expect(store.getState().layout.pinnedButtons["browser"]).toBe(false);
      // mergeButtonList will add browser back to leftButtons since it's a default
      expect(store.getState().layout.leftButtons).toContain("browser");
    });
  });

  describe("migration", () => {
    it("migrates v1 state through the v7→v8 conversion to pinnedButtons", async () => {
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
      expect(store.getState().layout.pinnedButtons).toEqual({});
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
      // The v3 rename moved agent-setup → agent-tray inside hiddenButtons; the
      // v8 migration then translates that to a pinnedButtons entry.
      expect(layout.pinnedButtons["agent-tray"]).toBe(false);
      expect((layout.pinnedButtons as Record<string, boolean>)["agent-setup"]).toBeUndefined();
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
      // panel-palette gets stripped before v8 reads hiddenButtons, so no
      // pinnedButtons entry should be created for it.
      expect((layout.pinnedButtons as Record<string, boolean>)["panel-palette"]).toBeUndefined();
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

    it("v4→v5 strips built-in agent IDs from hiddenButtons before v8 conversion", async () => {
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
      // Agent IDs stripped at v5, then v8 converts the remainder to a map.
      expect(layout.pinnedButtons).toEqual({ "copy-tree": false });
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
                "amp",
                "copy-tree",
              ],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 4,
        })
      );

      const store = await loadStore();
      // All built-in agent IDs stripped; non-agent entry survives into pinnedButtons.
      expect(store.getState().layout.pinnedButtons).toEqual({ "copy-tree": false });
    });

    it("v4→v5 leaves non-agent hidden entries untouched into pinnedButtons", async () => {
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
      expect(store.getState().layout.pinnedButtons).toEqual({
        "github-stats": false,
        "copy-tree": false,
      });
    });

    it("v4→v5 is a no-op on already-v5 state (idempotency guard)", async () => {
      // Rehydrating a store that's already at v5 must not re-apply the v4→v5
      // agent-stripping migration — agent IDs legitimately absent from
      // hiddenButtons should stay absent. The v5→v6 strips notes; v7→v8
      // converts the remainder to pinnedButtons.
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
      expect(store.getState().layout.pinnedButtons).toEqual({ "copy-tree": false });
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
      // v6 removes notes before v8 reads it — no pinnedButtons entry created.
      expect((layout.pinnedButtons as Record<string, boolean>)["notes"]).toBeUndefined();
    });

    it("v6→v7 strips 'assistant-toggle' from all button arrays", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "assistant-toggle", "browser"],
              rightButtons: ["assistant-toggle", "settings"],
              hiddenButtons: ["assistant-toggle"],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 6,
        })
      );

      const store = await loadStore();
      const { layout } = store.getState();
      expect(layout.leftButtons).not.toContain("assistant-toggle");
      expect(layout.rightButtons).not.toContain("assistant-toggle");
      // v7 removes assistant-toggle before v8 reads it — no pinnedButtons entry.
      expect(layout.pinnedButtons["assistant-toggle"]).toBeUndefined();
    });

    it("v6→v7 is idempotent on state already lacking assistant-toggle", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "browser"],
              rightButtons: ["settings"],
              hiddenButtons: [],
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 6,
        })
      );

      const store = await loadStore();
      const { layout } = store.getState();
      expect(layout.leftButtons).toContain("terminal");
      expect(layout.leftButtons).toContain("browser");
      expect(layout.rightButtons).toContain("settings");
      expect(layout.pinnedButtons).toEqual({});
    });

    it("sanitizeButtonList strips assistant-toggle when set via setRightButtons", async () => {
      const store = await loadStore();

      store.getState().setRightButtons(["settings", "assistant-toggle" as never, "copy-tree"]);

      const { layout } = store.getState();
      expect(layout.rightButtons).not.toContain("assistant-toggle");
      expect(layout.rightButtons).toContain("settings");
      expect(layout.rightButtons).toContain("copy-tree");
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
      // v7→v8: replaces the hiddenButtons array with the pinnedButtons map.
      expect(store.getState().layout.pinnedButtons).toEqual({});
    });

    describe("v7→v8 hiddenButtons → pinnedButtons", () => {
      it("converts a v7 hiddenButtons array to a pinnedButtons map of false entries", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["agent-tray", "terminal", "browser"],
                rightButtons: ["copy-tree", "settings"],
                hiddenButtons: ["terminal", "copy-tree"],
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 7,
          })
        );

        const store = await loadStore();
        const { layout } = store.getState();
        expect(layout.pinnedButtons).toEqual({
          terminal: false,
          "copy-tree": false,
        });
        // The hidden array is dropped from the canonical shape.
        expect((layout as unknown as { hiddenButtons?: unknown }).hiddenButtons).toBeUndefined();
        // Ordering arrays untouched.
        expect(layout.leftButtons).toContain("terminal");
        expect(layout.rightButtons).toContain("copy-tree");
      });

      it("yields an empty pinnedButtons map when v7 had no hiddenButtons entries", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal"],
                rightButtons: ["settings"],
                hiddenButtons: [],
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 7,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons).toEqual({});
      });

      it("synthesizes a v8 layout shape when v7 state lacks the layout block", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: { launcher: { alwaysShowDevServer: false } },
            version: 7,
          })
        );

        const store = await loadStore();
        // merge() should fall back to defaults rather than crash; pinnedButtons
        // must still be the canonical empty map.
        expect(store.getState().layout.pinnedButtons).toEqual({});
        expect(store.getState().layout.leftButtons).toBeDefined();
      });

      it("preserves an existing pinnedButtons map and merges v7 hiddenButtons on top", async () => {
        // Forward-compat: a payload that's nominally v7 but already carries a
        // pinnedButtons map (e.g. a downgrade-then-upgrade path) shouldn't lose
        // explicit entries.
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal"],
                rightButtons: ["settings", "copy-tree"],
                hiddenButtons: ["copy-tree"],
                pinnedButtons: { terminal: true },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 7,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons).toEqual({
          terminal: true,
          "copy-tree": false,
        });
      });

      it("is idempotent on v8 state without re-applying conversion", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "browser"],
                rightButtons: ["copy-tree", "settings"],
                pinnedButtons: { "copy-tree": false },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 8,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons).toEqual({ "copy-tree": false });
      });
    });
  });
});
