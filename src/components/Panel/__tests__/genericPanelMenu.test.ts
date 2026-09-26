import { afterEach, describe, expect, it } from "vitest";
import {
  getPanelKindRegistrySnapshot,
  panelKindHasPty,
  panelKindIsDockable,
  registerPanelKind,
  unregisterPanelKind,
} from "@shared/config/panelKindRegistry";
import { canDuplicatePanelKind } from "@/services/terminal/panelDuplicationService";
import {
  GENERIC_PANEL_MENU_ACTION_IDS,
  GENERIC_PANEL_RELOAD_ACTION_ID,
  canReloadPanelKind,
  getGenericPanelMenuGroups,
  hasGenericPanelMenu,
  isPluginMenuCommandId,
  pluginMenuCommandActionId,
  readPanelKindMenuCapabilities,
  type GenericPanelMenuInput,
} from "../genericPanelMenu";
import { getRegisteredTourIdsSnapshot, registerTour } from "@/components/Tour/tourRegistry";

const PTY_PLUGIN_KIND = "acme.shell";
const VIEW_PLUGIN_KIND = "acme.dashboard";
const UNDOCKABLE_PLUGIN_KIND = "acme.wallboard";
const TOURED_PLUGIN_KIND = "acme.metrics";

function registerPluginKind(
  id: string,
  overrides: {
    hasPty?: boolean;
    dockable?: boolean;
    name?: string;
    tourId?: string;
    hasPluginSettings?: boolean;
    hasPluginDatabases?: boolean;
    pluginMenu?: Array<{ actionId: string; label?: string }>;
  } = {}
) {
  registerPanelKind({
    id,
    name: overrides.name ?? id,
    iconId: "terminal",
    color: "#abcdef",
    hasPty: overrides.hasPty ?? false,
    canRestart: false,
    canConvert: false,
    extensionId: "acme",
    ...(overrides.dockable !== undefined ? { dockable: overrides.dockable } : {}),
    ...(overrides.tourId !== undefined ? { tourId: overrides.tourId } : {}),
    ...(overrides.hasPluginSettings ? { hasPluginSettings: true } : {}),
    ...(overrides.hasPluginDatabases ? { hasPluginDatabases: true } : {}),
    ...(overrides.pluginMenu ? { pluginMenu: overrides.pluginMenu } : {}),
  });
}

function groups(input: Partial<GenericPanelMenuInput> = {}) {
  return getGenericPanelMenuGroups({
    location: "grid",
    isMaximized: false,
    isDockable: true,
    canMoveToWorktree: true,
    canReload: true,
    ...input,
  });
}

const tourCleanups: Array<() => void> = [];

/** Registers a tour under `id` so a kind declaring it has something to play. */
function registerPlayableTour(id: string) {
  tourCleanups.push(
    registerTour({
      summary: { id, title: "Acme Tour", minutes: 1, chapterTitles: ["One"] },
      load: () => Promise.reject(new Error("not under test")),
    })
  );
}

afterEach(() => {
  for (const cleanupTour of tourCleanups.splice(0)) cleanupTour();
  unregisterPanelKind(PTY_PLUGIN_KIND);
  unregisterPanelKind(VIEW_PLUGIN_KIND);
  unregisterPanelKind(UNDOCKABLE_PLUGIN_KIND);
  unregisterPanelKind(TOURED_PLUGIN_KIND);
});

describe("readPanelKindMenuCapabilities", () => {
  it("answers as the registry helpers do, for built-in, plugin and unknown kinds", () => {
    registerPluginKind(PTY_PLUGIN_KIND, { hasPty: true });
    registerPluginKind(VIEW_PLUGIN_KIND);
    registerPluginKind(UNDOCKABLE_PLUGIN_KIND, { dockable: false });
    const snapshot = getPanelKindRegistrySnapshot();

    for (const kind of [
      "terminal",
      "browser",
      "file",
      "diff",
      PTY_PLUGIN_KIND,
      VIEW_PLUGIN_KIND,
      UNDOCKABLE_PLUGIN_KIND,
      "acme.missing",
    ]) {
      expect(readPanelKindMenuCapabilities(snapshot, kind)).toEqual({
        hasPty: panelKindHasPty(kind),
        isDockable: panelKindIsDockable(kind),
        tour: null,
        pluginSettingsId: null,
        pluginBackupId: null,
        pluginMenuItems: [],
      });
    }
  });

  it("offers the tour a kind declares under the kind's own name (#12774)", () => {
    registerPluginKind(TOURED_PLUGIN_KIND, { name: "Metrics", tourId: "acme.metrics-intro" });
    registerPlayableTour("acme.metrics-intro");

    expect(
      readPanelKindMenuCapabilities(
        getPanelKindRegistrySnapshot(),
        TOURED_PLUGIN_KIND,
        getRegisteredTourIdsSnapshot()
      ).tour
    ).toEqual({ id: "acme.metrics-intro", label: "Metrics Welcome Tour" });
  });

  it("offers no declared tour until it is registered, since it would open nothing", () => {
    registerPluginKind(TOURED_PLUGIN_KIND, { name: "Metrics", tourId: "acme.metrics-intro" });
    const read = () =>
      readPanelKindMenuCapabilities(
        getPanelKindRegistrySnapshot(),
        TOURED_PLUGIN_KIND,
        getRegisteredTourIdsSnapshot()
      ).tour;

    expect(read()).toBeNull();
    registerPlayableTour("acme.metrics-intro");
    expect(read()).toEqual({ id: "acme.metrics-intro", label: "Metrics Welcome Tour" });
    for (const cleanupTour of tourCleanups.splice(0)) cleanupTour();
    expect(read()).toBeNull();
  });

  it("names the plugin whose settings the menus open, only when it has some", () => {
    registerPluginKind(VIEW_PLUGIN_KIND, { hasPluginSettings: true });
    registerPluginKind(PTY_PLUGIN_KIND, { hasPty: true, hasPluginSettings: true });
    registerPluginKind(UNDOCKABLE_PLUGIN_KIND);
    const snapshot = getPanelKindRegistrySnapshot();

    expect(readPanelKindMenuCapabilities(snapshot, VIEW_PLUGIN_KIND).pluginSettingsId).toBe("acme");
    expect(readPanelKindMenuCapabilities(snapshot, PTY_PLUGIN_KIND).pluginSettingsId).toBe("acme");
    expect(
      readPanelKindMenuCapabilities(snapshot, UNDOCKABLE_PLUGIN_KIND).pluginSettingsId
    ).toBeNull();
    expect(readPanelKindMenuCapabilities(snapshot, "file").pluginSettingsId).toBeNull();
  });

  it("names the plugin whose data Back up data… copies, only when it declares databases", () => {
    registerPluginKind(VIEW_PLUGIN_KIND, { hasPluginDatabases: true });
    registerPluginKind(UNDOCKABLE_PLUGIN_KIND, { hasPluginSettings: true });
    const snapshot = getPanelKindRegistrySnapshot();

    expect(readPanelKindMenuCapabilities(snapshot, VIEW_PLUGIN_KIND).pluginBackupId).toBe("acme");
    expect(readPanelKindMenuCapabilities(snapshot, VIEW_PLUGIN_KIND).pluginSettingsId).toBeNull();
    expect(
      readPanelKindMenuCapabilities(snapshot, UNDOCKABLE_PLUGIN_KIND).pluginBackupId
    ).toBeNull();
  });

  it("offers a kind's own menu items in declared order, once each action is registered", () => {
    registerPluginKind(VIEW_PLUGIN_KIND, {
      pluginMenu: [
        { actionId: "acme.refresh" },
        { actionId: "acme.export", label: "Export as CSV" },
        { actionId: "acme.pending" },
      ],
    });
    const snapshot = getPanelKindRegistrySnapshot();
    const read = (registered: Array<[string, string]>) =>
      readPanelKindMenuCapabilities(snapshot, VIEW_PLUGIN_KIND, undefined, new Map(registered))
        .pluginMenuItems;

    expect(read([])).toEqual([]);
    expect(
      read([
        ["acme.export", "Export ledger"],
        ["acme.refresh", "Refresh data"],
      ])
    ).toEqual([
      { actionId: "acme.refresh", label: "Refresh data" },
      { actionId: "acme.export", label: "Export as CSV" },
    ]);
    expect(read([["acme.pending", "Sync now"]])).toEqual([
      { actionId: "acme.pending", label: "Sync now" },
    ]);
  });

  it("leaves out a menu item with nothing to call it", () => {
    registerPluginKind(VIEW_PLUGIN_KIND, { pluginMenu: [{ actionId: "acme.untitled" }] });

    expect(
      readPanelKindMenuCapabilities(
        getPanelKindRegistrySnapshot(),
        VIEW_PLUGIN_KIND,
        undefined,
        new Map([["acme.untitled", ""]])
      ).pluginMenuItems
    ).toEqual([]);
  });

  it("reads the snapshot it is handed, not the live registry", () => {
    const before = getPanelKindRegistrySnapshot();
    registerPluginKind(PTY_PLUGIN_KIND, { hasPty: true });

    expect(readPanelKindMenuCapabilities(before, PTY_PLUGIN_KIND).hasPty).toBe(false);
    expect(
      readPanelKindMenuCapabilities(getPanelKindRegistrySnapshot(), PTY_PLUGIN_KIND).hasPty
    ).toBe(true);
  });
});

describe("hasGenericPanelMenu", () => {
  it.each(["file", "file-browser", "diff"])("covers the built-in %s kind", (kind) => {
    expect(hasGenericPanelMenu(kind, false)).toBe(true);
  });

  it.each([
    ["terminal", true],
    ["browser", false],
    ["dev-preview", false],
    ["review", false],
  ] as const)("leaves the built-in %s kind to its own menu", (kind, hasPty) => {
    expect(hasGenericPanelMenu(kind, hasPty)).toBe(false);
  });

  it("covers a plugin kind without a PTY, registered or gone missing", () => {
    expect(hasGenericPanelMenu(VIEW_PLUGIN_KIND, false)).toBe(true);
  });

  it("leaves a PTY-backed plugin kind on the terminal menu", () => {
    expect(hasGenericPanelMenu(PTY_PLUGIN_KIND, true)).toBe(false);
  });

  it("offers none of its kinds a Duplicate that could work", () => {
    // Why the list carries no Duplicate: if one of these kinds gains a
    // duplicate recipe, this fails and the command belongs in the list.
    for (const kind of ["file", "file-browser", "diff", VIEW_PLUGIN_KIND]) {
      expect(hasGenericPanelMenu(kind, false)).toBe(true);
      expect(canDuplicatePanelKind(kind)).toBe(false);
    }
  });
});

describe("getGenericPanelMenuGroups", () => {
  const ids = (input: Partial<GenericPanelMenuInput> = {}) =>
    groups(input).map((group) => group.map((command) => command.id));

  const LAYOUT_INPUTS: Array<Partial<GenericPanelMenuInput>> = [
    {},
    { location: "dock" },
    { isMaximized: true },
    { isDockable: false },
    { canMoveToWorktree: false },
    { location: "dock", canMoveToWorktree: false },
  ];

  it("changes only the layout group with where the panel sits", () => {
    const [, ...rest] = groups();
    for (const input of LAYOUT_INPUTS) {
      expect(groups(input).slice(1)).toEqual(rest);
    }
  });

  it("offers Move to worktree only when there is somewhere to go, and leads with it", () => {
    expect(ids({ canMoveToWorktree: true })[0]?.[0]).toBe("move-to-worktree");
    expect(ids({ canMoveToWorktree: false }).flat()).not.toContain("move-to-worktree");
  });

  it("moves a grid panel to the dock or maximizes it, and a docked one only to the grid", () => {
    const grid = ids({ canMoveToWorktree: false })[0];
    const dock = ids({ location: "dock", canMoveToWorktree: false })[0];

    expect(grid).toEqual(["move-to-dock", "toggle-maximize"]);
    expect(dock).toEqual(["move-to-grid"]);
  });

  it("names the maximize command for what it will do", () => {
    const toggle = (isMaximized: boolean) =>
      groups({ isMaximized })
        .flat()
        .find((command) => command.id === "toggle-maximize")!;

    expect(toggle(true).label).not.toBe(toggle(false).label);
    expect(toggle(true).icon).not.toBe(toggle(false).icon);
    expect(toggle(true).shortcutActionId).toBe(toggle(false).shortcutActionId);
  });

  it("gives a shortcut to the maximize command alone", () => {
    for (const input of LAYOUT_INPUTS) {
      const withShortcut = groups(input)
        .flat()
        .filter((command) => command.shortcutActionId !== undefined)
        .map((command) => command.id);
      expect(withShortcut).toEqual(input.location === "dock" ? [] : ["toggle-maximize"]);
    }
  });

  it("disables only Move to dock, and only for a kind the dock cannot render", () => {
    const disabled = (isDockable: boolean) =>
      groups({ isDockable })
        .flat()
        .filter((command) => command.disabled)
        .map((command) => command.id);

    expect(disabled(false)).toEqual(["move-to-dock"]);
    expect(disabled(true)).toEqual([]);
  });

  it("ends on its one destructive command", () => {
    const all = groups().flat();
    const destructive = all.filter((command) => command.destructive);

    expect(destructive).toHaveLength(1);
    expect(all.at(-1)).toBe(destructive[0]);
  });

  it("never repeats a command or leaves a group empty", () => {
    for (const input of LAYOUT_INPUTS) {
      const result = groups(input);
      const all = result.flat().map((command) => command.id);
      expect(new Set(all).size).toBe(all.length);
      expect(result.every((group) => group.length > 0)).toBe(true);
    }
  });

  it("gives every command but the worktree move and reload an action to dispatch", () => {
    for (const input of LAYOUT_INPUTS) {
      for (const command of groups(input).flat()) {
        if (
          command.id === "move-to-worktree" ||
          command.id === "reload" ||
          command.id === "tour" ||
          command.id === "plugin-settings" ||
          command.id === "plugin-backup" ||
          isPluginMenuCommandId(command.id)
        )
          continue;
        expect(GENERIC_PANEL_MENU_ACTION_IDS[command.id]).toBeDefined();
      }
    }
  });

  it("offers Reload panel beside Rename only for a kind that can reload (#12611)", () => {
    expect(ids({ canReload: true })[1]).toEqual(["rename", "reload"]);
    expect(ids({ canReload: false }).flat()).not.toContain("reload");
    const reload = groups({ canReload: true })
      .flat()
      .find((command) => command.id === "reload")!;
    expect(reload.label).toBe("Reload panel");
    expect(reload.destructive).toBeUndefined();
    expect(GENERIC_PANEL_RELOAD_ACTION_ID).toBe("plugin.reloadPanel");
  });

  it("offers a declared tour in a group of its own, before the removal commands (#12774)", () => {
    const withTour = ids({ tourLabel: "Metrics Welcome Tour" });
    const withoutTour = ids();

    expect(withoutTour.flat()).not.toContain("tour");
    expect(withTour.find((group) => group.includes("tour"))).toEqual(["tour"]);
    expect(withTour.filter((group) => !group.includes("tour"))).toEqual(withoutTour);
    expect(withTour.flat().indexOf("tour")).toBeLessThan(withTour.flat().indexOf("trash"));

    const tour = groups({ tourLabel: "Metrics Welcome Tour" })
      .flat()
      .find((command) => command.id === "tour")!;
    expect(tour.label).toBe("Metrics Welcome Tour");
    expect(tour.destructive).toBeUndefined();
    expect(tour.disabled).toBeUndefined();
  });

  it("offers Plugin settings… as the last of the plugin's own entries", () => {
    const withSettings = ids({ hasPluginSettings: true });
    expect(withSettings.find((group) => group.includes("plugin-settings"))).toEqual([
      "plugin-settings",
    ]);
    expect(ids().flat()).not.toContain("plugin-settings");

    const both = ids({ tourLabel: "Metrics Welcome Tour", hasPluginSettings: true });
    expect(both.find((group) => group.includes("tour"))).toEqual(["tour", "plugin-settings"]);
    expect(both.flat().indexOf("plugin-settings")).toBeLessThan(both.flat().indexOf("trash"));

    const item = groups({ hasPluginSettings: true })
      .flat()
      .find((command) => command.id === "plugin-settings")!;
    expect(item.destructive).toBeUndefined();
    expect(item.disabled).toBeUndefined();
  });

  it("offers Back up data… after the tour and before Plugin settings…", () => {
    expect(ids().flat()).not.toContain("plugin-backup");
    expect(ids({ hasPluginDatabases: true }).find((g) => g.includes("plugin-backup"))).toEqual([
      "plugin-backup",
    ]);

    const all = ids({
      tourLabel: "Metrics Welcome Tour",
      hasPluginSettings: true,
      hasPluginDatabases: true,
    });
    expect(all.find((group) => group.includes("tour"))).toEqual([
      "tour",
      "plugin-backup",
      "plugin-settings",
    ]);

    const item = groups({ hasPluginDatabases: true })
      .flat()
      .find((command) => command.id === "plugin-backup")!;
    // The ellipsis promises the dialog that follows.
    expect(item.label.endsWith("…")).toBe(true);
    expect(item.destructive).toBeUndefined();
    expect(item.disabled).toBeUndefined();
  });

  it("puts the plugin's own items in a group directly above its entries, in order", () => {
    const items = [
      { actionId: "acme.refresh", label: "Refresh data" },
      { actionId: "acme.export", label: "Export as CSV" },
    ];
    const withEverything = groups({
      tourLabel: "Metrics Welcome Tour",
      hasPluginSettings: true,
      pluginMenuItems: items,
    });
    const groupIds = withEverything.map((group) => group.map((command) => command.id));
    const contributedIndex = groupIds.findIndex((group) => group.every(isPluginMenuCommandId));
    const ownedIndex = groupIds.findIndex((group) => group.includes("tour"));

    expect(contributedIndex).toBeGreaterThan(-1);
    expect(ownedIndex).toBe(contributedIndex + 1);
    const contributed = withEverything[contributedIndex]!;
    expect(contributed.map((command) => command.label)).toEqual(["Refresh data", "Export as CSV"]);
    expect(
      contributed.map((command) =>
        isPluginMenuCommandId(command.id) ? pluginMenuCommandActionId(command.id) : null
      )
    ).toEqual(["acme.refresh", "acme.export"]);
    expect(contributed.every((c) => !c.destructive && !c.disabled)).toBe(true);

    // Without the plugin's entries they still sit just above the removal group.
    const alone = ids({ pluginMenuItems: items });
    const aloneIndex = alone.findIndex((group) => group.every(isPluginMenuCommandId));
    expect(alone[aloneIndex + 1]).toContain("trash");
    // And nothing at all when the kind offers none.
    expect(ids().flat().some(isPluginMenuCommandId)).toBe(false);
  });

  it("still ends on its one destructive command with a tour offered", () => {
    const all = groups({ tourLabel: "Metrics Welcome Tour" }).flat();
    expect(all.at(-1)?.destructive).toBe(true);
    expect(all.filter((command) => command.destructive)).toHaveLength(1);
  });
});

describe("canReloadPanelKind (#12611)", () => {
  it("offers reload to plugin kinds, registered or gone missing", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    expect(canReloadPanelKind(VIEW_PLUGIN_KIND)).toBe(true);
    expect(canReloadPanelKind("acme.missing")).toBe(true);
  });

  it.each(["file", "file-browser", "diff"])("withholds it from the built-in %s kind", (kind) => {
    expect(canReloadPanelKind(kind)).toBe(false);
  });
});
