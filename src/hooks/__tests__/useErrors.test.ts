// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ErrorRecord } from "@/store";

const { onErrorMock, getPendingMock, notifyMock, shouldEscalateMock, consumeEscalationMock } =
  vi.hoisted(() => ({
    onErrorMock: vi.fn(),
    getPendingMock: vi.fn(),
    notifyMock: vi.fn().mockReturnValue(""),
    shouldEscalateMock: vi.fn().mockReturnValue(false),
    consumeEscalationMock: vi.fn(),
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

vi.mock("@/lib/notify", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    notify: notifyMock,
    shouldEscalateTransientError: shouldEscalateMock,
    consumeEscalation: consumeEscalationMock,
  };
});

function makeError(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
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
  let capturedOnError: (error: ErrorRecord) => void;

  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      value: { errors: {} },
      writable: true,
      configurable: true,
    });

    onErrorMock.mockImplementation((cb: (error: ErrorRecord) => void) => {
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

describe("useErrors — escalation of persistent transient errors", () => {
  let capturedOnError: (error: ErrorRecord) => void;

  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      value: { errors: {} },
      writable: true,
      configurable: true,
    });

    onErrorMock.mockImplementation((cb: (error: ErrorRecord) => void) => {
      capturedOnError = cb;
      return vi.fn();
    });
    getPendingMock.mockResolvedValue([]);
    notifyMock.mockClear();
    notifyMock.mockReturnValue("toast-id");
    shouldEscalateMock.mockReset();
    shouldEscalateMock.mockReturnValue(false);
    consumeEscalationMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("promotes priority to 'high' when escalation is triggered", async () => {
    shouldEscalateMock.mockReturnValue(true);
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "network", isTransient: true });
    act(() => capturedOnError(error));

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "high" }));
    unmount();
  });

  it("keeps 'low' priority when escalation is not triggered", async () => {
    shouldEscalateMock.mockReturnValue(false);
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "network", isTransient: true });
    act(() => capturedOnError(error));

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ priority: "low" }));
    unmount();
  });

  it("calls shouldEscalateTransientError before addError (dedup safety)", async () => {
    const callOrder: string[] = [];
    shouldEscalateMock.mockImplementation(() => {
      callOrder.push("escalate");
      return false;
    });
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "filesystem", isTransient: true });
    act(() => capturedOnError(error));

    expect(callOrder[0]).toBe("escalate");
    expect(notifyMock).toHaveBeenCalled();
    unmount();
  });

  it("consumes escalation only when toast was shown", async () => {
    shouldEscalateMock.mockReturnValue(true);
    notifyMock.mockReturnValue("toast-1");
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "network", isTransient: true });
    act(() => capturedOnError(error));

    expect(consumeEscalationMock).toHaveBeenCalled();
    unmount();
  });

  it("does not consume escalation when toast is suppressed (blurred/quiet/disabled)", async () => {
    shouldEscalateMock.mockReturnValue(true);
    notifyMock.mockReturnValue("");
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "network", isTransient: true });
    act(() => capturedOnError(error));

    expect(consumeEscalationMock).not.toHaveBeenCalled();
    unmount();
  });
});

describe("useErrors — humanized toast payload", () => {
  let capturedOnError: (error: ErrorRecord) => void;

  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      value: { errors: {} },
      writable: true,
      configurable: true,
    });

    onErrorMock.mockImplementation((cb: (error: ErrorRecord) => void) => {
      capturedOnError = cb;
      return vi.fn();
    });
    getPendingMock.mockResolvedValue([]);
    notifyMock.mockClear();
    notifyMock.mockReturnValue("toast-id");
    shouldEscalateMock.mockReset();
    shouldEscalateMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not pass raw error.source as the toast title", async () => {
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({
      type: "filesystem",
      source: "WorktreeMonitor",
      message: "EBUSY: resource busy or locked",
      isTransient: false,
    });
    act(() => capturedOnError(error));

    const payload = notifyMock.mock.calls.at(-1)?.[0] ?? {};
    expect(payload.title).not.toContain("WorktreeMonitor");
    expect(payload.title).toBe("File operation failed");
    unmount();
  });

  it("does not pass raw error.message as the toast body", async () => {
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({
      type: "filesystem",
      source: "WorktreeMonitor",
      message: "EBUSY: resource busy or locked /Users/me/proj",
      isTransient: false,
    });
    act(() => capturedOnError(error));

    const payload = notifyMock.mock.calls.at(-1)?.[0] ?? {};
    expect(payload.message).not.toContain("EBUSY");
    expect(payload.message).not.toContain("/Users/me/proj");
    unmount();
  });

  it("uses gitReason-specific copy when present", async () => {
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({
      type: "git",
      gitReason: "auth-failed",
      message: "fatal: Authentication failed for 'https://...'",
      isTransient: false,
    });
    act(() => capturedOnError(error));

    const payload = notifyMock.mock.calls.at(-1)?.[0] ?? {};
    expect(payload.title).toBe("Git authentication failed");
    expect(payload.message).toBe("Check your Git credentials or SSH key configuration.");
    unmount();
  });

  it("attaches a 'Copy details' action for high-priority errors", async () => {
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "process", isTransient: false });
    act(() => capturedOnError(error));

    const payload = notifyMock.mock.calls.at(-1)?.[0] ?? {};
    expect(payload.action).toBeDefined();
    expect(payload.action.label).toBe("Copy details");
    unmount();
  });

  it("omits the 'Copy details' action for low-priority errors", async () => {
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "network", isTransient: true });
    act(() => capturedOnError(error));

    const payload = notifyMock.mock.calls.at(-1)?.[0] ?? {};
    expect(payload.action).toBeUndefined();
    unmount();
  });

  it("Copy details action writes the raw payload to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({
      type: "filesystem",
      source: "WorktreeMonitor",
      message: "EBUSY: resource busy",
      details: "stack trace goes here",
      correlationId: "corr-1",
      context: { worktreeId: "wt-42", filePath: "/tmp/proj/src/foo.ts" },
      isTransient: false,
    });
    act(() => capturedOnError(error));

    const payload = notifyMock.mock.calls.at(-1)?.[0] ?? {};
    payload.action.onClick();

    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0]?.[0] ?? "";
    expect(written).toContain("WorktreeMonitor");
    expect(written).toContain("EBUSY: resource busy");
    expect(written).toContain("corr-1");
    expect(written).toContain("wt-42");
    expect(written).toContain("/tmp/proj/src/foo.ts");
    unmount();
  });

  it("does not leak token-bearing or path-bearing raw messages into title or body", async () => {
    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({
      type: "git",
      gitReason: "auth-failed",
      source: "GitHubService",
      message: "fatal: Authentication failed for 'https://ghp_secrettoken@github.com/org/repo'",
      isTransient: false,
    });
    act(() => capturedOnError(error));

    const payload = notifyMock.mock.calls.at(-1)?.[0] ?? {};
    expect(payload.title).not.toContain("ghp_secrettoken");
    expect(payload.title).not.toContain("github.com");
    expect(payload.title).not.toContain("fatal:");
    expect(payload.message).not.toContain("ghp_secrettoken");
    expect(payload.message).not.toContain("github.com");
    expect(payload.message).not.toContain("fatal:");
    unmount();
  });

  it("clipboard rejection does not throw out of the action handler", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard blocked"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const { useErrors } = await import("../useErrors");
    const { unmount } = renderHook(() => useErrors());

    const error = makeError({ type: "process", isTransient: false });
    act(() => capturedOnError(error));

    const payload = notifyMock.mock.calls.at(-1)?.[0] ?? {};
    expect(() => payload.action.onClick()).not.toThrow();
    unmount();
  });
});
