// @vitest-environment jsdom
/**
 * Close-time focus restoration for the copy-tree dropdown (#11733).
 *
 * The trigger's own action moved inside the panel, so the panel takes focus on
 * open — which makes handing it back on close the toolbar's problem. The trap is
 * the exit transition: `FixedDropdown` keeps its body mounted while the panel
 * animates out, so for that whole window the focused row is still in the
 * document and "has anything else claimed focus?" cannot be answered by looking
 * for `<body>`. These tests render the real dropdown so that window is real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { useRef, useState } from "react";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

vi.mock("@/store/uiStore", () => ({
  useUIStore: (selector: (state: { overlayStack: string[] }) => unknown) =>
    selector({ overlayStack: [] }),
}));

vi.mock("@/store/copyTreeHistoryStore", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({ records: [], loading: false, init: () => {} }));
  return { useCopyTreeHistoryStore: store };
});

import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";
import { _resetForTests } from "@/lib/escapeStack";
import { CopyTreeRecentsPanel } from "../CopyTreeRecentsPanel";
import { restoreCopyTreeTriggerFocus } from "../copyTreeFocus";

let frames: FrameRequestCallback[] = [];

function flushFrames() {
  act(() => {
    const queued = frames;
    frames = [];
    for (const cb of queued) cb(0);
  });
}

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useGlobalEscapeDispatcher();

  // The toolbar's `closeCopyTreePanel`, and the only part of it worth mirroring:
  // drop the open state, then let the helper decide about focus.
  const close = () => {
    setOpen(false);
    restoreCopyTreeTriggerFocus(triggerRef.current);
  };

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Copy context
      </button>
      <input data-testid="outside" />
      <FixedDropdown
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        anchorRef={triggerRef}
      >
        <CopyTreeRecentsPanel onCopyFullContext={close} onRunRecent={close} />
      </FixedDropdown>
    </>
  );
}

function openPanel() {
  const trigger = screen.getByRole("button", { name: "Copy context" });
  fireEvent.click(trigger);
  flushFrames();
  return trigger;
}

describe("copy-tree dropdown focus restoration", () => {
  beforeEach(() => {
    _resetForTests();
    frames = [];
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    // `unstubAllGlobals` below also clears the setup file's ResizeObserver
    // shim, which the scroll-shadow hook constructs on every render after the
    // first — reinstate it here rather than leaking the teardown.
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    render(<Harness />);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("hands focus back to the trigger while the panel is still animating out", () => {
    const trigger = openPanel();
    const primaryRow = screen.getByRole("button", { name: "Copy full context" });
    expect(document.activeElement).toBe(primaryRow);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    flushFrames();

    // The panel is still mounted here — the exact window in which a check for
    // `<body>` alone finds the focused row instead and restores nothing.
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("hands focus back to the trigger when a row is chosen", () => {
    const trigger = openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Copy full context" }));
    flushFrames();

    expect(document.activeElement).toBe(trigger);
  });

  it("leaves focus wherever an outside click put it", () => {
    openPanel();
    const outside = screen.getByTestId("outside");

    // The dismiss path runs off `mousedown`, ahead of the browser's own focus
    // transfer — so the panel still holds focus at the moment it closes.
    fireEvent.mouseDown(outside);
    act(() => {
      outside.focus();
    });
    flushFrames();

    expect(document.activeElement).toBe(outside);
  });
});
