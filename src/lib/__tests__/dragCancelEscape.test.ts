// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDragCancelEscape, isDragCancelEscape } from "../dragCancelEscape";

describe("dispatchDragCancelEscape", () => {
  const seen: KeyboardEvent[] = [];
  const capture = (event: KeyboardEvent) => seen.push(event);

  afterEach(() => {
    window.removeEventListener("keydown", capture, true);
    window.removeEventListener("keyup", capture, true);
    seen.length = 0;
  });

  it("presses and releases a code-only Escape on body, marked as a drag recovery's", () => {
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keyup", capture, true);
    dispatchDragCancelEscape();

    expect(seen.map((e) => [e.type, e.code, e.key])).toEqual([
      ["keydown", "Escape", ""],
      ["keyup", "Escape", ""],
    ]);
    expect(seen.every((e) => e.target === document.body && isDragCancelEscape(e))).toBe(true);
  });

  it("marks no other Escape", () => {
    expect(isDragCancelEscape(new KeyboardEvent("keyup", { code: "Escape" }))).toBe(false);
  });
});
