// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { retryMock, getSharedBuffersMock } = vi.hoisted(() => ({
  retryMock: vi.fn().mockResolvedValue(undefined),
  getSharedBuffersMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/clients", () => ({
  errorsClient: {
    retry: retryMock,
    cancelRetry: vi.fn(),
  },
  projectClient: {
    getProjectId: vi.fn().mockReturnValue("test-project"),
  },
  terminalClient: {
    getSharedBuffers: getSharedBuffersMock,
  },
}));

import { useTerminalLogic } from "../useTerminalLogic";
import { usePanelStore } from "@/store/panelStore";

describe("useTerminalLogic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes invalid exit codes to 0 without bootstrapping terminal ingestion", () => {
    const { result } = renderHook(() =>
      useTerminalLogic({
        id: "term-1",
        removeError: vi.fn(),
      })
    );

    act(() => {
      result.current.handleExit(Number.NaN);
    });

    expect(result.current.isExited).toBe(true);
    expect(result.current.exitCode).toBe(0);
    expect(retryMock).not.toHaveBeenCalled();
    expect(getSharedBuffersMock).not.toHaveBeenCalled();
  });

  it("keeps a lost terminal's exit code unknown rather than inventing one", () => {
    const { result } = renderHook(() => useTerminalLogic({ id: "term-1", removeError: vi.fn() }));

    act(() => {
      result.current.handleExit(null);
    });

    expect(result.current.isExited).toBe(true);
    expect(result.current.exitCode).toBeNull();
  });

  it("reads an exit only the store heard of, and drops it once the terminal runs again", () => {
    const base = { id: "term-2", kind: "terminal", location: "grid", title: "t", cwd: "/" };
    usePanelStore.setState({
      panelsById: { "term-2": { ...base, runtimeStatus: "exited" } as never },
    });
    const { result } = renderHook(() => useTerminalLogic({ id: "term-2", removeError: vi.fn() }));

    expect(result.current.isExited).toBe(true);
    expect(result.current.exitCode).toBeNull();

    act(() => {
      usePanelStore.setState({
        panelsById: { "term-2": { ...base, runtimeStatus: "running" } as never },
      });
    });
    expect(result.current.isExited).toBe(false);
  });

  it("takes a stored exit code when the pane mounts after the exit", () => {
    usePanelStore.setState({
      panelsById: {
        "term-3": {
          id: "term-3",
          kind: "terminal",
          location: "grid",
          title: "t",
          cwd: "/",
          runtimeStatus: "exited",
          exitCode: 2,
        } as never,
      },
    });
    const { result } = renderHook(() => useTerminalLogic({ id: "term-3", removeError: vi.fn() }));

    expect(result.current.isExited).toBe(true);
    expect(result.current.exitCode).toBe(2);
  });

  it("never shows the next tab, or the next run, the exit heard on the last (#16878)", () => {
    usePanelStore.setState({ panelsById: {} });
    const seen: Array<{ id: string; restartKey: number; isExited: boolean }> = [];
    const { result, rerender } = renderHook(
      ({ id, restartKey }: { id: string; restartKey: number }) => {
        const logic = useTerminalLogic({ id, removeError: vi.fn(), restartKey });
        seen.push({ id, restartKey, isExited: logic.isExited });
        return logic;
      },
      { initialProps: { id: "tab-a", restartKey: 0 } }
    );
    const exitOnA = result.current.handleExit;
    act(() => exitOnA(1));
    expect(result.current.isExited).toBe(true);

    rerender({ id: "tab-b", restartKey: 0 });
    act(() => exitOnA(1));
    expect(seen.filter((r) => r.id === "tab-b").some((r) => r.isExited)).toBe(false);
    act(() => result.current.handleExit(2));
    expect(result.current.isExited).toBe(true);
    expect(result.current.exitCode).toBe(2);

    rerender({ id: "tab-a", restartKey: 1 });
    expect(seen.filter((r) => r.restartKey === 1).some((r) => r.isExited)).toBe(false);
    act(() => result.current.handleExit(3));
    expect(result.current.isExited).toBe(true);
    expect(result.current.exitCode).toBe(3);
  });
});
