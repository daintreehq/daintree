// @vitest-environment jsdom
import { useLayoutEffect, type ReactNode } from "react";
import { render, act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialog } from "../AppDialog";
import { _resetForTests } from "@/lib/escapeStack";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function runFrames() {
  const due = [...frames.values()];
  frames = new Map();
  for (const callback of due) callback(performance.now());
}

// React commits an update and flushes its passive effects in separate tasks, so
// a frame can land between the two. Run from a parent's layout effect, the
// queued frames fire after the dialog's own layout effects and before its
// passive ones: exactly that gap, made deterministic.
function FrameInGap({ when, children }: { when: boolean; children: ReactNode }) {
  useLayoutEffect(() => {
    if (when) runFrames();
  }, [when]);
  return <>{children}</>;
}

function Loading({ listed }: { listed: boolean }) {
  return (
    <FrameInGap when={listed}>
      <AppDialog
        isOpen
        onClose={() => {}}
        initialFocus={listed ? "first" : "surface"}
        focusResetKey={listed ? "listed" : "loading"}
        data-testid="reset-dialog"
      >
        <AppDialog.Body>{listed && <button type="button">Row</button>}</AppDialog.Body>
      </AppDialog>
    </FrameInGap>
  );
}

describe("AppDialog focus reset with a frame between commit and effects", () => {
  beforeEach(() => {
    _resetForTests();
    frames = new Map();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("pays the reset's focus, not the one the frame queued before it was owed", () => {
    const { rerender } = render(<Loading listed={false} />);

    // The loading frame is still queued when the list arrives.
    act(() => rerender(<Loading listed />));
    act(() => runFrames());

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Row" }));
  });

  it("still lands on the surface while loading when the frame runs in time", () => {
    render(<Loading listed={false} />);
    act(() => runFrames());

    const active = document.activeElement;
    expect(screen.getByRole("dialog").contains(active)).toBe(true);
    expect(active?.tagName).toBe("DIV");
  });
});
