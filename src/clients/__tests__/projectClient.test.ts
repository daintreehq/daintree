import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let projectClient: typeof import("../projectClient").projectClient;
let invalidateCurrentCache: typeof import("../projectClient").invalidateCurrentCache;

let getCurrentMock: ReturnType<typeof vi.fn>;
let onSwitchMock: ReturnType<typeof vi.fn>;
let switchMock: ReturnType<typeof vi.fn>;
let reopenMock: ReturnType<typeof vi.fn>;
let savedOnSwitchCallback: (() => void) | null;

describe("projectClient getCurrent caching", () => {
  beforeEach(async () => {
    vi.resetModules();
    savedOnSwitchCallback = null;

    getCurrentMock = vi.fn();
    onSwitchMock = vi.fn((cb: () => void) => {
      savedOnSwitchCallback = cb;
      return () => {};
    });
    switchMock = vi.fn();
    reopenMock = vi.fn();

    typedGlobal.window = {
      electron: {
        project: {
          getCurrent: getCurrentMock,
          onSwitch: onSwitchMock,
          switch: switchMock,
          reopen: reopenMock,
        },
      },
    };

    const mod = await import("../projectClient");
    projectClient = mod.projectClient;
    invalidateCurrentCache = mod.invalidateCurrentCache;
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  const fakeProject = { id: "proj_1", name: "Test Project" } as never;
  const fakeProject2 = { id: "proj_2", name: "Other Project" } as never;

  it("coalesces concurrent getCurrent() calls into a single IPC call", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getCurrentMock.mockReturnValue(deferred);

    const p1 = projectClient.getCurrent();
    const p2 = projectClient.getCurrent();

    expect(getCurrentMock).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);

    resolve(fakeProject);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(fakeProject);
    expect(r2).toBe(fakeProject);
  });

  it("returns cached result on subsequent calls after resolution", async () => {
    getCurrentMock.mockResolvedValue(fakeProject);

    const r1 = await projectClient.getCurrent();
    const r2 = await projectClient.getCurrent();

    expect(getCurrentMock).toHaveBeenCalledTimes(1);
    expect(r1).toBe(fakeProject);
    expect(r2).toBe(fakeProject);
  });

  it("caches null results", async () => {
    getCurrentMock.mockResolvedValue(null);

    const r1 = await projectClient.getCurrent();
    const r2 = await projectClient.getCurrent();

    expect(getCurrentMock).toHaveBeenCalledTimes(1);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it("invalidates cache on project switch via onSwitch event", async () => {
    getCurrentMock.mockResolvedValue(fakeProject);
    await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(1);

    // Fire onSwitch to invalidate
    expect(savedOnSwitchCallback).toBeDefined();
    savedOnSwitchCallback!();

    // Next call should make a fresh IPC call
    getCurrentMock.mockResolvedValue(fakeProject2);
    const result = await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(fakeProject2);
  });

  it("prevents stale in-flight response from repopulating cache after invalidation", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getCurrentMock.mockReturnValue(deferred);

    const p1 = projectClient.getCurrent();

    // Invalidate before the in-flight resolves
    savedOnSwitchCallback!();

    // Resolve the stale promise
    resolve(fakeProject);
    const r1 = await p1;
    expect(r1).toBe(fakeProject); // caller still gets its result

    // But cache should NOT be populated with stale data
    getCurrentMock.mockResolvedValue(fakeProject2);
    const r2 = await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(2); // fresh IPC call
    expect(r2).toBe(fakeProject2);
  });

  it("does not poison cache on IPC rejection", async () => {
    getCurrentMock.mockRejectedValue(new Error("IPC error"));

    await expect(projectClient.getCurrent()).rejects.toThrow("IPC error");

    // Next call should retry
    getCurrentMock.mockResolvedValue(fakeProject);
    const result = await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(fakeProject);
  });

  it("invalidates cache when switch() is called", async () => {
    getCurrentMock.mockResolvedValue(fakeProject);
    await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(1);

    switchMock.mockResolvedValue(fakeProject2);
    await projectClient.switch("proj_2");

    // Cache should be invalidated, next getCurrent makes fresh IPC
    getCurrentMock.mockResolvedValue(fakeProject2);
    const result = await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(fakeProject2);
  });

  it("invalidates cache when reopen() is called", async () => {
    getCurrentMock.mockResolvedValue(fakeProject);
    await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(1);

    reopenMock.mockResolvedValue(fakeProject);
    await projectClient.reopen("proj_1");

    // Cache should be invalidated
    getCurrentMock.mockResolvedValue(fakeProject2);
    const result = await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(fakeProject2);
  });

  it("registers onSwitch listener lazily on first getCurrent() call", () => {
    expect(onSwitchMock).not.toHaveBeenCalled();

    getCurrentMock.mockResolvedValue(fakeProject);
    projectClient.getCurrent();

    expect(onSwitchMock).toHaveBeenCalledTimes(1);

    // Second call should not register again
    projectClient.getCurrent();
    expect(onSwitchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidateCurrentCache works directly without onSwitch", async () => {
    getCurrentMock.mockResolvedValue(fakeProject);
    await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(1);

    invalidateCurrentCache();

    getCurrentMock.mockResolvedValue(fakeProject2);
    const result = await projectClient.getCurrent();
    expect(getCurrentMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(fakeProject2);
  });
});
