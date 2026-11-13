// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialog } from "../AppDialog";
import { AppPaletteDialog } from "../AppPaletteDialog";
import { _resetForTests } from "@/lib/escapeStack";
import { _resetForTests as _resetBackstopForTests } from "@/lib/dialogEscapeBackstop";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store/portalStore", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

// Per instance, so two dialogs in one tree each run their own exit. The exit
// ends on a timer after the closing commit, with the surface still painted, and
// hands focus back there, as the real presence does — and, like the real exit,
// a few frames after a dialog opened alongside has placed its initial focus.
vi.mock("@/hooks/useAnimatedPresence", async () => {
  const { useEffect, useRef, useState } = await import("react");
  return {
    useAnimatedPresence: ({
      isOpen,
      onAnimateOut,
    }: {
      isOpen: boolean;
      onAnimateOut?: () => void;
    }) => {
      const [painted, setPainted] = useState(isOpen);
      if (isOpen && !painted) setPainted(true);
      const onAnimateOutRef = useRef(onAnimateOut);
      onAnimateOutRef.current = onAnimateOut;
      useEffect(() => {
        if (isOpen || !painted) return;
        const timer = setTimeout(() => {
          setPainted(false);
          onAnimateOutRef.current?.();
        }, 100);
        return () => clearTimeout(timer);
      }, [isOpen, painted]);
      return { isVisible: isOpen, shouldRender: isOpen || painted };
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

function Harness({
  outerOpen,
  nestedOpen,
  rowMounted,
}: {
  outerOpen: boolean;
  nestedOpen: boolean;
  rowMounted: boolean;
}) {
  return (
    <AppDialog isOpen={outerOpen} onClose={() => {}} data-testid="outer">
      <AppDialog.Header>
        <AppDialog.Title>Settings</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <button type="button">Add account</button>
        {rowMounted && <button type="button">Remove work</button>}
      </AppDialog.Body>
      <AppDialog isOpen={nestedOpen} onClose={() => {}} zIndex="nested" data-testid="nested">
        <AppDialog.Body>
          <button type="button">Confirm remove</button>
        </AppDialog.Body>
      </AppDialog>
    </AppDialog>
  );
}

describe("AppDialog fallback focus with a parent dialog still open", () => {
  let root: HTMLElement;
  let shellButton: HTMLButtonElement;

  beforeEach(() => {
    _resetForTests();
    _resetBackstopForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    root = document.createElement("div");
    root.id = "root";
    shellButton = document.createElement("button");
    shellButton.textContent = "Toolbar";
    root.appendChild(shellButton);
    document.body.appendChild(root);
  });

  afterEach(() => {
    cleanup();
    root.remove();
    vi.useRealTimers();
    _resetForTests();
    _resetBackstopForTests();
  });

  async function openNestedFromRow() {
    const view = render(<Harness outerOpen nestedOpen={false} rowMounted />);
    await act(() => vi.runAllTimersAsync());
    screen.getByRole("button", { name: "Remove work" }).focus();
    view.rerender(<Harness outerOpen nestedOpen rowMounted />);
    await act(() => vi.runAllTimersAsync());
    expect(document.activeElement?.textContent).toBe("Confirm remove");
    return view;
  }

  it("keeps focus inside the parent dialog when the nested dialog's trigger is gone", async () => {
    const view = await openNestedFromRow();

    // Confirming removes the row that opened the confirmation, then closes it.
    view.rerender(<Harness outerOpen nestedOpen rowMounted={false} />);
    view.rerender(<Harness outerOpen nestedOpen={false} rowMounted={false} />);
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement).not.toBe(shellButton);
    expect(screen.getByTestId("outer").contains(document.activeElement)).toBe(true);
    // The parent's first control, never its close button: a reflexive Enter
    // there would throw the whole parent away.
    expect(document.activeElement?.textContent).toBe("Add account");
  });

  it("falls back to the app shell when the parent closes along with it", async () => {
    const view = await openNestedFromRow();

    view.rerender(<Harness outerOpen nestedOpen rowMounted={false} />);
    view.rerender(<Harness outerOpen={false} nestedOpen={false} rowMounted={false} />);
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement).toBe(shellButton);
  });

  it("still returns to the trigger when it survived the nested dialog", async () => {
    const view = await openNestedFromRow();

    view.rerender(<Harness outerOpen nestedOpen={false} rowMounted />);
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement?.textContent).toBe("Remove work");
  });

  it("keeps focus inside the parent when the nested dialog unmounts with its row", async () => {
    function RowWithConfirm({ confirming }: { confirming: boolean }) {
      return (
        <>
          <button type="button">Delete preset</button>
          <AppDialog isOpen={confirming} onClose={() => {}} zIndex="nested">
            <AppDialog.Body>
              <button type="button">Confirm delete</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
    }
    const tree = (rowMounted: boolean, confirming: boolean) => (
      <AppDialog isOpen onClose={() => {}} data-testid="outer">
        <AppDialog.Body>
          <button type="button">Add preset</button>
          {rowMounted && <RowWithConfirm confirming={confirming} />}
        </AppDialog.Body>
      </AppDialog>
    );
    const view = render(tree(true, false));
    await act(() => vi.runAllTimersAsync());
    screen.getByRole("button", { name: "Delete preset" }).focus();
    view.rerender(tree(true, true));
    await act(() => vi.runAllTimersAsync());
    expect(document.activeElement?.textContent).toBe("Confirm delete");

    // The delete lands mid-exit and takes the row, confirm and all, with it.
    view.rerender(tree(true, false));
    view.rerender(tree(false, false));
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement?.textContent).toBe("Add preset");
  });

  it("lands on the parent's panel when the parent has nothing tabbable", async () => {
    const tree = (nestedOpen: boolean, triggerMounted: boolean) => (
      <AppDialog isOpen onClose={() => {}} data-testid="outer">
        <AppDialog.Body>
          <p>Nothing to press</p>
          {triggerMounted && <button type="button">Open</button>}
        </AppDialog.Body>
        <AppDialog isOpen={nestedOpen} onClose={() => {}} zIndex="nested">
          <AppDialog.Body>
            <button type="button">Inner</button>
          </AppDialog.Body>
        </AppDialog>
      </AppDialog>
    );
    const view = render(tree(false, true));
    await act(() => vi.runAllTimersAsync());
    screen.getByRole("button", { name: "Open" }).focus();
    view.rerender(tree(true, true));
    await act(() => vi.runAllTimersAsync());
    view.rerender(tree(true, false));
    view.rerender(tree(false, false));
    await act(() => vi.runAllTimersAsync());

    const outer = screen.getByTestId("outer");
    expect(document.activeElement).toBe(outer.firstElementChild);
  });
});

describe("AppDialog opened by a palette command", () => {
  let opener: HTMLButtonElement;

  beforeEach(() => {
    _resetForTests();
    _resetBackstopForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    opener = document.createElement("button");
    opener.textContent = "Terminal";
    document.body.appendChild(opener);
    opener.focus();
  });

  afterEach(() => {
    cleanup();
    opener.remove();
    vi.useRealTimers();
    _resetForTests();
    _resetBackstopForTests();
  });

  function Commands({ paletteOpen, dialogOpen }: { paletteOpen: boolean; dialogOpen: boolean }) {
    return (
      <>
        <AppPaletteDialog isOpen={paletteOpen} onClose={() => {}} ariaLabel="Commands" tier="command">
          <input aria-label="Search commands" />
        </AppPaletteDialog>
        <AppDialog isOpen={dialogOpen} onClose={() => {}} data-testid="command-dialog">
          <AppDialog.Body>
            <button type="button">Save</button>
          </AppDialog.Body>
        </AppDialog>
      </>
    );
  }

  async function openPalette() {
    const view = render(<Commands paletteOpen dialogOpen={false} />);
    await act(() => vi.runAllTimersAsync());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search commands");
    return view;
  }

  it("keeps the dialog's focus through the palette's exit and returns to what opened the palette", async () => {
    const view = await openPalette();

    // The pick closes the palette and opens the dialog in the same commit.
    view.rerender(<Commands paletteOpen={false} dialogOpen />);
    await act(() => vi.runAllTimersAsync());

    expect(screen.getByTestId("command-dialog").contains(document.activeElement)).toBe(true);

    view.rerender(<Commands paletteOpen={false} dialogOpen={false} />);
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement).toBe(opener);
  });

  it("does the same when the dialog opens a commit after the palette starts closing", async () => {
    const view = await openPalette();

    view.rerender(<Commands paletteOpen={false} dialogOpen={false} />);
    view.rerender(<Commands paletteOpen={false} dialogOpen />);
    await act(() => vi.runAllTimersAsync());

    expect(screen.getByTestId("command-dialog").contains(document.activeElement)).toBe(true);

    view.rerender(<Commands paletteOpen={false} dialogOpen={false} />);
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement).toBe(opener);
  });

  it("returns to the palette field when the palette stays open under the dialog", async () => {
    const view = await openPalette();

    view.rerender(<Commands paletteOpen dialogOpen />);
    await act(() => vi.runAllTimersAsync());
    view.rerender(<Commands paletteOpen dialogOpen={false} />);
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search commands");
  });
});
