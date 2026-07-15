/**
 * panelFocusRegistry — the panel-id → focus-target handoff behind macro-grid
 * Enter and in-group tab switches (#11109).
 *
 * The contract that matters to callers is the boolean: a handler reports
 * whether a live target actually took focus, and a panel with no registered
 * handler (or no mounted target) reports `false` so the caller can keep its
 * own focus instead of handing off into the void.
 */
import { describe, it, expect, vi } from "vitest";
import { registerPanelFocusHandler, focusPanelInput } from "../panelFocusRegistry";

describe("panelFocusRegistry", () => {
  it("reports failure for a panel that never registered", () => {
    expect(focusPanelInput("never-registered")).toBe(false);
  });

  it("invokes the handler for the requested id and propagates its success", () => {
    const handler = vi.fn(() => true);
    const cleanup = registerPanelFocusHandler("p-1", handler);

    expect(focusPanelInput("p-1")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("propagates a handler that declines the handoff", () => {
    // A mounted panel whose focus target is not live yet (lazy chunk still
    // loading, terminal with no xterm) declines rather than lying.
    const cleanup = registerPanelFocusHandler("p-1", () => false);

    expect(focusPanelInput("p-1")).toBe(false);

    cleanup();
  });

  it("routes to the handler owning that id, not another panel's", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const cleanupFirst = registerPanelFocusHandler("p-1", first);
    const cleanupSecond = registerPanelFocusHandler("p-2", second);

    focusPanelInput("p-2");

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    cleanupFirst();
    cleanupSecond();
  });

  it("stops routing to a handler once its cleanup runs", () => {
    const cleanup = registerPanelFocusHandler("p-1", () => true);
    cleanup();

    expect(focusPanelInput("p-1")).toBe(false);
  });

  it("keeps the newest handler when a stale cleanup fires after a remount", () => {
    // React can commit the replacement registration before the outgoing
    // effect's cleanup runs. A blind delete there would unregister the live
    // panel and leave Enter dead on a panel that is very much on screen.
    const stale = vi.fn(() => false);
    const live = vi.fn(() => true);

    const staleCleanup = registerPanelFocusHandler("p-1", stale);
    registerPanelFocusHandler("p-1", live);
    staleCleanup();

    expect(focusPanelInput("p-1")).toBe(true);
    expect(live).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });
});
