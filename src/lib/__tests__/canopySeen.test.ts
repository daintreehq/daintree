// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanopyStore } from "@/store/canopyStore";
import {
  __resetCanopySeenForTests,
  reportCanopySeen,
  reportCanopySent,
  reportRunLook,
} from "../canopySeen";

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
  useCanopyStore.setState({ mode: "on" });
});

afterEach(() => {
  useCanopyStore.setState({ mode: "unset" });
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

  it("tells main nothing while Canopy is off or hidden", () => {
    for (const mode of ["unset", "hidden"] as const) {
      useCanopyStore.setState({ mode });
      reportCanopySent("a");
    }
    expect(noteSent).not.toHaveBeenCalled();
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

describe("reportRunLook", () => {
  let noteRunLook: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    noteRunLook = vi.fn(async () => {});
    Object.defineProperty(window, "electron", {
      value: { fleet: { noteRunLook } },
      configurable: true,
      writable: true,
    });
  });

  it("reports whatever Canopy's mode, folding repeats of a look within a moment", () => {
    useCanopyStore.setState({ mode: "unset" });
    reportRunLook("a", true);
    reportRunLook("a", true);
    expect(noteRunLook).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    reportRunLook("a", true);
    expect(noteRunLook).toHaveBeenCalledTimes(2);
  });

  it("always tells a look ending, and a look starting straight after one", () => {
    reportRunLook("a", true);
    reportRunLook("a", false);
    reportRunLook("a", false);
    reportRunLook("a", true);
    expect(noteRunLook.mock.calls.map(([, looking]) => looking)).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });
});
