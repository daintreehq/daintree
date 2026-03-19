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
  useSidecarStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

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
    const lastButton = buttons[buttons.length - 1];
    lastButton.focus();
    expect(document.activeElement).toBe(lastButton);

    pressTab();

    const firstButton = buttons[0];
    expect(document.activeElement).toBe(firstButton);
  });

  it("wraps focus backward from first to last element on Shift+Tab", async () => {
    renderDialog();
    await act(() => vi.runAllTimersAsync());

    const buttons = screen.getAllByRole("button");
    const firstButton = buttons[0];
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
