// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { addErrorMock, removeErrorMock, isAvailableMock, cancelMock, onProgressMock } = vi.hoisted(
  () => ({
    addErrorMock: vi.fn(),
    removeErrorMock: vi.fn(),
    isAvailableMock: vi.fn(() => new Promise<boolean>(() => {})),
    cancelMock: vi.fn(() => undefined),
    onProgressMock: vi.fn(() => () => {}),
  })
);

const { terminalState, useTerminalStoreMock } = vi.hoisted(() => {
  const terminalState = {
    focusedId: "term-1",
    terminals: [
      {
        id: "term-1",
        worktreeId: "wt-1",
        agentId: undefined,
        agentState: "idle",
      },
    ],
  };

  const storeFn = vi.fn((selector: (state: typeof terminalState) => unknown) =>
    selector(terminalState)
  );
  const useTerminalStoreMock = Object.assign(storeFn, {
    subscribe: vi.fn(() => () => {}),
    getState: () => terminalState,
  });

  return { terminalState, useTerminalStoreMock };
});

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: useTerminalStoreMock,
}));

vi.mock("@/store/errorStore", () => ({
  useErrorStore: (selector: (state: { addError: typeof addErrorMock; removeError: typeof removeErrorMock }) => unknown) =>
    selector({ addError: addErrorMock, removeError: removeErrorMock }),
}));

vi.mock("@/clients", () => ({
  copyTreeClient: {
    onProgress: onProgressMock,
    isAvailable: isAvailableMock,
    injectToTerminal: vi.fn(),
    cancel: cancelMock,
  },
}));

import { useContextInjection } from "../useContextInjection";

describe("useContextInjection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalState.focusedId = "term-1";
    terminalState.terminals = [
      {
        id: "term-1",
        worktreeId: "wt-1",
        agentId: undefined,
        agentState: "idle",
      },
    ];
  });

  it("does not throw if cancel API returns non-promise", async () => {
    const { result } = renderHook(() => useContextInjection("term-1"));

    act(() => {
      void result.current.inject("wt-1", "term-1");
    });

    await expect(async () => {
      act(() => {
        result.current.cancel();
      });
    }).not.toThrow();
  });
});
