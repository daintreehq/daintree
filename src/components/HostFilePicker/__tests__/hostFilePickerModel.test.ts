import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@shared/types/ipc/hostFiles";
import { isSelectable, joinHostPath, matchesFilters, resolveChoice } from "../hostFilePickerModel";

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
