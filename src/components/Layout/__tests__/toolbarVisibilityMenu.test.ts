// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import type { ToolbarButtonMetadata } from "../toolbarButtonMetadata";
import {
  buildToolbarVisibilityMenuRows,
  isToolbarEmptySpaceTarget,
  resolveToolbarButtonMetadata,
  type ToolbarVisibilityMenuRowSource,
} from "../toolbarVisibilityMenu";

const Icon = () => null;

function meta(label: string): ToolbarButtonMetadata {
  return { label, icon: Icon, description: `${label} description` };
}

const METADATA: Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>> = {
  terminal: meta("Terminal"),
  browser: meta("Browser"),
  "forge-stats": meta("Repository stats"),
  "notification-center": meta("Notifications"),
  settings: meta("Settings"),
};

function source(overrides: Partial<ToolbarVisibilityMenuRowSource> = {}) {
  return {
    resolveMetadata: (id: AnyToolbarButtonId) => resolveToolbarButtonMetadata(id, METADATA, {}),
    canRender: () => true,
    isOnToolbar: () => true,
    ...overrides,
  };
}

describe("buildToolbarVisibilityMenuRows", () => {
  it("keeps each side's order and tags every row with the side it sits on", () => {
    const rows = buildToolbarVisibilityMenuRows(
      ["browser", "terminal"],
      ["settings", "forge-stats"],
      source()
    );

    expect(rows.left.map((row) => [row.id, row.side])).toEqual([
      ["browser", "left"],
      ["terminal", "left"],
    ]);
    expect(rows.right.map((row) => [row.id, row.side])).toEqual([
      ["settings", "right"],
      ["forge-stats", "right"],
    ]);
  });

  it("draws each checkmark from the placement resolver, so hidden buttons stay listed", () => {
    const hidden = new Set<AnyToolbarButtonId>(["forge-stats"]);
    const rows = buildToolbarVisibilityMenuRows(
      ["terminal"],
      ["forge-stats"],
      source({ isOnToolbar: (id) => !hidden.has(id) })
    );

    expect(rows.left[0]?.checked).toBe(true);
    expect(rows.right.map((row) => [row.label, row.checked])).toEqual([
      ["Repository stats", false],
    ]);
  });

  it("drops a button the view cannot draw and one with no name to show", () => {
    const rows = buildToolbarVisibilityMenuRows(
      ["terminal", "problems"],
      ["notification-center", "settings"],
      source({ canRender: (id) => id !== "notification-center" })
    );

    // `problems` has no metadata in this fixture; notifications are disabled.
    expect(rows.left.map((row) => row.id)).toEqual(["terminal"]);
    expect(rows.right.map((row) => row.id)).toEqual(["settings"]);
  });

  it("lists an id that sits on both sides once, on the side it appears first", () => {
    const rows = buildToolbarVisibilityMenuRows(["terminal"], ["terminal", "settings"], source());

    expect(rows.left.map((row) => row.id)).toEqual(["terminal"]);
    expect(rows.right.map((row) => row.id)).toEqual(["settings"]);
  });

  it("returns empty sides when nothing qualifies", () => {
    const rows = buildToolbarVisibilityMenuRows(
      ["terminal"],
      [],
      source({ canRender: () => false })
    );

    expect(rows).toEqual({ left: [], right: [] });
  });
});

describe("resolveToolbarButtonMetadata", () => {
  it("prefers the built-in entry and falls back to the live registry entry", () => {
    const pluginMeta = meta("Deploy");

    expect(resolveToolbarButtonMetadata("terminal", METADATA, { terminal: meta("Shadow") })).toBe(
      METADATA.terminal
    );
    expect(resolveToolbarButtonMetadata("copy-tree", METADATA, { "copy-tree": pluginMeta })).toBe(
      pluginMeta
    );
  });

  it("ignores entries the lookup tables only inherit", () => {
    const inherited: Record<string, ToolbarButtonMetadata> = Object.create({
      "copy-tree": meta("Inherited"),
    });

    expect(resolveToolbarButtonMetadata("copy-tree", METADATA, inherited)).toBeUndefined();
  });
});

describe("isToolbarEmptySpaceTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mountToolbar() {
    // The outer no-drag wrapper proves a match *above* the root never counts.
    document.body.innerHTML = `
      <div class="app-no-drag">
        <div id="root" role="toolbar" class="app-drag-region">
          <div id="group">
            <div id="divider"></div>
            <div data-toolbar-button-id="terminal" class="app-no-drag">
              <button id="button" data-toolbar-item=""><svg id="glyph"></svg></button>
            </div>
          </div>
          <div class="app-no-drag"><button id="chrome"></button></div>
          <span id="bare-item" data-toolbar-item=""></span>
        </div>
      </div>
      <div id="portal"><button id="portaled"></button></div>
    `;
  }

  function byId(id: string): Element {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing #${id}`);
    return element;
  }

  it("treats the root, a group container, and a divider as empty space", () => {
    mountToolbar();
    const root = byId("root");

    expect(isToolbarEmptySpaceTarget(root, root)).toBe(true);
    expect(isToolbarEmptySpaceTarget(byId("group"), root)).toBe(true);
    expect(isToolbarEmptySpaceTarget(byId("divider"), root)).toBe(true);
  });

  it("refuses a button slot, anything drawn inside it, fixed chrome, and a bare toolbar item", () => {
    mountToolbar();
    const root = byId("root");

    expect(isToolbarEmptySpaceTarget(byId("button"), root)).toBe(false);
    expect(isToolbarEmptySpaceTarget(byId("glyph"), root)).toBe(false);
    expect(isToolbarEmptySpaceTarget(byId("chrome"), root)).toBe(false);
    expect(isToolbarEmptySpaceTarget(byId("bare-item"), root)).toBe(false);
  });

  it("refuses content outside the toolbar's DOM, such as a portaled menu, and a missing target", () => {
    mountToolbar();
    const root = byId("root");

    expect(isToolbarEmptySpaceTarget(byId("portaled"), root)).toBe(false);
    expect(isToolbarEmptySpaceTarget(null, root)).toBe(false);
  });
});
