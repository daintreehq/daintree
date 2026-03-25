// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { useOverlayState } from "../useOverlayState";
import { useUIStore } from "@/store/uiStore";

function Overlay({ isOpen }: { isOpen: boolean }) {
  useOverlayState(isOpen);
  return null;
}

function getOverlayCount() {
  return useUIStore.getState().overlayCount;
}

beforeEach(() => {
  useUIStore.setState({ overlayCount: 0 });
});

describe("useOverlayState", () => {
  it("increments overlayCount when isOpen becomes true", () => {
    render(<Overlay isOpen={true} />);
    expect(getOverlayCount()).toBe(1);
  });

  it("decrements overlayCount when isOpen becomes false", () => {
    const { rerender } = render(<Overlay isOpen={true} />);
    expect(getOverlayCount()).toBe(1);

    rerender(<Overlay isOpen={false} />);
    expect(getOverlayCount()).toBe(0);
  });

  it("decrements overlayCount on unmount while open", () => {
    const { unmount } = render(<Overlay isOpen={true} />);
    expect(getOverlayCount()).toBe(1);

    unmount();
    expect(getOverlayCount()).toBe(0);
  });

  it("does not change overlayCount when isOpen is false from start", () => {
    render(<Overlay isOpen={false} />);
    expect(getOverlayCount()).toBe(0);
  });

  it("tracks rapid open/close cycles correctly", () => {
    const { rerender } = render(<Overlay isOpen={false} />);
    expect(getOverlayCount()).toBe(0);

    rerender(<Overlay isOpen={true} />);
    expect(getOverlayCount()).toBe(1);

    rerender(<Overlay isOpen={false} />);
    expect(getOverlayCount()).toBe(0);

    rerender(<Overlay isOpen={true} />);
    expect(getOverlayCount()).toBe(1);

    rerender(<Overlay isOpen={false} />);
    expect(getOverlayCount()).toBe(0);
  });

  it("stacks multiple overlays correctly", () => {
    const { unmount: unmountA } = render(<Overlay isOpen={true} />);
    render(<Overlay isOpen={true} />);
    expect(getOverlayCount()).toBe(2);

    unmountA();
    expect(getOverlayCount()).toBe(1);
  });

  it("does not double-pop when unmounting after isOpen becomes false", () => {
    // Keep a second overlay open so an extra pop would be visible
    // (popOverlay clamps at 0, so without this sentinel the test is vacuous)
    render(<Overlay isOpen={true} />);
    expect(getOverlayCount()).toBe(1);

    const { rerender, unmount } = render(<Overlay isOpen={true} />);
    expect(getOverlayCount()).toBe(2);

    rerender(<Overlay isOpen={false} />);
    expect(getOverlayCount()).toBe(1);

    unmount();
    expect(getOverlayCount()).toBe(1);
  });
});
