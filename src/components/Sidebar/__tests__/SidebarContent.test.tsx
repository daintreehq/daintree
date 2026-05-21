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
    const start = src.indexOf("{/* Filter scope and sort-disabled status */}");
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

  it("uses ARIA live region for screen reader announcements", () => {
    const region = statusLineRegion(source);
    expect(region).toContain('role="status"');
    expect(region).toContain('aria-live="polite"');
    expect(region).toContain('aria-atomic="true"');
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
