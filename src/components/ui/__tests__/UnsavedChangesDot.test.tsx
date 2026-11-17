// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../tooltip";
import { UnsavedChangesDot } from "../UnsavedChangesDot";

const PAST_HOVER_DELAY_MS = 2000;

function renderDot(conflict: boolean) {
  return render(
    <TooltipProvider>
      <UnsavedChangesDot conflict={conflict} data-testid="dot" />
    </TooltipProvider>
  );
}

function hover(el: HTMLElement) {
  act(() => {
    fireEvent.pointerMove(el, { pointerType: "mouse" });
    vi.advanceTimersByTime(PAST_HOVER_DELAY_MS);
  });
}

describe("UnsavedChangesDot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens a themed tooltip carrying the same words as its accessible name", () => {
    renderDot(false);
    const dot = screen.getByTestId("dot");
    expect(dot.hasAttribute("title")).toBe(false);
    expect(screen.queryByRole("tooltip")).toBeNull();

    hover(dot);

    expect(dot.getAttribute("aria-label")).toBe("Unsaved changes");
    expect(screen.getByRole("tooltip").textContent).toBe("Unsaved changes");
  });

  it("names a conflict with the file-changed-on-disk copy", () => {
    renderDot(true);
    const dot = screen.getByTestId("dot");

    hover(dot);

    expect(dot.getAttribute("aria-label")).toBe("Unsaved changes — file changed on disk");
    expect(screen.getByRole("tooltip").textContent).toBe("Unsaved changes — file changed on disk");
  });

  it("gives the 6px dot a padded pointer target", () => {
    renderDot(false);
    expect(screen.getByTestId("dot").className).toContain("h-4 w-4");
  });
});
