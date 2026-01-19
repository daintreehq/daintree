import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { access } from "fs/promises";
import { waitForPathExists } from "../fs.js";

vi.mock("fs/promises", () => ({
  access: vi.fn(),
}));

describe("waitForPathExists", () => {
  const mockAccess = vi.mocked(access);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should resolve immediately if path exists", async () => {
    mockAccess.mockResolvedValueOnce(undefined);

    const promise = waitForPathExists("/test/path");

    // We expect it to resolve without time advancement because it's immediate
    await expect(promise).resolves.toBeUndefined();

    expect(mockAccess).toHaveBeenCalledTimes(1);
    expect(mockAccess).toHaveBeenCalledWith("/test/path");
  });

  it("should retry with exponential backoff until path exists", async () => {
    mockAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce(undefined);

    const promise = waitForPathExists("/test/path", {
      initialRetryDelayMs: 50,
      backoffMultiplier: 2,
      timeoutMs: 5000,
    });

    // It should check immediately (0ms elapsed) and fail.
    // Then sleep(50).

    // We advance time to trigger the first retry.
    await vi.advanceTimersByTimeAsync(50);
    // Now it should have checked again (2nd call). And failed.
    // Next delay: 50 * 2 = 100.
    // sleeps 100.

    await vi.advanceTimersByTimeAsync(100);
    // Now it should have checked again (3rd call). And succeeded.

    await expect(promise).resolves.toBeUndefined();
    expect(mockAccess).toHaveBeenCalledTimes(3);
  });

  it("should respect maxRetryDelayMs cap", async () => {
    mockAccess.mockReset();
    mockAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce(undefined);

    const promise = waitForPathExists("/test/path", {
      initialRetryDelayMs: 50,
      backoffMultiplier: 2,
      maxRetryDelayMs: 120,
      timeoutMs: 5000,
    });

    // 1st call: fails. sleep 50.
    await vi.advanceTimersByTimeAsync(50);
    // 2nd call: fails. next=100. sleep 100.

    await vi.advanceTimersByTimeAsync(100);
    // 3rd call: fails. next=200. cap=120. sleep 120.

    await vi.advanceTimersByTimeAsync(120);
    // 4th call: succeeds.

    await expect(promise).resolves.toBeUndefined();
    expect(mockAccess).toHaveBeenCalledTimes(4);
  });

  it("should timeout if path never appears", async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const promise = waitForPathExists("/test/path", {
      initialRetryDelayMs: 100,
      backoffMultiplier: 2,
      timeoutMs: 500,
    });

    // Advance past timeout
    const advance = vi.advanceTimersByTimeAsync(600);
    await expect(promise).rejects.toThrow(/Timeout waiting for path to exist/);
    await advance;
  });

  it("should use default options when none provided", async () => {
    mockAccess.mockResolvedValueOnce(undefined);

    const promise = waitForPathExists("/test/path");
    await expect(promise).resolves.toBeUndefined();
  });

  it("should respect initialDelayMs", async () => {
    mockAccess.mockResolvedValueOnce(undefined);

    const promise = waitForPathExists("/test/path", {
      initialDelayMs: 100,
      timeoutMs: 5000,
    });

    // Should NOT have called access yet (sleeping 100ms)
    expect(mockAccess).toHaveBeenCalledTimes(0);

    // Advance time
    await vi.advanceTimersByTimeAsync(100);

    // Should call access now
    await expect(promise).resolves.toBeUndefined();
    expect(mockAccess).toHaveBeenCalledTimes(1);
  });

  it("should not exceed timeout even with long retry delays", async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const promise = waitForPathExists("/test/path", {
      initialRetryDelayMs: 200,
      backoffMultiplier: 2,
      maxRetryDelayMs: 1000,
      timeoutMs: 500,
    });

    // 1st call fails. Sleep 200.
    await vi.advanceTimersByTimeAsync(200); // 2nd call

    // 2nd fails. next=400. Sleep 400?
    // remaining = 500 - 200 = 300.
    // actualDelay = min(400, 300) = 300.

    await vi.advanceTimersByTimeAsync(200); // Only 200 elapsed. Total 400.
    // Still sleeping (need 100 more).

    expect(mockAccess).toHaveBeenCalledTimes(2);

    const advance = vi.advanceTimersByTimeAsync(100); // Total 500. Sleep done?
    // It wakes up. Check checkExists? No.
    // Logic:
    // await sleep(actualDelay);
    // loop continues.
    // elapsed = 500.
    // if (elapsed >= timeoutMs) throw.

    await expect(promise).rejects.toThrow(/Timeout waiting for path to exist/);
    await advance;
  });

  it("should clean up pending timers on success", async () => {
    mockAccess
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce(undefined);

    const promise = waitForPathExists("/test/path", {
      initialRetryDelayMs: 50,
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBeUndefined();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("should handle path with spaces and special characters", async () => {
    const specialPath = "/test/path with spaces/special-chars_123";
    mockAccess.mockResolvedValueOnce(undefined);

    await expect(waitForPathExists(specialPath)).resolves.toBeUndefined();
    expect(mockAccess).toHaveBeenCalledWith(specialPath);
  });

  it("should fail fast on permission errors (EACCES, EPERM)", async () => {
    const eaccesError = Object.assign(new Error("Permission denied"), {
      code: "EACCES",
    });
    mockAccess.mockRejectedValueOnce(eaccesError);

    const promise = waitForPathExists("/test/path", {
      initialRetryDelayMs: 50,
      timeoutMs: 5000,
    });

    await expect(promise).rejects.toThrow(/Cannot access path/);
    expect(mockAccess).toHaveBeenCalledTimes(1);
  });

  it("should fail fast on ENOTDIR errors", async () => {
    const enotdirError = Object.assign(new Error("Not a directory"), {
      code: "ENOTDIR",
    });
    mockAccess.mockRejectedValueOnce(enotdirError);

    const promise = waitForPathExists("/test/path/file", {
      initialRetryDelayMs: 50,
      timeoutMs: 5000,
    });

    await expect(promise).rejects.toThrow(/Cannot access path/);
    expect(mockAccess).toHaveBeenCalledTimes(1);
  });

  it("should retry only on ENOENT errors", async () => {
    const enoentError = Object.assign(new Error("No such file or directory"), {
      code: "ENOENT",
    });
    mockAccess
      .mockRejectedValueOnce(enoentError)
      .mockRejectedValueOnce(enoentError)
      .mockResolvedValueOnce(undefined);

    const promise = waitForPathExists("/test/path", {
      initialRetryDelayMs: 50,
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(150);
    await expect(promise).resolves.toBeUndefined();
    expect(mockAccess).toHaveBeenCalledTimes(3);
  });

  it("should timeout immediately when initialDelayMs >= timeoutMs", async () => {
    mockAccess.mockResolvedValue(undefined);

    const promise = waitForPathExists("/test/path", {
      initialDelayMs: 1000,
      timeoutMs: 500,
    });

    const advance = vi.advanceTimersByTimeAsync(1000);
    await expect(promise).rejects.toThrow(/Timeout waiting for path to exist/);
    expect(mockAccess).toHaveBeenCalledTimes(0);
    await advance;
  });

  it("should timeout immediately when timeoutMs is 0", async () => {
    mockAccess.mockResolvedValue(undefined);

    const promise = waitForPathExists("/test/path", {
      timeoutMs: 0,
    });

    await expect(promise).rejects.toThrow(/Timeout waiting for path to exist/);
  });
});
