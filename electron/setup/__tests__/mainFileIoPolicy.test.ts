import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logInfo, logWarn } = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("../../utils/logger.js", () => ({ logInfo, logWarn }));

import { applyMainFileIoPolicy, libuvThreadpoolSize } from "../mainFileIoPolicy.js";

describe("libuvThreadpoolSize", () => {
  it.each([
    [undefined, 4],
    ["8", 8],
    [" 16", 16],
    ["0", 1],
    ["abc", 1],
    ["-3", 1024],
    ["5000", 1024],
  ])("reads UV_THREADPOOL_SIZE=%s as libuv does", (raw, expected) => {
    const env = raw === undefined ? {} : { UV_THREADPOOL_SIZE: raw };
    expect(libuvThreadpoolSize(env)).toBe(expected);
  });
});

describe("applyMainFileIoPolicy", () => {
  const original = process.env.UV_THREADPOOL_SIZE;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.UV_THREADPOOL_SIZE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = original;
  });

  it("does nothing off macOS", async () => {
    const load = vi.fn();
    await applyMainFileIoPolicy({ platform: "linux", load });
    await applyMainFileIoPolicy({ platform: "win32", load });
    expect(load).not.toHaveBeenCalled();
  });

  it("asks for one rendezvous per libuv worker", async () => {
    process.env.UV_THREADPOOL_SIZE = "6";
    const disable = vi.fn(async (threads: number) => ({
      requested: threads,
      applied: threads,
      errors: [],
    }));
    await applyMainFileIoPolicy({
      platform: "darwin",
      load: () => ({ disableThreadPoolDatalessMaterialization: disable }),
    });
    expect(disable).toHaveBeenCalledWith(6, expect.any(Number));
    expect(logInfo).toHaveBeenCalledWith(expect.any(String), { workers: 6 });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("reports a policy that reached only some workers", async () => {
    await applyMainFileIoPolicy({
      platform: "darwin",
      load: () => ({
        disableThreadPoolDatalessMaterialization: async () => ({
          requested: 4,
          applied: 3,
          errors: [22],
        }),
      }),
    });
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(expect.any(String), {
      requested: 4,
      applied: 3,
      errors: [22],
    });
  });

  it("carries on when the addon is missing, unavailable or throws", async () => {
    await expect(
      applyMainFileIoPolicy({
        platform: "darwin",
        load: () => {
          throw new Error("Cannot find module");
        },
      })
    ).resolves.toBeUndefined();
    await applyMainFileIoPolicy({
      platform: "darwin",
      load: () => ({ disableThreadPoolDatalessMaterialization: () => null }),
    });
    await applyMainFileIoPolicy({ platform: "darwin", load: () => ({}) });
    await applyMainFileIoPolicy({
      platform: "darwin",
      load: () => ({
        disableThreadPoolDatalessMaterialization: () => Promise.reject(new Error("boom")),
      }),
    });
    expect(logWarn).toHaveBeenCalledTimes(4);
    expect(logInfo).not.toHaveBeenCalled();
  });
});
