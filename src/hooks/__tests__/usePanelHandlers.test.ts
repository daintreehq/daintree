// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelCloseRequest } from "@/services/terminal/optimisticPanelClose";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const {
  setFocusedMock,
  trashPanelGroupMock,
  closeDockTerminalMock,
  removePanelMock,
  updateTitleMock,
  getPanelGroupMock,
  requestPanelCloseMock,
} = vi.hoisted(() => ({
  setFocusedMock: vi.fn(),
  trashPanelGroupMock: vi.fn(),
  closeDockTerminalMock: vi.fn(),
  removePanelMock: vi.fn(),
  updateTitleMock: vi.fn(),
  getPanelGroupMock: vi.fn(),
  requestPanelCloseMock: vi.fn<(req: PanelCloseRequest) => void>(),
}));

vi.mock("@/store", () => {
  const state = {
    setFocused: setFocusedMock,
    trashPanelGroup: trashPanelGroupMock,
    closeDockTerminal: closeDockTerminalMock,
    removePanel: removePanelMock,
    updateTitle: updateTitleMock,
    getPanelGroup: getPanelGroupMock,
  };
  return {
    usePanelStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

vi.mock("@/services/terminal/optimisticPanelClose", () => ({
  requestPanelClose: requestPanelCloseMock,
}));

import { usePanelHandlers } from "../usePanelHandlers";

describe("usePanelHandlers", () => {
  beforeEach(() => {
    setFocusedMock.mockClear();
    trashPanelGroupMock.mockReset();
    closeDockTerminalMock.mockClear();
    removePanelMock.mockClear();
    updateTitleMock.mockClear();
    getPanelGroupMock.mockReset();
    requestPanelCloseMock.mockClear();
  });

  it("force-close calls removePanel synchronously, bypassing the optimistic path", () => {
    const onAfterClose = vi.fn();
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1", onAfterClose }));

    act(() => result.current.handleClose(true));

    expect(removePanelMock).toHaveBeenCalledWith("p1");
    expect(requestPanelCloseMock).not.toHaveBeenCalled();
    expect(onAfterClose).toHaveBeenCalledTimes(1);
  });

  it("normal close routes through the optimistic coordinator, deferring the trash", () => {
    getPanelGroupMock.mockReturnValue(undefined);
    const onAfterClose = vi.fn();
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1", onAfterClose }));

    act(() => result.current.handleClose());

    expect(requestPanelCloseMock).toHaveBeenCalledTimes(1);
    expect(requestPanelCloseMock.mock.calls[0]![0].hideIds).toEqual(["p1"]);
    // The canonical trash is deferred — it must NOT run synchronously.
    expect(trashPanelGroupMock).not.toHaveBeenCalled();
    expect(onAfterClose).toHaveBeenCalledTimes(1);
  });

  it("hides every panel in the tab group when closing a grouped panel", () => {
    getPanelGroupMock.mockReturnValue({ id: "g1", panelIds: ["p1", "p2", "p3"] });
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1" }));

    act(() => result.current.handleClose());

    expect(requestPanelCloseMock.mock.calls[0]![0].hideIds).toEqual(["p1", "p2", "p3"]);
  });

  it("the deferred commit trashes the panel group", () => {
    getPanelGroupMock.mockReturnValue(undefined);
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1" }));

    act(() => result.current.handleClose());
    expect(trashPanelGroupMock).not.toHaveBeenCalled();

    requestPanelCloseMock.mock.calls[0]![0].commit();
    expect(trashPanelGroupMock).toHaveBeenCalledWith("p1");
  });

  it("the deferred commit swallows trashPanelGroup errors", () => {
    getPanelGroupMock.mockReturnValue(undefined);
    trashPanelGroupMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1" }));

    act(() => result.current.handleClose());
    expect(() => requestPanelCloseMock.mock.calls[0]![0].commit()).not.toThrow();
  });

  it("rapid double-close only requests one close", () => {
    getPanelGroupMock.mockReturnValue(undefined);
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1" }));

    act(() => result.current.handleClose());
    act(() => result.current.handleClose());

    expect(requestPanelCloseMock).toHaveBeenCalledTimes(1);
  });

  it("force-close after a normal close is a no-op (already closing)", () => {
    getPanelGroupMock.mockReturnValue(undefined);
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1" }));

    act(() => result.current.handleClose());
    act(() => result.current.handleClose(true));

    expect(requestPanelCloseMock).toHaveBeenCalledTimes(1);
    expect(removePanelMock).not.toHaveBeenCalled();
  });

  it("dock-surface close dismisses the preview without trashing or killing the terminal", () => {
    const onAfterClose = vi.fn();
    const { result } = renderHook(() =>
      usePanelHandlers({ terminalId: "p1", surface: "dock", onAfterClose })
    );

    act(() => result.current.handleClose());

    expect(closeDockTerminalMock).toHaveBeenCalledWith("p1");
    expect(trashPanelGroupMock).not.toHaveBeenCalled();
    expect(removePanelMock).not.toHaveBeenCalled();
    expect(requestPanelCloseMock).not.toHaveBeenCalled();
    expect(onAfterClose).toHaveBeenCalledTimes(1);
  });

  it("dock-surface dismiss stays repeatable across reopen cycles (no trashedRef latch)", () => {
    // The DockedPanel hook instance survives collapse/reopen, so the X must
    // dismiss every time — not latch after the first like the destructive paths.
    const onAfterClose = vi.fn();
    const { result } = renderHook(() =>
      usePanelHandlers({ terminalId: "p1", surface: "dock", onAfterClose })
    );

    act(() => result.current.handleClose());
    act(() => result.current.handleClose());

    expect(closeDockTerminalMock).toHaveBeenCalledTimes(2);
    expect(onAfterClose).toHaveBeenCalledTimes(2);
  });

  it("dock-surface force-close still destroys via removePanel, never dismissing", () => {
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1", surface: "dock" }));

    act(() => result.current.handleClose(true));

    expect(removePanelMock).toHaveBeenCalledWith("p1");
    expect(closeDockTerminalMock).not.toHaveBeenCalled();
    expect(trashPanelGroupMock).not.toHaveBeenCalled();
  });

  it("handleFocus delegates to setFocused", () => {
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1" }));

    act(() => result.current.handleFocus());

    expect(setFocusedMock).toHaveBeenCalledWith("p1");
  });

  it("handleTitleChange delegates to updateTitle", () => {
    const { result } = renderHook(() => usePanelHandlers({ terminalId: "p1" }));

    act(() => result.current.handleTitleChange("New title"));

    expect(updateTitleMock).toHaveBeenCalledWith("p1", "New title");
  });
});
