import { describe, expect, it } from "vitest";
import {
  buildDefaultKeybindings,
  KEYBINDING_CATEGORY_ORDER,
} from "@shared/config/defaultKeybindings";
import {
  buildShortcutEntries,
  collapseNumberedSeries,
  groupByCategory,
  orderCategories,
  scopeLabel,
  searchShortcuts,
  type ReferenceBinding,
} from "../shortcutReferenceModel";
import { parseChord } from "@/lib/kbdShortcut";

function registry(isWindows: boolean): ReferenceBinding[] {
  return buildDefaultKeybindings(isWindows).map((binding) => ({
    actionId: binding.actionId,
    scope: binding.scope,
    description: binding.description,
    category: binding.category,
    effectiveCombo: binding.combo,
  }));
}

const noOverrides = () => false;

describe("buildShortcutEntries", () => {
  for (const isWindows of [false, true]) {
    const bindings = registry(isWindows);
    const entries = buildShortcutEntries(bindings, noOverrides);
    const label = isWindows ? "windows" : "mac/linux";

    it(`puts every action in exactly one row (${label})`, () => {
      const seen = new Map<string, number>();
      for (const entry of entries) {
        for (const id of entry.actionIds) seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      for (const binding of bindings) expect(seen.get(binding.actionId), binding.actionId).toBe(1);
    });

    it(`never shows the same name twice in a category (${label})`, () => {
      const keys = entries.map((entry) => `${entry.category}/${entry.description}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it(`keeps every shipped key on the row of the action it fires (${label})`, () => {
      for (const binding of bindings) {
        if (!binding.effectiveCombo) continue;
        const entry = entries.find((e) => e.actionIds.includes(binding.actionId))!;
        expect(
          entry.alternatives.map((alt) => alt.combo),
          binding.actionId
        ).toContain(binding.effectiveCombo);
      }
    });
  }

  it("keeps a scoped alternative's scope when the action is also bound globally", () => {
    const entries = buildShortcutEntries(
      [
        {
          actionId: "a",
          scope: "global",
          description: "Arm",
          category: "Fleet",
          effectiveCombo: "Cmd+J",
        },
        {
          actionId: "a",
          scope: "worktreeGrid",
          description: "Arm (grid)",
          category: "Fleet",
          effectiveCombo: "X",
        },
      ],
      noOverrides
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.alternatives.map((alt) => alt.scope)).toEqual(["global", "worktreeGrid"]);
  });

  it("marks a row custom when any of its actions is overridden, including a cleared one", () => {
    const entries = buildShortcutEntries(
      [
        {
          actionId: "a",
          scope: "global",
          description: "Watch",
          category: "Terminal",
          effectiveCombo: "",
        },
        {
          actionId: "b",
          scope: "global",
          description: "Kill",
          category: "Terminal",
          effectiveCombo: "Cmd+K",
        },
      ],
      (id) => id === "a"
    );
    expect(entries.find((e) => e.actionIds.includes("a"))).toMatchObject({
      isCustom: true,
      alternatives: [],
    });
    expect(entries.find((e) => e.actionIds.includes("b"))!.isCustom).toBe(false);
  });
});

describe("collapseNumberedSeries", () => {
  const series = (digits: number[], custom?: number) =>
    buildShortcutEntries(
      digits.map((d) => ({
        actionId: `switch${d}`,
        scope: "global",
        description: `Switch to worktree ${d}`,
        category: "Worktrees",
        effectiveCombo: d === custom ? "Ctrl+F9" : `Cmd+Alt+${d}`,
      })),
      (id) => custom !== undefined && id === `switch${custom}`
    );

  it("folds an intact numbered family into one row that still names every action", () => {
    const entries = series([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const folded = collapseNumberedSeries(entries);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.actionIds).toEqual(entries.flatMap((e) => e.actionIds));
    expect(folded[0]!.description).toMatch(/1.9$/);
  });

  it("leaves a family with a customised member expanded around it", () => {
    const entries = series([1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
    const folded = collapseNumberedSeries(entries);
    expect(folded.some((e) => e.actionIds.includes("switch5") && e.actionIds.length === 1)).toBe(
      true
    );
    expect(folded.flatMap((e) => e.actionIds).sort()).toEqual(
      entries.flatMap((e) => e.actionIds).sort()
    );
  });

  it("does not fold a gap or a short run", () => {
    expect(collapseNumberedSeries(series([1, 2]))).toHaveLength(2);
    expect(collapseNumberedSeries(series([1, 2, 4, 5]))).toHaveLength(4);
  });

  it("folds the shipped numbered families", () => {
    const groups = groupByCategory(buildShortcutEntries(registry(false), noOverrides));
    const folded = groups.flatMap((g) => g.entries).filter((e) => e.actionIds.length >= 3);
    expect(folded.length).toBeGreaterThanOrEqual(2);
  });
});

describe("orderCategories", () => {
  it("follows the shared browse order and appends unknown categories alphabetically", () => {
    const known = [...KEYBINDING_CATEGORY_ORDER].reverse();
    const ordered = orderCategories(["Zebra plugin", ...known, "Alpha plugin"]);
    expect(ordered.slice(0, known.length)).toEqual([...KEYBINDING_CATEGORY_ORDER]);
    expect(ordered.slice(known.length)).toEqual(["Alpha plugin", "Zebra plugin"]);
  });

  it("covers every shipped category", () => {
    const shipped = new Set(buildDefaultKeybindings(true).map((b) => b.category ?? "Other"));
    for (const category of shipped) expect(KEYBINDING_CATEGORY_ORDER, category).toContain(category);
  });

  it("uses sentence case for every shipped category name", () => {
    for (const category of KEYBINDING_CATEGORY_ORDER) {
      expect(category.slice(1), category).toBe(category.slice(1).toLowerCase());
    }
  });
});

describe("scopeLabel", () => {
  it("names every shipped non-global scope and leaves global unlabelled", () => {
    const scopes = new Set(buildDefaultKeybindings(true).map((b) => b.scope));
    for (const scope of scopes) {
      const label = scopeLabel(scope);
      if (scope === "global") expect(label).toBeNull();
      else expect(label, scope).toMatch(/^In [a-z ]+$/);
    }
  });
});

describe("searchShortcuts", () => {
  const entries = buildShortcutEntries(registry(false), noOverrides);

  it("returns null for an empty query, so the grouped view shows", () => {
    expect(searchShortcuts(entries, "   ", true)).toBeNull();
  });

  it("ranks names that contain the query as a word ahead of anything else", () => {
    const results = searchShortcuts(entries, "agent", true)!;
    const firstMiss = results.findIndex((e) => !/\bagent/i.test(e.description));
    const lastHit = results.map((e) => /\bagent/i.test(e.description)).lastIndexOf(true);
    expect(lastHit).toBeGreaterThan(0);
    if (firstMiss !== -1) expect(firstMiss).toBeGreaterThan(lastHit);
  });

  it("finds a multi-word query as words, not as a key combination", () => {
    const results = searchShortcuts(entries, "focused terminal", true)!;
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results.slice(0, 3)) expect(entry.description).toMatch(/focused terminal/i);
  });

  it("filters by key prefix when the query reads as keys", () => {
    const results = searchShortcuts(entries, "⌘K", true)!;
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) {
      expect(entry.alternatives.some((alt) => /^Cmd\+K /i.test(alt.combo))).toBe(true);
    }
  });

  it("lists every key using a lone modifier", () => {
    const results = searchShortcuts(entries, "ctrl", true)!;
    expect(results.length).toBeGreaterThan(0);
    for (const entry of results) {
      expect(entry.alternatives.some((alt) => /(^|[+ ])Ctrl\+/.test(alt.combo))).toBe(true);
    }
  });

  it("does not treat an inherited object key as a modifier", () => {
    expect(() => searchShortcuts(entries, "constructor", true)).not.toThrow();
    expect(searchShortcuts(entries, "constructor", true)).toEqual([]);
  });

  it("finds unset shortcuts by asking for them", () => {
    const results = searchShortcuts(entries, "not set", true)!;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((e) => e.alternatives.length === 0)).toBe(true);
  });

  it("falls back to fuzzy matching only when nothing matches as words", () => {
    expect(searchShortcuts(entries, "stsh", true)!.some((e) => /stash/i.test(e.description))).toBe(
      true
    );
  });

  for (const mac of [true, false]) {
    const platform = mac ? "macOS" : "Windows/Linux";
    const platformEntries = buildShortcutEntries(registry(!mac), noOverrides);

    it(`finds every key typed exactly as the reference prints it (${platform})`, () => {
      for (const entry of platformEntries) {
        for (const alt of entry.alternatives) {
          const printed = parseChord(alt.combo, mac)
            .map((keys) => keys.join(mac ? "" : "+"))
            .join(", ");
          const results = searchShortcuts(platformEntries, printed, mac) ?? [];
          expect(results, `${printed} (${entry.description})`).toContain(entry);
        }
      }
    });

    it(`never returns a row whose keys don't start with a typed chord (${platform})`, () => {
      const results = searchShortcuts(platformEntries, mac ? "⌘K" : "Ctrl+K", mac)!;
      expect(results.length).toBeGreaterThan(0);
      for (const entry of results) {
        const starts = entry.alternatives.some((alt) => /^(Cmd|Ctrl)\+K( |$)/.test(alt.combo));
        expect(starts, entry.description).toBe(true);
      }
    });
  }

  it("reads a comma straight after a modifier as the comma key", () => {
    const results = searchShortcuts(entries, "⌘,", true)!;
    expect(results.map((e) => e.description)).toContain("Open settings");
  });

  it("keeps typed words out of key matching", () => {
    for (const query of ["tab", "shift focus", "command palette"]) {
      const results = searchShortcuts(entries, query, true)!;
      for (const entry of results.slice(0, 1)) {
        expect(entry.description.toLowerCase(), query).toContain(query.split(" ").pop()!);
      }
    }
  });
});
