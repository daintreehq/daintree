import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import { PANEL_TOOLBAR_MAX_ITEMS } from "../../../shared/types/plugin.js";

const schema = getPluginManifestSchema("user");

function panel(toolbar: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "ledger",
    name: "Ledger",
    iconId: "wallet",
    color: "var(--theme-category-blue)",
    toolbar,
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
    name: "acme.ledger",
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

describe("contributes.panels[].toolbar", () => {
  it("accepts the plugin's own actions with every optional field, in order", () => {
    const result = parse([
      panel([
        {
          actionId: "acme.ledger.refresh-quotes",
          label: "Refresh prices",
          iconId: "./icons/refresh.svg",
          status: true,
        },
        { actionId: "acme.ledger.export" },
      ]),
    ]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.panels[0]!.toolbar).toEqual([
      {
        actionId: "acme.ledger.refresh-quotes",
        label: "Refresh prices",
        iconId: "./icons/refresh.svg",
        status: true,
      },
      { actionId: "acme.ledger.export" },
    ]);
  });

  it(`accepts ${PANEL_TOOLBAR_MAX_ITEMS} entries and refuses one more`, () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ actionId: `acme.ledger.action-${i}` }));

    expect(parse([panel(entries(PANEL_TOOLBAR_MAX_ITEMS))]).success).toBe(true);
    const over = parse([panel(entries(PANEL_TOOLBAR_MAX_ITEMS + 1))]);
    expect(over.success).toBe(false);
    expect(errorCodes(over)).toContain("too_big");
  });

  it.each([
    ["a built-in action", "terminal.list"],
    ["another plugin's action", "other.plugin.refresh"],
    ["the bare namespace", "acme.ledger."],
    ["an id the host would refuse to register", "acme.ledger.re fresh"],
    ["a name that only shares a prefix", "acme.ledgers.refresh"],
  ])("refuses %s", (_label, actionId) => {
    const result = parse([panel([{ actionId }])]);

    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("panel_toolbar_action_not_own");
  });

  it("holds an own-namespace id to the declared commands when there are any", () => {
    const typo = parse([panel([{ actionId: "acme.ledger.refesh" }])], [command("refresh")]);
    expect(errorCodes(typo)).toContain("action_id_undeclared_command");

    expect(
      parse([panel([{ actionId: "acme.ledger.refresh" }])], [command("refresh")]).success
    ).toBe(true);
  });

  it("refuses the same action twice in one toolbar, but not the same action in the menu too", () => {
    const twice = parse([
      panel([{ actionId: "acme.ledger.refresh" }, { actionId: "acme.ledger.refresh" }]),
    ]);
    expect(errorCodes(twice)).toContain("panel_toolbar_duplicate_action");

    const alsoInMenu = parse([
      panel([{ actionId: "acme.ledger.refresh" }], {
        menu: [{ actionId: "acme.ledger.refresh" }],
      }),
    ]);
    expect(alsoInMenu.success).toBe(true);
  });

  it("refuses a toolbar on a PTY-backed panel, whose terminal header would never show it", () => {
    const result = parse([panel([{ actionId: "acme.ledger.refresh" }], { hasPty: true })]);

    expect(errorCodes(result)).toContain("pty_panel_toolbar_unsupported");
  });

  it.each([
    ["an empty label", { actionId: "acme.ledger.refresh", label: "  " }],
    ["an empty icon", { actionId: "acme.ledger.refresh", iconId: "" }],
    ["a non-boolean status", { actionId: "acme.ledger.refresh", status: "yes" }],
    ["an unknown field", { actionId: "acme.ledger.refresh", placement: "end" }],
    ["a missing action", { label: "Refresh" }],
  ])("refuses an entry with %s", (_label, entry) => {
    expect(parse([panel([entry])]).success).toBe(false);
  });
});
