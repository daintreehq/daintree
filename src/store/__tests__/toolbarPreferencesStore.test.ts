// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyToolbarButtonId, PluginToolbarButtonId } from "@/../../shared/types/toolbar";
import { TOOLBAR_BUTTON_PRIORITIES } from "@shared/types/toolbar";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";

// Mirror the production agent IDs so the v5 migration is exercised against
// the real set, not a subset. Keeping the mock in sync guards against
// regressions when new built-in agents ship.
vi.mock("@shared/config/agentIds", () => {
  const BUILT_IN_AGENT_IDS = [
    "claude",
    "opencode",
    "aider",
    "gemini",
    "antigravity",
    "codex",
    "cursor",
    "copilot",
    "goose",
    "amp",
    "crush",
    "qwen",
    "kimi",
    "interpreter",
    "mistral",
    "kiro",
    "daintree-assistant",
  ] as const;
  const ASSISTANT_ONLY_AGENT_IDS = ["daintree-assistant"] as const;
  const LAUNCHABLE_AGENT_IDS = BUILT_IN_AGENT_IDS.filter(
    (id) => !(ASSISTANT_ONLY_AGENT_IDS as readonly string[]).includes(id)
  );
  return {
    BUILT_IN_AGENT_IDS,
    ASSISTANT_ONLY_AGENT_IDS,
    LAUNCHABLE_AGENT_IDS,
    isAssistantOnlyAgentId: (
      value: unknown
    ): value is (typeof ASSISTANT_ONLY_AGENT_IDS)[number] => {
      return (
        typeof value === "string" && (ASSISTANT_ONLY_AGENT_IDS as readonly string[]).includes(value)
      );
    },
  };
});

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

// The cases below compare `pinnedButtons` directly. They used to route through a
// `pinsWithoutShippedHides()` filter that stripped the `file-browser: false`
// seed v12 stamped onto every profile; v13 removed that seed and the store no
// longer ships any hidden built-in, so there is nothing left to filter out
// (#11667). An empty map is now the correct expectation everywhere.

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

      store.getState().toggleButtonVisibility("acme.foo.btn" as AnyToolbarButtonId, "right");

      expect(store.getState().launcher.defaultSelection).toBe(before);
      expect(store.getState().layout.pinnedButtons["acme.foo.btn"]).toBe(false);
    });
  });

  describe("setPluginButtonPromoted (#11304)", () => {
    const pluginButton = "acme.foo.btn" as PluginToolbarButtonId;

    it("persists an explicit true, which toggleButtonVisibility can never write", async () => {
      const store = await loadStore();
      // The distinction is load-bearing: under tray-default only `true` grants
      // a top-level slot, and the generic toggle records hides, never pins.
      store.getState().toggleButtonVisibility(pluginButton, "right");
      expect(store.getState().layout.pinnedButtons[pluginButton]).toBe(false);

      store.getState().setPluginButtonPromoted(pluginButton, true);
      expect(store.getState().layout.pinnedButtons[pluginButton]).toBe(true);
    });

    it("demotes by deleting the key, clearing a legacy hide entry too", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility(pluginButton, "right");

      store.getState().setPluginButtonPromoted(pluginButton, false);

      expect(store.getState().layout.pinnedButtons).not.toHaveProperty(pluginButton);
    });

    it("leaves the ordering arrays and launcher state alone", async () => {
      const store = await loadStore();
      store.getState().setDefaultSelection("terminal");
      const before = {
        left: [...store.getState().layout.leftButtons],
        right: [...store.getState().layout.rightButtons],
        selection: store.getState().launcher.defaultSelection,
      };

      store.getState().setPluginButtonPromoted(pluginButton, true);

      const after = store.getState();
      expect(after.layout.leftButtons).toEqual(before.left);
      expect(after.layout.rightButtons).toEqual(before.right);
      expect(after.launcher.defaultSelection).toBe(before.selection);
    });

    it("round-trips a promotion through storage so it survives a reload", async () => {
      // In-memory state alone would stay green through a `partialize` or
      // `merge` regression that drops the promotion on rehydration.
      const store = await loadStore();
      store.getState().setPluginButtonPromoted(pluginButton, true);

      vi.resetModules();
      const reloaded = await loadStore();
      expect(reloaded.getState().layout.pinnedButtons[pluginButton]).toBe(true);

      reloaded.getState().setPluginButtonPromoted(pluginButton, false);
      vi.resetModules();
      const afterDemote = await loadStore();
      expect(afterDemote.getState().layout.pinnedButtons).not.toHaveProperty(pluginButton);
    });

    it("is a no-op (preserves layout reference) when the state already matches", async () => {
      const store = await loadStore();
      store.getState().setPluginButtonPromoted(pluginButton, true);
      const layoutBefore = store.getState().layout;

      store.getState().setPluginButtonPromoted(pluginButton, true);
      expect(store.getState().layout).toBe(layoutBefore);

      // Demoting an already-absent key must not churn the persist layer either.
      store.getState().setPluginButtonPromoted("acme.foo.never" as PluginToolbarButtonId, false);
      expect(store.getState().layout).toBe(layoutBefore);
    });

    it("survives the stale sweep so a plugin update or disable cycle keeps the placement", async () => {
      // `unloadPlugin` broadcasts `complete: true` for an update and for
      // disable/re-enable, not just an uninstall — sweeping promotions would
      // silently undo the user's placement on every plugin update.
      const store = await loadStore();
      store.getState().setPluginButtonPromoted(pluginButton, true);

      store.getState().sweepStalePluginPinnedButtons([]);

      expect(store.getState().layout.pinnedButtons[pluginButton]).toBe(true);
    });

    it("still lets the sweep reclaim a stale hide entry alongside a kept promotion", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("acme.foo.hidden" as AnyToolbarButtonId, "right");
      store.getState().setPluginButtonPromoted(pluginButton, true);

      store.getState().sweepStalePluginPinnedButtons([]);

      const { pinnedButtons } = store.getState().layout;
      expect(pinnedButtons).not.toHaveProperty("acme.foo.hidden");
      expect(pinnedButtons[pluginButton]).toBe(true);
    });
  });

  describe("plugin-tray default placement (#11304)", () => {
    it("reaches an existing profile through merge, so no migration is needed", async () => {
      // The tray is a new built-in id, and `mergeButtonList` inserts defaults
      // the persisted list predates — proving the upgrade path without a v12.
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal"],
            rightButtons: ["settings"],
            pinnedButtons: {},
          },
          launcher: { alwaysShowDevServer: false },
        },
        11
      );

      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      // Right side specifically — a combined check would pass even if the
      // tray were inserted on the wrong side.
      expect(rightButtons).toContain("plugin-tray");
      expect(leftButtons).not.toContain("plugin-tray");
      expect(rightButtons).toContain("settings");
    });
  });

  describe("sweepStalePluginPinnedButtons", () => {
    it("removes plugin entries absent from the valid id set", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("acme.foo.old" as AnyToolbarButtonId, "right");
      store.getState().toggleButtonVisibility("acme.foo.active" as AnyToolbarButtonId, "right");

      store.getState().sweepStalePluginPinnedButtons(["acme.foo.active"]);

      const { pinnedButtons } = store.getState().layout;
      expect(pinnedButtons["acme.foo.old"]).toBeUndefined();
      expect(pinnedButtons["acme.foo.active"]).toBe(false);
    });

    it("never touches built-in (non-plugin) keys", async () => {
      const store = await loadStore();
      store.getState().toggleButtonVisibility("copy-tree", "right");
      store.getState().toggleButtonVisibility("acme.foo.gone" as AnyToolbarButtonId, "right");

      store.getState().sweepStalePluginPinnedButtons([]);

      const { pinnedButtons } = store.getState().layout;
      expect(pinnedButtons["copy-tree"]).toBe(false);
      expect(pinnedButtons["acme.foo.gone"]).toBeUndefined();
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
      // v9→v10 renames "github-stats" to "forge-stats" after the v8 conversion.
      expect(store.getState().layout.pinnedButtons).toEqual({
        terminal: false,
        "forge-stats": false,
        "copy-tree": false,
      });
    });

    it("preserves a hidden button's pin state without giving it a position back", async () => {
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
      // The v7→v8 conversion still translates the old `hiddenButtons` entry into
      // an explicit `false`.
      expect(store.getState().layout.pinnedButtons["browser"]).toBe(false);
      // But `browser` left the defaults in v13 (#11667), so `mergeButtonList`
      // has nothing to re-insert — the id is simply absent from this profile.
      expect(store.getState().layout.leftButtons).not.toContain("browser");
    });

    it("keeps browser and dev-server positioned when a profile already carries them", async () => {
      // The invariant the whole #11667 migration policy rests on: dropping the
      // two from `DEFAULT_LEFT_BUTTONS` must not evict them from a profile that
      // has them, because array membership is the only thing distinguishing an
      // existing toolbar from a fresh one.
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal", "browser", "file-browser", "dev-server"],
            rightButtons: ["settings"],
            pinnedButtons: {},
          },
          launcher: { alwaysShowDevServer: false },
        },
        12
      );

      const store = await loadStore();
      const { leftButtons, pinnedButtons } = store.getState().layout;
      // Relative order preserved, not merely membership: `mergeButtonList` takes
      // the persisted list verbatim and only inserts what's missing, so an
      // existing toolbar must come through with its own arrangement intact.
      // Filtered to the carried ids rather than compared whole — hydration also
      // inserts `launcher`, which this case is not about.
      const carried = ["terminal", "browser", "file-browser", "dev-server"];
      expect(leftButtons.filter((id) => carried.includes(id))).toEqual(carried);
      // The whole map, not two lookups: nothing at all may be written for a
      // profile that expressed no overrides.
      expect(pinnedButtons).toEqual({});
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

    it("omits browser and dev-server from default left buttons but keeps the ids valid", async () => {
      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      // Both moved into the launcher for fresh profiles (#11667). They are not
      // deleted ids — `TOOLBAR_BUTTON_PRIORITIES` and the metadata registry
      // still carry them — they simply aren't defaults any more.
      expect(leftButtons).not.toContain("browser");
      expect(leftButtons).not.toContain("dev-server");
      expect(rightButtons).not.toContain("browser");
      expect(rightButtons).not.toContain("dev-server");
      expect(leftButtons).toContain("launcher");
    });

    it("omits every agent id from default left buttons but keeps the ids valid", async () => {
      // The other half of #11680: an unset agent pin means "listed in the
      // launcher", not "on the toolbar", so a fresh row grows nothing when the
      // user installs another CLI. Same shape as browser/dev-server above —
      // absence from the defaults, never a seeded pin.
      const store = await loadStore();
      const { leftButtons, rightButtons, pinnedButtons } = store.getState().layout;
      const positioned = new Set([...leftButtons, ...rightButtons]);
      for (const id of LAUNCHABLE_AGENT_IDS) {
        expect(positioned.has(id)).toBe(false);
        expect(pinnedButtons[id]).toBeUndefined();
      }
      expect(TOOLBAR_BUTTON_PRIORITIES[LAUNCHABLE_AGENT_IDS[0]!]).toBeDefined();
    });

    it("leads the left group with the launcher", async () => {
      // A permanent category container belongs at the start of the group it
      // owns, so the row reads verb-then-nouns.
      const store = await loadStore();
      expect(store.getState().layout.leftButtons[0]).toBe("launcher");
    });

    it("includes command-palette in default right buttons before settings", async () => {
      const store = await loadStore();
      const right = store.getState().layout.rightButtons;
      expect(right).toContain("command-palette");
      expect(right.indexOf("command-palette")).toBeLessThan(right.indexOf("settings"));
    });

    it("includes resume-sessions in default right buttons before settings", async () => {
      const store = await loadStore();
      const right = store.getState().layout.rightButtons;
      expect(right).toContain("resume-sessions");
      expect(right.indexOf("resume-sessions")).toBeLessThan(right.indexOf("settings"));
    });

    it("re-inserts resume-sessions for persisted state missing it via mergeButtonList", async () => {
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal", "browser"],
            rightButtons: ["copy-tree", "command-palette", "settings"],
            pinnedButtons: {},
          },
          launcher: { alwaysShowDevServer: false },
        },
        10
      );

      const store = await loadStore();
      const right = store.getState().layout.rightButtons;
      expect(right).toContain("resume-sessions");
      // Visibility preserved (not implicitly hidden) for the newly added default.
      expect(store.getState().layout.pinnedButtons["resume-sessions"]).toBeUndefined();
    });

    it("re-inserts command-palette for persisted state missing it via mergeButtonList", async () => {
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal", "browser"],
            rightButtons: ["copy-tree", "settings"],
            hiddenButtons: [],
          },
          launcher: { alwaysShowDevServer: false },
        },
        7
      );

      const store = await loadStore();
      const right = store.getState().layout.rightButtons;
      expect(right).toContain("command-palette");
      // Visibility preserved (not implicitly hidden).
      expect(store.getState().layout.pinnedButtons["command-palette"]).toBeUndefined();
    });

    it("preserves a hidden command-palette across v7→v8 migration when re-inserted by mergeButtonList", async () => {
      // Defends the case where an early-adopter persisted state already hid
      // the command-palette button before this feature shipped its current
      // shape: the ordering array should still be auto-populated from
      // defaults, but the explicit hide must round-trip into the
      // pinnedButtons map.
      setStoredState(
        {
          layout: {
            leftButtons: ["terminal", "browser"],
            rightButtons: ["copy-tree", "settings"],
            hiddenButtons: ["command-palette"],
          },
          launcher: { alwaysShowDevServer: false },
        },
        7
      );

      const store = await loadStore();
      const { layout } = store.getState();
      expect(layout.rightButtons).toContain("command-palette");
      expect(layout.pinnedButtons["command-palette"]).toBe(false);
    });

    it("re-inserts a still-defaulted button for persisted state missing it via mergeButtonList", async () => {
      setStoredState({
        layout: {
          leftButtons: ["terminal", "browser", "notes"],
          rightButtons: ["notes", "settings"],
          hiddenButtons: [],
        },
        launcher: { alwaysShowDevServer: false },
      });

      const store = await loadStore();
      // `file-browser` stands in for what `dev-server` used to prove here: a
      // default missing from the persisted list gets inserted on hydration.
      // `dev-server` can no longer make the point — it left the defaults in v13.
      expect(store.getState().layout.leftButtons).toContain("file-browser");
      expect(store.getState().layout.leftButtons).not.toContain("dev-server");
    });

    it("v2→v3 renames 'agent-setup' to the tray id, which v14 carries onto the launcher", async () => {
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
      expect(layout.leftButtons).toContain("launcher");
      expect(layout.leftButtons).not.toContain("agent-setup");
      expect(layout.leftButtons).not.toContain("agent-tray");
      // The v3 rename moved agent-setup → agent-tray inside hiddenButtons and v8
      // translated that to a `false`. v14 then merges the two tray pins by union:
      // this profile never hid a panel tray, so the combined launcher stays
      // visible and no key survives. Hiding one of two access points must not
      // hide the one button that replaced both.
      expect(layout.pinnedButtons["launcher"]).toBeUndefined();
      expect((layout.pinnedButtons as Record<string, boolean>)["agent-tray"]).toBeUndefined();
      expect((layout.pinnedButtons as Record<string, boolean>)["agent-setup"]).toBeUndefined();
      // Position preserved through both renames — still index 0.
      expect(layout.leftButtons[0]).toBe("launcher");
    });

    it("v2→v3 rename dedupes when both 'agent-setup' and the tray id coexist", async () => {
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
        .layout.leftButtons.filter((id) => id === "launcher").length;
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
      expect(store.getState().layout.leftButtons).toContain("launcher");
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
      expect(layout.leftButtons).toContain("launcher");
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
      expect(store.getState().layout.pinnedButtons).toEqual({
        "copy-tree": false,
      });
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
        "forge-stats": false,
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
      expect(store.getState().layout.pinnedButtons).toEqual({
        "copy-tree": false,
      });
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

    it("sanitizeButtonList dedupes repeated ids when set via setRightButtons (#10937)", async () => {
      const store = await loadStore();

      store.getState().setRightButtons(["settings", "forge-stats", "forge-stats", "copy-tree"]);

      const { rightButtons } = store.getState().layout;
      expect(rightButtons.filter((id) => id === "forge-stats")).toHaveLength(1);
      // Non-duplicated ids all survive, in first-occurrence order.
      expect(rightButtons).toContain("copy-tree");
      expect(rightButtons.indexOf("settings")).toBeLessThan(rightButtons.indexOf("forge-stats"));
      expect(rightButtons.indexOf("forge-stats")).toBeLessThan(rightButtons.indexOf("copy-tree"));
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
      // v0→v1 strips the old `dev-server` entry, and since v13 the current
      // defaults no longer undo that — the removal finally sticks. This
      // assertion used to read `toContain`, which only passed because
      // `mergeButtonList` re-added what v0→v1 had just removed (#11667).
      expect(store.getState().layout.leftButtons).not.toContain("dev-server");
      // `browser` was never touched by v0→v1, and dropping it from the defaults
      // doesn't evict it from a profile that carries it.
      expect(store.getState().layout.leftButtons).toContain("browser");
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
        expect(store.getState().layout.pinnedButtons).toEqual({
          "copy-tree": false,
        });
      });
    });

    describe("v8→v9 plugin toolbar id rename (#9281)", () => {
      it("renames `plugin.{pluginId}.{btn}` pinned keys to canonical `{pluginId}.{btn}`", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal"],
                rightButtons: ["settings"],
                pinnedButtons: {
                  "plugin.acme.foo.btn": false,
                  "plugin.daintreehq.tool.opener": false,
                  "copy-tree": false,
                },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 8,
          })
        );

        const store = await loadStore();
        const { pinnedButtons } = store.getState().layout;
        expect(pinnedButtons["acme.foo.btn"]).toBe(false);
        expect(pinnedButtons["daintreehq.tool.opener"]).toBe(false);
        expect(pinnedButtons["copy-tree"]).toBe(false);
        expect(pinnedButtons["plugin.acme.foo.btn"]).toBeUndefined();
        expect(pinnedButtons["plugin.daintreehq.tool.opener"]).toBeUndefined();
      });

      it("is a no-op when there are no `plugin.` prefixed keys", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal"],
                rightButtons: ["settings"],
                pinnedButtons: { "copy-tree": false, terminal: false },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 8,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons).toEqual({
          "copy-tree": false,
          terminal: false,
        });
      });

      it("renames `plugin.{pluginId}.{btn}` entries in leftButtons/rightButtons", async () => {
        // Users who drag-and-dropped plugin toolbar buttons into a fixed
        // slot had the old-form id stored in the position arrays. Without
        // renaming, those become dangling references after the namespace
        // change.
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "plugin.acme.foo.btn", "browser"],
                rightButtons: ["plugin.daintreehq.tool.opener", "settings"],
                pinnedButtons: {},
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 8,
          })
        );

        const store = await loadStore();
        const { leftButtons, rightButtons } = store.getState().layout;
        expect(leftButtons).toContain("acme.foo.btn");
        expect(leftButtons).not.toContain("plugin.acme.foo.btn");
        expect(rightButtons).toContain("daintreehq.tool.opener");
        expect(rightButtons).not.toContain("plugin.daintreehq.tool.opener");
      });
    });

    describe("v9→v10 forge-stats rename", () => {
      // These two cases previously shared one fixture that placed `github-stats`
      // on both sides at once and asserted `forge-stats` on both afterwards. The
      // rename covering each array is the real subject; the duplication was only
      // a shortcut for exercising both branches, and hydration now collapses a
      // cross-side pair (the duplicate-pill defect behind #10937/#10938) — so the
      // fixture is split rather than the heal weakened.
      it("renames github-stats in the left array and the pinned keys", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "github-stats"],
                rightButtons: ["settings"],
                pinnedButtons: { "github-stats": false, "copy-tree": false },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 9,
          })
        );

        const store = await loadStore();
        const { leftButtons, pinnedButtons } = store.getState().layout;
        expect(leftButtons).toContain("forge-stats");
        expect(leftButtons).not.toContain("github-stats");
        expect(pinnedButtons["forge-stats"]).toBe(false);
        expect(pinnedButtons["copy-tree"]).toBe(false);
        expect(pinnedButtons).not.toHaveProperty("github-stats");
      });

      it("renames github-stats in the right array", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal"],
                rightButtons: ["github-stats", "settings"],
                pinnedButtons: { "github-stats": false },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 9,
          })
        );

        const store = await loadStore();
        const { rightButtons, pinnedButtons } = store.getState().layout;
        expect(rightButtons).toContain("forge-stats");
        expect(rightButtons).not.toContain("github-stats");
        expect(pinnedButtons["forge-stats"]).toBe(false);
      });

      it("is a no-op on already-renamed v10-shaped state", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal"],
                rightButtons: ["forge-stats", "settings"],
                pinnedButtons: { "forge-stats": false },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 9,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons).toEqual({
          "forge-stats": false,
        });
        expect(store.getState().layout.rightButtons).toContain("forge-stats");
      });

      it("dedupes a v9 rename collision so only one forge-stats survives (#10937)", async () => {
        // A v9 profile holding both `forge-stats` and the legacy `github-stats`
        // would, under the bare-`.map()` v10 rename, produce two `forge-stats`
        // entries. The dedup guard collapses them to one, keeping the first slot.
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal"],
                rightButtons: ["forge-stats", "settings", "github-stats", "problems"],
                pinnedButtons: {},
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 9,
          })
        );

        const store = await loadStore();
        const { rightButtons } = store.getState().layout;
        expect(rightButtons.filter((id) => id === "forge-stats")).toHaveLength(1);
        expect(rightButtons).not.toContain("github-stats");
        // First occurrence wins: forge-stats keeps its original slot ahead of settings.
        expect(rightButtons.indexOf("forge-stats")).toBeLessThan(rightButtons.indexOf("settings"));
      });
    });

    describe("v10→v11 deduplicates button ids", () => {
      it("collapses repeated ids in both arrays while leaving pinnedButtons untouched", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "terminal", "browser"],
                rightButtons: [
                  "voice-recording",
                  "forge-stats",
                  "forge-stats",
                  "forge-stats",
                  "settings",
                ],
                pinnedButtons: { "forge-stats": false },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 10,
          })
        );

        const store = await loadStore();
        const { leftButtons, rightButtons, pinnedButtons } = store.getState().layout;
        expect(leftButtons.filter((id) => id === "terminal")).toHaveLength(1);
        expect(rightButtons.filter((id) => id === "forge-stats")).toHaveLength(1);
        // Survivor order is preserved (existing entries never reorder).
        expect(rightButtons.indexOf("voice-recording")).toBeLessThan(
          rightButtons.indexOf("forge-stats")
        );
        expect(rightButtons.indexOf("forge-stats")).toBeLessThan(rightButtons.indexOf("settings"));
        // The pin map is a Record — unique keys by construction, left untouched.
        expect(pinnedButtons).toEqual({ "forge-stats": false });
      });

      it("heals duplicates on an already-current blob via merge() (#10937)", async () => {
        // The durable guard lives in `sanitizeButtonList`, run on every
        // hydration through `merge()` — not only the version-gated migration —
        // so a blob already stamped at the current version that still carries
        // duplicates (a stale dev build re-corrupting a shared profile) is
        // repaired regardless. Stamped current on purpose: at an older version
        // the migrate chain would run too, and this case is about `merge()`
        // healing on its own.
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal"],
                rightButtons: ["forge-stats", "forge-stats", "settings"],
                pinnedButtons: {},
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 12,
          })
        );

        const store = await loadStore();
        expect(
          store.getState().layout.rightButtons.filter((id) => id === "forge-stats")
        ).toHaveLength(1);
      });
    });

    describe("v11→v13 file-browser is stamped hidden then un-stamped (#11495, #11667)", () => {
      // A pre-v12 profile now runs both steps back to back: v12 stamps
      // `file-browser: false` onto it, v13 removes that stamp. These assert the
      // net result, which is what a real upgrade produces — the v12 step is not
      // reachable on its own any more.
      it("leaves no file-browser pin for a profile that has never seen the button", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "browser", "dev-server"],
                rightButtons: ["settings"],
                pinnedButtons: {},
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 11,
          })
        );

        const store = await loadStore();
        const { leftButtons, rightButtons, pinnedButtons } = store.getState().layout;
        expect(pinnedButtons["file-browser"]).toBeUndefined();
        // Positioned exactly once, and now actually on the toolbar.
        expect(
          [...leftButtons, ...rightButtons].filter((id) => id === "file-browser")
        ).toHaveLength(1);
      });

      it("leaves every unrelated preference untouched through both steps", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["browser", "terminal"],
                rightButtons: ["copy-tree", "settings", "problems"],
                pinnedButtons: { "copy-tree": false, terminal: true, "acme.tool": true },
              },
              launcher: { alwaysShowDevServer: true, defaultSelection: "browser" },
            },
            version: 11,
          })
        );

        const store = await loadStore();
        const { pinnedButtons } = store.getState().layout;
        const { launcher } = store.getState();
        expect(pinnedButtons).toEqual({
          "copy-tree": false,
          terminal: true,
          "acme.tool": true,
        });
        expect(launcher.alwaysShowDevServer).toBe(true);
      });

      it("preserves a stray file-browser `true` rather than deleting it", async () => {
        // v12 overwrote this with `false`; v13 only removes a literal `false`, so
        // the overwrite survives as an explicit-but-inert entry. Deleting a
        // `true` would be the same overreach v13 exists to undo — and nothing in
        // the app writes `true` for a built-in, so it can only be hand-authored.
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "file-browser"],
                rightButtons: ["settings"],
                pinnedButtons: { "file-browser": true },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 12,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons["file-browser"]).toBe(true);
      });

      it("synthesizes a layout when a pre-v12 blob has none", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: { launcher: { alwaysShowDevServer: false } },
            version: 11,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons).toEqual({});
        expect(store.getState().layout.leftButtons).toContain("file-browser");
      });
    });

    describe("v12→v13 un-hides file-browser (#11667)", () => {
      it("deletes the v12 stamp and nothing else", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "browser", "file-browser", "dev-server"],
                rightButtons: ["settings"],
                pinnedButtons: { "file-browser": false, "copy-tree": false, "acme.tool": true },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 12,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons).toEqual({
          "copy-tree": false,
          "acme.tool": true,
        });
      });

      it("never stamps browser or dev-server hidden on an existing profile", async () => {
        // The whole point of the additive policy: converging existing users would
        // mean mass-backfilling a default into their records, which permanently
        // destroys the ability to change that default again — the exact mistake
        // v12 made with file-browser and that v13 is undoing.
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "browser", "file-browser", "dev-server"],
                rightButtons: ["settings"],
                pinnedButtons: { "file-browser": false },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 12,
          })
        );

        const store = await loadStore();
        const { leftButtons, pinnedButtons } = store.getState().layout;
        expect(pinnedButtons["browser"]).toBeUndefined();
        expect(pinnedButtons["dev-server"]).toBeUndefined();
        // Still positioned, so still visible — nobody loses a button they use.
        expect(leftButtons).toContain("browser");
        expect(leftButtons).toContain("dev-server");
      });

      it("adds the launcher through the hydration merge, not a migration step", async () => {
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["terminal", "browser", "dev-server"],
                rightButtons: ["settings"],
                pinnedButtons: {},
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 12,
          })
        );

        const store = await loadStore();
        const { leftButtons, rightButtons } = store.getState().layout;
        // Exactly once — pushing a newly-defaulted id into the arrays from a
        // migration as well is how a profile ends up carrying it twice (#10938).
        expect([...leftButtons, ...rightButtons].filter((id) => id === "launcher")).toHaveLength(1);
        expect(leftButtons).toContain("launcher");
      });

      it("leaves a profile already at v13 alone", async () => {
        // `migrate` doesn't run for a current-version blob, so a user who hid
        // file-browser after v13 must not have that choice reverted on launch.
        // Pinned at the current version on purpose — the point is the untouched
        // path, so this fixture has to move up with every bump.
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: {
              layout: {
                leftButtons: ["launcher", "terminal", "file-browser"],
                rightButtons: ["settings"],
                pinnedButtons: { "file-browser": false },
              },
              launcher: { alwaysShowDevServer: false },
            },
            version: 14,
          })
        );

        const store = await loadStore();
        expect(store.getState().layout.pinnedButtons["file-browser"]).toBe(false);
      });
    });

    describe("v13→v14 merges both trays into one launcher (#11680)", () => {
      const v13 = (layout: Record<string, unknown>) =>
        storageMock.setItem(
          STORAGE_KEY,
          JSON.stringify({
            state: { layout, launcher: { alwaysShowDevServer: false } },
            version: 13,
          })
        );

      it("renames agent-tray in place and drops panel-tray", async () => {
        // Rename, not drop-and-re-add: the launcher has to inherit the exact
        // index the user dragged the agent tray to, and `mergeButtonList` would
        // only ever re-insert it at the default position.
        v13({
          leftButtons: ["terminal", "agent-tray", "file-browser", "panel-tray"],
          rightButtons: ["settings"],
          pinnedButtons: {},
        });

        const { leftButtons, rightButtons } = (await loadStore()).getState().layout;
        expect(leftButtons).toEqual(["terminal", "launcher", "file-browser"]);
        expect(rightButtons).not.toContain("launcher");
        expect([...leftButtons, ...rightButtons]).not.toContain("agent-tray");
        expect([...leftButtons, ...rightButtons]).not.toContain("panel-tray");
      });

      it("carries the rename across the side the tray was moved to", async () => {
        v13({
          leftButtons: ["terminal", "panel-tray"],
          rightButtons: ["agent-tray", "settings"],
          pinnedButtons: {},
        });

        const { leftButtons, rightButtons } = (await loadStore()).getState().layout;
        // On the right, ahead of what it was ahead of. Not index 0: `launcher`
        // is a left-side default, so `mergeButtonList` inserts the right side's
        // own missing defaults around it — what has to survive is the side and
        // the relative order, which is what the user actually arranged.
        expect(rightButtons).toContain("launcher");
        expect(rightButtons.indexOf("launcher")).toBeLessThan(rightButtons.indexOf("settings"));
        expect(leftButtons).not.toContain("launcher");
      });

      it("does not duplicate the launcher when a profile carries both trays", async () => {
        // The v3 rename precedent: two ids collapsing onto one has to dedupe, or
        // the merged id renders twice and React warns on the duplicate key.
        v13({
          leftButtons: ["agent-tray", "panel-tray", "terminal"],
          rightButtons: [],
          pinnedButtons: {},
        });

        const { leftButtons, rightButtons } = (await loadStore()).getState().layout;
        expect([...leftButtons, ...rightButtons].filter((id) => id === "launcher")).toHaveLength(1);
      });

      it("keeps the launcher visible unless BOTH trays were explicitly hidden", async () => {
        // Union, not rename. Hiding one of two access points must not hide the
        // single button that replaced both — the user who hid the agent tray
        // still reached panels through the panel tray, and still has to.
        v13({
          leftButtons: ["agent-tray", "terminal", "panel-tray"],
          rightButtons: ["settings"],
          pinnedButtons: { "agent-tray": false },
        });

        const { pinnedButtons } = (await loadStore()).getState().layout;
        expect(pinnedButtons["launcher"]).toBeUndefined();
      });

      it("carries the hide forward when both trays were explicitly hidden", async () => {
        v13({
          leftButtons: ["agent-tray", "terminal", "panel-tray"],
          rightButtons: ["settings"],
          pinnedButtons: { "agent-tray": false, "panel-tray": false },
        });

        const { pinnedButtons } = (await loadStore()).getState().layout;
        expect(pinnedButtons["launcher"]).toBe(false);
      });

      it("writes no pin entry for a profile that hid neither tray", async () => {
        // The #11667 invariant this issue was told not to repeat: the map records
        // user intent only, so a merge that nobody expressed anything about must
        // leave it exactly as empty as it found it.
        v13({
          leftButtons: ["agent-tray", "terminal", "panel-tray"],
          rightButtons: ["settings"],
          pinnedButtons: {},
        });

        expect((await loadStore()).getState().layout.pinnedButtons).toEqual({});
      });

      it("leaves promoted panel pins untouched", async () => {
        // `restorePromotedPanelButtons` rebuilds a dropped position from these,
        // so losing one silently un-promotes a button the user asked for.
        v13({
          leftButtons: ["agent-tray", "terminal", "browser", "panel-tray"],
          rightButtons: ["settings"],
          pinnedButtons: { browser: true, "dev-server": false, "some-plugin.btn": true },
        });

        const { pinnedButtons } = (await loadStore()).getState().layout;
        expect(pinnedButtons["browser"]).toBe(true);
        expect(pinnedButtons["dev-server"]).toBe(false);
        expect(pinnedButtons["some-plugin.btn" as AnyToolbarButtonId]).toBe(true);
      });

      it("leaves a grandfathered profile's agent buttons in place", async () => {
        // The whole grandfathering contract: array membership alone preserves an
        // existing toolbar, and nothing is stamped into `pinnedButtons` to do it.
        v13({
          leftButtons: ["agent-tray", "claude", "gemini", "terminal", "panel-tray"],
          rightButtons: ["settings"],
          pinnedButtons: {},
        });

        const { leftButtons, pinnedButtons } = (await loadStore()).getState().layout;
        // `file-browser` is appended by the ordinary default merge, not by this
        // step — the point is that both agent ids survive with their positions
        // and that nothing was written to record it.
        expect(leftButtons.filter((id) => id !== "file-browser")).toEqual([
          "launcher",
          "claude",
          "gemini",
          "terminal",
        ]);
        expect(pinnedButtons).toEqual({});
      });

      it("survives a layout with no button arrays at all", async () => {
        v13({ pinnedButtons: { "agent-tray": false } });
        const store = await loadStore();
        expect(store.getState().layout.leftButtons).toContain("launcher");
      });
    });
  });

  describe("panel button defaults (#11495, #11667)", () => {
    it("ships file-browser visible and the launcher ahead of it", async () => {
      // No stored state on purpose: a fresh install never runs `migrate`, so the
      // store's own defaults are the only source of truth for a new user.
      const store = await loadStore();
      const { leftButtons, pinnedButtons } = store.getState().layout;

      expect(pinnedButtons["file-browser"]).toBeUndefined();
      expect(leftButtons).toContain("file-browser");
      expect(leftButtons.indexOf("launcher")).toBeLessThan(leftButtons.indexOf("file-browser"));
    });

    it("synthesizes no pin entries at all for a fresh profile", async () => {
      // The #11667 invariant: `pinnedButtons` records user intent only. A profile
      // nobody has touched has expressed none, so an empty map is the only
      // correct state — a seeded default here is what made a deliberate hide
      // indistinguishable from a migration artifact in v12.
      const store = await loadStore();
      expect(store.getState().layout.pinnedButtons).toEqual({});
    });

    it("keeps file-browser on the side the user moved it to across hydration", async () => {
      // `mergeButtonList` re-materializes a default that is missing from its home
      // side. Without the cross-side check that means a switched button lands on
      // BOTH sides — `sanitizeButtonList` dedupes within a side, never across —
      // so it would render twice and the side switch would look like it failed.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "browser", "dev-server"],
              rightButtons: ["file-browser", "settings"],
              pinnedButtons: {},
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 12,
        })
      );

      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      expect(rightButtons).toContain("file-browser");
      expect(leftButtons).not.toContain("file-browser");
      expect([...leftButtons, ...rightButtons].filter((id) => id === "file-browser")).toHaveLength(
        1
      );
    });

    it("synthesizes no pins for a current-version blob whose layout carries no pin map", async () => {
      // A blob already stamped at the current version never reaches `migrate`,
      // so `merge()` alone decides what a missing pin map resolves to. Since
      // #11667 that is `{}` — there is no ships-hidden default left to restore,
      // and inventing one here would put a value in the map the user never chose.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: { leftButtons: ["terminal", "file-browser"], rightButtons: ["settings"] },
            launcher: { alwaysShowDevServer: false },
          },
          version: 13,
        })
      );

      const store = await loadStore();
      expect(store.getState().layout.pinnedButtons).toEqual({});
    });

    it("hydrates cleanly with no persisted blob at all", async () => {
      // zustand calls `merge` even when storage is empty. This used to throw
      // inside the merge and get swallowed, leaving the right state by accident
      // and `hasHydrated()` stuck false — assert the outcome is now deliberate.
      const store = await loadStore();

      expect(store.persist.hasHydrated()).toBe(true);
      expect(store.getState().layout.pinnedButtons).toEqual({});
      expect(store.getState().layout.leftButtons).toContain("file-browser");
    });

    it("does not carry the previous blob's pins into a re-hydrate onto one with no pin map", async () => {
      // zustand hands `merge` the LIVE state on a second `rehydrate()`, not the
      // creator defaults, so resolving a missing pin map from current state would
      // leak the previous blob's overrides into one that has none.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "file-browser"],
              rightButtons: ["settings"],
              pinnedButtons: { "copy-tree": false },
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 13,
        })
      );

      const store = await loadStore();
      expect(store.getState().layout.pinnedButtons).toEqual({ "copy-tree": false });

      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: { leftButtons: ["terminal", "file-browser"], rightButtons: ["settings"] },
            launcher: { alwaysShowDevServer: false },
          },
          version: 13,
        })
      );
      await store.persist.rehydrate();

      expect(store.getState().layout.pinnedButtons).toEqual({});
    });

    it("heals a browser duplicated across sides toward the moved copy after it left the defaults", async () => {
      // `browser` is no longer in `DEFAULT_LEFT_BUTTONS`, but a profile old
      // enough to have duplicated it had it as a left-side button at the time.
      // `healCrossSideDuplicates` reads a frozen home set rather than the live
      // defaults precisely so the repair still keeps the copy the user dragged
      // away, instead of flipping and deleting it (#11667).
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "browser"],
              rightButtons: ["browser", "settings"],
              pinnedButtons: {},
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 12,
        })
      );

      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      expect([...leftButtons, ...rightButtons].filter((id) => id === "browser")).toHaveLength(1);
      expect(rightButtons).toContain("browser");
      expect(leftButtons).not.toContain("browser");
    });

    it("heals a default already duplicated onto both sides by the old hydration", async () => {
      // Profiles corrupted before the cross-side fix carry the id twice. The
      // survivor is the non-home side, which is where the user had dragged it.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "browser", "file-browser"],
              rightButtons: ["file-browser", "settings"],
              pinnedButtons: {},
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 12,
        })
      );

      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      expect([...leftButtons, ...rightButtons].filter((id) => id === "file-browser")).toHaveLength(
        1
      );
      expect(rightButtons).toContain("file-browser");
      expect(leftButtons).not.toContain("file-browser");
    });

    it("heals a right-side default duplicated onto the left, keeping the moved copy", async () => {
      // Mirror direction: `copy-tree` is a right-side default, so a both-sides
      // pair means the user moved it left and the left copy is the survivor.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "copy-tree"],
              rightButtons: ["copy-tree", "settings"],
              pinnedButtons: {},
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 12,
        })
      );

      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      expect([...leftButtons, ...rightButtons].filter((id) => id === "copy-tree")).toHaveLength(1);
      expect(leftButtons).toContain("copy-tree");
      expect(rightButtons).not.toContain("copy-tree");
    });

    it("does not re-home any moved default, not just file-browser", async () => {
      // The same hydration bug applies to every default. `terminal` is the
      // longest-standing left-side default, so it is the honest regression probe.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["browser"],
              rightButtons: ["terminal", "settings"],
              pinnedButtons: {},
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 12,
        })
      );

      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      expect(leftButtons).not.toContain("terminal");
      expect(rightButtons).toContain("terminal");
    });
  });

  describe("setPanelButtonOnToolbar (#11667)", () => {
    it("gives an unpositioned button a slot before the tray and records the promotion", async () => {
      // The case `toggleButtonVisibility` cannot handle: on a fresh profile
      // `browser` is in neither side array, so clearing a pin alone would leave
      // it with nowhere to render.
      const store = await loadStore();
      expect(store.getState().layout.leftButtons).not.toContain("browser");

      store.getState().setPanelButtonOnToolbar("browser", true);

      const { leftButtons, pinnedButtons } = store.getState().layout;
      expect(leftButtons).toContain("browser");
      expect(leftButtons.indexOf("browser")).toBe(leftButtons.indexOf("launcher") + 1);
      // An explicit `true`, unlike `toggleButtonVisibility`. `browser` is not a
      // default, so the promotion is a real choice with nothing else recording
      // it — and it's the only part that survives a stale sibling view
      // overwriting the position arrays.
      expect(pinnedButtons["browser"]).toBe(true);
    });

    it("hides by writing false and keeps the position for a later re-show", async () => {
      const store = await loadStore();
      store.getState().setPanelButtonOnToolbar("browser", true);
      const promotedIndex = store.getState().layout.leftButtons.indexOf("browser");

      store.getState().setPanelButtonOnToolbar("browser", false);
      expect(store.getState().layout.pinnedButtons["browser"]).toBe(false);
      // Position retained, so re-showing restores it where the user had it
      // rather than appending it somewhere new.
      expect(store.getState().layout.leftButtons.indexOf("browser")).toBe(promotedIndex);

      store.getState().setPanelButtonOnToolbar("browser", true);
      expect(store.getState().layout.pinnedButtons["browser"]).toBe(true);
      expect(store.getState().layout.leftButtons.indexOf("browser")).toBe(promotedIndex);
    });

    it("rebuilds a promoted button's position when hydration finds it missing", async () => {
      // The cross-view repair. Orderings reconcile last-writer-wins, so a stale
      // sibling view writing any toolbar preference replaces the arrays wholesale
      // and drops a promotion this view just made. `pinnedButtons` merges per id
      // and survives, so the explicit `true` is what the position is rebuilt from
      // — otherwise the button would silently un-promote itself.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "file-browser", "panel-tray"],
              rightButtons: ["settings"],
              pinnedButtons: { browser: true },
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 13,
        })
      );

      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      expect(leftButtons).toContain("browser");
      expect(leftButtons.indexOf("browser")).toBe(leftButtons.indexOf("launcher") + 1);
      expect([...leftButtons, ...rightButtons].filter((id) => id === "browser")).toHaveLength(1);
    });

    it("does not rebuild a position for a button the user hid", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "file-browser", "panel-tray"],
              rightButtons: ["settings"],
              pinnedButtons: { browser: false, "dev-server": false },
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 13,
        })
      );

      const store = await loadStore();
      const { leftButtons, rightButtons } = store.getState().layout;
      expect([...leftButtons, ...rightButtons]).not.toContain("browser");
      expect([...leftButtons, ...rightButtons]).not.toContain("dev-server");
    });

    it("never positions the same id twice", async () => {
      const store = await loadStore();
      store.getState().setPanelButtonOnToolbar("dev-server", true);
      store.getState().setPanelButtonOnToolbar("dev-server", true);

      const { leftButtons, rightButtons } = store.getState().layout;
      expect([...leftButtons, ...rightButtons].filter((id) => id === "dev-server")).toHaveLength(1);
    });

    it("clears an existing hide without moving an already-positioned button", async () => {
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "browser", "file-browser", "panel-tray"],
              rightButtons: ["settings"],
              pinnedButtons: { browser: false },
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 13,
        })
      );

      const store = await loadStore();
      const before = store.getState().layout.leftButtons.indexOf("browser");

      store.getState().setPanelButtonOnToolbar("browser", true);

      expect(store.getState().layout.pinnedButtons["browser"]).toBe(true);
      expect(store.getState().layout.leftButtons.indexOf("browser")).toBe(before);
    });

    it("follows the launcher to the right side when the user moved it there", async () => {
      // `agent-tray`, not `panel-tray`: only one of the two survives v14, so the
      // side the launcher ends up on is the side the *renamed* id was parked on.
      storageMock.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            layout: {
              leftButtons: ["terminal", "file-browser"],
              rightButtons: ["agent-tray", "settings"],
              pinnedButtons: {},
            },
            launcher: { alwaysShowDevServer: false },
          },
          version: 13,
        })
      );

      const store = await loadStore();
      store.getState().setPanelButtonOnToolbar("dev-server", true);

      const { leftButtons, rightButtons } = store.getState().layout;
      expect(rightButtons).toContain("dev-server");
      expect(leftButtons).not.toContain("dev-server");
      expect(rightButtons.indexOf("dev-server")).toBe(rightButtons.indexOf("launcher") + 1);
    });
  });
});
