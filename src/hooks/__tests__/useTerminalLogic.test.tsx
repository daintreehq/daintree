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
});
