// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FixedDropdown } from "../fixed-dropdown";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

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

function Dispatcher() {
  useGlobalEscapeDispatcher();
  return null;
}

function createAnchor() {
  const el = document.createElement("button");
  el.getBoundingClientRect = () =>
    ({ top: 0, right: 100, bottom: 40, left: 0, width: 100, height: 40 }) as DOMRect;
  document.body.appendChild(el);
  return { current: el };
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe("FixedDropdown overlay-count dismiss behavior", () => {
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let anchorRef: React.RefObject<HTMLElement | null>;

  beforeEach(() => {
    _resetForTests();
    mockOverlayCount = 0;
    onOpenChange = vi.fn();
    anchorRef = createAnchor();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    _resetForTests();
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

  it("captures baseline at open time and closes on later rise above baseline", () => {
    mockOverlayCount = 1;
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // Baseline captured as 1; rising to 2 should close.
    mockOverlayCount = 2;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does NOT close when open and overlayCount rise in the same commit (issue #5084 cold-start race)", () => {
    // Dropdown starts closed with no overlays.
    const { rerender } = render(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // Simulates cold-start race: an in-flight modal mounts in the same
    // commit where the user opens the dropdown. `useLayoutEffect` captures
    // the snapshot at the open transition before sibling passive effects
    // fire, so the snapshot should capture the already-incremented count.
    mockOverlayCount = 1;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("resets baseline snapshot on reopen", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // Close the dropdown.
    rerender(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // Reopen while overlayCount is now 2 — new baseline captured at 2.
    mockOverlayCount = 2;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();

    // Rising above the new baseline should close.
    mockOverlayCount = 3;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledTimes(1);
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
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    pressEscape();

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
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    mockOverlayCount = 0;
    rerender(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    pressEscape();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays suppressed through multiple overlay transitions (1→2→1)", () => {
    mockOverlayCount = 1;
    const { rerender } = render(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    mockOverlayCount = 2;
    rerender(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    expect(onOpenChange).not.toHaveBeenCalled();

    mockOverlayCount = 1;
    rerender(
      <>
        <Dispatcher />
        <FixedDropdown
          open={true}
          onOpenChange={onOpenChange}
          anchorRef={anchorRef}
          persistThroughChildOverlays
        >
          <div>Content</div>
        </FixedDropdown>
      </>
    );

    pressEscape();

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
