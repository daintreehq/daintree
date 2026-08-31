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
    for (const site of virtuosoCallSites(source)) {
      expect(site).toContain("key={virtuosoResetKey}");
    }
  });

  it("restores the replaced scroll offset on both call sites", () => {
    for (const site of virtuosoCallSites(source)) {
      expect(site).toContain("initialScrollTop={virtuosoInitialScrollTop}");
    }
  });

  it("feeds the hook the unfiltered live worktree ids", () => {
    // `dragStartOrder` is the filtered order — it would report every search
    // keystroke as a deletion and remount the list under the user.
    expect(source).toContain("useSidebarVirtuosoReset({");
    expect(source).toMatch(/liveWorktreeIds:\s*worktreeIdList/);
    expect(source).not.toMatch(/liveWorktreeIds:\s*dragStartOrder/);
  });

  it("measures the shrink against the rendered item array", () => {
    expect(source).toMatch(/itemCount:\s*sidebarItems\.length/);
  });
});
