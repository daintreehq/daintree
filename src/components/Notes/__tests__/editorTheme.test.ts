import { describe, expect, it } from "vitest";
import { daintreeTheme } from "../editorTheme";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";

/**
 * Walk an object tree looking for a property value, handling circular refs.
 */
function deepContainsValue(obj: unknown, target: string, seen = new WeakSet()): boolean {
  if (obj === target) return true;
  if (typeof obj === "string" && obj.includes(target)) return true;
  if (obj == null || typeof obj !== "object") return false;
  if (seen.has(obj as object)) return false;
  seen.add(obj as object);
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (deepContainsValue(val, target, seen)) return true;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (deepContainsValue(item, target, seen)) return true;
    }
  }
  return false;
}

describe("daintreeTheme", () => {
  it("includes fontFamily in the theme extension", () => {
    expect(deepContainsValue(daintreeTheme, DEFAULT_TERMINAL_FONT_FAMILY)).toBe(true);
  });

  it("is a valid CodeMirror extension array", () => {
    expect(Array.isArray(daintreeTheme)).toBe(true);
    expect((daintreeTheme as readonly unknown[]).length).toBeGreaterThan(0);
  });
});
