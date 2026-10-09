// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCanopySeenForTests, reportCanopySeen, reportCanopySent } from "../canopySeen";

let markSeen: ReturnType<typeof vi.fn>;
let noteSent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  __resetCanopySeenForTests();
  markSeen = vi.fn(async () => {});
  noteSent = vi.fn(async () => {});
  Object.defineProperty(window, "electron", {
    value: { canopy: { markSeen, noteSent } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  delete (window as { electron?: unknown }).electron;
  vi.useRealTimers();
});

describe("reportCanopySent", () => {
  it("tells main once per moment for a run, and again after", () => {
    reportCanopySent("a");
    reportCanopySent("a");
    reportCanopySent("b");
    expect(noteSent.mock.calls.map(([id]) => String(id))).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1_000);
    reportCanopySent("a");
    expect(noteSent).toHaveBeenCalledTimes(3);
  });

  it("does nothing where Canopy has no bridge", () => {
    delete (window as { electron?: unknown }).electron;
    expect(() => reportCanopySent("a")).not.toThrow();
  });
});

describe("reportCanopySeen", () => {
  it("always tells a look ending, and keeps the pane's and the panel's looks apart", () => {
    reportCanopySeen("a", true);
    reportCanopySeen("a", true, "panel");
    reportCanopySeen("a", false);
    expect(markSeen.mock.calls).toEqual([
      ["a", true, "pane"],
      ["a", true, "panel"],
      ["a", false, "pane"],
    ]);
  });
});
