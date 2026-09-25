// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalStartupPlaceholder } from "../TerminalPane";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

describe("TerminalStartupPlaceholder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("shows nothing visible before the Doherty gate, then spinner and caption", () => {
    const { container } = render(<TerminalStartupPlaceholder />);
    // Sub-threshold: the status node is mounted empty, so its first text is a change
    // AT hears, and nothing is visible yet.
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("p[aria-hidden='true']")).toBeNull();

    advance(UI_DOHERTY_THRESHOLD);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("p[aria-hidden='true']")?.textContent).toBe(
      "Starting terminal…"
    );
  });

  it("falls back to the generic label for an unknown agent id", () => {
    const { container } = render(<TerminalStartupPlaceholder agentId="not-a-real-agent" />);
    advance(UI_DOHERTY_THRESHOLD);
    expect(container.querySelector("p[aria-hidden='true']")?.textContent).toBe(
      "Starting terminal…"
    );
  });

  it("names the agent in the caption and the status label when known", () => {
    const { container } = render(<TerminalStartupPlaceholder agentId="claude" />);
    advance(UI_DOHERTY_THRESHOLD);
    const caption = container.querySelector("p[aria-hidden='true']")?.textContent;
    expect(caption).toMatch(/^Starting .+…$/);
    expect(caption).not.toBe("Starting terminal…");
    // The AT announcement and the visible caption must agree.
    expect(container.querySelector('[role="status"]')?.textContent).toBe(caption);
  });

  it("never repeats the caption in the long-wait hint", () => {
    const { container } = render(
      <TerminalStartupPlaceholder agentId="claude" onCancel={() => {}} />
    );
    advance(8_000);
    const caption = container.querySelector("p[aria-hidden='true']")?.textContent;
    const hint = container.querySelector("span.animate-hint-fade-in")?.textContent;
    expect(hint).toBeTruthy();
    expect(hint).not.toBe(caption);
  });

  it("keeps every aria-live region outside the aria-busy status wrapper", () => {
    const { container } = render(<TerminalStartupPlaceholder />);
    advance(UI_DOHERTY_THRESHOLD);
    const liveRegions = container.querySelectorAll("[aria-live]");
    expect(liveRegions.length).toBeGreaterThan(0);
    for (const region of liveRegions) {
      expect(region.closest('[role="status"]')).toBeNull();
    }
  });

  it("surfaces Cancel only after the hint threshold and wires it through", () => {
    const onCancel = vi.fn();
    const { container, getByRole } = render(<TerminalStartupPlaceholder onCancel={onCancel} />);

    // Right after the Doherty gate the hint is still hidden — no buttons.
    advance(UI_DOHERTY_THRESHOLD);
    expect(container.querySelector("button")).toBeNull();

    // Well past every hint threshold the Cancel affordance is up.
    advance(20_000);
    const cancel = getByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("never renders buttons when no cancel handler is provided", () => {
    const { container } = render(<TerminalStartupPlaceholder />);
    advance(UI_DOHERTY_THRESHOLD + 30_000);
    expect(container.querySelector("button")).toBeNull();
  });
});
