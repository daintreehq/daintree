import { beforeEach, describe, expect, it, vi } from "vitest";

let mac = true;
vi.mock("@/lib/platform", () => ({ isMac: () => mac }));

import { listStepOf, type ListStepKey } from "../listStepChord";

function press(
  key: string,
  held: { meta?: boolean; alt?: boolean; ctrl?: boolean; shift?: boolean } = {},
  ime: { isComposing?: boolean; keyCode?: number } = {}
): ListStepKey {
  return {
    key,
    metaKey: held.meta ?? false,
    altKey: held.alt ?? false,
    ctrlKey: held.ctrl ?? false,
    shiftKey: held.shift ?? false,
    keyCode: ime.keyCode ?? 0,
    nativeEvent: { isComposing: ime.isComposing ?? false },
  };
}

describe("listStepOf", () => {
  beforeEach(() => {
    mac = true;
  });

  it("steps up and down with ⌘ on macOS, and with nothing else held", () => {
    expect(listStepOf(press("ArrowUp", { meta: true }))).toBe(-1);
    expect(listStepOf(press("ArrowDown", { meta: true }))).toBe(1);
    expect(listStepOf(press("ArrowDown", { alt: true }))).toBeNull();
    expect(listStepOf(press("ArrowDown", { meta: true, alt: true }))).toBeNull();
    expect(listStepOf(press("ArrowDown", { meta: true, ctrl: true }))).toBeNull();
  });

  it("steps with Alt off macOS, never Ctrl, which terminals take for themselves", () => {
    mac = false;
    expect(listStepOf(press("ArrowUp", { alt: true }))).toBe(-1);
    expect(listStepOf(press("ArrowDown", { alt: true }))).toBe(1);
    expect(listStepOf(press("ArrowDown", { ctrl: true }))).toBeNull();
    expect(listStepOf(press("ArrowDown", { meta: true }))).toBeNull();
    expect(listStepOf(press("ArrowDown", { alt: true, ctrl: true }))).toBeNull();
    expect(listStepOf(press("ArrowDown", { alt: true, meta: true }))).toBeNull();
  });

  it("leaves selecting with Shift, other keys, and an input method's own keys alone", () => {
    expect(listStepOf(press("ArrowDown", { meta: true, shift: true }))).toBeNull();
    expect(listStepOf(press("ArrowLeft", { meta: true }))).toBeNull();
    expect(listStepOf(press("ArrowDown"))).toBeNull();
    expect(listStepOf(press("ArrowDown", { meta: true }, { isComposing: true }))).toBeNull();
    expect(listStepOf(press("ArrowDown", { meta: true }, { keyCode: 229 }))).toBeNull();
  });
});
