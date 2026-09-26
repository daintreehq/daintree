import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import { PANEL_MENU_MAX_ITEMS } from "../../../shared/types/plugin.js";

const schema = getPluginManifestSchema("user");

function panel(menu: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "board",
    name: "Board",
    iconId: "kanban",
    color: "var(--theme-category-orange)",
    menu,
    ...overrides,
  };
}

function command(id: string) {
  return {
    id,
    title: id,
    description: "",
    category: "general",
    kind: "command",
    danger: "safe",
  };
}

function parse(panels: unknown[], commands: unknown[] = []) {
  return schema.safeParse({
    name: "acme.board",
    version: "1.0.0",
    contributes: { panels, commands },
  });
}

function errorCodes(result: ReturnType<typeof parse>): unknown[] {
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: unknown } }).params?.errorCode ?? issue.code
  );
}

describe("contributes.panels[].menu", () => {
  it("accepts the plugin's own actions, with and without a label, and keeps their order", () => {
    const result = parse([
      panel([{ actionId: "acme.board.refresh" }, { actionId: "acme.board.export", label: "CSV" }]),
    ]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.panels[0]!.menu).toEqual([
      { actionId: "acme.board.refresh" },
      { actionId: "acme.board.export", label: "CSV" },
    ]);
  });

  it(`accepts ${PANEL_MENU_MAX_ITEMS} entries and refuses one more`, () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ actionId: `acme.board.action-${i}` }));

    expect(parse([panel(entries(PANEL_MENU_MAX_ITEMS))]).success).toBe(true);
    const over = parse([panel(entries(PANEL_MENU_MAX_ITEMS + 1))]);
    expect(over.success).toBe(false);
    expect(errorCodes(over)).toContain("too_big");
  });

  it.each([
    ["a built-in action", "terminal.list"],
    ["another plugin's action", "other.plugin.refresh"],
    ["the bare namespace", "acme.board."],
    ["an id the host would refuse to register", "acme.board.re fresh"],
    ["a name that only shares a prefix", "acme.boardroom.refresh"],
  ])("refuses %s", (_label, actionId) => {
    const result = parse([panel([{ actionId }])]);

    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("panel_menu_action_not_own");
  });

  it("accepts any id the host can register, capitals included", () => {
    expect(parse([panel([{ actionId: "acme.board.Refresh" }])], [command("Refresh")]).success).toBe(
      true
    );
  });

  it("holds an own-namespace id to the declared commands when there are any", () => {
    const typo = parse([panel([{ actionId: "acme.board.refesh" }])], [command("refresh")]);
    expect(errorCodes(typo)).toContain("action_id_undeclared_command");

    expect(parse([panel([{ actionId: "acme.board.refresh" }])], [command("refresh")]).success).toBe(
      true
    );
  });

  it("refuses the same action twice in one menu", () => {
    const result = parse([
      panel([
        { actionId: "acme.board.refresh" },
        { actionId: "acme.board.refresh", label: "Again" },
      ]),
    ]);

    expect(errorCodes(result)).toContain("panel_menu_duplicate_action");
  });

  it("refuses a menu on a PTY-backed panel, whose terminal menus would never show it", () => {
    const result = parse([panel([{ actionId: "acme.board.refresh" }], { hasPty: true })]);

    expect(errorCodes(result)).toContain("pty_panel_menu_unsupported");
  });

  it.each([
    ["an empty label", { actionId: "acme.board.refresh", label: "  " }],
    ["an unknown field", { actionId: "acme.board.refresh", icon: "star" }],
    ["a missing action", { label: "Refresh" }],
  ])("refuses an entry with %s", (_label, entry) => {
    expect(parse([panel([entry])]).success).toBe(false);
  });
});
