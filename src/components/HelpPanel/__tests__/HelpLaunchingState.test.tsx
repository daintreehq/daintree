// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelpLaunchingState } from "../HelpLaunchingState";
import { __resetHelpSessionControllersForTests } from "@/controllers/helpSessionControllerRegistry";

describe("HelpLaunchingState", () => {
  beforeEach(() => {
    // #12108: controllers live in a per-view registry, not component
    // state, so they outlive a render and must be reset between tests.
    __resetHelpSessionControllersForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  function statusNode(container: HTMLElement) {
    return container.querySelector('[role="status"]')!;
  }

  it("shows and announces nothing until the Doherty gate elapses", () => {
    const { container } = render(
      <HelpLaunchingState phase="provisioning" isLoading onCancel={() => {}} />
    );
    // The announcer is mounted up front, empty, so its first text is a change AT hears.
    expect(statusNode(container).textContent).toBe("");
    expect(container.textContent).toBe("");
    advance(400);
    expect(statusNode(container).textContent).toBe("Preparing session…");
  });

  it("announces each phase from exactly one node, outside any busy subtree", () => {
    const { container, rerender } = render(
      <HelpLaunchingState phase="version-checking" isLoading onCancel={() => {}} />
    );
    advance(400);
    rerender(<HelpLaunchingState phase="launching" isLoading onCancel={() => {}} />);
    const spoken = Array.from(container.querySelectorAll('[role="status"], [aria-live]')).filter(
      (el) => el.textContent?.includes("Starting assistant…")
    );
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.closest('[aria-busy="true"]')).toBeNull();
    // The visible copy of the label is hidden from AT rather than read twice.
    const visible = Array.from(container.querySelectorAll("p")).find(
      (el) => el.textContent === "Starting assistant…"
    )!;
    expect(visible.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("never repeats the phase in the long-wait hint", () => {
    const { container } = render(
      <HelpLaunchingState phase="launching" isLoading onCancel={() => {}} />
    );
    // Every rung of the ladder: reassurance, escalation, action.
    for (const ms of [5_000, 8_000, 7_000]) {
      advance(ms);
      const hint = container.querySelector("span.animate-hint-fade-in")!;
      expect(hint.textContent).not.toBe("Starting assistant…");
    }
  });

  it("offers Cancel with the first hint, five seconds into the launch", () => {
    const onCancel = vi.fn();
    const { getByRole, queryByRole } = render(
      <HelpLaunchingState phase="launching" isLoading onCancel={onCancel} />
    );
    advance(4_999);
    expect(queryByRole("button", { name: "Cancel" })).toBeNull();
    advance(1);
    getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
