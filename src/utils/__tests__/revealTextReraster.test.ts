// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVEAL_RERASTER_ATTR, scheduleRevealTextReraster } from "../revealTextReraster";

const rafQueue = new Map<number, FrameRequestCallback>();
let rafIdCounter = 0;

function flushFrame(): void {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of pending) cb(0);
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  rafQueue.clear();
  rafIdCounter = 0;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    const id = ++rafIdCounter;
    rafQueue.set(id, cb);
    return id;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    rafQueue.delete(id);
  });
  setVisibilityState("visible");
  document.documentElement.removeAttribute(REVEAL_RERASTER_ATTR);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>)["visibilityState"];
  document.documentElement.removeAttribute(REVEAL_RERASTER_ATTR);
});

describe("scheduleRevealTextReraster", () => {
  it("sets the root attribute on the first frame and clears it on the second", () => {
    scheduleRevealTextReraster();
    expect(document.documentElement.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(false);

    flushFrame();
    expect(document.documentElement.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(true);

    flushFrame();
    expect(document.documentElement.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(false);
    expect(rafQueue.size).toBe(0);
  });

  it("does nothing when the document goes hidden before the first frame", () => {
    scheduleRevealTextReraster();
    setVisibilityState("hidden");
    flushFrame();
    expect(document.documentElement.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(false);
    expect(rafQueue.size).toBe(0);
  });

  it("cancel clears a pending frame and never leaves the attribute behind", () => {
    const cancel = scheduleRevealTextReraster();
    flushFrame();
    expect(document.documentElement.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(true);

    cancel();
    expect(document.documentElement.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(false);
    expect(rafQueue.size).toBe(0);
    // Idempotent: a second cancel after completion is harmless.
    cancel();
  });

  it("works against an explicit root element", () => {
    const root = document.createElement("div");
    const cancel = scheduleRevealTextReraster(root);
    flushFrame();
    expect(root.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(true);
    expect(document.documentElement.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(false);
    cancel();
    expect(root.hasAttribute(REVEAL_RERASTER_ATTR)).toBe(false);
  });
});
