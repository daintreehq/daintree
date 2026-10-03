/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewMock = vi.hoisted(() => ({ isProjectViewObservable: vi.fn(() => true) }));
vi.mock("@/lib/viewCacheState", () => viewMock);

import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";
import {
  _resetCopyFlashForTests,
  captureCopyFlash,
  dismissCopyFlash,
  getCopyFlash,
  invalidateCopyFlash,
  noteCopyFlashKeyboard,
  noteCopyFlashPointer,
  showCopyFlash,
  subscribeCopyFlash,
} from "../copyFlash";

describe("copyFlash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCopyFlashForTests();
    viewMock.isProjectViewObservable.mockReturnValue(true);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  afterEach(() => {
    _resetCopyFlashForTests();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("anchors a pointer gesture to where the pointer went down", () => {
    noteCopyFlashPointer(120, 40);
    expect(captureCopyFlash().origin).toEqual({ kind: "point", x: 120, y: 40 });
  });

  it("anchors a keyboard gesture to the focused element, not an older pointer position", () => {
    noteCopyFlashPointer(120, 40);
    const item = document.createElement("button");
    document.body.appendChild(item);
    item.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 44,
      width: 100,
      height: 24,
      toJSON: () => ({}),
    });
    item.focus();
    noteCopyFlashKeyboard();

    expect(captureCopyFlash().origin).toEqual({
      kind: "rect",
      left: 10,
      top: 20,
      right: 110,
      bottom: 44,
    });
  });

  it("falls back to no origin when nothing is focused and no pointer was seen", () => {
    expect(captureCopyFlash().origin).toBeNull();
  });

  it("replaces the flash on a second copy instead of stacking, and restarts the dwell", () => {
    const listener = vi.fn();
    subscribeCopyFlash(listener);
    showCopyFlash(captureCopyFlash());
    const first = getCopyFlash();
    vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS - 100);
    showCopyFlash(captureCopyFlash());
    const second = getCopyFlash();

    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first!.id);

    // The first flash's deadline must not take the second one down early.
    vi.advanceTimersByTime(200);
    expect(getCopyFlash()).toBe(second);
    vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS);
    expect(getCopyFlash()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("clears on dismiss", () => {
    showCopyFlash(captureCopyFlash());
    dismissCopyFlash();
    expect(getCopyFlash()).toBeNull();
  });

  it("draws nothing while the view cannot be seen", () => {
    viewMock.isProjectViewObservable.mockReturnValue(false);
    showCopyFlash(captureCopyFlash());
    expect(getCopyFlash()).toBeNull();
  });

  it("never draws a copy captured before the view was hidden, even after it returns", () => {
    showCopyFlash(captureCopyFlash());
    const pending = captureCopyFlash();
    invalidateCopyFlash();
    expect(getCopyFlash()).toBeNull();

    showCopyFlash(pending);
    expect(getCopyFlash()).toBeNull();

    showCopyFlash(captureCopyFlash());
    expect(getCopyFlash()).not.toBeNull();
  });

  it("forgets the last pointer position when the view is hidden", () => {
    noteCopyFlashPointer(120, 40);
    invalidateCopyFlash();
    expect(captureCopyFlash().origin).toBeNull();
  });
});
