import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

/**
 * The fixed control zone at the top of the Worktrees sidebar — the title row,
 * the search/filter rail, and the status line under them (#11991).
 *
 * These assert rules about how the zone is composed, not the particular
 * spacing values it is composed from, so a later density pass restates the
 * numbers in one place instead of here as well.
 */
const SIDEBAR_CONTENT = path.resolve(__dirname, "../SidebarContent.tsx");
const SEARCH_BAR = path.resolve(__dirname, "../../Worktree/WorktreeSidebarSearchBar.tsx");
/** Unique to the rail's own element — the bare class name also appears in prose. */
const RAIL_MARKER = 'variant === "sidebar" && "worktree-filter-bar"';

/**
 * The class string of the row element that carries `marker`.
 *
 * Comments are stripped first: both rows explain themselves in a comment
 * between `cn(` and its first argument, and one of the markers also appears in
 * the file's own doc block.
 */
function rowClasses(chunk: string, marker: string): string {
  const stripped = chunk.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const at = stripped.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const from = stripped.lastIndexOf("<div", at);
  expect(from).toBeGreaterThan(-1);
  // Window past the marker: the class string it identifies continues beyond it.
  const slice = stripped.slice(from, from + 600);
  return slice.match(/className=(?:"|\{cn\(\s*")([^"]*)"/)?.[1] ?? "";
}

function inset(classes: string): string | null {
  return classes.match(/\bpx-[\d.]+\b/)?.[0] ?? null;
}

describe("Worktrees sidebar control zone — issue #11991", () => {
  let sidebar: string;
  let searchBar: string;

  beforeAll(async () => {
    sidebar = await fs.readFile(SIDEBAR_CONTENT, "utf-8");
    searchBar = await fs.readFile(SEARCH_BAR, "utf-8");
  });

  it("carries exactly one horizontal rule, at the bottom of the whole zone", () => {
    // The header used to draw a rule and the rail drew another, putting two
    // hairlines inside the first 90px of the sidebar with the list's own
    // dividers immediately below. Whichever row is last owns the rule: the
    // rail when it renders, the header when it does not.
    const header = rowClasses(sidebar, "group/header");
    expect(header).not.toMatch(/(?:^|\s)border-b(?:\s|$)/);
    expect(sidebar).toMatch(/!hasNonMainWorktrees && "border-b border-divider"/);

    const rail = rowClasses(searchBar, RAIL_MARKER);
    expect(rail).toMatch(/\bborder-b\b/);
  });

  it("keeps the header and the rail on one horizontal inset", () => {
    // Three competing left margins in 90px of height — the title at one inset,
    // the field container at another — is what made the zone read as two
    // separately framed bands rather than one control zone.
    const headerInset = inset(rowClasses(sidebar, "group/header"));
    const railInset = inset(rowClasses(searchBar, RAIL_MARKER));
    expect(headerInset).not.toBeNull();
    expect(railInset).not.toBeNull();
    expect(headerInset).toBe(railInset);
  });

  it("gives every header branch the same row height so the zone never resizes", () => {
    // Loading, empty and loaded all render the same landmark row; if their
    // heights diverge the sidebar's contents jump as a project resolves.
    const heights = [
      ...sidebar.matchAll(/className=(?:"|\{cn\(\s*")([^"]*\bitems-center\b[^"]*)"/g),
    ]
      .map((m) => m[1] ?? "")
      .filter((cls) => cls.includes("border-divider") || cls.includes("group/header"))
      .map((cls) => cls.match(/\bh-\d+\b/)?.[0] ?? cls.match(/\bpy-[\d.]+\b/)?.[0] ?? null);

    expect(heights.length).toBeGreaterThanOrEqual(3);
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).not.toBeNull();
  });

  it("reveals the secondary header actions on keyboard focus, not hover alone", () => {
    // The cluster is hidden at rest; if it only came back on hover it would be
    // unreachable by keyboard, since visibility:hidden also removes it from the
    // tab order.
    expect(sidebar).toMatch(/group-hover\/header:visible/);
    expect(sidebar).toMatch(/group-focus-within\/header:visible/);
  });

  it("honours reduced motion on the reconnecting spinner", () => {
    const spinners = [...sidebar.matchAll(/className="[^"]*\banimate-spin\b[^"]*"/g)].map(
      (m) => m[0]
    );
    expect(spinners.length).toBeGreaterThan(0);
    for (const cls of spinners) {
      expect(cls).toContain("motion-reduce:animate-none");
    }
  });
});
