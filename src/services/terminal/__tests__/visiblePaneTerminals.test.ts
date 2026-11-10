// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const view = vi.hoisted(() => ({
  cached: false,
  lifecycle: new Set<(phase: "cached" | "active" | "revealed") => void>(),
  resync: new Set<() => void>(),
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => view.cached,
  subscribeProjectViewLifecycle: (listener: (phase: "cached" | "active" | "revealed") => void) => {
    view.lifecycle.add(listener);
    return () => view.lifecycle.delete(listener);
  },
}));
vi.mock("@/store/hostResyncSignal", () => ({
  onHostResync: (listener: () => void) => {
    view.resync.add(listener);
    return () => view.resync.delete(listener);
  },
}));
const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logWarn }));

type Reporter = typeof import("../visiblePaneTerminals");

describe("visiblePaneTerminals (#16737)", () => {
  let reporter: Reporter;
  const setVisiblePaneTerminals = vi.fn(async (_ids: string[]) => {});
  const reports = () => setVisiblePaneTerminals.mock.calls.map(([ids]) => ids);
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const offs: Array<() => void> = [];
  const register = (shown: Set<string>) => {
    const off = reporter.registerVisiblePaneSource(() => shown);
    offs.push(off);
    return off;
  };

  beforeEach(async () => {
    vi.resetModules();
    view.cached = false;
    view.lifecycle.clear();
    view.resync.clear();
    setVisiblePaneTerminals.mockReset();
    setVisiblePaneTerminals.mockResolvedValue(undefined);
    logWarn.mockClear();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { canopy: { setVisiblePaneTerminals } },
    });
    reporter = await import("../visiblePaneTerminals");
  });

  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });

  it("reports what every service shows as one list, once per task", async () => {
    const first = new Set(["t2", "t1"]);
    const second = new Set(["t1", "t3"]);
    register(first);
    register(second);
    first.add("t4");
    reporter.noteVisiblePanesChanged();
    reporter.noteVisiblePanesChanged();
    await settle();

    expect(reports()).toEqual([["t1", "t2", "t3", "t4"]]);
  });

  it("sends nothing when what the panes show hasn't changed", async () => {
    const shown = new Set(["t1"]);
    register(shown);
    await settle();
    reporter.noteVisiblePanesChanged();
    await settle();
    shown.delete("t1");
    reporter.noteVisiblePanesChanged();
    await settle();

    expect(reports()).toEqual([["t1"], []]);
  });

  it("shows nothing while the view is cached, said before anything else runs", async () => {
    register(new Set(["t1"]));
    await settle();

    view.cached = true;
    for (const listener of view.lifecycle) listener("cached");
    expect(reports()).toEqual([["t1"], []]);

    view.cached = false;
    for (const listener of view.lifecycle) listener("active");
    await settle();
    expect(reports()).toEqual([["t1"], [], ["t1"]]);
  });

  it("says it all again when the host comes back, as the host may have forgotten", async () => {
    register(new Set(["t1"]));
    await settle();

    for (const listener of view.resync) listener();
    await settle();

    expect(reports()).toEqual([["t1"], ["t1"]]);
  });

  it("sends a refused report again on the next change, warning once", async () => {
    setVisiblePaneTerminals.mockRejectedValue(new Error("unknown channel"));
    const shown = new Set(["t1"]);
    register(shown);
    await settle();
    reporter.noteVisiblePanesChanged();
    await settle();

    expect(reports()).toEqual([["t1"], ["t1"]]);
    expect(logWarn).toHaveBeenCalledTimes(1);

    setVisiblePaneTerminals.mockResolvedValue(undefined);
    shown.add("t2");
    reporter.noteVisiblePanesChanged();
    await settle();
    expect(reports().at(-1)).toEqual(["t1", "t2"]);
  });

  it("says the view shows nothing once the last service goes, and stops listening", async () => {
    const off = register(new Set(["t1"]));
    await settle();

    off();

    expect(reports()).toEqual([["t1"], []]);
    expect(view.lifecycle.size).toBe(0);
    expect(view.resync.size).toBe(0);
    reporter.noteVisiblePanesChanged();
    await settle();
    expect(reports()).toHaveLength(2);
  });

  it("reports again when one of several services goes", async () => {
    register(new Set(["t1"]));
    const off = register(new Set(["t2"]));
    await settle();

    off();
    await settle();

    expect(reports()).toEqual([["t1", "t2"], ["t1"]]);
    expect(view.lifecycle.size).toBe(1);
  });

  it("leaves out a terminal its owner hides while it stays attached, until every owner shows it", async () => {
    register(new Set(["t1", "t2"]));
    await settle();

    const hide = reporter.hidePaneTerminal("t1");
    const hideAgain = reporter.hidePaneTerminal("t1");
    await settle();
    hide();
    hide();
    await settle();
    expect(reports()).toEqual([["t1", "t2"], ["t2"]]);

    hideAgain();
    await settle();
    expect(reports()).toEqual([["t1", "t2"], ["t2"], ["t1", "t2"]]);
  });

  it("does nothing where the preload has no such call", async () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { canopy: {} },
    });
    register(new Set(["t1"]));
    await settle();
    expect(logWarn).not.toHaveBeenCalled();
  });
});
