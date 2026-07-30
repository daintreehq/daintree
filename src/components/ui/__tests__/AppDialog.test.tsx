// @vitest-environment jsdom
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AppDialog } from "../AppDialog";
import { _resetForTests } from "@/lib/escapeStack";
import { _resetForTests as _resetBackstopForTests } from "@/lib/dialogEscapeBackstop";
import { handleDockEscapeKeyDown } from "@/components/Layout/dockPopoverGuard";
import {
  setDockPopoverOpen,
  _resetForTests as _resetDockPopoverForTests,
} from "@/lib/dockPopoverLayer";
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

  describe("restoreFocusTo logical successor", () => {
    type FocusTarget = React.RefObject<HTMLElement | null> | (() => HTMLElement | null);

    function setupTriggerAndRoot() {
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

      return { root, fallbackButton, trigger };
    }

    async function openCloseWith(restoreFocusTo: FocusTarget, trigger: HTMLButtonElement) {
      const { rerender } = render(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} restoreFocusTo={restoreFocusTo}>
            <AppDialog.Body>
              <button type="button">Inner</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      // The trigger is removed by the action that ran inside the dialog.
      document.body.removeChild(trigger);

      rerender(
        <>
          <Dispatcher />
          <AppDialog isOpen={false} onClose={() => {}} restoreFocusTo={restoreFocusTo}>
            <AppDialog.Body>
              <button type="button">Inner</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
    }

    it("focuses a connected ref target instead of the #root fallback", async () => {
      const { root, fallbackButton, trigger } = setupTriggerAndRoot();
      const successor = document.createElement("button");
      successor.textContent = "Successor";
      document.body.appendChild(successor);

      await openCloseWith({ current: successor }, trigger);

      expect(document.activeElement).toBe(successor);
      expect(document.activeElement).not.toBe(fallbackButton);
      document.body.removeChild(successor);
      document.body.removeChild(root);
    });

    it("falls through to the #root fallback when the ref target is disconnected", async () => {
      const { root, fallbackButton, trigger } = setupTriggerAndRoot();
      // Never appended to the document — disconnected.
      const successor = document.createElement("button");
      successor.textContent = "Successor";

      await openCloseWith({ current: successor }, trigger);

      expect(document.activeElement).toBe(fallbackButton);
      document.body.removeChild(root);
    });

    it("focuses the element returned by a function target", async () => {
      const { root, fallbackButton, trigger } = setupTriggerAndRoot();
      const successor = document.createElement("button");
      successor.textContent = "Successor";
      document.body.appendChild(successor);

      await openCloseWith(() => successor, trigger);

      expect(document.activeElement).toBe(successor);
      expect(document.activeElement).not.toBe(fallbackButton);
      document.body.removeChild(successor);
      document.body.removeChild(root);
    });

    it("falls through to the #root fallback when the function returns null", async () => {
      const { root, fallbackButton, trigger } = setupTriggerAndRoot();

      await openCloseWith(() => null, trigger);

      expect(document.activeElement).toBe(fallbackButton);
      document.body.removeChild(root);
    });

    it("ignores restoreFocusTo when the trigger is still connected", async () => {
      const { root, trigger } = setupTriggerAndRoot();
      const successor = document.createElement("button");
      successor.textContent = "Successor";
      document.body.appendChild(successor);

      const { rerender } = render(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} restoreFocusTo={{ current: successor }}>
            <AppDialog.Body>
              <button type="button">Inner</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      // Trigger stays mounted — focus must return to it, not the successor.
      rerender(
        <>
          <Dispatcher />
          <AppDialog isOpen={false} onClose={() => {}} restoreFocusTo={{ current: successor }}>
            <AppDialog.Body>
              <button type="button">Inner</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );

      expect(document.activeElement).toBe(trigger);
      expect(document.activeElement).not.toBe(successor);
      document.body.removeChild(successor);
      document.body.removeChild(trigger);
      document.body.removeChild(root);
    });

    it("falls through to #root when the connected target cannot take focus", async () => {
      const { root, fallbackButton, trigger } = setupTriggerAndRoot();
      // A connected but non-focusable element: focus() is a no-op.
      const successor = document.createElement("div");
      successor.textContent = "Successor";
      document.body.appendChild(successor);

      await openCloseWith({ current: successor }, trigger);

      expect(document.activeElement).toBe(fallbackButton);
      expect(document.activeElement).not.toBe(successor);
      document.body.removeChild(successor);
      document.body.removeChild(root);
    });

    it("falls through to #root when the function target throws", async () => {
      const { root, fallbackButton, trigger } = setupTriggerAndRoot();

      await openCloseWith(() => {
        throw new Error("boom");
      }, trigger);

      expect(document.activeElement).toBe(fallbackButton);
      document.body.removeChild(root);
    });

    it("does not restore focus prematurely when restoreFocusTo identity changes while open", async () => {
      const { root, trigger } = setupTriggerAndRoot();
      const successor = document.createElement("button");
      successor.textContent = "Successor";
      document.body.appendChild(successor);

      const { rerender } = render(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} restoreFocusTo={() => successor}>
            <AppDialog.Body>
              <button type="button">Inner</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());
      const innerButton = screen.getByText("Inner");
      expect(document.activeElement).toBe(innerButton);

      // Parent re-renders while the dialog is open, passing a fresh inline
      // function. Focus must stay inside the dialog — no premature restore.
      rerender(
        <>
          <Dispatcher />
          <AppDialog isOpen={true} onClose={() => {}} restoreFocusTo={() => successor}>
            <AppDialog.Body>
              <button type="button">Inner</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      expect(document.activeElement).toBe(innerButton);

      // The real close still restores to the successor once the trigger is gone.
      document.body.removeChild(trigger);
      rerender(
        <>
          <Dispatcher />
          <AppDialog isOpen={false} onClose={() => {}} restoreFocusTo={() => successor}>
            <AppDialog.Body>
              <button type="button">Inner</button>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      expect(document.activeElement).toBe(successor);
      document.body.removeChild(successor);
      document.body.removeChild(root);
    });
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

    it('renders role="dialog" for destructive variant with hasPreview={true}', async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog
            isOpen={true}
            onClose={() => {}}
            variant="destructive"
            hasPreview={true}
            data-testid="test-dialog"
          >
            <AppDialog.Body>
              <ul>
                <li>commit abc123</li>
              </ul>
            </AppDialog.Body>
          </AppDialog>
        </>
      );
      await act(() => vi.runAllTimersAsync());

      expect(screen.getByTestId("test-dialog").getAttribute("role")).toBe("dialog");
    });

    it('renders role="alertdialog" for destructive variant with hasPreview={false}', async () => {
      render(
        <>
          <Dispatcher />
          <AppDialog
            isOpen={true}
            onClose={() => {}}
            variant="destructive"
            hasPreview={false}
            data-testid="test-dialog"
          >
            <AppDialog.Body>
              <p>Are you sure?</p>
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

// VoiceOver suppresses `aria-live` updates outside the focused `aria-modal`
// subtree (Chromium 354736464). Daintree co-locates a live-region inside
// AppDialog so the DOM-mutation fallback path survives that bug.
describe("AppDialog co-located live region", () => {
  beforeEach(() => {
    mockPrevOpen = false;
    _resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it("renders an aria-live region inside the aria-modal subtree", () => {
    renderDialog();
    const modal = screen.getByRole("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    const liveRegions = modal.querySelectorAll("[aria-live]");
    expect(liveRegions.length).toBeGreaterThan(0);
  });
});

// WCAG 2.3.3: opacity is not vestibular, movement is. Reduced motion must strip
// the card's rise/zoom while leaving both fades intact. jsdom evaluates neither
// Tailwind's output nor the `motion-reduce` media query, so the policy is only
// observable here as the set of variant utilities the component elects to emit.
describe("AppDialog reduced-motion policy", () => {
  beforeEach(() => {
    mockPrevOpen = false;
    _resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    _resetForTests();
  });

  function getCard(): Element {
    const card = screen.getByTestId("test-dialog").firstElementChild;
    if (!card) throw new Error("AppDialog rendered no card inside the backdrop");
    return card;
  }

  it("keeps the backdrop scrim fading under reduced motion", () => {
    renderDialog();
    const backdrop = screen.getByTestId("test-dialog");

    expect(backdrop.className).toContain("transition-opacity");
    expect(backdrop.className).not.toContain("motion-reduce:transition-none");
  });

  it("narrows the card to an opacity-only transition under reduced motion", () => {
    renderDialog();

    expect(getCard().className).toContain("motion-reduce:transition-opacity");
    expect(getCard().className).not.toContain("motion-reduce:transition-none");
  });

  it("freezes the card's translate and scale under reduced motion", () => {
    renderDialog();

    // Tailwind v4 emits `translate`/`scale` as individual properties, so both
    // need explicit neutralizers — `transform-none` would not cover them.
    expect(getCard().className).toContain("motion-reduce:translate-none");
    expect(getCard().className).toContain("motion-reduce:scale-none");
  });

  it("gives the backdrop an explicit easing rather than the Tailwind default", () => {
    renderDialog();
    const backdrop = screen.getByTestId("test-dialog");

    expect(backdrop.style.transitionTimingFunction).not.toBe("");
  });
});

describe("AppDialog header composition", () => {
  beforeEach(() => {
    mockPrevOpen = false;
    _resetForTests();
    // Earlier describes install fake timers and never restore them, so a
    // whole-file run would otherwise leak them into `waitFor` below.
    vi.useRealTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    _resetForTests();
  });

  // Queried by accessible name rather than by comparing two nullable
  // attributes: dropping the id, or the heading's text, has to fail these.
  it("labels the dialog by its title heading", () => {
    renderDialog({
      children: (
        <AppDialog.Header>
          <AppDialog.Title>Named</AppDialog.Title>
        </AppDialog.Header>
      ),
    });

    expect(screen.getByRole("dialog", { name: "Named" })).toBe(screen.getByTestId("test-dialog"));
  });

  it("keeps the title wired when rendered as an h3", () => {
    renderDialog({
      children: (
        <AppDialog.Header>
          <AppDialog.Title as="h3">Section</AppDialog.Title>
        </AppDialog.Header>
      ),
    });

    // Settings renders its section title as an h3; the dialog must still
    // resolve its accessible name to that heading.
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Section");
    expect(screen.getByRole("dialog", { name: "Section" })).toBe(screen.getByTestId("test-dialog"));
  });

  it("labels the dialog from a title mounted outside the header", () => {
    renderDialog({
      children: (
        <AppDialog.Body>
          <AppDialog.Title>Standalone</AppDialog.Title>
        </AppDialog.Body>
      ),
    });

    expect(screen.getByRole("dialog", { name: "Standalone" })).toBe(
      screen.getByTestId("test-dialog")
    );
  });

  it("forwards a header class override to the rendered frame", () => {
    // CrossWorktreeDiff restyles its header entirely through this prop; the
    // primitive's own tests would not catch the adapter dropping it.
    renderDialog({
      children: (
        <AppDialog.Header className="px-4 border-border-subtle">
          <AppDialog.Title>Named</AppDialog.Title>
        </AppDialog.Header>
      ),
    });
    const header = screen.getByRole("heading").parentElement;

    expect(header?.className).toContain("px-4");
    expect(header?.className).not.toContain("px-6");
  });

  it("forwards a title icon and class override", () => {
    // Nine dialogs pass a leading icon; the file viewers shrink the title.
    renderDialog({
      children: (
        <AppDialog.Header>
          <AppDialog.Title icon={<span data-testid="icon">*</span>} className="text-sm">
            Named
          </AppDialog.Title>
        </AppDialog.Header>
      ),
    });
    const heading = screen.getByRole("heading");

    expect(screen.queryByTestId("icon")).not.toBeNull();
    expect(heading.textContent).toBe("*Named");
    expect(heading.className).toContain("text-sm");
    expect(heading.className).not.toContain("text-lg");
  });

  it("defaults the close button label", () => {
    renderDialog({
      children: (
        <AppDialog.Header>
          <AppDialog.CloseButton />
        </AppDialog.Header>
      ),
    });

    expect(screen.queryByRole("button", { name: "Close dialog" })).not.toBeNull();
  });

  it("lets a surface name its own close button", () => {
    renderDialog({
      children: (
        <AppDialog.Header>
          <AppDialog.CloseButton aria-label="Close settings" />
        </AppDialog.Header>
      ),
    });

    expect(screen.queryByRole("button", { name: "Close settings" })).not.toBeNull();
  });

  it("closes through the dialog's own close handler", () => {
    const onClose = vi.fn();
    renderDialog({
      onClose,
      children: (
        <AppDialog.Header>
          <AppDialog.CloseButton />
        </AppDialog.Header>
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("routes the close button through onBeforeClose", async () => {
    const onClose = vi.fn();
    const onBeforeClose = vi.fn().mockResolvedValue(true);
    render(
      <>
        <Dispatcher />
        <AppDialog isOpen onClose={onClose} onBeforeClose={onBeforeClose} data-testid="test-dialog">
          <AppDialog.Header>
            <AppDialog.CloseButton />
          </AppDialog.Header>
        </AppDialog>
      </>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onBeforeClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open when onBeforeClose vetoes", async () => {
    const onClose = vi.fn();
    const onBeforeClose = vi.fn().mockResolvedValue(false);
    render(
      <>
        <Dispatcher />
        <AppDialog isOpen onClose={onClose} onBeforeClose={onBeforeClose} data-testid="test-dialog">
          <AppDialog.Header>
            <AppDialog.CloseButton />
          </AppDialog.Header>
        </AppDialog>
      </>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    await waitFor(() => expect(onBeforeClose).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * A dock popover deliberately survives the dialog it spawns, so it is always
 * "the open Radix layer" the capture probe records — and the backstop's gate
 * would hand it every Escape, dismissing the panel underneath instead of the
 * dialog on top of it (#11505). The popover declines the keypress; this is the
 * receiving half.
 */
describe("AppDialog Escape yielded by the layer underneath", () => {
  let dockGuard: ((e: KeyboardEvent) => void) | null = null;

  beforeEach(() => {
    mockPrevOpen = false;
    _resetForTests();
    _resetBackstopForTests();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    if (dockGuard) {
      document.removeEventListener("keydown", dockGuard, true);
      dockGuard = null;
    }
    _resetForTests();
    _resetBackstopForTests();
    document.querySelectorAll("[data-open-radix-layer]").forEach((el) => el.remove());
  });

  /** Stands in for the still-open dock popover behind the dialog. */
  function openRadixLayerBehind() {
    const layer = document.createElement("div");
    layer.setAttribute("role", "dialog");
    layer.setAttribute("data-state", "open");
    layer.setAttribute("data-open-radix-layer", "");
    document.body.appendChild(layer);
  }

  /**
   * Radix's DismissableLayer listens on document *capture*, which is what puts
   * the popover's `onEscapeKeyDown` between the window-capture probe and the
   * dialog's document-bubble backstop. Registering on bubble instead would let
   * the backstop run first and never see the yield.
   */
  function armDockGuard(portalContainer: HTMLElement | null) {
    dockGuard = (e) => handleDockEscapeKeyDown(e, portalContainer);
    document.addEventListener("keydown", dockGuard, true);
  }

  /** From the focused element, so document sees a real capture-then-bubble pass. */
  function pressEscape() {
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
  }

  it("closes the dialog when the popover underneath declines the keypress", () => {
    const onClose = vi.fn();
    render(
      <AppDialog isOpen onClose={onClose}>
        <button>Confirm</button>
      </AppDialog>
    );
    openRadixLayerBehind();
    // Focus lives in the dialog, not the dock's portal — the case the guard's
    // containment check cannot see.
    screen.getByText("Confirm").focus();
    armDockGuard(document.createElement("div"));

    pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the dock popover to handle Escape while focus is still in the terminal", () => {
    const onClose = vi.fn();
    const dockPortal = document.createElement("div");
    const terminalInput = document.createElement("input");
    dockPortal.appendChild(terminalInput);
    document.body.appendChild(dockPortal);
    render(
      <AppDialog isOpen onClose={onClose}>
        <button>Confirm</button>
      </AppDialog>
    );
    openRadixLayerBehind();
    terminalInput.focus();
    armDockGuard(dockPortal);

    pressEscape();

    // The popover owns this one: typing in a docked terminal must keep closing
    // the popover rather than a dialog the user isn't focused on.
    expect(onClose).not.toHaveBeenCalled();
    dockPortal.remove();
  });

  it("stands down for an open layer that never yielded", () => {
    const onClose = vi.fn();
    render(
      <AppDialog isOpen onClose={onClose}>
        <button>Confirm</button>
      </AppDialog>
    );
    openRadixLayerBehind();
    screen.getByText("Confirm").focus();
    // No dock guard: a Select or DropdownMenu opened inside the dialog owns its
    // own Escape, and the dialog underneath must not close with it.

    pressEscape();

    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * A dock popover renders above the standard modal tier, so any dialog opened
 * while one is up paints underneath it while still trapping focus (#11505).
 *
 * Resolved here rather than per call site, which is what makes this one suite
 * cover every dialog in the app — including the destructive confirms reachable
 * from a docked terminal, where an unreadable prompt is the real hazard.
 */
describe("AppDialog layering over a dock popover", () => {
  beforeEach(() => {
    mockPrevOpen = false;
    _resetDockPopoverForTests();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    _resetDockPopoverForTests();
  });

  /**
   * The z-tier a surface resolved to, read off the rendered element rather than
   * compared against a hard-coded token so the tier's value stays free to change.
   */
  function tierOf(el: Element): string | undefined {
    return Array.from(el.classList).find((c) => c.startsWith("z-["));
  }

  function renderDialogAt(zIndex?: "modal" | "nested") {
    const { unmount } = render(
      <AppDialog isOpen onClose={() => {}} {...(zIndex ? { zIndex } : {})}>
        <span>body</span>
      </AppDialog>
    );
    const tier = tierOf(screen.getByRole("dialog"));
    unmount();
    return tier;
  }

  it("distinguishes the two tiers at all", () => {
    // Guards every assertion below: if both options rendered the same token
    // they would all pass while the bug was fully present.
    expect(renderDialogAt("modal")).not.toBe(renderDialogAt("nested"));
  });

  it("keeps the standard tier while no dock popover is on screen", () => {
    expect(renderDialogAt()).toBe(renderDialogAt("modal"));
  });

  it("clears the popover for a dialog that asked for no particular tier", () => {
    act(() => setDockPopoverOpen(true));

    expect(renderDialogAt()).toBe(renderDialogAt("nested"));
  });

  it("promotes a destructive confirm, the case that must never be unreadable", () => {
    act(() => setDockPopoverOpen(true));
    const { unmount } = render(
      <AppDialog isOpen onClose={() => {}} variant="destructive">
        <span>body</span>
      </AppDialog>
    );

    expect(tierOf(screen.getByRole("alertdialog"))).toBe(renderDialogAt("nested"));
    unmount();
  });

  it("re-layers an already-open dialog when the popover appears underneath it", () => {
    const { rerender } = render(
      <AppDialog isOpen onClose={() => {}}>
        <span>body</span>
      </AppDialog>
    );
    const before = tierOf(screen.getByRole("dialog"));

    act(() => setDockPopoverOpen(true));
    rerender(
      <AppDialog isOpen onClose={() => {}}>
        <span>body</span>
      </AppDialog>
    );

    expect(tierOf(screen.getByRole("dialog"))).not.toBe(before);
  });

  it("drops back once the popover closes", () => {
    act(() => setDockPopoverOpen(true));
    const promoted = renderDialogAt();

    act(() => setDockPopoverOpen(false));

    expect(renderDialogAt()).not.toBe(promoted);
  });
});
