import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent filter scope and sort status — issue #8391", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  // Slice from the header group to the inline search bar comment to isolate
  // the status line region. This sits between the header and the search bar.
  function statusLineRegion(src: string): string {
    const start = src.indexOf("{/* Filter scope and sort-disabled status");
    const end = src.indexOf("{/* Inline search bar", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("renders the status line only when there is status text, reserving no empty height", () => {
    const region = statusLineRegion(source);
    // No permanent min-height reservation — an empty status row left a stray
    // gap under the header, so the whole row is gated on having content.
    expect(region).not.toContain("min-h-5");
    expect(region).toContain("shrink-0");
    expect(region).toMatch(/\{\(showScope \|\| dragDisabledReason\) &&/);
  });

  it("keeps the visible status line free of live-region attributes (#9665)", () => {
    // The status line mixes a dynamic filter count with persistent
    // sort-disabled text. role="status" carries an implicit aria-atomic, so a
    // live region here re-announced the whole line — including the persistent
    // text — on every keystroke. Announcements are now routed through the
    // debounced global announcer instead.
    const region = statusLineRegion(source);
    expect(region).not.toContain('role="status"');
    expect(region).not.toContain("aria-live");
    expect(region).not.toContain("aria-atomic");
  });

  it("renders scope text 'N of M worktrees' pattern when filters narrow results", () => {
    // The source uses template literals for dynamic counts
    expect(source).toContain("{filteredCount} of {totalCount} worktrees");
  });

  it("renders drag-disabled reason for search", () => {
    expect(source).toContain("Sorting disabled while searching");
  });

  it("renders drag-disabled reason for group-by-type", () => {
    expect(source).toContain("Sorting disabled while grouped by type");
  });

  it("separates scope and drag reason with a middle dot when both present", () => {
    const region = statusLineRegion(source);
    expect(region).toContain(" · ");
  });

  it("gates visible content on showScope or dragDisabledReason", () => {
    expect(source).toMatch(/showScope\s*\|\|\s*dragDisabledReason/);
  });

  it("derives drag-disabled reason with query taking priority over group-by-type", () => {
    // Query-first precedence: hasQuery ? "searching" : isGroupedByType ? "grouped by type" : null
    expect(source).toMatch(/hasQuery\s*\?[\s\S]*?Sorting disabled while searching/);
    expect(source).toMatch(/isGroupedByType\s*\?[\s\S]*?Sorting disabled while grouped by type/);
  });

  it("exports totalCount from the filter useMemo alongside filteredWorktrees", () => {
    expect(source).toContain("totalCount: nonMain.length");
  });

  it("computes showScope from hasActiveFilters and count comparison", () => {
    expect(source).toMatch(
      /showScope\s*=\s*hasActiveFilters\(\)\s*&&\s*filteredCount\s*!==\s*totalCount/
    );
  });
});

describe("SidebarContent screen-reader announcements — issue #9665", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("routes announcements through the global announcer store", () => {
    expect(source).toContain(
      'import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore"'
    );
    expect(source).toContain("useAnnouncerStore.getState().announce(");
  });

  it("debounces the count announcement on the shared Doherty threshold", () => {
    expect(source).toContain('import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils"');
    // The count announcement is scheduled on a timer cleared on re-run, so
    // rapid keystrokes coalesce into a single late announcement.
    expect(source).toMatch(
      /setTimeout\([\s\S]*?announce\(`\$\{filteredCount\} of \$\{totalCount\} worktrees`\)[\s\S]*?\},\s*UI_DOHERTY_THRESHOLD\)/
    );
    expect(source).toMatch(/clearTimeout\(timer\)/);
  });

  it("gates the count announcement on showScope being active", () => {
    // No filters narrowing the list → no count announcement at all.
    expect(source).toMatch(/if \(!showScope\) return;/);
  });

  it("announces the sort-disabled reason on appear/change but not on re-enable", () => {
    // Fires on null → reason and reason → reason, but not reason → null (the
    // re-enable path is owned by the isSortDisabledPrevRef effect) and not when
    // the reason is unchanged (so a stable reason isn't re-spoken every render).
    expect(source).toContain("prevDragDisabledReasonRef");
    expect(source).toMatch(/dragDisabledReason !== null && prev !== dragDisabledReason/);
  });
});
