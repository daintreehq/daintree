import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiffMediaFileVersionsResponse,
  DiffMediaReadFileVersionsPayload,
  DiffMediaWireSide,
} from "@shared/types";

const mockRead =
  vi.fn<(payload: DiffMediaReadFileVersionsPayload) => Promise<DiffMediaFileVersionsResponse>>();

const typedGlobal = globalThis as unknown as Record<string, unknown>;

function loaded(tag: string, version: string | undefined, length = 16): DiffMediaWireSide {
  return {
    ok: true,
    dataUrl: `data:image/png;base64,${tag}`.padEnd(length, "A"),
    byteSize: length,
    ...(version !== undefined ? { version } : {}),
  };
}

function unchanged(version: string): DiffMediaWireSide {
  return { ok: true, unchanged: true, version };
}

describe("diffMediaClient.readFileVersions caching", () => {
  let client: typeof import("../diffMediaClient");

  beforeEach(async () => {
    vi.resetModules();
    mockRead.mockReset();
    typedGlobal.window = { electron: { diffMedia: { readFileVersions: mockRead } } };
    client = await import("../diffMediaClient");
    client.resetDiffMediaCacheForTests();
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  const payload = { cwd: "/repo", filePath: "img.png" };

  it("sends no known versions on a first visit", async () => {
    mockRead.mockResolvedValue({ head: loaded("h", "h1"), working: loaded("w", "w1") });

    await client.diffMediaClient.readFileVersions(payload);

    expect(mockRead).toHaveBeenCalledWith(payload);
  });

  it("revalidates a revisit and reuses the held data URLs for unchanged sides", async () => {
    const head = loaded("h", "h1");
    const working = loaded("w", "w1");
    mockRead.mockResolvedValueOnce({ head, working });
    const first = await client.diffMediaClient.readFileVersions(payload);

    mockRead.mockResolvedValueOnce({ head: unchanged("h1"), working: unchanged("w1") });
    const second = await client.diffMediaClient.readFileVersions(payload);

    expect(mockRead).toHaveBeenLastCalledWith({
      ...payload,
      known: { head: "h1", working: "w1" },
    });
    expect(second).toEqual(first);
    expect(second.head).toBe(first.head);
  });

  it("replaces a side that changed and keeps the one that didn't", async () => {
    mockRead.mockResolvedValueOnce({ head: loaded("h", "h1"), working: loaded("w", "w1") });
    const first = await client.diffMediaClient.readFileVersions(payload);

    const edited = loaded("w2", "w2");
    mockRead.mockResolvedValueOnce({ head: unchanged("h1"), working: edited });
    const second = await client.diffMediaClient.readFileVersions(payload);
    expect(second.head).toBe(first.head);
    expect(second.working).toEqual(edited);

    mockRead.mockResolvedValueOnce({ head: unchanged("h1"), working: unchanged("w2") });
    await client.diffMediaClient.readFileVersions(payload);
    expect(mockRead).toHaveBeenLastCalledWith({
      ...payload,
      known: { head: "h1", working: "w2" },
    });
  });

  it("forgets a side that turned into an error", async () => {
    mockRead.mockResolvedValueOnce({ head: loaded("h", "h1"), working: loaded("w", "w1") });
    await client.diffMediaClient.readFileVersions(payload);

    mockRead.mockResolvedValueOnce({
      head: unchanged("h1"),
      working: { ok: false, error: "NOT_FOUND" },
    });
    const second = await client.diffMediaClient.readFileVersions(payload);
    expect(second.working).toEqual({ ok: false, error: "NOT_FOUND" });

    mockRead.mockResolvedValueOnce({ head: unchanged("h1"), working: loaded("w", "w3") });
    await client.diffMediaClient.readFileVersions(payload);
    expect(mockRead).toHaveBeenLastCalledWith({ ...payload, known: { head: "h1" } });
  });

  it("revalidates only the working side when HEAD had no version", async () => {
    const working = loaded("w", "w1");
    mockRead.mockResolvedValueOnce({ head: { ok: false, error: "NOT_FOUND" }, working });
    await client.diffMediaClient.readFileVersions(payload);

    mockRead.mockResolvedValueOnce({
      head: { ok: false, error: "NOT_FOUND" },
      working: unchanged("w1"),
    });
    const second = await client.diffMediaClient.readFileVersions(payload);

    expect(mockRead).toHaveBeenLastCalledWith({ ...payload, known: { working: "w1" } });
    expect(second.working).toBe(working);
  });

  it("doesn't cache sides that came back without a version", async () => {
    mockRead.mockResolvedValue({ head: loaded("h", undefined), working: loaded("w", undefined) });

    await client.diffMediaClient.readFileVersions(payload);
    await client.diffMediaClient.readFileVersions(payload);

    expect(mockRead).toHaveBeenLastCalledWith(payload);
    expect(client.getDiffMediaCacheBytesForTests()).toBe(0);
  });

  it("keys entries by worktree as well as path", async () => {
    mockRead.mockResolvedValue({ head: loaded("h", "h1"), working: loaded("w", "w1") });
    await client.diffMediaClient.readFileVersions(payload);

    await client.diffMediaClient.readFileVersions({ cwd: "/other", filePath: "img.png" });

    expect(mockRead).toHaveBeenLastCalledWith({ cwd: "/other", filePath: "img.png" });
  });

  it("rejects an unchanged reply for a version it doesn't hold", async () => {
    mockRead.mockResolvedValueOnce({ head: loaded("h", "h1"), working: loaded("w", "w1") });
    await client.diffMediaClient.readFileVersions(payload);

    mockRead.mockResolvedValueOnce({ head: unchanged("h-other"), working: unchanged("w1") });
    await expect(client.diffMediaClient.readFileVersions(payload)).rejects.toThrow(/not held/);
  });

  it("propagates a transport rejection and keeps the held entry", async () => {
    mockRead.mockResolvedValueOnce({ head: loaded("h", "h1"), working: loaded("w", "w1") });
    await client.diffMediaClient.readFileVersions(payload);

    mockRead.mockRejectedValueOnce(Object.assign(new Error("slow down"), { code: "RATE_LIMITED" }));
    await expect(client.diffMediaClient.readFileVersions(payload)).rejects.toThrow("slow down");

    mockRead.mockResolvedValueOnce({ head: unchanged("h1"), working: unchanged("w1") });
    await client.diffMediaClient.readFileVersions(payload);
    expect(mockRead).toHaveBeenLastCalledWith({
      ...payload,
      known: { head: "h1", working: "w1" },
    });
  });

  it("evicts least recently used entries past the byte cap", async () => {
    const side = 12 * 1024 * 1024;
    const readFor = (filePath: string) =>
      client.diffMediaClient.readFileVersions({ cwd: "/repo", filePath });
    mockRead.mockImplementation(async ({ filePath, known }) =>
      known
        ? { head: unchanged(`h-${filePath}`), working: unchanged(`w-${filePath}`) }
        : {
            head: loaded(filePath, `h-${filePath}`, side),
            working: loaded(filePath, `w-${filePath}`, side),
          }
    );

    // 24 MB per file against a 64 MB cap: a, b, then touch a, then c evicts b.
    await readFor("a.png");
    await readFor("b.png");
    await readFor("a.png");
    await readFor("c.png");
    expect(client.getDiffMediaCacheBytesForTests()).toBeLessThanOrEqual(64 * 1024 * 1024);

    mockRead.mockClear();
    await readFor("a.png");
    await readFor("b.png");
    expect(mockRead.mock.calls[0]?.[0].known).toBeDefined();
    expect(mockRead.mock.calls[1]?.[0].known).toBeUndefined();
  });

  it("never caches an entry larger than the whole cap", async () => {
    const huge = 40 * 1024 * 1024;
    mockRead.mockResolvedValue({ head: loaded("h", "h1", huge), working: loaded("w", "w1", huge) });

    await client.diffMediaClient.readFileVersions(payload);

    expect(client.getDiffMediaCacheBytesForTests()).toBe(0);
  });
});
