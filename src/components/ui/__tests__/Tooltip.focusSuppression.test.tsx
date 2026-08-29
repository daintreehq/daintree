// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import {
  _resetTooltipFocusSuppressionForTests,
  armTooltipFocusSuppression,
} from "@/lib/tooltipFocusSuppression";

const { rootSpy } = vi.hoisted(() => ({
  rootSpy: vi.fn<(props: { open?: boolean }) => void>(),
}));

vi.mock("../radix-loader", () => ({
  primeOnEvent: vi.fn(),
  useRadixPrimitives: () => ({
    TooltipPrimitive: {
      Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
      Root: (props: {
        open?: boolean;
        onOpenChange?: (open: boolean) => void;
        children: React.ReactNode;
      }) => {
        rootSpy(props);
        openChange = props.onOpenChange;
        return <>{props.children}</>;
      },
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
      Content: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
    },
  }),
}));

let openChange: ((open: boolean) => void) | undefined;

function lastOpen() {
  return rootSpy.mock.calls.at(-1)?.[0].open;
}

beforeEach(() => {
  rootSpy.mockClear();
  openChange = undefined;
  _resetTooltipFocusSuppressionForTests();
});

afterEach(cleanup);

/**
 * The stranded-tooltip half of the overlay close policy: an overlay marks the
 * element it is about to hand focus to, and that element's tooltip must not
 * open on the focus it never asked for.
 */
describe("Tooltip — focus-open suppression around an overlay close", () => {
  function renderTooltip() {
    render(
      <Tooltip>
        <TooltipTrigger>trigger</TooltipTrigger>
        <TooltipContent>hint</TooltipContent>
      </Tooltip>
    );
    return document.querySelector("button") as HTMLButtonElement;
  }

  function markRestoredFocus(element: HTMLElement) {
    // What an overlay's onCloseAutoFocus does, followed by the focus itself.
    armTooltipFocusSuppression();
    element.focus();
    fireEvent.focusIn(element);
  }

  it("swallows the focus-driven open that follows an overlay close", () => {
    const trigger = renderTooltip();
    act(() => markRestoredFocus(trigger));
    act(() => openChange?.(true));
    expect(lastOpen()).toBe(false);
  });

  it("still opens on a genuine hover afterwards", () => {
    // The suppression must not outlive the restoration — pointerenter on the
    // trigger means the user really is hovering it.
    const trigger = renderTooltip();
    act(() => markRestoredFocus(trigger));
    // fireEvent, not a raw dispatch: React routes onPointerEnter through its own
    // synthetic delegation, so a hand-built `pointerenter` never reaches it.
    act(() => {
      fireEvent.pointerEnter(trigger);
    });
    act(() => openChange?.(true));
    expect(lastOpen()).toBe(true);
  });

  it("also clears on a pointer that was already resting on the trigger", () => {
    // Radix opens from pointermove, not pointerenter, so a pointer already
    // parked over the trigger when the menu closed never fires an enter — its
    // next micro-move has to be enough to lift the suppression.
    const trigger = renderTooltip();
    act(() => markRestoredFocus(trigger));
    act(() => {
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    });
    act(() => openChange?.(true));
    expect(lastOpen()).toBe(true);
  });

  it("leaves an unrelated trigger's tooltip alone", () => {
    // The whole point of doing this per element rather than through
    // `dismissAllTooltips()`: one menu closing must not mute the rest of the app.
    renderTooltip();
    const stranger = document.createElement("button");
    document.body.appendChild(stranger);
    act(() => markRestoredFocus(stranger));

    act(() => openChange?.(true));
    expect(lastOpen()).toBe(true);
    stranger.remove();
  });

  it("expires rather than pinning the trigger shut", () => {
    vi.useFakeTimers();
    try {
      const trigger = renderTooltip();
      act(() => markRestoredFocus(trigger));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      act(() => openChange?.(true));
      expect(lastOpen()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
