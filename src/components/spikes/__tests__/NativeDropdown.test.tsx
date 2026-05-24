import { describe, it, expect } from "vitest";
import { resolveMenuIndex, type NativeMenuItem } from "../NativeDropdown";

const items: NativeMenuItem[] = [
  { label: "a", onSelect: () => {} },
  { label: "b", onSelect: () => {} },
  { label: "c", onSelect: () => {}, disabled: true },
  { label: "d", onSelect: () => {} },
];

describe("resolveMenuIndex", () => {
  it("moves down to the next enabled item", () => {
    expect(resolveMenuIndex("ArrowDown", 0, items)).toBe(1);
  });

  it("skips disabled items when moving down", () => {
    expect(resolveMenuIndex("ArrowDown", 1, items)).toBe(3);
  });

  it("skips disabled items when moving up", () => {
    expect(resolveMenuIndex("ArrowUp", 3, items)).toBe(1);
  });

  it("wraps from last to first on ArrowDown", () => {
    expect(resolveMenuIndex("ArrowDown", 3, items)).toBe(0);
  });

  it("wraps from first to last enabled on ArrowUp", () => {
    expect(resolveMenuIndex("ArrowUp", 0, items)).toBe(3);
  });

  it("jumps to first enabled on Home", () => {
    expect(resolveMenuIndex("Home", 3, items)).toBe(0);
  });

  it("jumps to last enabled on End", () => {
    expect(resolveMenuIndex("End", 0, items)).toBe(3);
  });

  it("returns null for non-navigation keys", () => {
    expect(resolveMenuIndex("Enter", 0, items)).toBeNull();
    expect(resolveMenuIndex("Escape", 0, items)).toBeNull();
    expect(resolveMenuIndex("a", 0, items)).toBeNull();
  });

  it("returns null when every item is disabled", () => {
    const allDisabled: NativeMenuItem[] = [
      { label: "x", onSelect: () => {}, disabled: true },
      { label: "y", onSelect: () => {}, disabled: true },
    ];
    expect(resolveMenuIndex("ArrowDown", 0, allDisabled)).toBeNull();
  });

  it("starts from the first enabled item when current index is unset (-1)", () => {
    expect(resolveMenuIndex("ArrowDown", -1, items)).toBe(0);
  });

  it("starts from the last enabled item on ArrowUp when current is unset (-1)", () => {
    expect(resolveMenuIndex("ArrowUp", -1, items)).toBe(3);
  });

  it("treats a current index pointing at a disabled item like unset", () => {
    // index 2 is disabled; ArrowDown lands on the first enabled item.
    expect(resolveMenuIndex("ArrowDown", 2, items)).toBe(0);
    expect(resolveMenuIndex("ArrowUp", 2, items)).toBe(3);
  });

  it("returns the sole enabled item for every navigation key", () => {
    const oneEnabled: NativeMenuItem[] = [
      { label: "x", onSelect: () => {}, disabled: true },
      { label: "y", onSelect: () => {} },
      { label: "z", onSelect: () => {}, disabled: true },
    ];
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(resolveMenuIndex(key, 1, oneEnabled)).toBe(1);
    }
  });

  it("returns null for an empty items array", () => {
    expect(resolveMenuIndex("ArrowDown", 0, [])).toBeNull();
  });
});
