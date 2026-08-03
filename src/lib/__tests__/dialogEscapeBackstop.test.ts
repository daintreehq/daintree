// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerDialogEscapeBackstop,
  isTopmostDialogBackstop,
  radixLayerWasOpenWhenEscapePressed,
  markBackstopConsumedEscape,
  backstopAlreadyConsumedEscape,
  markEscapeYieldedToDialog,
  escapeWasYieldedToDialog,
  _resetForTests,
} from "../dialogEscapeBackstop";

function fireEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

function addRadixLayer(role: string, dataState = "open"): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", role);
  el.setAttribute("data-state", dataState);
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  _resetForTests();
  document.body.innerHTML = "";
});

describe("dialogEscapeBackstop — capture-phase Radix probe", () => {
  it("records radixLayerOpenAtCapture=true when a Radix listbox is open", () => {
    addRadixLayer("listbox");
    fireEscape();
    expect(radixLayerWasOpenWhenEscapePressed()).toBe(true);
  });

  it("records radixLayerOpenAtCapture=true for an open menu", () => {
    addRadixLayer("menu");
    fireEscape();
    expect(radixLayerWasOpenWhenEscapePressed()).toBe(true);
  });

  it("records radixLayerOpenAtCapture=true for an open non-modal dialog", () => {
    addRadixLayer("dialog");
    fireEscape();
    expect(radixLayerWasOpenWhenEscapePressed()).toBe(true);
  });

  it("records radixLayerOpenAtCapture=true for an open tooltip", () => {
    addRadixLayer("tooltip");
    fireEscape();
    expect(radixLayerWasOpenWhenEscapePressed()).toBe(true);
  });

  it("ignores modal dialogs (aria-modal=true) — those are AppDialog territory", () => {
    const el = addRadixLayer("dialog");
    el.setAttribute("aria-modal", "true");
    fireEscape();
    expect(radixLayerWasOpenWhenEscapePressed()).toBe(false);
  });

  it("records radixLayerOpenAtCapture=false when no Radix layer is in the DOM", () => {
    fireEscape();
    expect(radixLayerWasOpenWhenEscapePressed()).toBe(false);
  });

  it("treats data-state=closed (stale Presence layer) as not open", () => {
    addRadixLayer("listbox", "closed");
    fireEscape();
    expect(radixLayerWasOpenWhenEscapePressed()).toBe(false);
  });

  it("ignores non-Escape keydown events", () => {
    addRadixLayer("listbox");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    expect(radixLayerWasOpenWhenEscapePressed()).toBe(false);
  });
});

describe("dialogEscapeBackstop — gating real vs spurious Radix preventDefault", () => {
  let bubbleHandler: ((e: KeyboardEvent) => void) | null = null;

  afterEach(() => {
    if (bubbleHandler) {
      document.removeEventListener("keydown", bubbleHandler);
      bubbleHandler = null;
    }
  });

  it("does NOT fire backstop when a real Radix layer was open at capture time", () => {
    addRadixLayer("listbox");
    const backstopFire = vi.fn();

    bubbleHandler = (e) => {
      if (e.key !== "Escape") return;
      if (radixLayerWasOpenWhenEscapePressed()) return;
      backstopFire();
      markBackstopConsumedEscape();
    };
    document.addEventListener("keydown", bubbleHandler);

    fireEscape();

    expect(backstopFire).not.toHaveBeenCalled();
    expect(backstopAlreadyConsumedEscape()).toBe(false);
  });

  it("FIRES backstop when a stale Presence layer fires preventDefault but no layer was open at capture", () => {
    const backstopFire = vi.fn();

    const stalePresenceHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    document.addEventListener("keydown", stalePresenceHandler);

    bubbleHandler = (e) => {
      if (e.key !== "Escape") return;
      if (radixLayerWasOpenWhenEscapePressed()) return;
      backstopFire();
      markBackstopConsumedEscape();
    };
    document.addEventListener("keydown", bubbleHandler);

    fireEscape();

    document.removeEventListener("keydown", stalePresenceHandler);

    expect(backstopFire).toHaveBeenCalledOnce();
    expect(backstopAlreadyConsumedEscape()).toBe(true);
  });
});

/**
 * A dock popover deliberately stays open behind the dialog it spawned, so it is
 * always "the open Radix layer" the capture probe sees — and the gate above
 * would hand it every Escape, dismissing the panel underneath instead of the
 * dialog the user is looking at (#11505). The popover's own guard declines the
 * keypress and marks it, which releases the gate for that event alone.
 */
describe("dialogEscapeBackstop — a layer yielding Escape to the dialog above it", () => {
  // Tracked rather than removed inline: a failing assertion between add and
  // remove would otherwise leak the listener into the rest of the file.
  const listeners: Array<(e: KeyboardEvent) => void> = [];

  function addListener(handler: (e: KeyboardEvent) => void) {
    listeners.push(handler);
    document.addEventListener("keydown", handler);
    return handler;
  }

  function removeListener(handler: (e: KeyboardEvent) => void) {
    document.removeEventListener("keydown", handler);
    const idx = listeners.indexOf(handler);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  afterEach(() => {
    for (const handler of listeners.splice(0)) {
      document.removeEventListener("keydown", handler);
    }
  });

  function armBackstop(onFire: () => void) {
    addListener((e) => {
      if (e.key !== "Escape") return;
      if (radixLayerWasOpenWhenEscapePressed() && !escapeWasYieldedToDialog(e)) return;
      onFire();
      markBackstopConsumedEscape();
    });
  }

  it("fires the backstop for an Escape the open layer yielded", () => {
    addRadixLayer("dialog");
    const backstopFire = vi.fn();

    // Stand in for the dock guard, which runs between the capture probe and
    // the bubble backstop.
    addListener((e) => {
      if (e.key === "Escape") markEscapeYieldedToDialog(e);
    });
    armBackstop(backstopFire);

    fireEscape();

    expect(backstopFire).toHaveBeenCalledOnce();
  });

  it("still stands down for an open layer that did not yield", () => {
    addRadixLayer("dialog");
    const backstopFire = vi.fn();
    armBackstop(backstopFire);

    fireEscape();

    expect(backstopFire).not.toHaveBeenCalled();
  });

  it("does not let the mark leak into the next Escape press", () => {
    addRadixLayer("dialog");
    const backstopFire = vi.fn();

    const yieldOnce = addListener((e) => {
      if (e.key === "Escape") markEscapeYieldedToDialog(e);
    });
    armBackstop(backstopFire);

    fireEscape();
    expect(backstopFire).toHaveBeenCalledOnce();

    // Second press with no yield — e.g. a Select legitimately open inside the
    // dialog. A sticky flag here would close the dialog underneath it.
    removeListener(yieldOnce);
    fireEscape();

    expect(backstopFire).toHaveBeenCalledOnce();
  });

  it("reports a yield only for the exact event object that was marked", () => {
    const first = new KeyboardEvent("keydown", { key: "Escape" });
    const second = new KeyboardEvent("keydown", { key: "Escape" });

    markEscapeYieldedToDialog(first);

    expect(escapeWasYieldedToDialog(first)).toBe(true);
    expect(escapeWasYieldedToDialog(second)).toBe(false);
  });
});

describe("dialogEscapeBackstop — LIFO stack semantics", () => {
  it("isTopmostDialogBackstop is true only for the most recently registered handler", () => {
    const outer = vi.fn();
    const inner = vi.fn();

    registerDialogEscapeBackstop(outer);
    registerDialogEscapeBackstop(inner);

    expect(isTopmostDialogBackstop(outer)).toBe(false);
    expect(isTopmostDialogBackstop(inner)).toBe(true);
  });

  it("unregistering the topmost handler exposes the previous one as topmost", () => {
    const outer = vi.fn();
    const inner = vi.fn();

    registerDialogEscapeBackstop(outer);
    const disposeInner = registerDialogEscapeBackstop(inner);

    disposeInner();

    expect(isTopmostDialogBackstop(outer)).toBe(true);
    expect(isTopmostDialogBackstop(inner)).toBe(false);
  });

  it("layered backstops only fire the topmost on each Escape press", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    registerDialogEscapeBackstop(outer);
    const disposeInner = registerDialogEscapeBackstop(inner);

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (radixLayerWasOpenWhenEscapePressed()) return;
      const top = isTopmostDialogBackstop(inner) ? inner : outer;
      top();
      markBackstopConsumedEscape();
    };
    document.addEventListener("keydown", handler);

    fireEscape();
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();

    disposeInner();
    fireEscape();

    document.removeEventListener("keydown", handler);

    expect(outer).toHaveBeenCalledOnce();
    expect(inner).toHaveBeenCalledOnce();
  });

  it("three-layer stack unwinds in reverse order across successive Escape presses", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    registerDialogEscapeBackstop(a);
    const disposeB = registerDialogEscapeBackstop(b);
    const disposeC = registerDialogEscapeBackstop(c);

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (radixLayerWasOpenWhenEscapePressed()) return;
      if (isTopmostDialogBackstop(c)) {
        c();
      } else if (isTopmostDialogBackstop(b)) {
        b();
      } else if (isTopmostDialogBackstop(a)) {
        a();
      }
      markBackstopConsumedEscape();
    };
    document.addEventListener("keydown", handler);

    fireEscape();
    expect(c).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();

    disposeC();
    fireEscape();
    expect(b).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();

    disposeB();
    fireEscape();

    document.removeEventListener("keydown", handler);

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(c).toHaveBeenCalledOnce();
  });

  it("unregistering a middle entry preserves order of remaining", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    registerDialogEscapeBackstop(a);
    const disposeB = registerDialogEscapeBackstop(b);
    registerDialogEscapeBackstop(c);

    disposeB();

    expect(isTopmostDialogBackstop(c)).toBe(true);
    expect(isTopmostDialogBackstop(a)).toBe(false);
    expect(isTopmostDialogBackstop(b)).toBe(false);
  });

  it("double-dispose is safe", () => {
    const handler = vi.fn();
    const dispose = registerDialogEscapeBackstop(handler);

    dispose();
    dispose();

    expect(isTopmostDialogBackstop(handler)).toBe(false);
  });

  it("isTopmostDialogBackstop returns false for an unregistered handler", () => {
    const other = vi.fn();
    expect(isTopmostDialogBackstop(other)).toBe(false);
  });
});

describe("dialogEscapeBackstop — backstopAlreadyConsumedEscape reset", () => {
  it("returns false initially", () => {
    expect(backstopAlreadyConsumedEscape()).toBe(false);
  });

  it("returns true after markBackstopConsumedEscape() is called", () => {
    markBackstopConsumedEscape();
    expect(backstopAlreadyConsumedEscape()).toBe(true);
  });

  it("resets to false on the next Escape press (capture-phase clears the flag)", () => {
    markBackstopConsumedEscape();
    expect(backstopAlreadyConsumedEscape()).toBe(true);

    fireEscape();
    expect(backstopAlreadyConsumedEscape()).toBe(false);
  });

  it("does NOT reset on non-Escape keydown events", () => {
    markBackstopConsumedEscape();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );
    expect(backstopAlreadyConsumedEscape()).toBe(true);
  });

  it("stays false across consecutive Escape presses when nothing marks it consumed", () => {
    fireEscape();
    expect(backstopAlreadyConsumedEscape()).toBe(false);
    fireEscape();
    expect(backstopAlreadyConsumedEscape()).toBe(false);
  });
});
