// @vitest-environment jsdom
import * as React from "react";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedDropdownVisibleContext } from "../fixed-dropdown";
import { Tooltip, TooltipTrigger, TooltipContent } from "../tooltip";
import { UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";

const { rootSpy, mountSpy, primeOnEventSpy, contentSpy } = vi.hoisted(() => ({
  rootSpy: vi.fn(),
  mountSpy: vi.fn(),
  primeOnEventSpy: vi.fn(),
  contentSpy: vi.fn(),
}));

vi.mock("../radix-loader", () => ({
  primeOnEvent: primeOnEventSpy,
  useRadixPrimitives: () => ({
    TooltipPrimitive: {
      Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
      Root: (props: { open?: boolean; children: React.ReactNode }) => {
        rootSpy(props);
        // Each new mount of the stub creates a fresh closure id. Reading it
        // back from rendered DOM lets tests assert when React remounted the
        // Root (e.g., via key change) vs. when it just re-rendered it. This
        // is the test-side proxy for "Radix internal state would have been
        // reset" since the real `useControllableState` retains its
        // `uncontrolledProp` across re-renders of the same instance only.
        const [mountId] = useState(() => {
          mountSpy();
          return Math.random().toString(36).slice(2);
        });
        return (
          <span data-testid="root-mount" data-mount-id={mountId}>
            {props.children}
          </span>
        );
      },
      // Forward all props/ref so tests can fire DOM events through the
      // wrapper's handlers — needed for the pointerActiveRef focus filter
      // (issue #8008).
      Trigger: React.forwardRef<
        HTMLButtonElement,
        React.ButtonHTMLAttributes<HTMLButtonElement> & {
          asChild?: boolean;
          children: React.ReactNode;
        }
      >(({ asChild: _asChild, children, ...rest }, ref) => (
        <button type="button" ref={ref} {...rest}>
          {children}
        </button>
      )),
      Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
      Content: (props: { children: React.ReactNode } & Record<string, unknown>) => {
        contentSpy(props);
        return <div>{props.children}</div>;
      },
    },
  }),
}));

describe("Tooltip wrapper — FixedDropdownVisibleContext gate (issue #8001)", () => {
  beforeEach(() => {
    rootSpy.mockClear();
    mountSpy.mockClear();
  });

  function TooltipNode({ open }: { open?: boolean }) {
    return (
      <Tooltip open={open}>
        <TooltipTrigger>trigger</TooltipTrigger>
        <TooltipContent>content</TooltipContent>
      </Tooltip>
    );
  }

  it("preserves the caller's `open` prop when the context value is `true`", () => {
    render(
      <FixedDropdownVisibleContext.Provider value={true}>
        <TooltipNode open={true} />
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = rootSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.open).toBe(true);
  });

  it("forces `open={false}` on the Radix Root when the context value is `false`", () => {
    // The bug fixed by issue #8001: with `open={true}` from the caller, the
    // Radix Root would otherwise keep the tooltip portal mounted on
    // document.body when the surrounding keepMounted FixedDropdown
    // transitions to Activity-hidden. Floating UI then falls back to (0,0)
    // and the tooltip strands in the top-left until reload.
    render(
      <FixedDropdownVisibleContext.Provider value={false}>
        <TooltipNode open={true} />
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = rootSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.open).toBe(false);
  });

  it("forces `open={false}` even when the caller leaves the tooltip uncontrolled", () => {
    // The five GitHub list tooltips are uncontrolled — they rely on Radix's
    // internal pointer-event-driven state. The gate must still apply to
    // those by switching them to controlled-closed on the hidden transition.
    render(
      <FixedDropdownVisibleContext.Provider value={false}>
        <TooltipNode />
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = rootSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.open).toBe(false);
  });

  it("leaves uncontrolled tooltips uncontrolled when the context is `true`", () => {
    // Outside the hidden state, the wrapper must not force a value — the
    // caller's `undefined` should pass through so Radix continues to
    // manage open/close internally.
    render(
      <FixedDropdownVisibleContext.Provider value={true}>
        <TooltipNode />
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = rootSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.open).toBeUndefined();
  });

  it("remounts the Radix Root on each hidden/visible transition to clear stale internal state", () => {
    // Regression for the controlled/uncontrolled flip identified in
    // review: Radix's `useControllableState` only updates its internal
    // `uncontrolledProp` via uncontrolled `setValue` calls. The
    // controlled-close path (open: undefined → open: false) skips that
    // update entirely, so the next switch back to uncontrolled
    // (open: undefined) would re-read the stale pre-hide value and
    // immediately re-open the tooltip without any user hover.
    //
    // Keying the Root on `dropdownVisible` forces a remount each time
    // the dropdown transitions, which is observable here by a fresh
    // mount id on the rendered Root stub.
    function Harness({ visible }: { visible: boolean }) {
      return (
        <FixedDropdownVisibleContext.Provider value={visible}>
          <TooltipNode />
        </FixedDropdownVisibleContext.Provider>
      );
    }

    const { rerender, container } = render(<Harness visible={true} />);
    const initialMountId = container
      .querySelector('[data-testid="root-mount"]')
      ?.getAttribute("data-mount-id");
    expect(initialMountId).toBeTruthy();

    rerender(<Harness visible={false} />);
    const hiddenMountId = container
      .querySelector('[data-testid="root-mount"]')
      ?.getAttribute("data-mount-id");
    expect(hiddenMountId).toBeTruthy();
    expect(hiddenMountId).not.toBe(initialMountId);

    rerender(<Harness visible={true} />);
    const revealedMountId = container
      .querySelector('[data-testid="root-mount"]')
      ?.getAttribute("data-mount-id");
    expect(revealedMountId).toBeTruthy();
    expect(revealedMountId).not.toBe(hiddenMountId);
    // The reveal mount id must also differ from the initial one — both are
    // distinct mounts, just both share the "visible" key.
    expect(revealedMountId).not.toBe(initialMountId);
  });
});

describe("TooltipTrigger — pointerActiveRef focus filter (issue #8008)", () => {
  beforeEach(() => {
    primeOnEventSpy.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(props: {
    onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
    onPointerUp?: React.PointerEventHandler<HTMLButtonElement>;
    onPointerEnter?: React.PointerEventHandler<HTMLButtonElement>;
    onFocusCapture?: React.FocusEventHandler<HTMLButtonElement>;
  }) {
    return (
      <FixedDropdownVisibleContext.Provider value={true}>
        <Tooltip>
          <TooltipTrigger {...props} data-testid="trigger">
            trigger
          </TooltipTrigger>
          <TooltipContent>content</TooltipContent>
        </Tooltip>
      </FixedDropdownVisibleContext.Provider>
    );
  }

  it("suppresses focus opened by a pointer click", () => {
    const onFocusCapture = vi.fn();
    const { getByTestId } = render(harness({ onFocusCapture }));
    const btn = getByTestId("trigger");

    // Simulate the browser sequence for a click-on-button: pointerdown,
    // focus (synchronously dispatched by the browser before pointerup),
    // pointerup. The wrapper must skip both primeOnEvent and the consumer's
    // onFocusCapture — the focus arrived via a pointer click, not keyboard,
    // and opening the tooltip here is the sticky-after-click pattern.
    fireEvent.pointerDown(btn);
    primeOnEventSpy.mockClear(); // pointerDown legitimately primes; isolate the focus path
    fireEvent.focus(btn);

    expect(primeOnEventSpy).not.toHaveBeenCalled();
    expect(onFocusCapture).not.toHaveBeenCalled();
  });

  it("allows keyboard focus (no preceding pointer event) to open normally", () => {
    const onFocusCapture = vi.fn();
    const { getByTestId } = render(harness({ onFocusCapture }));
    const btn = getByTestId("trigger");

    fireEvent.focus(btn);

    expect(primeOnEventSpy).toHaveBeenCalled();
    expect(onFocusCapture).toHaveBeenCalledTimes(1);
  });

  it("clears the pointer guard on the next tick so subsequent keyboard focus opens", () => {
    const onFocusCapture = vi.fn();
    const { getByTestId } = render(harness({ onFocusCapture }));
    const btn = getByTestId("trigger");

    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    // The setTimeout(0) inside pointerUp must clear the ref before the
    // next discrete user interaction. Flush the timer and then fire
    // focus — this models the user tabbing to the trigger after the
    // click sequence settles.
    vi.runAllTimers();

    fireEvent.focus(btn);

    expect(onFocusCapture).toHaveBeenCalledTimes(1);
  });

  it("forwards consumer pointer/focus handlers", () => {
    const onPointerDown = vi.fn();
    const onPointerUp = vi.fn();
    const onPointerEnter = vi.fn();
    const onFocusCapture = vi.fn();
    const { getByTestId } = render(
      harness({ onPointerDown, onPointerUp, onPointerEnter, onFocusCapture })
    );
    const btn = getByTestId("trigger");

    fireEvent.pointerEnter(btn);
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    vi.runAllTimers();
    fireEvent.focus(btn);

    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerUp).toHaveBeenCalledTimes(1);
    expect(onFocusCapture).toHaveBeenCalledTimes(1);
  });
});

describe("TooltipContent — collisionPadding default and override (issue #8008)", () => {
  beforeEach(() => {
    contentSpy.mockClear();
  });

  it("forwards collisionPadding={8} by default", () => {
    render(
      <FixedDropdownVisibleContext.Provider value={true}>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent>content</TooltipContent>
        </Tooltip>
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = contentSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.collisionPadding).toBe(8);
  });

  it("forwards a caller-provided collisionPadding override", () => {
    render(
      <FixedDropdownVisibleContext.Provider value={true}>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent collisionPadding={24}>content</TooltipContent>
        </Tooltip>
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = contentSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.collisionPadding).toBe(24);
  });

  it("applies the max-w-xs width cap on the rendered className", () => {
    render(
      <FixedDropdownVisibleContext.Provider value={true}>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent>content</TooltipContent>
        </Tooltip>
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = contentSpy.mock.calls.at(-1)?.[0];
    expect(typeof lastCall?.className === "string" && lastCall.className).toContain("max-w-xs");
  });
});

describe("TooltipContent — sticky and hideWhenDetached defaults (issue #8100)", () => {
  beforeEach(() => {
    contentSpy.mockClear();
  });

  it('forwards sticky="partial" and hideWhenDetached by default', () => {
    render(
      <FixedDropdownVisibleContext.Provider value={true}>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent>content</TooltipContent>
        </Tooltip>
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = contentSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.sticky).toBe("partial");
    expect(lastCall?.hideWhenDetached).toBe(true);
  });

  it("forwards caller-provided sticky and hideWhenDetached overrides", () => {
    render(
      <FixedDropdownVisibleContext.Provider value={true}>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent sticky="always" hideWhenDetached={false}>
            content
          </TooltipContent>
        </Tooltip>
      </FixedDropdownVisibleContext.Provider>
    );

    const lastCall = contentSpy.mock.calls.at(-1)?.[0];
    expect(lastCall?.sticky).toBe("always");
    expect(lastCall?.hideWhenDetached).toBe(false);
  });
});

describe("UI_TOOLTIP_SKIP_DELAY_DURATION (issue #8100)", () => {
  it("is 300ms to cover toolbar hand-travel and match the Radix default", () => {
    expect(UI_TOOLTIP_SKIP_DELAY_DURATION).toBe(300);
  });
});
