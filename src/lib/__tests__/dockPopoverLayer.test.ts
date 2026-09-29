// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  registerDockPopoverLayer,
  getDockPopoverOpen,
  useDockPopoverLayer,
  _resetForTests,
} from "../dockPopoverLayer";

afterEach(() => {
  _resetForTests();
});

describe("dockPopoverLayer", () => {
  it("stays up until the last of several overlapping popovers closes", () => {
    // The docked panel's popover and a status pill's can both be on screen; the
    // first to close must not drop a dialog under the one still showing.
    const releaseDock = registerDockPopoverLayer();
    const releasePill = registerDockPopoverLayer();

    releaseDock();
    expect(getDockPopoverOpen()).toBe(true);

    releasePill();
    expect(getDockPopoverOpen()).toBe(false);
  });

  it("ignores a second release of the same registration", () => {
    const releaseA = registerDockPopoverLayer();
    const releaseB = registerDockPopoverLayer();

    releaseA();
    releaseA();
    expect(getDockPopoverOpen()).toBe(true);

    releaseB();
    expect(getDockPopoverOpen()).toBe(false);
  });
});

describe("useDockPopoverLayer", () => {
  it("registers only while open", () => {
    const { rerender } = renderHook(({ open }) => useDockPopoverLayer(open), {
      initialProps: { open: false },
    });
    expect(getDockPopoverOpen()).toBe(false);

    rerender({ open: true });
    expect(getDockPopoverOpen()).toBe(true);

    rerender({ open: false });
    expect(getDockPopoverOpen()).toBe(false);
  });

  it("releases when its host unmounts while still open", () => {
    const { unmount } = renderHook(() => useDockPopoverLayer(true));

    unmount();

    expect(getDockPopoverOpen()).toBe(false);
  });

  it("leaves other registrations alone when it unmounts", () => {
    const release = registerDockPopoverLayer();
    const { unmount } = renderHook(() => useDockPopoverLayer(true));

    unmount();

    expect(getDockPopoverOpen()).toBe(true);
    release();
    expect(getDockPopoverOpen()).toBe(false);
  });
});
