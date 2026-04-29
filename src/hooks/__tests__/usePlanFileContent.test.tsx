// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePlanFileContent } from "../usePlanFileContent";

vi.mock("@/clients/filesClient", () => ({
  filesClient: {
    read: vi.fn(),
  },
}));

import { filesClient } from "@/clients/filesClient";

const mockRead = filesClient.read as ReturnType<typeof vi.fn>;

describe("usePlanFileContent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRead.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns idle status when isOpen is false", () => {
    const { result } = renderHook(() => usePlanFileContent(false, "TODO.md", "/project", 2000));
    expect(result.current.status).toBe("idle");
    expect(result.current.content).toBeNull();
  });

  it("returns idle status when filePath is undefined", () => {
    const { result } = renderHook(() => usePlanFileContent(true, undefined, "/project", 2000));
    expect(result.current.status).toBe("idle");
  });

  it("reads file immediately on open and transitions to loaded", async () => {
    mockRead.mockResolvedValue({ content: "# Plan\n- item 1" });

    const { result } = renderHook(() => usePlanFileContent(true, "TODO.md", "/project", 2000));

    expect(result.current.status).toBe("loading");

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status).toBe("loaded");
    expect(result.current.content).toBe("# Plan\n- item 1");
    expect(mockRead).toHaveBeenCalledWith({ path: "/project/TODO.md", rootPath: "/project" });
  });

  it("polls content at the given interval", async () => {
    mockRead.mockResolvedValueOnce({ content: "v1" }).mockResolvedValueOnce({ content: "v2" });

    const { result } = renderHook(() => usePlanFileContent(true, "PLAN.md", "/project", 2000));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.content).toBe("v1");

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(result.current.content).toBe("v2");
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  it("transitions to error state on read failure", async () => {
    mockRead.mockRejectedValue(
      Object.assign(new Error("File not found"), { name: "AppError", code: "NOT_FOUND" })
    );

    const { result } = renderHook(() => usePlanFileContent(true, "TODO.md", "/project", 2000));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorCode).toBe("NOT_FOUND");
    expect(result.current.content).toBeNull();
  });

  it("clears content and resets to idle when isOpen becomes false", async () => {
    mockRead.mockResolvedValue({ content: "# Plan" });

    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean }) => usePlanFileContent(isOpen, "TODO.md", "/project", 2000),
      { initialProps: { isOpen: true } }
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("loaded");

    rerender({ isOpen: false });
    expect(result.current.status).toBe("idle");
    expect(result.current.content).toBeNull();
  });

  it("transitions to error when a later poll returns NOT_FOUND (plan file deleted)", async () => {
    mockRead
      .mockResolvedValueOnce({ content: "# Plan" })
      .mockRejectedValueOnce(
        Object.assign(new Error("File not found"), { name: "AppError", code: "NOT_FOUND" })
      );

    const { result } = renderHook(() => usePlanFileContent(true, "TODO.md", "/project", 2000));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("loaded");

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorCode).toBe("NOT_FOUND");
    expect(result.current.content).toBeNull();
  });

  it("stops polling after interval is cleared on unmount", async () => {
    mockRead.mockResolvedValue({ content: "content" });

    const { unmount } = renderHook(() => usePlanFileContent(true, "TODO.md", "/project", 2000));

    await act(async () => {
      await Promise.resolve();
    });
    const callCountAfterMount = mockRead.mock.calls.length;

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });

    expect(mockRead.mock.calls.length).toBe(callCountAfterMount);
  });

  it("uses absolute path directly when filePath is already absolute", async () => {
    mockRead.mockResolvedValue({ content: "content" });

    renderHook(() => usePlanFileContent(true, "/absolute/path/TODO.md", "/project", 2000));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRead).toHaveBeenCalledWith({
      path: "/absolute/path/TODO.md",
      rootPath: "/project",
    });
  });
});
