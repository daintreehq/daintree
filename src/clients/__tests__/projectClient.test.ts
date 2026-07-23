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

describe("projectClient getSettings caching", () => {
  let getSettingsMock: ReturnType<typeof vi.fn>;
  let saveSettingsMock: ReturnType<typeof vi.fn>;
  let projectClient: typeof import("../projectClient").projectClient;
  let invalidateProjectSettingsCache: typeof import("../projectClient").invalidateProjectSettingsCache;

  const settingsA = { environmentVariables: { FOO: "a" } } as never;
  const settingsB = { environmentVariables: { FOO: "b" } } as never;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ shouldAdvanceTime: false });

    getSettingsMock = vi.fn();
    saveSettingsMock = vi.fn().mockResolvedValue(undefined);

    typedGlobal.window = {
      electron: {
        project: {
          getCurrent: vi.fn(),
          onSwitch: vi.fn(() => () => {}),
          switch: vi.fn(),
          reopen: vi.fn(),
          getSettings: getSettingsMock,
          saveSettings: saveSettingsMock,
        },
      },
    };

    const mod = await import("../projectClient");
    projectClient = mod.projectClient;
    invalidateProjectSettingsCache = mod.invalidateProjectSettingsCache;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete typedGlobal.window;
  });

  it("coalesces concurrent getSettings(projectId) calls into a single IPC call", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getSettingsMock.mockReturnValue(deferred);

    const p1 = projectClient.getSettings("proj-1");
    const p2 = projectClient.getSettings("proj-1");

    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);

    resolve(settingsA);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(settingsA);
    expect(r2).toBe(settingsA);
  });

  it("returns cached result for follow-on calls within TTL", async () => {
    getSettingsMock.mockResolvedValue(settingsA);

    const r1 = await projectClient.getSettings("proj-1");
    const r2 = await projectClient.getSettings("proj-1");

    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(r1).toBe(settingsA);
    expect(r2).toBe(settingsA);
  });

  it("isolates cache per projectId", async () => {
    getSettingsMock.mockImplementation((id: string) =>
      Promise.resolve(id === "proj-1" ? settingsA : settingsB)
    );

    const r1 = await projectClient.getSettings("proj-1");
    const r2 = await projectClient.getSettings("proj-2");

    expect(getSettingsMock).toHaveBeenCalledTimes(2);
    expect(r1).toBe(settingsA);
    expect(r2).toBe(settingsB);
  });

  it("re-fetches after the TTL expires", async () => {
    vi.setSystemTime(new Date(0));
    getSettingsMock.mockResolvedValue(settingsA);

    await projectClient.getSettings("proj-1");
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    // Within TTL: cached (wide enough to outlive the serialized startup queue, #10390)
    vi.setSystemTime(new Date(499));
    await projectClient.getSettings("proj-1");
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    // After TTL: fresh fetch
    vi.setSystemTime(new Date(600));
    getSettingsMock.mockResolvedValue(settingsB);
    const r3 = await projectClient.getSettings("proj-1");
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
    expect(r3).toBe(settingsB);
  });

  it("saveSettings invalidates the project's cached settings", async () => {
    getSettingsMock.mockResolvedValue(settingsA);
    await projectClient.getSettings("proj-1");
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    await projectClient.saveSettings("proj-1", settingsB);
    expect(saveSettingsMock).toHaveBeenCalledWith("proj-1", settingsB);

    getSettingsMock.mockResolvedValue(settingsB);
    const result = await projectClient.getSettings("proj-1");
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(settingsB);
  });

  it("saveSettings only invalidates the affected projectId", async () => {
    getSettingsMock.mockImplementation((id: string) =>
      Promise.resolve(id === "proj-1" ? settingsA : settingsB)
    );

    await projectClient.getSettings("proj-1");
    await projectClient.getSettings("proj-2");
    expect(getSettingsMock).toHaveBeenCalledTimes(2);

    await projectClient.saveSettings("proj-1", settingsA);

    // proj-1 should re-fetch, proj-2 still cached
    await projectClient.getSettings("proj-1");
    await projectClient.getSettings("proj-2");
    expect(getSettingsMock).toHaveBeenCalledTimes(3);
  });

  it("invalidateProjectSettingsCache() with no args clears all entries", async () => {
    getSettingsMock.mockImplementation((id: string) =>
      Promise.resolve(id === "proj-1" ? settingsA : settingsB)
    );

    await projectClient.getSettings("proj-1");
    await projectClient.getSettings("proj-2");
    expect(getSettingsMock).toHaveBeenCalledTimes(2);

    invalidateProjectSettingsCache();

    await projectClient.getSettings("proj-1");
    await projectClient.getSettings("proj-2");
    expect(getSettingsMock).toHaveBeenCalledTimes(4);
  });

  it("does not poison cache on IPC rejection", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("IPC error"));

    await expect(projectClient.getSettings("proj-1")).rejects.toThrow("IPC error");

    getSettingsMock.mockResolvedValue(settingsA);
    const result = await projectClient.getSettings("proj-1");
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
    expect(result).toBe(settingsA);
  });

  it("saveSettings during in-flight getSettings does not let stale data poison the cache", async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => {
      resolve = r;
    });
    getSettingsMock.mockReturnValueOnce(deferred);

    const inflight = projectClient.getSettings("proj-1");

    // Mid-flight write — invalidate the per-projectId cache.
    await projectClient.saveSettings("proj-1", settingsB);
    expect(saveSettingsMock).toHaveBeenCalledWith("proj-1", settingsB);

    // Old fetch resolves with stale data; cache must not repopulate from it.
    resolve(settingsA);
    await inflight;

    getSettingsMock.mockResolvedValue(settingsB);
    const fresh = await projectClient.getSettings("proj-1");
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
    expect(fresh).toBe(settingsB);
  });
});

describe("projectClient.setDraftInputs delta forwarding (#11352)", () => {
  let setDraftInputsMock: ReturnType<typeof vi.fn>;
  let client: typeof import("../projectClient").projectClient;

  beforeEach(async () => {
    vi.resetModules();
    setDraftInputsMock = vi.fn().mockResolvedValue(undefined);
    typedGlobal.window = {
      electron: {
        project: {
          onSwitch: vi.fn(() => () => {}),
          setDraftInputs: setDraftInputsMock,
        },
      },
    };
    client = (await import("../projectClient")).projectClient;
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  it("forwards changedIds and removedIds unchanged to the IPC layer", async () => {
    await client.setDraftInputs("proj-1", { t1: "draft" }, ["t1"], ["t2"]);
    expect(setDraftInputsMock).toHaveBeenCalledWith("proj-1", { t1: "draft" }, ["t1"], ["t2"]);
  });

  it("passes undefined delta args through for a legacy full-replace call", async () => {
    await client.setDraftInputs("proj-1", { t1: "draft" });
    expect(setDraftInputsMock).toHaveBeenCalledWith("proj-1", { t1: "draft" }, undefined, undefined);
  });
});
