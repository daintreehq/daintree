import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSearch =
  vi.fn<
    (payload: { cwd: string; query: string; limit?: number }) => Promise<{ files: string[] }>
  >();

const typedGlobal = globalThis as unknown as Record<string, unknown>;

describe("filesClient.search caching", () => {
  let filesClient: typeof import("../filesClient").filesClient;
  let resetSearchCacheForTests: typeof import("../filesClient").resetSearchCacheForTests;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mockSearch.mockReset();
    mockSearch.mockResolvedValue({ files: ["a.ts", "b.ts"] });

    typedGlobal.window = {
      electron: {
        files: { search: mockSearch, read: vi.fn() },
      },
    };

    const mod = await import("../filesClient");
    filesClient = mod.filesClient;
    resetSearchCacheForTests = mod.resetSearchCacheForTests;
    resetSearchCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete typedGlobal.window;
  });

  it("returns cached result for identical query within TTL", async () => {
    const payload = { cwd: "/project", query: "index", limit: 50 };

    const r1 = await filesClient.search(payload);
    const r2 = await filesClient.search(payload);

    expect(r1).toEqual({ files: ["a.ts", "b.ts"] });
    expect(r2).toEqual({ files: ["a.ts", "b.ts"] });
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const payload = { cwd: "/project", query: "index", limit: 50 };

    await filesClient.search(payload);
    expect(mockSearch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_001);

    mockSearch.mockResolvedValueOnce({ files: ["c.ts"] });
    const r2 = await filesClient.search(payload);

    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(r2).toEqual({ files: ["c.ts"] });
  });

  it("uses separate cache entries for different cwd", async () => {
    await filesClient.search({ cwd: "/a", query: "q" });
    await filesClient.search({ cwd: "/b", query: "q" });

    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  it("uses separate cache entries for different limit values", async () => {
    await filesClient.search({ cwd: "/a", query: "q", limit: 10 });
    await filesClient.search({ cwd: "/a", query: "q", limit: 50 });

    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  it("treats undefined limit differently from explicit limit", async () => {
    await filesClient.search({ cwd: "/a", query: "q" });
    await filesClient.search({ cwd: "/a", query: "q", limit: 50 });

    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry when cache exceeds max size", async () => {
    // Fill cache with 50 entries (q0..q49)
    for (let i = 0; i < 50; i++) {
      mockSearch.mockResolvedValueOnce({ files: [`file-${i}.ts`] });
      await filesClient.search({ cwd: "/project", query: `q${i}` });
    }
    expect(mockSearch).toHaveBeenCalledTimes(50);

    // Adding q50 should evict q0 (oldest)
    mockSearch.mockResolvedValueOnce({ files: ["new.ts"] });
    await filesClient.search({ cwd: "/project", query: "q50" });
    expect(mockSearch).toHaveBeenCalledTimes(51);

    // q0 was evicted — re-fetch triggers IPC
    mockSearch.mockResolvedValueOnce({ files: ["refetched.ts"] });
    await filesClient.search({ cwd: "/project", query: "q0" });
    expect(mockSearch).toHaveBeenCalledTimes(52);

    // q49 (most recently inserted before q50) should still be cached
    await filesClient.search({ cwd: "/project", query: "q49" });
    expect(mockSearch).toHaveBeenCalledTimes(52);
  });

  it("promotes accessed entries so they survive LRU eviction", async () => {
    // Fill cache with 50 entries
    for (let i = 0; i < 50; i++) {
      mockSearch.mockResolvedValueOnce({ files: [`file-${i}.ts`] });
      await filesClient.search({ cwd: "/project", query: `q${i}` });
    }

    // Access q0 to promote it (should become most recently used)
    await filesClient.search({ cwd: "/project", query: "q0" });
    expect(mockSearch).toHaveBeenCalledTimes(50); // still cached

    // Add new entry — should evict q1 (now oldest) instead of q0
    mockSearch.mockResolvedValueOnce({ files: ["new.ts"] });
    await filesClient.search({ cwd: "/project", query: "q50" });

    // q0 should still be cached (was promoted)
    await filesClient.search({ cwd: "/project", query: "q0" });
    expect(mockSearch).toHaveBeenCalledTimes(51); // only the q50 call

    // q1 should be evicted
    mockSearch.mockResolvedValueOnce({ files: ["refetched.ts"] });
    await filesClient.search({ cwd: "/project", query: "q1" });
    expect(mockSearch).toHaveBeenCalledTimes(52);
  });

  it("does not cache rejected results", async () => {
    mockSearch.mockRejectedValueOnce(new Error("IPC failed"));

    await expect(filesClient.search({ cwd: "/a", query: "q" })).rejects.toThrow("IPC failed");

    mockSearch.mockResolvedValueOnce({ files: ["recovered.ts"] });
    const result = await filesClient.search({ cwd: "/a", query: "q" });

    expect(result).toEqual({ files: ["recovered.ts"] });
    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  it("replaces stale entry with fresh data after TTL expiry", async () => {
    mockSearch.mockResolvedValueOnce({ files: ["old.ts"] });
    const r1 = await filesClient.search({ cwd: "/a", query: "q" });
    expect(r1).toEqual({ files: ["old.ts"] });

    vi.advanceTimersByTime(5_001);

    mockSearch.mockResolvedValueOnce({ files: ["fresh.ts"] });
    const r2 = await filesClient.search({ cwd: "/a", query: "q" });
    expect(r2).toEqual({ files: ["fresh.ts"] });

    // Third call within TTL should return the fresh cached value
    const r3 = await filesClient.search({ cwd: "/a", query: "q" });
    expect(r3).toEqual({ files: ["fresh.ts"] });
    expect(mockSearch).toHaveBeenCalledTimes(2);
  });
});
