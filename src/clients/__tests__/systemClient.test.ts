import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let systemClient: typeof import("../systemClient").systemClient;

let getTmpDirMock: ReturnType<typeof vi.fn>;

describe("systemClient.getTmpDir", () => {
  beforeEach(async () => {
    vi.resetModules();

    getTmpDirMock = vi.fn();

    typedGlobal.window = {
      electron: {
        system: {
          getTmpDir: getTmpDirMock,
        },
      },
    };

    const mod = await import("../systemClient");
    systemClient = mod.systemClient;
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("coalesces concurrent calls into a single IPC call", async () => {
    let resolve!: (v: string) => void;
    const deferred = new Promise<string>((r) => {
      resolve = r;
    });
    getTmpDirMock.mockReturnValue(deferred);

    const p1 = systemClient.getTmpDir();
    const p2 = systemClient.getTmpDir();

    expect(getTmpDirMock).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);

    resolve("/tmp");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("/tmp");
    expect(r2).toBe("/tmp");
  });

  it("returns the cached value on subsequent calls after resolution", async () => {
    getTmpDirMock.mockResolvedValue("/tmp");

    const r1 = await systemClient.getTmpDir();
    const r2 = await systemClient.getTmpDir();
    const r3 = await systemClient.getTmpDir();

    expect(getTmpDirMock).toHaveBeenCalledTimes(1);
    expect(r1).toBe("/tmp");
    expect(r2).toBe("/tmp");
    expect(r3).toBe("/tmp");
  });

  it("does not poison the cache on IPC rejection", async () => {
    getTmpDirMock.mockRejectedValueOnce(new Error("IPC error"));

    await expect(systemClient.getTmpDir()).rejects.toThrow("IPC error");

    getTmpDirMock.mockResolvedValue("/tmp");
    const result = await systemClient.getTmpDir();
    expect(getTmpDirMock).toHaveBeenCalledTimes(2);
    expect(result).toBe("/tmp");
  });
});
