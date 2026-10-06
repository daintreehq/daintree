// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const capturing = vi.hoisted(() => ({ value: false }));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { isCapturingShortcut: () => capturing.value },
}));

import { useDoubleShift } from "../useDoubleShift";

let now = 10_000;

function key(target: EventTarget, type: "keydown" | "keyup", init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
}

/** One Shift press held for `holdMs`, then released `gapMs` before the next. */
function tap(target: EventTarget, { holdMs = 60, gapMs = 120, ...init }: TapOptions = {}) {
  key(target, "keydown", { key: "Shift", shiftKey: true, ...init });
  now += holdMs;
  key(target, "keyup", { key: "Shift", ...init });
  now += gapMs;
}

type TapOptions = KeyboardEventInit & { holdMs?: number; gapMs?: number };

function terminalInput(): HTMLTextAreaElement {
  const xterm = document.createElement("div");
  xterm.className = "xterm";
  const textarea = document.createElement("textarea");
  textarea.className = "xterm-helper-textarea";
  xterm.appendChild(textarea);
  document.body.appendChild(xterm);
  return textarea;
}

beforeEach(() => {
  now += 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  capturing.value = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("useDoubleShift", () => {
  it("fires from a focused terminal, where focus sits nearly all the time", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    const textarea = terminalInput();
    tap(textarea);
    tap(textarea);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("fires from a text field and from the page itself", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    const input = document.createElement("input");
    document.body.appendChild(input);
    tap(input);
    tap(input);
    now += 1000;
    tap(document.body);
    tap(document.body);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("ignores taps too far apart", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    tap(document.body, { gapMs: 400 });
    tap(document.body);
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not count a held Shift as a tap", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    tap(document.body, { holdMs: 800, gapMs: 50 });
    tap(document.body);
    expect(callback).not.toHaveBeenCalled();
  });

  it("treats Shift with another key as typing", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    const textarea = terminalInput();
    key(textarea, "keydown", { key: "Shift", shiftKey: true });
    key(textarea, "keydown", { key: "A", shiftKey: true });
    key(textarea, "keyup", { key: "Shift" });
    now += 100;
    tap(textarea);
    expect(callback).not.toHaveBeenCalled();
  });

  it("stays out of an IME composition and a shortcut recorder", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    tap(document.body, { isComposing: true });
    tap(document.body, { isComposing: true });
    capturing.value = true;
    tap(document.body);
    tap(document.body);
    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores Shift held with another modifier", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    tap(document.body, { metaKey: true });
    tap(document.body, { metaKey: true });
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not count taps of one Shift while the other is held", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    key(document.body, "keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true });
    now += 800;
    tap(document.body, { code: "ShiftRight", shiftKey: true });
    tap(document.body, { code: "ShiftRight", shiftKey: true });
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not count a Shift pressed while another key is held", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    key(document.body, "keydown", { key: "a", code: "KeyA" });
    tap(document.body);
    tap(document.body);
    expect(callback).not.toHaveBeenCalled();
    key(document.body, "keyup", { key: "a", code: "KeyA" });
    now += 1000;
    tap(document.body);
    tap(document.body);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("treats two Shift-clicks as clicks, not a double tap", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    for (let i = 0; i < 2; i++) {
      key(document.body, "keydown", { key: "Shift", shiftKey: true });
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      now += 60;
      key(document.body, "keyup", { key: "Shift" });
      now += 120;
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it("forgets a half-finished tap when the window loses focus", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback));
    tap(document.body);
    window.dispatchEvent(new Event("blur"));
    tap(document.body);
    expect(callback).not.toHaveBeenCalled();
  });

  it("does nothing while turned off", () => {
    const callback = vi.fn();
    renderHook(() => useDoubleShift(callback, false));
    tap(document.body);
    tap(document.body);
    expect(callback).not.toHaveBeenCalled();
  });
});
