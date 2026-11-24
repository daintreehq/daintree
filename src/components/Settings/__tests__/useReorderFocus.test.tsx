// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  _resetTooltipFocusSuppressionForTests,
  isTooltipFocusSuppressionArmed,
  isTooltipSuppressedForElement,
} from "@/lib/tooltipFocusSuppression";
import { useReorderFocus, type ReorderDirection } from "../useReorderFocus";

function Harness({
  request,
  upDisabled = false,
}: {
  request: [string, ReorderDirection];
  upDisabled?: boolean;
}) {
  const { registerArrow, focusMoved } = useReorderFocus();
  return (
    <>
      <button ref={registerArrow("a", "up")} disabled={upDisabled}>
        a up
      </button>
      <button ref={registerArrow("a", "down")}>a down</button>
      <button onClick={() => focusMoved(...request)}>request</button>
    </>
  );
}

// A synchronous act flushes the focus effect but not the suppression's 0ms disarm
// timer, so a listener armed for a focus that never happened is still observable.
const requestFocus = () =>
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "request" }));
  });

describe("useReorderFocus", () => {
  afterEach(() => _resetTooltipFocusSuppressionForTests());

  it("focuses the requested arrow without opening its tooltip", () => {
    render(<Harness request={["a", "down"]} />);
    requestFocus();
    const arrow = screen.getByRole("button", { name: "a down" });
    expect(document.activeElement).toBe(arrow);
    expect(isTooltipSuppressedForElement(arrow)).toBe(true);
  });

  it("leaves an arrow that already holds focus alone", () => {
    render(<Harness request={["a", "down"]} />);
    const arrow = screen.getByRole("button", { name: "a down" });
    act(() => arrow.focus());
    requestFocus();
    expect(document.activeElement).toBe(arrow);
    expect(isTooltipFocusSuppressionArmed()).toBe(false);
  });

  it("skips a natively disabled arrow", () => {
    render(<Harness request={["a", "up"]} upDisabled />);
    requestFocus();
    expect(document.activeElement).toBe(document.body);
    expect(isTooltipFocusSuppressionArmed()).toBe(false);
  });

  it("skips an arrow that is not registered", () => {
    render(<Harness request={["gone", "up"]} />);
    requestFocus();
    expect(document.activeElement).toBe(document.body);
    expect(isTooltipFocusSuppressionArmed()).toBe(false);
  });
});
