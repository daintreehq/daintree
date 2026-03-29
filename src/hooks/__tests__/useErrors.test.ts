// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AppError } from "@/store";

const { onErrorMock, getPendingMock, notifyMock } = vi.hoisted(() => ({
  onErrorMock: vi.fn(),
  getPendingMock: vi.fn(),
  notifyMock: vi.fn().mockReturnValue(""),
}));

vi.mock("@/clients", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    errorsClient: {
      onError: onErrorMock,
      getPending: getPendingMock,
      onRetryProgress: vi.fn().mockReturnValue(vi.fn()),
      retry: vi.fn(),
      cancelRetry: vi.fn(),
      openLogs: vi.fn(),
    },
  };
});

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

function makeError(overrides: Partial<AppError> = {}): AppError {
  return {
    id: "err-1",
    timestamp: Date.now(),
    type: "unknown",
    message: "Something went wrong",
    isTransient: false,
    dismissed: false,
    ...overrides,
  };
}

describe("getErrorPriority", () => {
  let getErrorPriority: typeof import("../useErrors").getErrorPriority;

  beforeEach(async () => {
    ({ getErrorPriority } = await import("../useErrors"));
  });

  it("returns 'low' for transient errors regardless of type", () => {
    expect(getErrorPriority({ type: "process", isTransient: true })).toBe("low");
    expect(getErrorPriority({ type: "config", isTransient: true })).toBe("low");
    expect(getErrorPriority({ type: "git", isTransient: true })).toBe("low");
    expect(getErrorPriority({ type: "network", isTransient: true })).toBe("low");
    expect(getErrorPriority({ type: "filesystem", isTransient: true })).toBe("low");
    expect(getErrorPriority({ type: "unknown", isTransient: true })).toBe("low");
  });

  it("returns 'high' for non-transient process errors", () => {
    expect(getErrorPriority({ type: "process", isTransient: false })).toBe("high");
  });

  it("returns 'high' for non-transient config errors", () => {
    expect(getErrorPriority({ type: "config", isTransient: false })).toBe("high");
  });

  it("returns 'high' for non-transient git errors", () => {
    expect(getErrorPriority({ type: "git", isTransient: false })).toBe("high");
  });

  it("returns 'high' for non-transient network errors", () => {
    expect(getErrorPriority({ type: "network", isTransient: false })).toBe("high");
  });

  it("returns 'high' for non-transient filesystem errors", () => {
    expect(getErrorPriority({ type: "filesystem", isTransient: false })).toBe("high");
  });

  it("returns 'high' for non-transient unknown errors", () => {
    expect(getErrorPriority({ type: "unknown", isTransient: false })).toBe("high");
  });
});

describe("useErrors — onError path", () => {
  let capturedOnError: (error: AppError) => void;

  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      value: { errors: {} },
      writable: true,
      configurable: true,
    });

    onErrorMock.mockImplementation((cb: (error: AppError) => void) => {
      capturedOnError = cb;
      return vi.fn();
    });
    getPendingMock.mockResolvedValue([]);
    notifyMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls notify with 'high' priority for non-transient process error", async () => {
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "process", isTransient: false });
    act(() => capturedOnError(error));

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "high" }));
    unmount();
  });

  it("calls notify with 'low' priority for transient error", async () => {
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "network", isTransient: true });
    act(() => capturedOnError(error));

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "low" }));
    unmount();
  });
});

describe("useErrors — getPending path", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      value: { errors: {} },
      writable: true,
      configurable: true,
    });

    onErrorMock.mockImplementation(() => vi.fn());
    notifyMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls notify with 'high' priority for pending non-transient errors", async () => {
    const pendingError = makeError({
      type: "config",
      isTransient: false,
      fromPreviousSession: true,
    });
    getPendingMock.mockResolvedValue([pendingError]);

    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    await act(async () => {
      await vi.waitFor(() => {
        expect(notifyMock).toHaveBeenCalled();
      });
    });

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "high" }));
    unmount();
  });

  it("calls notify with 'low' priority for pending transient errors", async () => {
    const pendingError = makeError({
      type: "git",
      isTransient: true,
      fromPreviousSession: true,
    });
    getPendingMock.mockResolvedValue([pendingError]);

    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    await act(async () => {
      await vi.waitFor(() => {
        expect(notifyMock).toHaveBeenCalled();
      });
    });

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "low" }));
    unmount();
  });
});
