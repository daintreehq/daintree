import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import {
  LIST_DETAIL_ROW_CLASS,
  LIST_ROW_HOVER_CLASS,
  ROW_MENU_TARGET_CLASS,
} from "@/components/ui/paletteRowStyles";

/**
 * The file-list row family (docs/themes/interaction-state-recipes.md, "List Row
 * Hover" and "Row Menu Target"): the file tree, the diff file shelf, the
 * cross-worktree diff, the worktree change list and overview, and the Review
 * Hub rows. They drifted into a hover (`tint/5`) brighter than their selection
 * (`overlay-subtle`), and into a menu-open tier that on light themes was the
 * selection's own colour. These pin the rules, not the values.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");

const FAMILY = [
  "src/panels/file-browser/FileTreeView.tsx",
  "src/panels/file-browser/FolderListingView.tsx",
  "src/panels/file-browser/FileBrowserPane.tsx",
  "src/panels/file-browser/FileBrowserChangeSummary.tsx",
  "src/components/FileViewer/DiffFileSidebar.tsx",
  "src/components/Worktree/CrossWorktreeDiff.tsx",
  "src/components/Worktree/FileChangeList.tsx",
  "src/components/Worktree/WorktreeOverviewRow.tsx",
  "src/components/Worktree/ReviewHub/FileStageRow.tsx",
  "src/components/Worktree/ReviewHub/BaseBranchFileRow.tsx",
  "src/components/Worktree/ReviewHub/ConflictPanel.tsx",
];

/** Source with comments stripped, so prose that names a class is not a use of it. */
function code(rel: string): string {
  return fs
    .readFileSync(path.join(REPO_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const family = FAMILY.map((rel) => ({ rel, source: code(rel) }));

describe("file-list rows", () => {
  it("hover with the overlay ladder, never a raw tint", () => {
    // `tint/N` is not on the ladder the selection is measured against, which is
    // how a 5% hover ended up over a 2% selection.
    const offenders = family
      .flatMap(({ rel, source }) =>
        (source.match(/hover:bg-tint\/[\w.[\]]+/g) ?? []).map((m) => `${rel}: ${m}`)
      )
      .sort();
    expect(offenders).toEqual([]);
  });

  it("never pick the selected fill with a JS ternary beside a hover of their own", () => {
    // The drift this family had: `isSelected ? "bg-…" : "hover:bg-…"`. The shared
    // classes key both off the rendered attribute instead.
    // The pane's split handle has a pressed state, not a selection.
    const offenders = family
      .filter(({ rel }) => rel !== "src/panels/file-browser/FileBrowserPane.tsx")
      .filter(({ source }) => /\?\s*"bg-overlay-[\w-]+[^"]*"\s*:\s*"hover:bg-/.test(source))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("mark an open row menu only with the shared ring", () => {
    const handRolled = family
      .flatMap(({ rel, source }) =>
        (source.match(/data-\[state=open\]:[\w[\]/.:-]+/g) ?? []).map((m) => `${rel}: ${m}`)
      )
      .sort();
    expect(handRolled).toEqual([]);

    const menuRows = family.filter(({ source }) => /<ContextMenuTrigger\b/.test(source));
    expect(menuRows.length).toBeGreaterThan(0);
    for (const { rel, source } of menuRows) {
      expect(
        /\b(ROW_MENU_TARGET_CLASS|LIST_DETAIL_ROW_CLASS)\b/.test(source),
        `${rel} opens a row menu without marking which row it targets`
      ).toBe(true);
    }
  });

  it("name a radius step instead of the bare `rounded` that renders the large one", () => {
    const offenders = family
      .flatMap(({ rel, source }) => (/["\s]rounded(?=["\s])/.test(source) ? [rel] : []))
      .sort();
    expect(offenders).toEqual([]);
  });
});

describe("list-row states", () => {
  const classes = (value: string) => value.split(/\s+/).filter(Boolean);

  it("give the menu target no fill, so it can never collide with hover or selection", () => {
    // On light themes `overlay-raised` resolves to the highlight's own colour; a
    // fill tier here had no free rung left on the ladder.
    const fills = classes(ROW_MENU_TARGET_CLASS).filter((c) => /(^|:)bg-/.test(c));
    expect(fills).toEqual([]);
    expect(classes(ROW_MENU_TARGET_CLASS).some((c) => /:outline(-\d)?$/.test(c))).toBe(true);
  });

  it("never paint hover on the selected row, whichever attribute carries selection", () => {
    for (const c of classes(LIST_ROW_HOVER_CLASS).filter((c) => /hover:bg-/.test(c))) {
      expect(c).toMatch(/not-aria-selected:/);
      expect(c).toMatch(/not-data-\[selected=true\]:/);
    }
    const detail = classes(LIST_DETAIL_ROW_CLASS);
    for (const part of [...classes(LIST_ROW_HOVER_CLASS), ...classes(ROW_MENU_TARGET_CLASS)]) {
      expect(detail).toContain(part);
    }
  });

  it("hover with a lighter step than the selection fill on every built-in theme", () => {
    const hoverToken = /hover:bg-([\w-]+)/.exec(LIST_ROW_HOVER_CLASS)![1]!;
    const selectedToken = /aria-selected:bg-([\w-]+)/.exec(LIST_DETAIL_ROW_CLASS)![1]!;
    const alpha = (v: string) => {
      const m = v.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
      return m ? Number(m[1]) : v.startsWith("#") ? 1 : null;
    };
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const tokens = scheme.tokens as Record<string, string>;
      const hover = tokens[hoverToken]!;
      const selected = tokens[selectedToken]!;
      expect(hover, `${scheme.id}: hover must not read as the selection`).not.toBe(selected);
      const a = alpha(hover);
      const b = alpha(selected);
      if (a !== null && b !== null) {
        expect(a, `${scheme.id}: ${hoverToken} vs ${selectedToken}`).toBeLessThanOrEqual(b);
      }
    }
  });
});
