// @vitest-environment jsdom
import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AppDialog } from "../AppDialog";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

let mockPrevOpen = false;

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({
    isOpen,
    onAnimateOut,
  }: {
    isOpen: boolean;
    onAnimateOut?: () => void;
  }) => {
    if (mockPrevOpen && !isOpen) onAnimateOut?.();
    mockPrevOpen = isOpen;
    return { isVisible: isOpen, shouldRender: isOpen };
  },
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function Dispatcher() {
  useGlobalEscapeDispatcher();
  return null;
}

function renderDialog({
  isOpen = true,
  onClose = vi.fn(),
  children,
}: {
  isOpen?: boolean;
  onClose?: () => void;
  children?: React.ReactNode;
} = {}) {
  return render(
    <>
      <Dispatcher />
      <AppDialog isOpen={isOpen} onClose={onClose} data-testid="test-dialog">
        {children ?? (
          <AppDialog.Body>
            <button type="button">First</button>
            <input type="text" placeholder="Middle" />
            <button type="button">Last</button>
          </AppDialog.Body>
        )}
      </AppDialog>
    </>
  );
}

function pressTab(shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    shiftKey,
  });
  window.dispatchEvent(event);
}

function pressEscape() {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
  });
  window.dispatchEvent(event);
}

describe("AppDialog focus trapping", () => {
  beforeEach(() => {
    mockPrevOpen = false;
    _resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it("auto-focuses the first focusable element on open", async () => {
    renderDialog();
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement).toBeInstanceOf(HTMLButtonElement);
    expect((document.activeElement as HTMLElement).textContent).toBe("First");
  });

  it("wraps focus forward from last to first element on Tab", async () => {
    renderDialog();
    await act(() => vi.runAllTimersAsync());

    const buttons = screen.getAllByRole("button");
    const lastButton = buttons[buttons.length - 1]!;
    lastButton.focus();
    expect(document.activeElement).toBe(lastButton);

    pressTab();

    const firstButton = buttons[0];
    expect(document.activeElement).toBe(firstButton);
  });

  it("wraps focus from the last visible element when hidden tabbables follow it", async () => {
    renderDialog({
      children: (
        <AppDialog.Body>
          <button type="button">First</button>
          <button type="button">Last visible</button>
          <button type="button" hidden>
            Hidden
          </button>
        </AppDialog.Body>
      ),
    });
    await act(() => vi.runAllTimersAsync());

    const firstButton = screen.getByRole("button", { name: "First" });
    const lastVisibleButton = screen.getByRole("button", { name: "Last visible" });
    lastVisibleButton.focus();
    expect(document.activeElement).toBe(lastVisibleButton);

    pressTab();

    expect(document.activeElement).toBe(firstButton);
  });

  it("wraps focus backward from first to last element on Shift+Tab", async () => {
    renderDialog();
    await act(() => vi.runAllTimersAsync());

    const buttons = screen.getAllByRole("button");
    const firstButton = buttons[0]!;
    firstButton.focus();
    expect(document.activeElement).toBe(firstButton);

    pressTab(true);

    const lastButton = buttons[buttons.length - 1];
    expect(document.activeElement).toBe(lastButton);
  });

  it("focuses the container when there are no focusable children", async () => {
    renderDialog({
      children: (
        <AppDialog.Body>
          <p>No focusable elements here</p>
        </AppDialog.Body>
      ),
    });
    await act(() => vi.runAllTimersAsync());

    // The dialog container should have focus (tabIndex={-1})
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");

    // Tab should keep focus on the container
    pressTab();
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("still closes on Escape", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await act(() => vi.runAllTimersAsync());

    pressEscape();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores focus to previously focused element on close", async () => {
    const outerButton = document.createElement("button");
    outerButton.textContent = "Outer";
    document.body.appendChild(outerButton);
    outerButton.focus();

    const { rerender } = render(
      <>
        <Dispatcher />
        <AppDialog isOpen={true} onClose={() => {}} data-testid="test-dialog">
          <AppDialog.Body>
            <button type="button">Inner</button>
          </AppDialog.Body>
        </AppDialog>
      </>
    );
    await act(() => vi.runAllTimersAsync());

    rerender(
      <>
        <Dispatcher />
        <AppDialog isOpen={false} onClose={() => {}} data-testid="test-dialog">
          <AppDialog.Body>
            <button type="button">Inner</button>
          </AppDialog.Body>
        </AppDialog>
      </>
    );

    expect(document.activeElement).toBe(outerButton);
    document.body.removeChild(outerButton);
  });

  it("falls back via cleanup effect when the dialog host unmounts while open", async () => {
    const root = document.createElement("div");
    root.id = "root";
    const fallbackButton = document.createElement("button");
    fallbackButton.textContent = "Fallback";
    root.appendChild(fallbackButton);
    document.body.appendChild(root);

    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <>
        <Dispatcher />
        <AppDialog isOpen={true} onClose={() => {}} data-testid="test-dialog">
          <AppDialog.Body>
            <button type="button">Inner</button>
          </AppDialog.Body>
        </AppDialog>
      </>
    );
    await act(() => vi.runAllTimersAsync());

    document.body.removeChild(trigger);
    unmount();

    expect(document.activeElement).toBe(fallbackButton);
    expect(document.activeElement).not.toBe(document.body);
    document.body.removeChild(root);
  });

  it("falls back to first tabbable in #root when trigger was unmounted before close", async () => {
    const root = document.createElement("div");
    root.id = "root";
    const fallbackButton = document.createElement("button");
    fallbackButton.textContent = "Fallback";
    root.appendChild(fallbackButton);
    document.body.appendChild(root);

    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <>
        <Dispatcher />
        <AppDialog isOpen={true} onClose={() => {}} data-testid="test-dialog">
          <AppDialog.Body>
            <button type="button">Inner</button>
          </AppDialog.Body>
        </AppDialog>
      </>
    );
    await act(() => vi.runAllTimersAsync());

    // Trigger gets unmounted by the action that ran inside the dialog
    // (e.g., the row containing it was deleted).
    document.body.removeChild(trigger);

    rerender(
      <>
        <Dispatcher />
        <AppDialog isOpen={false} onClose={() => {}} data-testid="test-dialog">
          <AppDialog.Body>
            <button type="button">Inner</button>
          </AppDialog.Body>
        </AppDialog>
      </>
    );

    expect(document.activeElement).toBe(fallbackButton);
    expect(document.activeElement).not.toBe(document.body);
    document.body.removeChild(root);
  });

  describe("AppDialog Footer a11y", () => {
    it("sets aria-busy on primary button when loading", async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} data-testid="test-dialog">
            <AppDialog.Body>
              <p>Content</p>
            </AppDialog.Body>
            <AppDialog.Footer
              primaryAction={{
                label: "Save",
                onClick: () => {},
                loading: true,
              }}
            />
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      const primary = screen.getByRole("button", { name: "Save" });
      expect(primary.getAttribute("aria-busy")).toBe("true");
    });

    it("omits aria-busy on primary button when not loading", async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} data-testid="test-dialog">
            <AppDialog.Body>
              <p>Content</p>
            </AppDialog.Body>
            <AppDialog.Footer
              primaryAction={{
                label: "Save",
                onClick: () => {},
              }}
            />
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      const primary = screen.getByRole("button", { name: "Save" });
      expect(primary.hasAttribute("aria-busy")).toBe(false);
    });

    it("secondary button ignores loading prop", async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} data-testid="test-dialog">
            <AppDialog.Body>
              <p>Content</p>
            </AppDialog.Body>
            <AppDialog.Footer
              primaryAction={{
                label: "OK",
                onClick: () => {},
              }}
              secondaryAction={{
                label: "Cancel",
                onClick: () => {},
                loading: true,
              }}
            />
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      const secondary = screen.getByRole("button", { name: "Cancel" });
      expect(secondary.hasAttribute("aria-busy")).toBe(false);
      // Not disabled by the unused loading flag
      expect((secondary as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe("AppDialog destructive variant", () => {
    it('renders role="alertdialog" when variant is destructive', async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog
            isOpen={true}
            onClose={() => {}}
            variant="destructive"
            data-testid="test-dialog"
          >
            <AppDialog.Body>
              <p>Content</p>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      expect(screen.getByTestId("test-dialog").getAttribute("role")).toBe("alertdialog");
    });

    it('renders role="dialog" for the default variant', async () => {
      renderDialog();
      await act(() => vi.runAllTimersAsync());

      expect(screen.getByTestId("test-dialog").getAttribute("role")).toBe("dialog");
    });

    it("auto-focuses the Cancel button by default for destructive variant", async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog
            isOpen={true}
            onClose={() => {}}
            variant="destructive"
            data-testid="test-dialog"
          >
            <AppDialog.Body>
              <input type="text" placeholder="Some input" />
            </AppDialog.Body>
            <AppDialog.Footer
              secondaryAction={{ label: "Cancel", onClick: () => {} }}
              primaryAction={{ label: "Delete worktree", onClick: () => {} }}
            />
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
      expect((document.activeElement as HTMLElement).textContent).toBe("Cancel");
    });

    it('focuses the confirm button when initialFocus="confirm"', async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog
            isOpen={true}
            onClose={() => {}}
            variant="default"
            initialFocus="confirm"
            data-testid="test-dialog"
          >
            <AppDialog.Body>
              <input type="text" placeholder="Some input" />
            </AppDialog.Body>
            <AppDialog.Footer
              secondaryAction={{ label: "Cancel", onClick: () => {} }}
              primaryAction={{ label: "Save", onClick: () => {} }}
            />
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("confirm");
    });

    it('does not move focus when initialFocus="none"', async () => {
      const outerInput = document.createElement("input");
      document.body.appendChild(outerInput);
      outerInput.focus();
      expect(document.activeElement).toBe(outerInput);

      render(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} initialFocus="none" data-testid="test-dialog">
            <AppDialog.Body>
              <button type="button">Inside</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      expect(document.activeElement).toBe(outerInput);
      document.body.removeChild(outerInput);
    });

    it("falls back to first tabbable when destructive footer has no data-confirm-role marker", async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog
            isOpen={true}
            onClose={() => {}}
            variant="destructive"
            data-testid="test-dialog"
          >
            <AppDialog.Body>
              <button type="button">First inside body</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      expect(document.activeElement).toBeInstanceOf(HTMLButtonElement);
      expect((document.activeElement as HTMLElement).textContent).toBe("First inside body");
    });

    it("tags footer Cancel button with data-confirm-role=cancel", async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} data-testid="test-dialog">
            <AppDialog.Body>
              <p>Content</p>
            </AppDialog.Body>
            <AppDialog.Footer
              secondaryAction={{ label: "Cancel", onClick: () => {} }}
              primaryAction={{ label: "Save", onClick: () => {} }}
            />
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      const cancel = screen.getByRole("button", { name: "Cancel" });
      const save = screen.getByRole("button", { name: "Save" });
      expect(cancel.getAttribute("data-confirm-role")).toBe("cancel");
      expect(save.getAttribute("data-confirm-role")).toBe("confirm");
    });
  });

  it("does not interfere with focus in portaled popovers outside dialogRef", async () => {
    renderDialog();
    await act(() => vi.runAllTimersAsync());

    // Simulate a portaled popover outside dialogRef (e.g., Radix popover)
    const popoverInput = document.createElement("input");
    popoverInput.placeholder = "Popover";
    document.body.appendChild(popoverInput);
    popoverInput.focus();
    expect(document.activeElement).toBe(popoverInput);

    // Tab should NOT yank focus back into the dialog
    pressTab();
    // Focus should remain on the popover input (no preventDefault in JSDOM = no move)
    expect(document.activeElement).toBe(popoverInput);

    document.body.removeChild(popoverInput);
  });
});
