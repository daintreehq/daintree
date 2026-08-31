import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

// jsdom gives Virtuoso no real geometry (no layout, no ResizeObserver sizes), so
// the remount itself can't be driven in a unit test. What can be protected is
// the wiring: the surface renders from two sibling branches, and the regression
// returns the moment either one loses the key.
describe("SidebarContent Virtuoso reset wiring — issue #12094", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  function virtuosoCallSites(src: string): string[] {
    const sites: string[] = [];
    const open = "<Virtuoso<SidebarFlatItem, SidebarVirtuosoContext>";
    let from = src.indexOf(open);
    while (from !== -1) {
      const end = src.indexOf("/>", from);
      expect(end).toBeGreaterThan(from);
      sites.push(src.slice(from, end));
      from = src.indexOf(open, end);
    }
    return sites;
  }

  it("still renders exactly two Virtuoso call sites", () => {
    // The grouped-sections branch and the SortableContext branch. A third would
    // need the same wiring, so the count is part of the contract.
    expect(virtuosoCallSites(source)).toHaveLength(2);
  });

  it("keys both call sites off the reset generation", () => {
    const sites = virtuosoCallSites(source);
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).toContain("key={virtuosoResetKey}");
    }
  });

  it("restores the replaced scroll offset on both call sites", () => {
    const sites = virtuosoCallSites(source);
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(site).toContain("initialScrollTop={virtuosoInitialScrollTop}");
    }
  });

  it("suppresses the remount against the deferred query, not the live one", () => {
    // `liveQuery` updates on the keystroke, a render before the list narrows —
    // comparing against it would let every typed character through as an
    // uncorrelated shrink and remount the list under the user.
    expect(source).toContain("useSidebarVirtuosoReset({");
    expect(source).toMatch(/searchQuery:\s*deferredQuery/);
    expect(source).not.toMatch(/searchQuery:\s*liveQuery/);
  });

  it("also hands over the live query so the hook can tell settled from stale", () => {
    // Without it the hook cannot see the urgent commit that carries a new
    // character while the filtered list is still the old one, and reads that
    // commit as the query holding still.
    const start = source.indexOf("useSidebarVirtuosoReset({");
    expect(start).toBeGreaterThan(-1);
    const call = source.slice(start, source.indexOf("});", start));
    expect(call).toMatch(/\bliveQuery\b/);
  });

  it("measures the shrink against the rendered item array", () => {
    expect(source).toMatch(/itemCount:\s*sidebarItems\.length/);
  });
});
