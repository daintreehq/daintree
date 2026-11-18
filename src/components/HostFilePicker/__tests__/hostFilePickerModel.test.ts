import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@shared/types/ipc/hostFiles";
import {
  isSelectable,
  joinHostPath,
  matchesFilters,
  resolveChoice,
  revealScrollTop,
  rowInView,
  visibleRowRange,
  type ListGeometry,
} from "../hostFilePickerModel";

const dir: HostDirectoryEntry = { name: "src", kind: "directory", size: null, mtimeMs: 0 };
const link: HostDirectoryEntry = { name: "alias", kind: "symlink", size: null, mtimeMs: 0 };
const json: HostDirectoryEntry = { name: "a.JSON", kind: "file", size: 3, mtimeMs: 0 };
const txt: HostDirectoryEntry = { name: "b.txt", kind: "file", size: 3, mtimeMs: 0 };

describe("hostFilePickerModel", () => {
  it("joins host paths without doubling the root slash", () => {
    expect(joinHostPath("/", "etc")).toBe("/etc");
    expect(joinHostPath("/srv/app", "x")).toBe("/srv/app/x");
  });

  it("matches extension filters case-insensitively, with * and no filters passing all", () => {
    const filters = [{ name: "JSON", extensions: ["json"] }];
    expect(matchesFilters("a.JSON", filters)).toBe(true);
    expect(matchesFilters("b.txt", filters)).toBe(false);
    expect(matchesFilters(".json", filters)).toBe(false);
    expect(matchesFilters("b.txt", [{ name: "All", extensions: ["*"] }])).toBe(true);
    expect(matchesFilters("b.txt", undefined)).toBe(true);
  });

  it("lets a folder picker choose folders and links, and a file picker files", () => {
    const folder = { mode: "directory" as const, title: "t" };
    const file = {
      mode: "file" as const,
      title: "t",
      filters: [{ name: "J", extensions: ["json"] }],
    };
    expect([dir, link, json].map((entry) => isSelectable(entry, folder))).toEqual([
      true,
      true,
      false,
    ]);
    expect([dir, json, txt].map((entry) => isSelectable(entry, file))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("chooses the shown folder when a folder picker has nothing selected", () => {
    const folder = { mode: "directory" as const, title: "t" };
    expect(resolveChoice(folder, "/srv", [])).toEqual(["/srv"]);
    expect(resolveChoice(folder, "/srv", [dir])).toEqual(["/srv/src"]);
    expect(resolveChoice(folder, null, [dir])).toBeNull();
  });

  it("chooses one file unless multiple are allowed, and never an unmatched one", () => {
    const single = { mode: "file" as const, title: "t" };
    const multiple = { mode: "file" as const, title: "t", multiple: true };
    expect(resolveChoice(single, "/srv", [])).toBeNull();
    expect(resolveChoice(single, "/srv", [json, txt])).toEqual(["/srv/a.JSON"]);
    expect(resolveChoice(multiple, "/srv", [json, txt])).toEqual(["/srv/a.JSON", "/srv/b.txt"]);
    expect(resolveChoice(multiple, "/srv", [dir])).toBeNull();
  });
});

describe("hostFilePickerModel list window", () => {
  const geometry: ListGeometry = { rowHeight: 34, padding: 4, viewport: 286 };
  const count = 2_000;
  const maxTop = count * geometry.rowHeight + 2 * geometry.padding - geometry.viewport;
  const rowSpan = (index: number) => {
    const top = geometry.padding + index * geometry.rowHeight;
    return { top, bottom: top + geometry.rowHeight };
  };
  // Round numbers, so exact answers can be worked by hand.
  const plain: ListGeometry = { rowHeight: 10, padding: 0, viewport: 30 };

  it("mounts every row in view and a bounded window around it, at any offset", () => {
    const overscan = 3;
    const most = Math.ceil(geometry.viewport / geometry.rowHeight) + 1 + 2 * overscan;
    for (const scrollTop of [0, 1, 33, 34, 35, 1_000, 33_333, maxTop - 1, maxTop]) {
      const { start, end } = visibleRowRange(count, scrollTop, geometry, overscan);
      expect(end - start).toBeLessThanOrEqual(most);
      for (let index = 0; index < count; index++) {
        const { top, bottom } = rowSpan(index);
        const inView = bottom > scrollTop && top < scrollTop + geometry.viewport;
        if (inView) expect(index >= start && index < end).toBe(true);
        expect(rowInView(index, count, scrollTop, geometry)).toBe(inView);
      }
    }
  });

  it("adds the overscan on both sides of the rows in view", () => {
    // Rows 5, 6 and 7 are in view at 50.
    expect(visibleRowRange(100, 50, plain, 2)).toEqual({ start: 3, end: 10 });
    expect(visibleRowRange(100, 50, plain, 0)).toEqual({ start: 5, end: 8 });
    expect(visibleRowRange(100, -20, plain, 2)).toEqual({ start: 0, end: 5 });
  });

  it("shows a listing's end, not nothing, when it shrinks under an old offset", () => {
    expect(visibleRowRange(5, maxTop, geometry, 3)).toEqual({ start: 0, end: 5 });
    // 100 rows of 10 in a 30 viewport end at 970: rows 97 to 99.
    expect(visibleRowRange(100, 5_000, plain, 1)).toEqual({ start: 96, end: 100 });
    expect(visibleRowRange(0, 500, geometry, 3)).toEqual({ start: 0, end: 0 });
    expect(rowInView(99, 100, 5_000, plain)).toBe(true);
  });

  it("scrolls a row fully into view by the nearer edge, and not at all when it is", () => {
    for (const [index, from] of [
      [0, maxTop],
      [count - 1, 0],
      [1_000, 0],
      [1_000, maxTop],
      [500, rowSpan(500).top + 6],
    ] as const) {
      const target = revealScrollTop(index, count, from, geometry);
      expect(target).not.toBeNull();
      const { top, bottom } = rowSpan(index);
      expect(top).toBeGreaterThanOrEqual(target!);
      expect(bottom).toBeLessThanOrEqual(target! + geometry.viewport);
      expect(revealScrollTop(index, count, target!, geometry)).toBeNull();
    }
    expect(revealScrollTop(0, count, maxTop, geometry)).toBe(0);
    expect(revealScrollTop(count - 1, count, 0, geometry)).toBe(maxTop);
    expect(revealScrollTop(3, count, 0, geometry)).toBeNull();
  });

  it("aligns a row below the view to the bottom and one above it to the top", () => {
    expect(revealScrollTop(20, 100, 0, plain)).toBe(180);
    expect(revealScrollTop(2, 100, 50, plain)).toBe(20);
    // Fully in view, even flush against the edge: no nudge.
    expect(revealScrollTop(7, 100, 50, plain)).toBeNull();
    expect(revealScrollTop(5, 100, 50, plain)).toBeNull();
    // In view only once the stale offset is clamped: the clamped one is the answer.
    expect(revealScrollTop(4, 5, 500, plain)).toBe(20);
  });
});
