import { describe, it, expect } from "vitest";
import type { KeyScope } from "@shared/types/keybinding";
import {
  buildShortcutRows,
  distinctCombos,
  findShortcutRow,
  overrideScopes,
  replaceCombo,
  scopeNote,
  type ShortcutRowSource,
} from "../shortcutRows";

function source(
  actionId: string,
  combo: string,
  scope: KeyScope,
  description = actionId,
  override?: string[]
): ShortcutRowSource {
  return {
    actionId,
    combo,
    scope,
    priority: 0,
    description,
    category: "Test",
    effectiveCombos: override ?? (combo ? [combo] : []),
  };
}

const fleet = (override?: string[]) => [
  source("fleet.armFocused", "Cmd+J", "global", "Arm (join)", override),
  source("fleet.armFocused", "X", "worktreeGrid", "Arm (grid only)", override),
];

describe("distinctCombos", () => {
  it("drops empty entries and platform-equivalent repeats, keeping the first spelling", () => {
    expect(distinctCombos(["Cmd+K", "", "  ", "Ctrl+K", "Cmd+K Cmd+R"], false)).toEqual([
      "Cmd+K",
      "Cmd+K Cmd+R",
    ]);
  });

  it("keeps Cmd and Ctrl apart on macOS", () => {
    expect(distinctCombos(["Cmd+K", "Ctrl+K"], true)).toEqual(["Cmd+K", "Ctrl+K"]);
  });
});

describe("replaceCombo", () => {
  it("swaps one key in place and keeps the others", () => {
    expect(replaceCombo(["Cmd+=", "Cmd+Shift+="], "Cmd+Shift+=", "Cmd+K", true)).toEqual([
      "Cmd+=",
      "Cmd+K",
    ]);
    expect(replaceCombo(["Cmd+J", "X"], "Cmd+J", "Cmd+L", true)).toEqual(["Cmd+L", "X"]);
  });

  it("drops only the row's key on a removal, down to an empty list", () => {
    expect(replaceCombo(["Cmd+J", "X"], "X", "", true)).toEqual(["Cmd+J"]);
    expect(replaceCombo(["Cmd+J"], "Cmd+J", "", true)).toEqual([]);
  });

  it("adds to the list from a row with no key", () => {
    expect(replaceCombo(["Cmd+J"], "", "Y", true)).toEqual(["Cmd+J", "Y"]);
    expect(replaceCombo([], "", "Y", true)).toEqual(["Y"]);
  });

  it("removes nothing for a key the action no longer holds", () => {
    expect(replaceCombo(["Cmd+J"], "X", "", true)).toEqual(["Cmd+J"]);
    expect(replaceCombo(["Cmd+J"], "X", "Y", true)).toEqual(["Cmd+J", "Y"]);
  });

  it("treats a platform-equivalent spelling as the row's key and folds repeats", () => {
    expect(replaceCombo(["Cmd+K", "Ctrl+K", "X"], "Ctrl+K", "", false)).toEqual(["X"]);
    expect(replaceCombo(["Cmd+K", "X"], "X", "Cmd+K", false)).toEqual(["Cmd+K"]);
  });

  it("edits a chord as one key", () => {
    expect(replaceCombo(["Cmd+K Cmd+R", "Cmd+R"], "Cmd+K Cmd+R", "", true)).toEqual(["Cmd+R"]);
  });
});

describe("overrideScopes and scopeNote", () => {
  it("collapses to global once any registration is global", () => {
    expect(overrideScopes(["worktreeGrid", "global"])).toEqual(["global"]);
    expect(scopeNote(overrideScopes(["worktreeGrid", "global"]))).toBe("Across the app");
  });

  it("names every scope when none is global", () => {
    const scopes = overrideScopes(["portal", "dev-preview", "portal"]);
    expect(scopes).toEqual(["portal", "dev-preview"]);
    expect(scopeNote(scopes)).toBe("In the portal and in dev preview");
  });
});

describe("buildShortcutRows", () => {
  it("keeps a row per default registration, each with its own key and scope", () => {
    const rows = buildShortcutRows(fleet(), () => false, true);
    expect(rows.map((row) => [row.key, row.scopeNote, row.otherKeys])).toEqual([
      ["Cmd+J", "Across the app", ["X"]],
      ["X", "In an expanded worktree card", ["Cmd+J"]],
    ]);
    expect(rows.every((row) => row.editScope === "global")).toBe(true);
  });

  it("says before the first edit which keys will apply more widely", () => {
    const [joinRow, gridRow] = buildShortcutRows(fleet(), () => false, true);
    // Saved from the global row, X stays but is no longer grid-only.
    expect(joinRow!.widening).toEqual({ self: false, keys: ["X"], where: "across the app" });
    // Saved from the grid row, the new key applies across the app; Cmd+J already did.
    expect(gridRow!.widening).toEqual({ self: true, keys: [], where: "across the app" });
  });

  it("warns of nothing when every key already applies where an override would", () => {
    const rows = buildShortcutRows(
      [source("window.zoomIn", "Cmd+=", "global"), source("window.zoomIn", "Cmd+Shift+=", "global")],
      () => false,
      true
    );
    expect(rows.map((row) => row.widening)).toEqual([undefined, undefined]);
    expect(rows.map((row) => row.scopeNote)).toEqual(["Across the app", "Across the app"]);
  });

  it("shows an override as one row per key, with the scope it really has", () => {
    const rows = buildShortcutRows(fleet(["Cmd+J", "Y"]), () => true, true);
    expect(rows.map((row) => [row.key, row.scopeNote, row.description, row.otherKeys])).toEqual([
      ["Cmd+J", "Across the app", "Arm (join)", ["Y"]],
      ["Y", "Across the app", "Arm (join)", ["Cmd+J"]],
    ]);
    expect(rows.every((row) => row.isOverridden && row.widening === undefined)).toBe(true);
    expect(new Set(rows.map((row) => row.rowId)).size).toBe(2);
  });

  it("drops the scope note once an override leaves one key, and shows a keyless row for none", () => {
    expect(
      buildShortcutRows(fleet(["Cmd+J"]), () => true, true).map((r) => [r.key, r.scopeNote])
    ).toEqual([["Cmd+J", undefined]]);
    expect(
      buildShortcutRows(fleet([]), () => true, true).map((r) => [r.key, r.scopeNote])
    ).toEqual([["", undefined]]);
  });

  it("shows an imported override's repeated keys once", () => {
    const rows = buildShortcutRows(
      [source("app.save", "Cmd+S", "global", "Save", ["Cmd+S", "", "Ctrl+S", "Cmd+S"])],
      () => true,
      false
    );
    expect(rows.map((row) => row.key)).toEqual(["Cmd+S"]);
  });

  it("leaves other actions' rows where they were", () => {
    const rows = buildShortcutRows(
      [
        source("a", "Cmd+A", "global"),
        ...fleet(["Y", "Z"]),
        source("b", "Cmd+B", "global"),
      ],
      (actionId) => actionId === "fleet.armFocused",
      true
    );
    expect(rows.map((row) => row.key)).toEqual(["Cmd+A", "Y", "Z", "Cmd+B"]);
  });

  it("keeps a plugin's exact duplicate registration on its own row", () => {
    const rows = buildShortcutRows(
      [source("app.save", "Cmd+S", "global"), source("app.save", "Cmd+S", "global")],
      () => false,
      true
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.rowId)).size).toBe(2);
    expect(rows.map((row) => row.otherKeys)).toEqual([[], []]);
  });
});

describe("findShortcutRow", () => {
  const rows = buildShortcutRows(fleet(["Cmd+J", "Y"]), () => true, true);

  it("finds the row holding the key", () => {
    expect(findShortcutRow(rows, "fleet.armFocused", "Y", true)?.key).toBe("Y");
  });

  it("falls back to the action's first row", () => {
    expect(findShortcutRow(rows, "fleet.armFocused", "Q", true)?.key).toBe("Cmd+J");
    expect(findShortcutRow(rows, "fleet.armFocused", "", true)?.key).toBe("Cmd+J");
    expect(findShortcutRow(rows, "missing", "Y", true)).toBeUndefined();
  });
});
