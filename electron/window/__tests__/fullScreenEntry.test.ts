import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isInOrEnteringNativeFullScreen, markEnteringFullScreen } from "../fullScreenEntry.js";

function fakeWindow() {
  const win = Object.assign(new EventEmitter(), {
    full: false,
    simple: false,
    isFullScreen: () => win.full,
    isSimpleFullScreen: () => win.simple,
  });
  return win;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("isInOrEnteringNativeFullScreen", () => {
  it("holds from the mark through the transition and native full screen, until the window leaves", () => {
    const win = fakeWindow();
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(false);

    markEnteringFullScreen(win as never);
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(true);
    win.emit("show");
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(true);

    win.full = true;
    win.emit("enter-full-screen");
    vi.advanceTimersByTime(60_000);
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(true);

    win.full = false;
    win.emit("leave-full-screen");
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(false);
  });

  it("lets go of a transition macOS refused, a few seconds after the window shows", () => {
    const win = fakeWindow();
    markEnteringFullScreen(win as never);
    vi.advanceTimersByTime(60_000);
    // Still hidden: the transition has not even been asked for.
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(true);

    win.emit("show");
    vi.advanceTimersByTime(4_999);
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(false);
  });

  it("leaves simple full screen out: it stays on the Space it was entered from", () => {
    const win = fakeWindow();
    win.simple = true;
    expect(isInOrEnteringNativeFullScreen(win as never)).toBe(false);
  });
});
