import { describe, it, expect } from "vitest";
import { getPluginManifestSchema, PluginToolbarButtonRuntimeStateSchema } from "../plugin.js";

/**
 * A toolbar button carries a short menu of the plugin's own commands (#13786),
 * held to the same rules as a panel's menu.
 */

type ParseResult = ReturnType<ReturnType<typeof getPluginManifestSchema>["safeParse"]>;

const view = { id: "inbox", componentPath: "dist/inbox.js", location: "panel" as const };
const panel = { id: "inbox", name: "Inbox", iconId: "puzzle", color: "#ffffff" };

function parse(button: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return getPluginManifestSchema("user").safeParse({
    name: "acme.inbox",
    version: "1.0.0",
    contributes: {
      toolbarButtons: [{ id: "open", label: "Inbox", iconId: "package", ...button }],
      ...extra,
    },
  });
}

function issuesFor(result: ParseResult, code: string) {
  if (result.success) return [];
  return result.error.issues.filter(
    (i) => (i as { params?: { errorCode?: string } }).params?.errorCode === code
  );
}

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ actionId: `acme.inbox.cmd${i}` }));

describe("toolbar button menu", () => {
  it("accepts a menu beside an action, or as the button's only behaviour", () => {
    const split = parse({ actionId: "acme.inbox.open", menu: items(2) });
    expect(split.success).toBe(true);
    const menuOnly = parse({ menu: [{ actionId: "acme.inbox.cmd0", label: "Sync now" }] });
    expect(menuOnly.success).toBe(true);
    if (!menuOnly.success) return;
    expect(menuOnly.data.contributes.toolbarButtons[0]?.menu).toEqual([
      { actionId: "acme.inbox.cmd0", label: "Sync now" },
    ]);
  });

  it("does not count an empty menu as behaviour", () => {
    const result = parse({ menu: [] });
    expect(issuesFor(result, "toolbar_button_behavior_missing")).toHaveLength(1);
  });

  it("caps the menu at five items", () => {
    expect(parse({ actionId: "acme.inbox.open", menu: items(5) }).success).toBe(true);
    expect(parse({ actionId: "acme.inbox.open", menu: items(6) }).success).toBe(false);
  });

  it("refuses a built-in or foreign action, naming the item", () => {
    for (const actionId of ["terminal.new", "other.plugin.cmd", "acme.inbox.", "acme.inbox"]) {
      const result = parse({ actionId: "acme.inbox.open", menu: [{ actionId }] });
      const [issue] = issuesFor(result, "toolbar_button_menu_action_not_own");
      expect(issue?.path, actionId).toEqual([
        "contributes",
        "toolbarButtons",
        0,
        "menu",
        0,
        "actionId",
      ]);
    }
  });

  it("refuses a repeated action", () => {
    const result = parse({
      actionId: "acme.inbox.open",
      menu: [{ actionId: "acme.inbox.cmd0" }, { actionId: "acme.inbox.cmd0" }],
    });
    expect(issuesFor(result, "toolbar_button_menu_duplicate_action")).toHaveLength(1);
  });

  it("checks items against declared commands only when the plugin declares some", () => {
    const declared = {
      commands: [
        {
          id: "cmd0",
          title: "Cmd",
          description: "A command",
          category: "general",
          kind: "command",
          danger: "safe",
        },
      ],
    };
    const typo = parse(
      { actionId: "acme.inbox.cmd0", menu: [{ actionId: "acme.inbox.cmd9" }] },
      declared
    );
    expect(issuesFor(typo, "action_id_undeclared_command").length).toBeGreaterThan(0);
    expect(
      parse({ actionId: "acme.inbox.open", menu: [{ actionId: "acme.inbox.cmd9" }] }).success
    ).toBe(true);
  });

  it("keeps a popover button from carrying a menu", () => {
    const result = parse(
      { popover: { viewId: "inbox" }, menu: items(1) },
      { panels: [panel], views: [view] }
    );
    expect(issuesFor(result, "toolbar_button_menu_popover_conflict")).toHaveLength(1);
  });

  it("rejects an unknown key on a menu item", () => {
    expect(
      parse({ actionId: "acme.inbox.open", menu: [{ actionId: "acme.inbox.cmd0", args: {} }] })
        .success
    ).toBe(false);
  });
});

describe("runtime toolbar button state menu", () => {
  it("accepts a menu and an empty one that removes it", () => {
    expect(
      PluginToolbarButtonRuntimeStateSchema.safeParse({ menu: [{ actionId: "acme.inbox.cmd0" }] })
        .success
    ).toBe(true);
    expect(PluginToolbarButtonRuntimeStateSchema.safeParse({ menu: [] }).success).toBe(true);
  });

  it("caps it at five and keeps items strict", () => {
    expect(PluginToolbarButtonRuntimeStateSchema.safeParse({ menu: items(6) }).success).toBe(false);
    expect(
      PluginToolbarButtonRuntimeStateSchema.safeParse({
        menu: [{ actionId: "acme.inbox.cmd0", extra: 1 }],
      }).success
    ).toBe(false);
  });
});
