import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTests,
  dismissAllTooltips,
  isTooltipFocusOpenSuppressed,
  notifyTooltipPointerActivity,
  registerTooltipDismiss,
  TOOLTIP_FOCUS_SUPPRESS_MS,
} from "../tooltipDismissRegistry";

describe("tooltipDismissRegistry", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetForTests();
    vi.useRealTimers();
  });

  it("invokes every registered handler on dismissAllTooltips", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerTooltipDismiss(a);
    registerTooltipDismiss(b);

    dismissAllTooltips();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("stops invoking a handler after its unregister closure runs", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unregisterA = registerTooltipDismiss(a);
    registerTooltipDismiss(b);

    unregisterA();
    dismissAllTooltips();

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unregisters exactly one entry when the same handler registered twice", () => {
    const handler = vi.fn();
    registerTooltipDismiss(handler);
    const unregisterSecond = registerTooltipDismiss(handler);

    unregisterSecond();
    dismissAllTooltips();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("tolerates double-unregister without touching other entries", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unregisterA = registerTooltipDismiss(a);
    registerTooltipDismiss(b);

    unregisterA();
    unregisterA();
    dismissAllTooltips();

    expect(b).toHaveBeenCalledTimes(1);
  });

  it("walks a snapshot so a handler unregistering another mid-dismiss cannot skip entries", () => {
    // A dismiss can re-render controlled consumers and unmount sibling
    // tooltips mid-walk; iteration must not skip the handlers that were
    // registered when the dismissal started.
    const c = vi.fn();
    const b = vi.fn();
    let unregisterB: () => void = () => {};
    registerTooltipDismiss(() => unregisterB());
    unregisterB = registerTooltipDismiss(b);
    registerTooltipDismiss(c);

    dismissAllTooltips();

    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("arms the focus-open suppression window on dismissAllTooltips", () => {
    expect(isTooltipFocusOpenSuppressed()).toBe(false);

    dismissAllTooltips();

    expect(isTooltipFocusOpenSuppressed()).toBe(true);
  });

  it("lets the suppression window expire", () => {
    dismissAllTooltips();

    vi.advanceTimersByTime(TOOLTIP_FOCUS_SUPPRESS_MS + 1);

    expect(isTooltipFocusOpenSuppressed()).toBe(false);
  });

  it("clears suppression immediately on genuine pointer activity", () => {
    dismissAllTooltips();
    expect(isTooltipFocusOpenSuppressed()).toBe(true);

    notifyTooltipPointerActivity();

    expect(isTooltipFocusOpenSuppressed()).toBe(false);
  });

  it("re-arms a fresh window on each dismissal", () => {
    dismissAllTooltips();
    vi.advanceTimersByTime(TOOLTIP_FOCUS_SUPPRESS_MS - 50);

    dismissAllTooltips();
    vi.advanceTimersByTime(100);

    expect(isTooltipFocusOpenSuppressed()).toBe(true);
  });

  it("_resetForTests clears handlers and suppression", () => {
    const handler = vi.fn();
    registerTooltipDismiss(handler);
    dismissAllTooltips();
    handler.mockClear();

    _resetForTests();

    expect(isTooltipFocusOpenSuppressed()).toBe(false);
    dismissAllTooltips();
    expect(handler).not.toHaveBeenCalled();
  });
});
