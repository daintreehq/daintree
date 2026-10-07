import { describe, expect, it } from "vitest";
import { normalizePanelMenuItems, samePanelMenuItems } from "../pluginPanelMenuItems.js";
import { PANEL_MENU_LABEL_MAX, PANEL_RUNTIME_MENU_MAX_ITEMS } from "../../types/plugin.js";

const MANIFEST = "acme.board";
const PROJECT_INSTANCE = "project__p1__acme.board";

describe("normalizePanelMenuItems", () => {
  it("keeps the plugin's own actions in order, labelled or not", () => {
    expect(
      normalizePanelMenuItems(
        [{ actionId: "acme.board.open" }, { actionId: "acme.board.export", label: "CSV" }],
        MANIFEST,
        MANIFEST
      )
    ).toEqual({
      ok: true,
      items: [{ actionId: "acme.board.open" }, { actionId: "acme.board.export", label: "CSV" }],
    });
  });

  it("rewrites the authored namespace into a project instance's", () => {
    expect(
      normalizePanelMenuItems([{ actionId: "acme.board.open" }], MANIFEST, PROJECT_INSTANCE)
    ).toEqual({ ok: true, items: [{ actionId: `${PROJECT_INSTANCE}.open` }] });
  });

  it("treats null, undefined and [] as clearing", () => {
    for (const items of [null, undefined, []]) {
      expect(normalizePanelMenuItems(items, MANIFEST, MANIFEST)).toEqual({ ok: true, items: [] });
    }
  });

  it("trims a label, drops a blank one and cuts a long one", () => {
    const result = normalizePanelMenuItems(
      [
        { actionId: "acme.board.a", label: "  Open  " },
        { actionId: "acme.board.b", label: "   " },
        { actionId: "acme.board.c", label: "x".repeat(PANEL_MENU_LABEL_MAX + 20) },
      ],
      MANIFEST,
      MANIFEST
    );
    expect(result).toEqual({
      ok: true,
      items: [
        { actionId: "acme.board.a", label: "Open" },
        { actionId: "acme.board.b" },
        { actionId: "acme.board.c", label: "x".repeat(PANEL_MENU_LABEL_MAX) },
      ],
    });
  });

  it.each([
    ["a built-in action", [{ actionId: "terminal.kill" }]],
    ["another plugin's action", [{ actionId: "other.plugin.run" }]],
    ["the bare namespace", [{ actionId: "acme.board." }]],
    ["a non-string id", [{ actionId: 42 }]],
    ["a non-object entry", ["acme.board.open"]],
    ["a non-string label", [{ actionId: "acme.board.open", label: 7 }]],
    ["a repeated action", [{ actionId: "acme.board.open" }, { actionId: "acme.board.open" }]],
    ["a non-array", { actionId: "acme.board.open" }],
  ])("refuses the whole list for %s", (_label, items) => {
    expect(normalizePanelMenuItems(items, MANIFEST, MANIFEST).ok).toBe(false);
  });

  it(`accepts ${PANEL_RUNTIME_MENU_MAX_ITEMS} entries and refuses one more`, () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ actionId: `acme.board.a${i}` }));
    expect(
      normalizePanelMenuItems(entries(PANEL_RUNTIME_MENU_MAX_ITEMS), MANIFEST, MANIFEST).ok
    ).toBe(true);
    expect(
      normalizePanelMenuItems(entries(PANEL_RUNTIME_MENU_MAX_ITEMS + 1), MANIFEST, MANIFEST).ok
    ).toBe(false);
  });

  it("ignores inherited fields rather than reading a prototype's actionId", () => {
    const entry = Object.create({ actionId: "acme.board.open" }) as object;
    expect(normalizePanelMenuItems([entry], MANIFEST, MANIFEST).ok).toBe(false);
  });
});

describe("samePanelMenuItems", () => {
  it("compares entries in order, label included", () => {
    const a = [{ actionId: "x.a" }, { actionId: "x.b", label: "B" }];
    expect(samePanelMenuItems(a, [{ actionId: "x.a" }, { actionId: "x.b", label: "B" }])).toBe(
      true
    );
    expect(samePanelMenuItems(a, [{ actionId: "x.b", label: "B" }, { actionId: "x.a" }])).toBe(
      false
    );
    expect(samePanelMenuItems(a, [{ actionId: "x.a" }, { actionId: "x.b" }])).toBe(false);
    expect(samePanelMenuItems(a, [{ actionId: "x.a" }])).toBe(false);
  });
});
