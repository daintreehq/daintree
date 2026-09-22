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
  getGenericPanelMenuGroups,
  hasGenericPanelMenu,
  readPanelKindMenuCapabilities,
  type GenericPanelMenuInput,
} from "../genericPanelMenu";

const PTY_PLUGIN_KIND = "acme.shell";
const VIEW_PLUGIN_KIND = "acme.dashboard";
const UNDOCKABLE_PLUGIN_KIND = "acme.wallboard";

function registerPluginKind(id: string, overrides: { hasPty?: boolean; dockable?: boolean } = {}) {
  registerPanelKind({
    id,
    name: id,
    iconId: "terminal",
    color: "#abcdef",
    hasPty: overrides.hasPty ?? false,
    canRestart: false,
    canConvert: false,
    extensionId: "acme",
    ...(overrides.dockable !== undefined ? { dockable: overrides.dockable } : {}),
  });
}

function groups(input: Partial<GenericPanelMenuInput> = {}) {
  return getGenericPanelMenuGroups({
    location: "grid",
    isMaximized: false,
    isDockable: true,
    canMoveToWorktree: true,
    ...input,
  });
}

afterEach(() => {
  unregisterPanelKind(PTY_PLUGIN_KIND);
  unregisterPanelKind(VIEW_PLUGIN_KIND);
  unregisterPanelKind(UNDOCKABLE_PLUGIN_KIND);
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
      });
    }
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

  it("gives every command but the worktree move an action to dispatch", () => {
    for (const input of LAYOUT_INPUTS) {
      for (const command of groups(input).flat()) {
        if (command.id === "move-to-worktree") continue;
        expect(GENERIC_PANEL_MENU_ACTION_IDS[command.id]).toBeDefined();
      }
    }
  });
});
