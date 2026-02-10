// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { retryMock } = vi.hoisted(() => ({
  retryMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/clients", () => ({
  errorsClient: {
    retry: retryMock,
  },
}));

import { useTerminalLogic } from "../useTerminalLogic";

describe("useTerminalLogic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes invalid exit codes to 0", () => {
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
  });
});
