// @vitest-environment jsdom
/**
 * The Portal writes its width on every frame of a dock resize. A dialog that
 * isn't on screen must not re-render for it — hosts keep their dialogs mounted
 * and closed once opened, one pair per worktree card (#17072).
 */
import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

// While set, a closing dialog stays painted, mid-exit, until a render with it
// cleared. Otherwise the exit finishes at once on close.
let mockExitPending = false;

vi.mock("@/hooks/useAnimatedPresence", async () => {
  const { useRef } = await import("react");
  return {
    useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => {
      const painted = useRef(false);
      if (isOpen) painted.current = true;
      else if (painted.current && !mockExitPending) painted.current = false;
      return { isVisible: isOpen, shouldRender: painted.current };
    },
  };
});

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

import { AppDialog } from "../AppDialog";
import { usePortalStore } from "@/store/portalStore";

let commits = 0;
const countCommit = () => {
  commits += 1;
};

function Dialog({ isOpen }: { isOpen: boolean }) {
  return (
    <Profiler id="dialog" onRender={countCommit}>
      <AppDialog isOpen={isOpen} onClose={() => {}}>
        <AppDialog.Body>Body</AppDialog.Body>
      </AppDialog>
    </Profiler>
  );
}

function resizePortal(width: number) {
  act(() => {
    usePortalStore.setState({ isOpen: true, width });
  });
}

function backdropRight(): string | undefined {
  const styled = [...document.querySelectorAll<HTMLElement>("[style]")].find(
    (el) => el.style.right !== ""
  );
  return styled?.style.right;
}

beforeEach(() => {
  usePortalStore.setState({ isOpen: true, width: 300 });
  commits = 0;
  mockExitPending = false;
});

afterEach(() => {
  cleanup();
});

describe("AppDialog Portal reads (#17072)", () => {
  it("does not re-render a closed dialog while the Portal resizes", () => {
    render(<Dialog isOpen={false} />);
    commits = 0;
    resizePortal(320);
    resizePortal(340);
    expect(commits).toBe(0);
  });

  it("keeps an open dialog clear of the Portal as it resizes", () => {
    render(<Dialog isOpen />);
    expect(backdropRight()).toBe("300px");
    resizePortal(360);
    expect(backdropRight()).toBe("360px");
  });

  it("stops re-rendering for the Portal once an opened dialog has closed", () => {
    const view = render(<Dialog isOpen />);
    view.rerender(<Dialog isOpen={false} />);
    commits = 0;
    resizePortal(380);
    expect(commits).toBe(0);

    view.rerender(<Dialog isOpen />);
    expect(backdropRight()).toBe("380px");
  });

  it("follows the Portal through the exit, and lets go once it has finished", () => {
    const view = render(<Dialog isOpen />);
    mockExitPending = true;
    view.rerender(<Dialog isOpen={false} />);
    resizePortal(420);
    expect(backdropRight()).toBe("420px");

    mockExitPending = false;
    view.rerender(<Dialog isOpen={false} />);
    commits = 0;
    resizePortal(440);
    expect(commits).toBe(0);
  });
});
