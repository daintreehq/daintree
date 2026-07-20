// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClientAppError } from "@/utils/clientAppError";
import { useDiffFileSource } from "../useDiffFileSource";

const { readMock } = vi.hoisted(() => ({
  readMock: vi.fn<(payload: { path: string; rootPath: string }) => Promise<{ content: string }>>(),
}));

vi.mock("@/clients/filesClient", () => ({
  filesClient: { read: readMock },
}));

const SUBJECT = { worktreePath: "/repo", filePath: "src/a.ts" };

beforeEach(() => {
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "file contents" });
});

describe("useDiffFileSource", () => {
  it("reads nothing until the scope is enabled", () => {
    renderHook(() => useDiffFileSource(SUBJECT, false));
    expect(readMock).not.toHaveBeenCalled();
  });

  it("reads the file against its worktree root once enabled", async () => {
    const { result } = renderHook(() => useDiffFileSource(SUBJECT, true));

    await waitFor(() => expect(result.current.source).toBe("file contents"));
    expect(readMock).toHaveBeenCalledWith({ path: "src/a.ts", rootPath: "/repo" });
  });

  it("starts reading when the scope is turned on mid-session", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useDiffFileSource(SUBJECT, enabled),
      { initialProps: { enabled: false } }
    );
    expect(readMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.source).toBe("file contents"));
  });

  it("surfaces a read failure as its error code and no content", async () => {
    readMock.mockRejectedValue(new ClientAppError("FILE_TOO_LARGE", "too big"));
    const { result } = renderHook(() => useDiffFileSource(SUBJECT, true));

    await waitFor(() => expect(result.current.errorCode).toBe("FILE_TOO_LARGE"));
    expect(result.current.source).toBeUndefined();
  });

  it("maps an error that isn't an AppError to a safe code", async () => {
    readMock.mockRejectedValue(new Error("socket hangup"));
    const { result } = renderHook(() => useDiffFileSource(SUBJECT, true));

    await waitFor(() => expect(result.current.errorCode).not.toBeNull());
    expect(result.current.source).toBeUndefined();
  });

  it("drops a read that resolves after the file changed", async () => {
    // The first file's read is still in flight when the hook is repointed; its
    // content must never surface under the second file.
    let resolveFirst: ((value: { content: string }) => void) | undefined;
    readMock.mockImplementationOnce(
      () =>
        new Promise<{ content: string }>((resolve) => {
          resolveFirst = resolve;
        })
    );
    readMock.mockResolvedValueOnce({ content: "second file" });

    const { result, rerender } = renderHook(
      ({ filePath }: { filePath: string }) =>
        useDiffFileSource({ worktreePath: "/repo", filePath }, true),
      { initialProps: { filePath: "first.ts" } }
    );

    rerender({ filePath: "second.ts" });
    await waitFor(() => expect(result.current.source).toBe("second file"));

    await act(async () => {
      resolveFirst?.({ content: "first file" });
    });

    expect(result.current.source).toBe("second file");
  });

  it("drops an error that arrives after the file changed", async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    readMock.mockImplementationOnce(
      () =>
        new Promise<{ content: string }>((_resolve, reject) => {
          rejectFirst = reject;
        })
    );
    readMock.mockResolvedValueOnce({ content: "second file" });

    const { result, rerender } = renderHook(
      ({ filePath }: { filePath: string }) =>
        useDiffFileSource({ worktreePath: "/repo", filePath }, true),
      { initialProps: { filePath: "first.ts" } }
    );

    rerender({ filePath: "second.ts" });
    await waitFor(() => expect(result.current.source).toBe("second file"));

    await act(async () => {
      rejectFirst?.(new ClientAppError("NOT_FOUND", "gone"));
    });

    expect(result.current.errorCode).toBeNull();
    expect(result.current.source).toBe("second file");
  });

  it("re-reads on retry so a transient failure can recover", async () => {
    readMock.mockRejectedValueOnce(new ClientAppError("NOT_FOUND", "gone"));
    const { result } = renderHook(() => useDiffFileSource(SUBJECT, true));
    await waitFor(() => expect(result.current.errorCode).toBe("NOT_FOUND"));

    await act(async () => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.source).toBe("file contents"));
    expect(result.current.errorCode).toBeNull();
  });

  it("reports nothing for a null subject", () => {
    const { result } = renderHook(() => useDiffFileSource(null, true));
    expect(result.current.source).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(readMock).not.toHaveBeenCalled();
  });
});
