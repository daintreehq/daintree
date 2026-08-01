// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppPalettePopover } from "../AppPalettePopover";
import { AppPaletteDialog } from "../AppPaletteDialog";
import { useUIStore } from "@/store/uiStore";

/**
 * Radix is stubbed so the shell's own policy is what's under test: which
 * handlers it installs, what they do, and which props it forwards. The real
 * primitive's focus trap and dismissal are Radix's contract, covered by the
 * consumers' E2E specs.
 */
interface CapturedContentProps {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onPointerDownOutside?: () => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onFocus?: React.FocusEventHandler<HTMLDivElement>;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  children?: ReactNode;
  [key: string]: unknown;
}

let rootProps: { open?: boolean; modal?: boolean } = {};
let contentProps: CapturedContentProps = {};

vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
    modal,
  }: {
    children: ReactNode;
    open?: boolean;
    modal?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    rootProps = { open, modal };
    return <>{children}</>;
  },
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  // Content renders unconditionally so the shell's handlers stay reachable
  // without driving Radix's presence machinery. tabIndex mirrors the real
  // focus-scope wrapper, which is what focus parks on.
  PopoverContent: ({
    children,
    onFocus,
    onMouseDown,
    onKeyDown,
    ...rest
  }: CapturedContentProps) => {
    contentProps = { children, onFocus, onMouseDown, onKeyDown, ...rest };
    return (
      <div
        data-testid="content"
        tabIndex={-1}
        onFocus={onFocus}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    );
  },
}));

interface HarnessProps {
  modal?: boolean;
  dismissOnForeignOverlay?: boolean;
  restoreFocusOnPointerDismiss?: boolean;
  initialOpen?: boolean;
  /** Drives the open state from the test, overriding the harness's own. */
  open?: boolean;
  initialQuery?: string;
  onCloseAutoFocus?: () => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onFocus?: React.FocusEventHandler<HTMLDivElement>;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

function Harness({
  modal = true,
  dismissOnForeignOverlay = false,
  restoreFocusOnPointerDismiss,
  initialOpen = true,
  open: openOverride,
  initialQuery = "",
  onOpenChange,
  align,
  sideOffset,
  ...contentOverrides
}: HarnessProps) {
  const [openState, setOpen] = useState(initialOpen);
  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = openOverride ?? openState;

  return (
    <AppPalettePopover
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      modal={modal}
      dismissOnForeignOverlay={dismissOnForeignOverlay}
    >
      <AppPalettePopover.Trigger asChild>
        <button type="button">Open</button>
      </AppPalettePopover.Trigger>
      <AppPalettePopover.Content
        ariaLabel="Test palette"
        inputRef={inputRef}
        onClearQuery={() => setQuery("")}
        restoreFocusOnPointerDismiss={restoreFocusOnPointerDismiss}
        align={align}
        sideOffset={sideOffset}
        {...contentOverrides}
      >
        {/* The real Header, so the marker the shell's mousedown delegation
            looks for is the one the shell actually stamps. */}
        <AppPaletteDialog.Header label="Test">
          <AppPaletteDialog.Input
            inputRef={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </AppPaletteDialog.Header>
        <button type="button" data-testid="row">
          A row
        </button>
      </AppPalettePopover.Content>
    </AppPalettePopover>
  );
}

/**
 * Real events, not shaped literals: the shell branches on `defaultPrevented`
 * after handing the event to a consumer veto, and only a cancelable DOM event
 * reports that honestly.
 */
function fireEscape(overrides: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, ...overrides });
  const preventDefault = vi.spyOn(event, "preventDefault");
  act(() => contentProps.onEscapeKeyDown?.(event));
  return { preventDefault };
}

function fireOpenAutoFocus() {
  const event = new Event("openAutoFocus", { cancelable: true });
  const preventDefault = vi.spyOn(event, "preventDefault");
  act(() => contentProps.onOpenAutoFocus?.(event));
  return { preventDefault };
}

function fireCloseAutoFocus() {
  const event = new Event("closeAutoFocus", { cancelable: true });
  const preventDefault = vi.spyOn(event, "preventDefault");
  act(() => contentProps.onCloseAutoFocus?.(event));
  return { preventDefault };
}

function input(container: HTMLElement): HTMLInputElement {
  const element = container.querySelector("input");
  if (!element) throw new Error("search input not found");
  return element;
}

beforeEach(() => {
  rootProps = {};
  contentProps = {};
  useUIStore.setState({ overlayStack: [] });
});

describe("AppPalettePopover", () => {
  it("forwards the open state and the required modal choice to the popover root", () => {
    const { unmount } = render(<Harness modal={true} />);
    expect(rootProps).toEqual({ open: true, modal: true });
    unmount();

    render(<Harness modal={false} />);
    expect(rootProps).toEqual({ open: true, modal: false });
  });

  it("names the content and mirrors aria-modal onto the modal form only", () => {
    const { unmount } = render(<Harness modal={true} />);
    expect(contentProps["aria-label"]).toBe("Test palette");
    expect(contentProps["aria-modal"]).toBe(true);
    unmount();

    render(<Harness modal={false} />);
    // `aria-modal="false"` is noise, so the non-modal form carries nothing.
    expect(contentProps["aria-modal"]).toBeUndefined();
  });

  it("forwards positioning props through to the popover content", () => {
    render(<Harness align="end" sideOffset={12} />);
    expect(contentProps.align).toBe("end");
    expect(contentProps.sideOffset).toBe(12);
  });

  it("never claims the app overlay stack", () => {
    render(<Harness />);
    expect(useUIStore.getState().overlayStack).toEqual([]);
  });

  it("throws when the content is rendered outside its root", () => {
    const inputRef = { current: null };
    expect(() =>
      render(
        <AppPalettePopover.Content ariaLabel="Orphan" inputRef={inputRef} onClearQuery={vi.fn()}>
          <span />
        </AppPalettePopover.Content>
      )
    ).toThrow(/inside AppPalettePopover/);
  });

  describe("open focus", () => {
    it("takes over the mount autofocus and drives it into the search box", () => {
      const { container } = render(<Harness />);
      input(container).blur();

      const { preventDefault } = fireOpenAutoFocus();

      // Radix would otherwise focus the content wrapper.
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(input(container));
    });

    it("also focuses the search box a frame after opening", async () => {
      // The two paths cover opposite orderings of the lazy Radix chunk
      // resolving; neither covers both alone, so both must survive. This is the
      // path that runs without `onOpenAutoFocus` ever firing.
      const { container, rerender } = render(<Harness open={false} />);
      input(container).blur();
      expect(document.activeElement).not.toBe(input(container));

      rerender(<Harness open={true} />);

      await waitFor(() => expect(document.activeElement).toBe(input(container)));
    });

    it("cancels the pending frame when the palette closes", () => {
      const cancel = vi.spyOn(window, "cancelAnimationFrame");
      const { rerender } = render(<Harness open={true} />);
      const before = cancel.mock.calls.length;

      rerender(<Harness open={false} />);

      // A frame left queued would focus an input the user has already left.
      expect(cancel.mock.calls.length).toBeGreaterThan(before);
      cancel.mockRestore();
    });

    it("hands focus back to the search box when it parks on the content wrapper", () => {
      const { container, getByTestId } = render(<Harness />);
      input(container).blur();

      fireEvent.focus(getByTestId("content"));

      expect(document.activeElement).toBe(input(container));
    });

    it("leaves focus alone when it lands on something inside the content", () => {
      const { container, getByTestId } = render(<Harness />);
      const row = getByTestId("row");
      input(container).blur();
      row.focus();

      fireEvent.focus(row);

      expect(document.activeElement).toBe(row);
    });
  });

  describe("header mousedown", () => {
    it("redirects a click on the padding around the search box into it", () => {
      const { container } = render(<Harness />);
      const header = container.querySelector("[data-palette-header]");
      if (!(header instanceof HTMLElement)) throw new Error("header not found");
      input(container).blur();

      // Cancelled, so Radix's tabIndex={-1} wrapper never takes the focus.
      expect(fireEvent.mouseDown(header)).toBe(false);
      expect(document.activeElement).toBe(input(container));
    });

    it("leaves the search box's own mousedown alone so the caret can be placed", () => {
      const { container } = render(<Harness />);
      expect(fireEvent.mouseDown(input(container))).toBe(true);
    });

    it("ignores a mousedown outside the header", () => {
      const { getByTestId } = render(<Harness />);
      expect(fireEvent.mouseDown(getByTestId("row"))).toBe(true);
    });

    it("defers to a consumer handler that already cancelled the event", () => {
      const onMouseDown = vi.fn((event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
      });
      const { container } = render(<Harness onMouseDown={onMouseDown} />);
      const header = container.querySelector("[data-palette-header]");
      if (!(header instanceof HTMLElement)) throw new Error("header not found");
      input(container).blur();

      fireEvent.mouseDown(header);

      expect(onMouseDown).toHaveBeenCalledTimes(1);
      expect(document.activeElement).not.toBe(input(container));
    });
  });

  describe("staged escape", () => {
    it("spends the first press clearing a non-empty query and blocks the close", () => {
      const { container } = render(<Harness initialQuery="review" />);

      const { preventDefault } = fireEscape();

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(input(container).value).toBe("");
    });

    it("leaves the press alone once the query is empty so the palette closes", () => {
      render(<Harness initialQuery="" />);
      expect(fireEscape().preventDefault).not.toHaveBeenCalled();
    });

    it("does not spend a press on whitespace, which never filtered anything", () => {
      render(<Harness initialQuery="   " />);
      expect(fireEscape().preventDefault).not.toHaveBeenCalled();
    });

    it("reads the live query, not a render-stale copy", () => {
      // Radix dismisses from a capture listener that beats React's re-render,
      // so a closed-over query would be a keystroke behind.
      const { container } = render(<Harness initialQuery="" />);
      fireEvent.change(input(container), { target: { value: "review" } });

      expect(fireEscape().preventDefault).toHaveBeenCalledTimes(1);
      expect(input(container).value).toBe("");
    });

    it("leaves a composing keystroke to the IME candidate window", () => {
      const { container } = render(<Harness initialQuery="review" />);

      const { preventDefault } = fireEscape({ isComposing: true });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      // Blocked, not consumed: the query survives for the candidate window.
      expect(input(container).value).toBe("review");
    });

    it("also honours the keyCode 229 half of the IME signal", () => {
      // Chromium can emit 229 before `isComposing` flips true.
      const { container } = render(<Harness initialQuery="review" />);

      fireEscape({ isComposing: false, keyCode: 229 });

      expect(input(container).value).toBe("review");
    });

    it("lets a consumer veto run first and short-circuit the clear", () => {
      const onEscapeKeyDown = vi.fn((event: KeyboardEvent) => event.preventDefault());
      const { container } = render(
        <Harness initialQuery="review" onEscapeKeyDown={onEscapeKeyDown} />
      );

      fireEscape();

      expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
      // A nested editor cancelling itself must not also cost the query.
      expect(input(container).value).toBe("review");
    });

    it("still stages the clear when the consumer veto passes", () => {
      const onEscapeKeyDown = vi.fn();
      const { container } = render(
        <Harness initialQuery="review" onEscapeKeyDown={onEscapeKeyDown} />
      );

      fireEscape();

      expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
      expect(input(container).value).toBe("");
    });
  });

  describe("close focus restore", () => {
    it("lets a keyboard dismissal return focus to the trigger", () => {
      render(<Harness />);

      expect(fireCloseAutoFocus().preventDefault).not.toHaveBeenCalled();
    });

    it("suppresses the return on a pointer dismissal so the trigger keeps no ring", () => {
      render(<Harness />);
      act(() => contentProps.onPointerDownOutside?.());

      expect(fireCloseAutoFocus().preventDefault).toHaveBeenCalledTimes(1);
    });

    it("re-arms after a single pointer dismissal", () => {
      render(<Harness />);
      act(() => contentProps.onPointerDownOutside?.());
      fireCloseAutoFocus();

      expect(fireCloseAutoFocus().preventDefault).not.toHaveBeenCalled();
    });

    it("keeps the return when the consumer opts in, and still clears the flag", () => {
      render(<Harness restoreFocusOnPointerDismiss={true} />);
      act(() => contentProps.onPointerDownOutside?.());

      expect(fireCloseAutoFocus().preventDefault).not.toHaveBeenCalled();
      // A stale flag here would taint the next close if the prop ever flipped.
      expect(fireCloseAutoFocus().preventDefault).not.toHaveBeenCalled();
    });

    it("notifies the consumer before Radix restores focus", () => {
      const onCloseAutoFocus = vi.fn();
      render(<Harness onCloseAutoFocus={onCloseAutoFocus} />);

      fireCloseAutoFocus();

      expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
    });
  });

  describe("foreign overlay dismissal", () => {
    it("closes when something stacks above an open palette", () => {
      const onOpenChange = vi.fn();
      render(<Harness dismissOnForeignOverlay={true} onOpenChange={onOpenChange} />);

      act(() => useUIStore.getState().addOverlayClaim("confirm-dialog"));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("stays open when the palette did not opt in", () => {
      const onOpenChange = vi.fn();
      render(<Harness dismissOnForeignOverlay={false} onOpenChange={onOpenChange} />);

      act(() => useUIStore.getState().addOverlayClaim("confirm-dialog"));

      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("ignores a stack that shrinks", () => {
      const onOpenChange = vi.fn();
      act(() => useUIStore.getState().addOverlayClaim("existing"));
      render(<Harness dismissOnForeignOverlay={true} onOpenChange={onOpenChange} />);

      act(() => useUIStore.getState().removeOverlayClaim("existing"));

      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("does not fire for an overlay that was already up when it opened", () => {
      const onOpenChange = vi.fn();
      act(() => useUIStore.getState().addOverlayClaim("existing"));

      render(<Harness dismissOnForeignOverlay={true} onOpenChange={onOpenChange} />);

      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  describe("consumer handler composition", () => {
    it("composes rather than replaces the content focus handler", () => {
      const onFocus = vi.fn();
      const { container, getByTestId } = render(<Harness onFocus={onFocus} />);
      input(container).blur();

      fireEvent.focus(getByTestId("content"));

      // Not a call count: React's focus events bubble, so the shell's own
      // redirect into the input re-enters this handler a second time.
      expect(onFocus).toHaveBeenCalled();
      expect(document.activeElement).toBe(input(container));
    });

    it("passes an unrecognised handler straight through", () => {
      const onKeyDown = vi.fn();
      const { getByTestId } = render(<Harness onKeyDown={onKeyDown} />);

      fireEvent.keyDown(getByTestId("content"), { key: "ArrowDown" });

      expect(onKeyDown).toHaveBeenCalledTimes(1);
    });
  });
});
