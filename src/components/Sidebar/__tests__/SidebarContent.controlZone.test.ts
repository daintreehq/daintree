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
const WORKSPACE_SIDEBAR = path.resolve(__dirname, "../WorkspaceRootSidebar.tsx");
const SIDEBAR_HEADER = path.resolve(__dirname, "../sidebarHeader.ts");
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
  return slice.match(/className=(?:"|\{cn\([^"]*")([^"]*)"/)?.[1] ?? "";
}

function inset(classes: string): string | null {
  return classes.match(/\bpx-[\d.]+\b/)?.[0] ?? null;
}

describe("Worktrees sidebar control zone — issue #11991", () => {
  let sidebar: string;
  let searchBar: string;
  let workspaceSidebar: string;
  let headerRow: string;

  beforeAll(async () => {
    sidebar = await fs.readFile(SIDEBAR_CONTENT, "utf-8");
    searchBar = await fs.readFile(SEARCH_BAR, "utf-8");
    workspaceSidebar = await fs.readFile(WORKSPACE_SIDEBAR, "utf-8");
    const shared = await fs.readFile(SIDEBAR_HEADER, "utf-8");
    headerRow = shared.match(/SIDEBAR_HEADER_ROW = "([^"]*)"/)?.[1] ?? "";
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
    expect(sidebar).toMatch(/cn\(\s*SIDEBAR_HEADER_ROW,\s*"group\/header/);
    const headerInset = inset(headerRow);
    const railInset = inset(rowClasses(searchBar, RAIL_MARKER));
    expect(headerInset).not.toBeNull();
    expect(railInset).not.toBeNull();
    expect(headerInset).toBe(railInset);
  });

  it("gives every header branch, in every workspace kind, one fixed row height", () => {
    // Loading, empty and loaded all render the same landmark row, and so does
    // the non-git workspace sidebar; if their heights diverge the sidebar's
    // contents jump as a project resolves or the workspace kind changes. One
    // shared row with a fixed height — not padding around whatever sits in it —
    // is what holds them together.
    expect(headerRow).toMatch(/(?:^|\s)h-\d+(?:\s|$)/);
    expect(headerRow).not.toMatch(/\bpy-/);

    const worktreeBranches = sidebar.match(/cn\(\s*SIDEBAR_HEADER_ROW\b/g) ?? [];
    expect(worktreeBranches.length).toBeGreaterThanOrEqual(3);
    expect(workspaceSidebar).toMatch(/cn\(\s*SIDEBAR_HEADER_ROW\b/);

    // No branch sizes itself around the shared row.
    for (const source of [sidebar, workspaceSidebar]) {
      for (const m of source.matchAll(/cn\(\s*SIDEBAR_HEADER_ROW,\s*"([^"]*)"/g)) {
        expect(m[1]).not.toMatch(/(?:^|\s)(?:h|py|min-h)-/);
      }
    }
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
