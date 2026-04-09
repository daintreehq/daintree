// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FixedDropdown } from "../fixed-dropdown";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

const GRACE_MS = 300;

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

function advancePastGrace() {
  act(() => {
    vi.advanceTimersByTime(GRACE_MS + 1);
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
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetForTests();
    vi.useRealTimers();
  });

  it("closes when overlayCount increases (default behavior)", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // Wait for the cold-start grace window to expire so that subsequent
    // overlay rises are treated as user-initiated dismiss triggers.
    advancePastGrace();

    mockOverlayCount = 1;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does NOT close when overlayCount rises during the grace window (issue #5084)", () => {
    // Dropdown opens with no overlays present.
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // An in-flight modal (e.g. cold-start AgentSetupWizard) mounts shortly
    // after and pushes the overlay count. Still inside the grace window, so
    // the dropdown should not be auto-closed.
    mockOverlayCount = 1;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();

    // Even after the grace window expires, the baseline absorbed the rise
    // so a steady overlay count must not trigger a close.
    advancePastGrace();
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes when an additional overlay opens after the grace window absorbed an in-flight one", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // In-flight modal arrives during grace; absorbed into baseline.
    mockOverlayCount = 1;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    advancePastGrace();

    // User now opens a genuinely new modal — this must dismiss the dropdown.
    mockOverlayCount = 2;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("restarts the grace window on reopen", () => {
    const { rerender } = render(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );
    advancePastGrace();

    // Close, then reopen while a modal is already visible.
    rerender(
      <FixedDropdown open={false} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    mockOverlayCount = 2;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );

    // Within the new grace window, any further in-flight rise is absorbed.
    mockOverlayCount = 3;
    rerender(
      <FixedDropdown open={true} onOpenChange={onOpenChange} anchorRef={anchorRef}>
        <div>Content</div>
      </FixedDropdown>
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    // After the new grace window expires, a further rise closes.
    advancePastGrace();
    mockOverlayCount = 4;
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

    advancePastGrace();

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
