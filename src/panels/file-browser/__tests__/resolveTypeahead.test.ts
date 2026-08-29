import { describe, it, expect } from "vitest";
import { resolveTypeahead, type FlatTreeRow } from "../fileBrowserTree";

function rows(...names: string[]): FlatTreeRow[] {
  return names.map((name, index) => ({
    path: name,
    name,
    isDirectory: false,
    depth: 0,
    isExpanded: false,
    isLoading: false,
    posInSet: index + 1,
    setSize: names.length,
  }));
}

describe("resolveTypeahead", () => {
  it("moves to the next match after the cursor rather than restarting at the top", () => {
    // Otherwise repeating a letter sticks on the first match forever, which is
    // the whole point of typeahead in a long list.
    const list = rows("app.ts", "assets", "index.ts", "avatar.png");
    expect(resolveTypeahead("a", list, "app.ts")).toBe("assets");
    expect(resolveTypeahead("a", list, "assets")).toBe("avatar.png");
  });

  it("wraps exactly once, so cycling a letter returns to where it started", () => {
    const list = rows("app.ts", "assets", "index.ts");
    expect(resolveTypeahead("a", list, "assets")).toBe("app.ts");
  });

  it("re-tests the cursor row while a multi-character buffer is still being typed", () => {
    // Typing "sr" must not match `src` on the "s" and then skip past it hunting
    // for a second "sr" — the second character refines the same search rather
    // than starting a new one.
    //
    // `srv` is what makes this test bite: with only one "sr" row the wrap-around
    // finds the cursor row again anyway, so a search that wrongly starts past
    // the cursor still returns the right answer and the bug hides.
    const list = rows("src", "srv", "styles");
    const afterFirstKey = resolveTypeahead("s", list, null);
    expect(afterFirstKey).toBe("src");
    expect(resolveTypeahead("sr", list, afterFirstKey)).toBe("src");
  });

  it("still advances on a repeated single character even when the cursor matches", () => {
    // The counterpart to the rule above: a one-character buffer is a fresh
    // search, so it must move on rather than re-selecting where it already is.
    const list = rows("src", "srv", "styles");
    expect(resolveTypeahead("s", list, "src")).toBe("srv");
  });

  it("returns null on a miss instead of moving somewhere arbitrary", () => {
    // A typo must not navigate. Returning the nearest row would make a mistyped
    // character silently retarget the viewer.
    const list = rows("src", "docs");
    expect(resolveTypeahead("zz", list, "src")).toBeNull();
  });

  it("matches the rendered name, not the path", () => {
    // A user types what they can see. Matching the path would make "p" jump to
    // a file whose name starts with something else entirely.
    const list: FlatTreeRow[] = [
      { ...rows("x")[0]!, path: "panels/deep/alpha.ts", name: "alpha.ts" },
      { ...rows("x")[0]!, path: "other/panels.ts", name: "panels.ts" },
    ];
    expect(resolveTypeahead("p", list, null)).toBe("other/panels.ts");
  });

  it("is case-insensitive in both directions", () => {
    const list = rows("README.md", "src");
    expect(resolveTypeahead("r", list, null)).toBe("README.md");
    expect(resolveTypeahead("RE", list, null)).toBe("README.md");
  });

  it("does nothing without a buffer or without rows", () => {
    expect(resolveTypeahead("", rows("src"), null)).toBeNull();
    expect(resolveTypeahead("s", [], null)).toBeNull();
  });
});
