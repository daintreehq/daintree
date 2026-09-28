// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";
import { primeRadix } from "../radix-loader";

// A popover trigger that also explains itself through the shared Tooltip carries
// two Radix triggers on one element, and the tooltip's `data-state` wins. The
// trigger's `aria-controls` cleanup must key on what the popover owns, or an open
// popover loses the attribute that names it.

class NoopResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  await primeRadix();
});

afterEach(() => {
  cleanup();
});

function renderTooltippedPopover(open: boolean) {
  return render(
    <TooltipProvider>
      <Popover open={open} onOpenChange={() => {}}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button type="button" aria-label="Sort">
                sort
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Sort</TooltipContent>
        </Tooltip>
        <PopoverContent>options</PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

describe("PopoverTrigger inside a Tooltip trigger", () => {
  it("keeps aria-controls pointing at the open popover", async () => {
    const { getByRole } = renderTooltippedPopover(true);
    await act(async () => {});
    const trigger = getByRole("button", { name: "Sort" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).not.toBeNull();
  });

  it("drops aria-controls while the popover is closed", async () => {
    const { getByRole } = renderTooltippedPopover(false);
    await act(async () => {});
    const trigger = getByRole("button", { name: "Sort" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
  });
});
