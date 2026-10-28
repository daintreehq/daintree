import { describe, expect, it } from "vitest";
import { PLUGIN_PANEL_ACTIVITY_REASON_MAX } from "../../types/plugin.js";
import { samePanelActivity, validatePluginPanelActivity } from "../pluginPanelActivity.js";

describe("validatePluginPanelActivity", () => {
  it("accepts each state and a trimmed reason as a fresh copy", () => {
    for (const state of ["working", "waiting", "finished", "failed"] as const) {
      const input = { state, reason: "  Importing 3 of 12 " };
      const result = validatePluginPanelActivity("panel-1", input);
      expect(result).toEqual({
        ok: true,
        panelId: "panel-1",
        activity: { state, reason: "Importing 3 of 12" },
      });
      expect(result.ok && result.activity).not.toBe(input);
    }
  });

  it("leaves an omitted or null reason out", () => {
    expect(validatePluginPanelActivity("p", { state: "working" })).toEqual({
      ok: true,
      panelId: "p",
      activity: { state: "working" },
    });
    expect(validatePluginPanelActivity("p", { state: "working", reason: null })).toEqual({
      ok: true,
      panelId: "p",
      activity: { state: "working" },
    });
  });

  it("treats null and undefined as a clear", () => {
    expect(validatePluginPanelActivity("p", null)).toEqual({
      ok: true,
      panelId: "p",
      activity: null,
    });
    expect(validatePluginPanelActivity("p", undefined)).toEqual({
      ok: true,
      panelId: "p",
      activity: null,
    });
  });

  it("rejects an empty or non-string panel id", () => {
    for (const id of ["", 5, null, undefined]) {
      expect(validatePluginPanelActivity(id, { state: "working" })).toEqual({
        ok: false,
        error: "panelId must be a non-empty string",
      });
    }
  });

  it("rejects a state outside the four, and agent-only states", () => {
    for (const state of ["idle", "completed", "directing", "running", "", 1, undefined]) {
      expect(validatePluginPanelActivity("p", { state }).ok).toBe(false);
    }
  });

  it("rejects a non-object, an array and an extra field", () => {
    expect(validatePluginPanelActivity("p", "working").ok).toBe(false);
    expect(validatePluginPanelActivity("p", ["working"]).ok).toBe(false);
    expect(validatePluginPanelActivity("p", { state: "working", agentState: "working" })).toEqual({
      ok: false,
      error: 'activity has an unsupported field "agentState"',
    });
  });

  it("holds the reason to one bounded, non-empty line", () => {
    expect(validatePluginPanelActivity("p", { state: "waiting", reason: "  " }).ok).toBe(false);
    expect(validatePluginPanelActivity("p", { state: "waiting", reason: "a\nb" }).ok).toBe(false);
    expect(validatePluginPanelActivity("p", { state: "waiting", reason: 5 }).ok).toBe(false);
    expect(
      validatePluginPanelActivity("p", {
        state: "waiting",
        reason: "x".repeat(PLUGIN_PANEL_ACTIVITY_REASON_MAX),
      }).ok
    ).toBe(true);
    expect(
      validatePluginPanelActivity("p", {
        state: "waiting",
        reason: "x".repeat(PLUGIN_PANEL_ACTIVITY_REASON_MAX + 1),
      }).ok
    ).toBe(false);
  });

  it("reads fields without running a getter", () => {
    let calls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "state", {
      enumerable: true,
      get() {
        calls += 1;
        return "working";
      },
    });
    expect(validatePluginPanelActivity("p", hostile).ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("samePanelActivity", () => {
  it("compares state and reason", () => {
    expect(samePanelActivity({ state: "working" }, { state: "working" })).toBe(true);
    expect(samePanelActivity({ state: "working", reason: "a" }, { state: "working" })).toBe(false);
    expect(samePanelActivity({ state: "working" }, { state: "finished" })).toBe(false);
    expect(samePanelActivity(undefined, { state: "working" })).toBe(false);
  });
});
