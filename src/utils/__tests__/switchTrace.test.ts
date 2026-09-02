// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginSwitchTrace,
  consumeSwitchTrace,
  getActiveSwitchTrace,
  markSwitch,
  resetSwitchTraceForTesting,
  setActiveSwitchTrace,
} from "../switchTrace";

describe("switchTrace", () => {
  beforeEach(() => {
    resetSwitchTraceForTesting();
    window.__DAINTREE_PERF_MARKS__ = [];
  });

  afterEach(() => {
    delete window.__DAINTREE_PERF_MARKS__;
    vi.useRealTimers();
  });

  it("beginSwitchTrace mints a unique id, records the entry point, and marks keydown", () => {
    const a = beginSwitchTrace("mru-shortcut");
    const b = beginSwitchTrace("palette-mouse");
    expect(a.switchId).not.toBe(b.switchId);
    expect(a.entryPoint).toBe("mru-shortcut");
    const marks = window.__DAINTREE_PERF_MARKS__!;
    expect(marks.map((m) => m.mark)).toEqual(["project_switch.keydown", "project_switch.keydown"]);
    expect(marks[0]!.meta).toEqual({ switchId: a.switchId, entryPoint: "mru-shortcut" });
  });

  it("consumeSwitchTrace returns the fresh pending trace once", () => {
    const trace = beginSwitchTrace("toolbar");
    expect(consumeSwitchTrace()).toEqual(trace);
    expect(consumeSwitchTrace()).toBeNull();
  });

  it("consumeSwitchTrace drops a pending trace older than 5s", () => {
    vi.useFakeTimers();
    beginSwitchTrace("palette-keyboard");
    vi.advanceTimersByTime(5_001);
    expect(consumeSwitchTrace()).toBeNull();
  });

  it("a later gesture replaces the pending trace", () => {
    beginSwitchTrace("toolbar");
    const second = beginSwitchTrace("menu");
    expect(consumeSwitchTrace()).toEqual(second);
  });

  it("markSwitch stamps the active trace over the pending one, with explicit meta winning", () => {
    beginSwitchTrace("toolbar");
    markSwitch("project_switch.intent", { extra: 1 });
    setActiveSwitchTrace({ switchId: "active-id", entryPoint: "api" });
    markSwitch("project_switch.on_switch_received");
    markSwitch("project_switch.pty_port_ready", { switchId: "override" });

    const marks = window.__DAINTREE_PERF_MARKS__!;
    const intent = marks.find((m) => m.mark === "project_switch.intent")!;
    expect(intent.meta).toEqual(
      expect.objectContaining({ entryPoint: "toolbar", extra: 1, switchId: expect.any(String) })
    );
    expect(marks.find((m) => m.mark === "project_switch.on_switch_received")!.meta).toEqual({
      switchId: "active-id",
      entryPoint: "api",
    });
    expect(marks.find((m) => m.mark === "project_switch.pty_port_ready")!.meta).toEqual({
      switchId: "override",
      entryPoint: "api",
    });
    expect(getActiveSwitchTrace()).toEqual({ switchId: "active-id", entryPoint: "api" });
  });

  it("markSwitch without any trace still records the mark", () => {
    markSwitch("project_switch.intent");
    expect(window.__DAINTREE_PERF_MARKS__![0]!.meta).toEqual({});
  });
});
