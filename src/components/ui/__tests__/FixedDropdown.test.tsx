// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { FixedDropdown } from "../fixed-dropdown";

let mockOverlayCount = 0;

vi.mock("@/store/uiStore", () => ({
  useUIStore: (selector: (state: { overlayCount: number }) => unknown) =>
    selector({ overlayCount: mockOverlayCount }),
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

function createAnchor() {
  const el = document.createElement("button");
  el.getBoundingClientRect = () =>
    ({ top: 0, right: 100, bottom: 40, left: 0, width: 100, height: 40 }) as DOMRect;
  document.body.appendChild(el);
  return { current: el };
}

describe("FixedDropdown overlay-count dismiss behavior", () => {
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let anchorRef: React.RefObject<HTMLElement | null>;

  beforeEach(() => {
    mockOverlayCount = 0;
    onOpenChange = vi.fn();
    anchorRef = createAnchor();
  });

  it("closes when overlayCount increases (default behavior)", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    mockOverlayCount = 1;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does NOT close when overlayCount increases with persistThroughChildOverlays", () => {
    const { rerender } = render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    mockOverlayCount = 1;
    rerender(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("suppresses Escape dismiss while child overlay is active", () => {
    mockOverlayCount = 1;
    render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("suppresses outside pointer dismiss while child overlay is active", () => {
    mockOverlayCount = 1;
    render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("resumes Escape dismiss after child overlay closes", () => {
    mockOverlayCount = 1;
    const { rerender } = render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    mockOverlayCount = 0;
    rerender(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays suppressed through multiple overlay transitions (1→2→1)", () => {
    mockOverlayCount = 1;
    const { rerender } = render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    mockOverlayCount = 2;
    rerender(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();

    mockOverlayCount = 1;
    rerender(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("can be explicitly closed by parent while child overlay is active", () => {
    mockOverlayCount = 1;
    const { rerender } = render(
      <FixedDropdown
        open={true}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    rerender(
      <FixedDropdown
        open={false}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        persistThroughChildOverlays
      >
        <div>Content</div>
      </FixedDropdown>
    );

    expect(document.querySelector("[class*='fixed']")).toBeNull();
  });
});
