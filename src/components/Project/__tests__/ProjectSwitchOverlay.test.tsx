/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { ProjectSwitchOverlay } from "../ProjectSwitchOverlay";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="status"]');
}

describe("ProjectSwitchOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Unmount (and tear down the portal) before swapping back to real timers,
    // so React removes its own nodes instead of a manual document.body wipe
    // racing the unmount.
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders nothing while not switching", () => {
    render(<ProjectSwitchOverlay isSwitching={false} projectName="Acme" />);
    advance(UI_DOHERTY_THRESHOLD + 50);
    expect(overlay()).toBeNull();
  });

  it("stays hidden until the Doherty gate elapses, then appears", () => {
    render(<ProjectSwitchOverlay isSwitching={true} projectName="Acme" />);
    // Before the gate: no overlay — anti-flicker for fast warm switches.
    advance(UI_DOHERTY_THRESHOLD - 50);
    expect(overlay()).toBeNull();
    // Crossing the gate reveals the overlay.
    advance(100);
    expect(overlay()).not.toBeNull();
  });

  it("shows a spinner and the target project name once gated on", () => {
    render(<ProjectSwitchOverlay isSwitching={true} projectName="Acme" />);
    advance(UI_DOHERTY_THRESHOLD + 50);
    const el = overlay();
    expect(el).not.toBeNull();
    expect(el?.querySelector(".animate-spin")).not.toBeNull();
    expect(el?.textContent).toContain("Switching to Acme");
  });

  it("falls back to a generic label when no project name is provided", () => {
    render(<ProjectSwitchOverlay isSwitching={true} />);
    advance(UI_DOHERTY_THRESHOLD + 50);
    const el = overlay();
    expect(el?.textContent).toContain("Switching project");
    expect(el?.textContent).not.toContain("Switching to");
  });

  it("never paints when switching ends before the Doherty gate elapses", () => {
    const { rerender } = render(<ProjectSwitchOverlay isSwitching={true} projectName="Acme" />);
    // Switch completes just before the gate would fire — the fast-warm case.
    advance(UI_DOHERTY_THRESHOLD - 1);
    rerender(<ProjectSwitchOverlay isSwitching={false} projectName="Acme" />);
    // Advancing well past the original threshold must not resurrect the overlay.
    advance(500);
    expect(overlay()).toBeNull();
  });

  it("tears down the overlay when switching ends", () => {
    const { rerender } = render(<ProjectSwitchOverlay isSwitching={true} projectName="Acme" />);
    advance(UI_DOHERTY_THRESHOLD + 50);
    expect(overlay()).not.toBeNull();

    rerender(<ProjectSwitchOverlay isSwitching={false} projectName="Acme" />);
    expect(overlay()).toBeNull();
  });
});
