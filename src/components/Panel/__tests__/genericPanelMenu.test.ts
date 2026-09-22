import { afterEach, describe, expect, it } from "vitest";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import {
  getGenericPanelMenuGroups,
  hasGenericPanelMenu,
  type GenericPanelMenuCommand,
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

function labels(input: Partial<GenericPanelMenuInput> = {}): string[][] {
  return getGenericPanelMenuGroups({
    kind: VIEW_PLUGIN_KIND,
    location: "grid",
    isMaximized: false,
    canMoveToWorktree: true,
    ...input,
  }).map((group) => group.map((command) => command.label));
}

function find(input: Partial<GenericPanelMenuInput>, id: string): GenericPanelMenuCommand {
  const command = getGenericPanelMenuGroups({
    kind: VIEW_PLUGIN_KIND,
    location: "grid",
    isMaximized: false,
    canMoveToWorktree: false,
    ...input,
  })
    .flat()
    .find((entry) => entry.id === id);
  if (!command) throw new Error(`no ${id} command`);
  return command;
}

afterEach(() => {
  unregisterPanelKind(PTY_PLUGIN_KIND);
  unregisterPanelKind(VIEW_PLUGIN_KIND);
  unregisterPanelKind(UNDOCKABLE_PLUGIN_KIND);
});

describe("hasGenericPanelMenu", () => {
  it.each(["file", "file-browser", "diff"])("covers the built-in %s kind", (kind) => {
    expect(hasGenericPanelMenu(kind)).toBe(true);
  });

  it.each(["terminal", "browser", "dev-preview", "review"])(
    "leaves the built-in %s kind to its own menu",
    (kind) => {
      expect(hasGenericPanelMenu(kind)).toBe(false);
    }
  );

  it("covers a plugin kind without a PTY", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    expect(hasGenericPanelMenu(VIEW_PLUGIN_KIND)).toBe(true);
  });

  it("covers a plugin kind whose plugin has gone missing", () => {
    // Unregistered: the lookup a missing plugin leaves behind.
    expect(hasGenericPanelMenu("acme.missing")).toBe(true);
  });

  it("leaves a PTY-backed plugin kind on the terminal menu", () => {
    registerPluginKind(PTY_PLUGIN_KIND, { hasPty: true });
    expect(hasGenericPanelMenu(PTY_PLUGIN_KIND)).toBe(false);
  });
});

describe("getGenericPanelMenuGroups", () => {
  it("lists a grid panel's commands in order, grouped", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    expect(labels()).toEqual([
      ["Move to worktree", "Move to dock", "Maximize"],
      ["Rename panel"],
      ["Send to background", "Trash panel", "Remove panel"],
    ]);
  });

  it("offers Restore in place of Maximize on a maximized panel", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    expect(labels({ isMaximized: true })[0]).toEqual([
      "Move to worktree",
      "Move to dock",
      "Restore",
    ]);
  });

  it("offers Move to grid and no maximize in the dock", () => {
    expect(labels({ location: "dock" })[0]).toEqual(["Move to worktree", "Move to grid"]);
  });

  it("drops Move to worktree when there is nowhere to move to", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    expect(labels({ canMoveToWorktree: false })[0]).toEqual(["Move to dock", "Maximize"]);
  });

  it("disables Move to dock for a kind the dock cannot render", () => {
    registerPluginKind(UNDOCKABLE_PLUGIN_KIND, { dockable: false });
    expect(find({ kind: UNDOCKABLE_PLUGIN_KIND }, "move-to-dock").disabled).toBe(true);
  });

  it("keeps Move to dock enabled for a dockable kind", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    expect(find({}, "move-to-dock").disabled).toBe(false);
  });

  it("never offers Duplicate", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    for (const kind of ["file", "file-browser", "diff", VIEW_PLUGIN_KIND]) {
      const ids = getGenericPanelMenuGroups({
        kind,
        location: "grid",
        isMaximized: false,
        canMoveToWorktree: true,
      })
        .flat()
        .map((command) => command.id as string);
      expect(ids).not.toContain("duplicate");
    }
  });

  it("marks only Remove panel destructive", () => {
    const destructive = getGenericPanelMenuGroups({
      kind: "file",
      location: "grid",
      isMaximized: false,
      canMoveToWorktree: true,
    })
      .flat()
      .filter((command) => command.destructive)
      .map((command) => command.label);
    expect(destructive).toEqual(["Remove panel"]);
  });
});
