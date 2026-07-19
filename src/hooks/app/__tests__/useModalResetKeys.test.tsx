// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const gitPushState = vi.hoisted(() => ({ requestSeq: 1 }));
const gitPullRebaseState = vi.hoisted(() => ({ requestSeq: 2 }));
const panelLimitState = vi.hoisted(() => ({ requestSeq: 3 }));
const recipeConflictState = vi.hoisted(() => ({ requestSeq: 4 }));
const mcpConfirmState = vi.hoisted(() => ({ current: { requestId: "mcp-1" } }));
const pluginConfirmState = vi.hoisted(() => ({ current: { requestId: "plugin-1" } }));
const pluginMcpConfirmState = vi.hoisted(() => ({ current: null as { requestId: string } | null }));
const pluginCapabilityConfirmState = vi.hoisted(() => ({ current: { requestId: "cap-1" } }));
const diagnosticsReviewState = vi.hoisted(() => ({ requestSeq: 5 }));

function selectorMock<T>(state: T) {
  return vi.fn((selector: (s: T) => unknown) => selector(state));
}

vi.mock("@/store/gitPushConfirmStore", () => ({
  useGitPushConfirmStore: selectorMock(gitPushState),
}));
vi.mock("@/store/gitPullRebaseConfirmStore", () => ({
  useGitPullRebaseConfirmStore: selectorMock(gitPullRebaseState),
}));
vi.mock("@/store/panelLimitStore", () => ({
  usePanelLimitStore: selectorMock(panelLimitState),
}));
vi.mock("@/store/recipeConflictStore", () => ({
  useRecipeConflictStore: selectorMock(recipeConflictState),
}));
vi.mock("@/store/mcpConfirmStore", () => ({
  useMcpConfirmStore: selectorMock(mcpConfirmState),
}));
vi.mock("@/store/pluginConfirmStore", () => ({
  usePluginConfirmStore: selectorMock(pluginConfirmState),
}));
vi.mock("@/store/pluginMcpConfirmStore", () => ({
  usePluginMcpConfirmStore: selectorMock(pluginMcpConfirmState),
}));
vi.mock("@/store/pluginCapabilityConfirmStore", () => ({
  usePluginCapabilityConfirmStore: selectorMock(pluginCapabilityConfirmState),
}));
vi.mock("@/store/diagnosticsReviewStore", () => ({
  useDiagnosticsReviewStore: selectorMock(diagnosticsReviewState),
}));

import { useModalResetKeys } from "../useModalResetKeys";

describe("useModalResetKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives reset keys from each store's request signal", () => {
    const { result } = renderHook(() => useModalResetKeys());

    expect(result.current).toEqual({
      gitPushResetKey: 1,
      gitPullRebaseResetKey: 2,
      panelLimitResetKey: 3,
      recipeConflictResetKey: 4,
      mcpConfirmResetKey: "mcp-1",
      pluginConfirmResetKey: "plugin-1",
      pluginMcpConfirmResetKey: "",
      pluginCapabilityConfirmResetKey: "cap-1",
      diagnosticsReviewResetKey: 5,
      terminalInfoResetKey: 0,
    });
  });

  it("increments only terminalInfoResetKey on daintree:open-terminal-info", () => {
    const { result } = renderHook(() => useModalResetKeys());

    act(() => {
      window.dispatchEvent(new Event("daintree:open-terminal-info"));
    });

    expect(result.current.terminalInfoResetKey).toBe(1);
  });

  it("removes its window listeners on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useModalResetKeys());

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("daintree:open-terminal-info", expect.any(Function));
    removeSpy.mockRestore();
  });
});
