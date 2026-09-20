// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetDevPreviewToolsForTests,
  getAvailableDevPreviewTool,
  getDevPreviewTool,
  registerDevPreviewTool,
  useDevPreviewTools,
} from "@/registry/devPreviewToolRegistry";
import { _resetPluginRuntimeStoreForTest, usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

const PLUGIN = "acme.tools";
const TOOL = "acme.tools.picker";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));
const { logWarn } = await import("@/utils/logger");

afterEach(() => {
  __resetDevPreviewToolsForTests();
  _resetPluginRuntimeStoreForTest();
  vi.mocked(logWarn).mockClear();
});

function register(id = TOOL): void {
  registerDevPreviewTool({ id, pluginId: PLUGIN, label: "Picker", Button: () => null });
}

function snapshot(previewToolIds: string[], disabled: string[] = []): void {
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([
      [PLUGIN, { devMode: false, displayName: "Acme", previewToolIds: new Set(previewToolIds) }],
    ]),
    disabledPluginIds: new Set(disabled),
  });
}

describe("dev preview tool manifest gate", () => {
  it("serves a tool its plugin's manifest declares", () => {
    register();
    snapshot([TOOL]);
    expect(getAvailableDevPreviewTool(TOOL)?.id).toBe(TOOL);
  });

  it("hides a registered tool the manifest does not declare, and warns once", () => {
    register();
    snapshot(["acme.tools.other"]);

    expect(getAvailableDevPreviewTool(TOOL)).toBeUndefined();
    // Still registered — the gate is admission, not registration, so the drift
    // is diagnosable rather than invisible.
    expect(getDevPreviewTool(TOOL)?.id).toBe(TOOL);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logWarn).mock.calls[0]?.[0]).toContain("contributes.previewTools");

    getAvailableDevPreviewTool(TOOL);
    getAvailableDevPreviewTool(TOOL);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("stays silent before the first plugin snapshot arrives", () => {
    register();
    // No snapshot: the enable gate already hides the tool here, and warning
    // would fire on every cold start.
    expect(getAvailableDevPreviewTool(TOOL)).toBeUndefined();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("admits a declared tool as soon as the snapshot lands", () => {
    register();
    expect(getAvailableDevPreviewTool(TOOL)).toBeUndefined();
    snapshot([TOOL]);
    expect(getAvailableDevPreviewTool(TOOL)?.id).toBe(TOOL);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("hides a declared tool whose plugin is disabled", () => {
    register();
    snapshot([TOOL], [PLUGIN]);
    expect(getAvailableDevPreviewTool(TOOL)).toBeUndefined();
    // A disabled plugin is not drift, so it must not be reported as such.
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("returns undefined for an id nothing registered", () => {
    snapshot([TOOL]);
    expect(getAvailableDevPreviewTool(TOOL)).toBeUndefined();
  });
});

describe("useDevPreviewTools", () => {
  it("serves declared tools and hides undeclared ones", () => {
    register();
    register("acme.tools.ghost");
    snapshot([TOOL]);
    const { result } = renderHook(() => useDevPreviewTools());
    expect(result.current.map((tool) => tool.id)).toEqual([TOOL]);
  });

  it("reports drift after the commit, once, without warning during render", () => {
    register();
    snapshot(["acme.tools.other"]);
    // The filter itself must be pure: rendering it in isolation says nothing.
    const { rerender } = renderHook(() => useDevPreviewTools());
    expect(logWarn).toHaveBeenCalledTimes(1);
    rerender();
    rerender();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("stays silent before the first plugin snapshot arrives", () => {
    register();
    const { result } = renderHook(() => useDevPreviewTools());
    expect(result.current).toEqual([]);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("drops a tool live when its plugin is disabled, without reporting drift", () => {
    register();
    snapshot([TOOL]);
    const { result } = renderHook(() => useDevPreviewTools());
    expect(result.current).toHaveLength(1);

    act(() => snapshot([TOOL], [PLUGIN]));
    expect(result.current).toEqual([]);
    expect(logWarn).not.toHaveBeenCalled();
  });
});
