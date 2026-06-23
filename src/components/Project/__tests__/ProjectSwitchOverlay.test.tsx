/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { ProjectSwitchOverlay, SWITCH_OVERLAY_MAX_MS } from "../ProjectSwitchOverlay";
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

  it("force-dismisses and fires onAutoDismiss if the flag stays stuck past the ceiling", () => {
    const onAutoDismiss = vi.fn();
    render(
      <ProjectSwitchOverlay isSwitching={true} projectName="Acme" onAutoDismiss={onAutoDismiss} />
    );
    advance(UI_DOHERTY_THRESHOLD + 50);
    expect(overlay()).not.toBeNull();

    // The store flag never clears (the stuck-overlay bug). The watchdog must
    // hide the overlay and invoke the escape hatch regardless.
    advance(SWITCH_OVERLAY_MAX_MS);
    expect(onAutoDismiss).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
  });

  it("does not fire the watchdog for a valid switch that resolves just under the ceiling", () => {
    const onAutoDismiss = vi.fn();
    const { rerender } = render(
      <ProjectSwitchOverlay isSwitching={true} projectName="Acme" onAutoDismiss={onAutoDismiss} />
    );
    advance(UI_DOHERTY_THRESHOLD + 50);
    // Stay switching almost the whole ceiling, then resolve before it trips.
    advance(SWITCH_OVERLAY_MAX_MS - UI_DOHERTY_THRESHOLD - 100);
    expect(onAutoDismiss).not.toHaveBeenCalled();
    rerender(
      <ProjectSwitchOverlay isSwitching={false} projectName="Acme" onAutoDismiss={onAutoDismiss} />
    );
    advance(SWITCH_OVERLAY_MAX_MS);
    expect(onAutoDismiss).not.toHaveBeenCalled();
  });

  it("re-shows the overlay for a later switch after a prior watchdog dismissal", () => {
    const onAutoDismiss = vi.fn();
    const { rerender } = render(
      <ProjectSwitchOverlay
        isSwitching={true}
        projectName="Acme"
        switchTargetId="a"
        onAutoDismiss={onAutoDismiss}
      />
    );
    // Trip the watchdog on the first (stuck) switch. The watchdog only arms once
    // the overlay is actually visible, so cross the Doherty gate first, then run
    // the full ceiling.
    advance(UI_DOHERTY_THRESHOLD + 50);
    advance(SWITCH_OVERLAY_MAX_MS);
    expect(overlay()).toBeNull();

    // The escape hatch clears the flag; a fresh switch starts.
    rerender(
      <ProjectSwitchOverlay
        isSwitching={false}
        switchTargetId={null}
        onAutoDismiss={onAutoDismiss}
      />
    );
    rerender(
      <ProjectSwitchOverlay
        isSwitching={true}
        projectName="Beta"
        switchTargetId="b"
        onAutoDismiss={onAutoDismiss}
      />
    );
    advance(UI_DOHERTY_THRESHOLD + 50);
    // The latch must have released so the new switch can paint its overlay.
    expect(overlay()?.textContent).toContain("Switching to Beta");
  });

  it("releases the latch on a new switch target even if the flag never cleared", () => {
    // The hard guarantee: if onAutoDismiss fails to reset the store (flag stays
    // stuck true), a switch to a *different* target must still re-show the
    // overlay — the latch keys off the episode identity, not just isSwitching.
    const { rerender } = render(
      <ProjectSwitchOverlay isSwitching={true} projectName="Acme" switchTargetId="a" />
    );
    advance(UI_DOHERTY_THRESHOLD + 50);
    advance(SWITCH_OVERLAY_MAX_MS);
    expect(overlay()).toBeNull();

    // isSwitching stays true (never cleared); only the target changes.
    rerender(<ProjectSwitchOverlay isSwitching={true} projectName="Beta" switchTargetId="b" />);
    advance(UI_DOHERTY_THRESHOLD + 50);
    expect(overlay()?.textContent).toContain("Switching to Beta");
  });
});
