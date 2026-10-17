import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let globalEnvClient: typeof import("../globalEnvClient").globalEnvClient;
let invalidateGlobalEnvCache: typeof import("../globalEnvClient").invalidateGlobalEnvCache;

let getMock: ReturnType<typeof vi.fn>;
let setMock: ReturnType<typeof vi.fn>;

describe("globalEnvClient", () => {
  beforeEach(async () => {
    vi.resetModules();

    getMock = vi.fn();
    setMock = vi.fn().mockResolvedValue(undefined);

    typedGlobal.window = {
      electron: {
        globalEnv: {
          get: getMock,
          set: setMock,
        },
      },
    };

    const mod = await import("../globalEnvClient");
    globalEnvClient = mod.globalEnvClient;
    invalidateGlobalEnvCache = mod.invalidateGlobalEnvCache;
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("coalesces concurrent get() calls into a single IPC call", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getMock.mockReturnValue(deferred);

    const p1 = globalEnvClient.get();
    const p2 = globalEnvClient.get();

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);

    resolve({ FOO: "bar" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ FOO: "bar" });
    expect(r2).toEqual({ FOO: "bar" });
  });

  it("returns cached result on subsequent calls after resolution", async () => {
    getMock.mockResolvedValue({ FOO: "bar" });

    const r1 = await globalEnvClient.get();
    const r2 = await globalEnvClient.get();
    const r3 = await globalEnvClient.get();

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ FOO: "bar" });
    expect(r2).toEqual({ FOO: "bar" });
    expect(r3).toEqual({ FOO: "bar" });
  });

  it("treats missing/undefined IPC response as empty record", async () => {
    getMock.mockResolvedValue(undefined);

    const result = await globalEnvClient.get();
    expect(result).toEqual({});
  });

  it("does not poison cache on IPC rejection", async () => {
    getMock.mockRejectedValueOnce(new Error("IPC error"));

    await expect(globalEnvClient.get()).rejects.toThrow("IPC error");

    getMock.mockResolvedValue({ ok: "1" });
    const result = await globalEnvClient.get();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: "1" });
  });

  it("invalidate() forces a fresh IPC call on the next get()", async () => {
    getMock.mockResolvedValue({ FOO: "old" });
    await globalEnvClient.get();
    expect(getMock).toHaveBeenCalledTimes(1);

    invalidateGlobalEnvCache();

    getMock.mockResolvedValue({ FOO: "new" });
    const result = await globalEnvClient.get();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ FOO: "new" });
  });

  it("set() invalidates cache before the IPC write completes", async () => {
    getMock.mockResolvedValue({ FOO: "old" });
    await globalEnvClient.get();
    expect(getMock).toHaveBeenCalledTimes(1);

    await globalEnvClient.set({ FOO: "new" });
    expect(setMock).toHaveBeenCalledWith({ FOO: "new" });

    getMock.mockResolvedValue({ FOO: "new" });
    const result = await globalEnvClient.get();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ FOO: "new" });
  });

  it("returns empty object when window.electron is missing", async () => {
    delete typedGlobal.window;
    const result = await globalEnvClient.get();
    expect(result).toEqual({});
  });

  it("set() during an in-flight get() does not let stale data poison the cache", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getMock.mockReturnValueOnce(deferred);

    const inflight = globalEnvClient.get();

    // Mid-flight write — must invalidate before the IPC set resolves.
    await globalEnvClient.set({ FOO: "new" });

    // Old fetch resolves with stale data, but invalidation prevents cache repopulation.
    resolve({ FOO: "old" });
    await inflight;

    getMock.mockResolvedValue({ FOO: "new" });
    const fresh = await globalEnvClient.get();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(fresh).toEqual({ FOO: "new" });
  });
});
