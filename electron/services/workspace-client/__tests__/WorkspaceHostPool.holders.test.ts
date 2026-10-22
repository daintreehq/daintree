import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hosts = vi.hoisted(
  () => [] as Array<{ projectPath: string; dispose: ReturnType<typeof vi.fn> }>
);

vi.mock("electron", () => ({}));
vi.mock("../../WorkspaceHostProcess.js", () => ({
  WorkspaceHostProcess: class {
    projectPath: string;
    dispose = vi.fn();
    send = vi.fn();
    on = vi.fn();
    setLogLevelOverrides = vi.fn();
    relayFetchThrottle = vi.fn();
    flushWorkspacePowerPolicy = vi.fn();
    waitForReady = vi.fn(async () => undefined);
    generateRequestId = () => "req";
    sendWithResponse = vi.fn(async () => undefined);
    isReady = () => true;
    constructor(projectPath: string) {
      this.projectPath = projectPath;
      hosts.push(this);
    }
  },
}));
vi.mock("../../../store.js", () => ({ store: { get: vi.fn(() => undefined), set: vi.fn() } }));
vi.mock("../../../utils/logger.js", () => ({ isValidLogOverrideLevel: () => false }));
vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getProjectSettings: vi.fn().mockResolvedValue(null),
    resolveProjectIdForPath: vi.fn((p: string) => `id-for-${p}`),
  },
}));

import { WorkspaceHostPool } from "../WorkspaceHostPool.js";

const GRACE_MS = 180_000;
const PROJECT = "/srv/pagesugar";
const LOCAL_WINDOW = 1;
const REMOTE_VIEW = -9;

beforeEach(() => {
  vi.useFakeTimers();
  hosts.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceHostPool holders", () => {
  it("does not let a holder of a replaced host release the host that replaced it", async () => {
    const pool = new WorkspaceHostPool({ config: {}, emit: vi.fn() });
    await pool.loadProject(PROJECT, REMOTE_VIEW);
    await pool.loadProject(PROJECT, LOCAL_WINDOW);

    // The host goes away under both holders, and only the local window loads it again.
    pool.evictProjectForRelocation(PROJECT);
    await pool.loadProject(PROJECT, LOCAL_WINDOW);
    const replacement = pool.entries.get(PROJECT)!;
    expect(replacement.windowIds).toEqual(new Set([LOCAL_WINDOW]));

    pool.releaseWindow(REMOTE_VIEW);
    expect(replacement.refCount).toBe(1);

    await vi.advanceTimersByTimeAsync(GRACE_MS + 1);
    expect(replacement.host.dispose).not.toHaveBeenCalled();
    expect(pool.getHostForProject(PROJECT)).toBe(replacement.host);
  });

  it("tells whether a window holds a project's current host", async () => {
    const pool = new WorkspaceHostPool({ config: {}, emit: vi.fn() });
    await pool.loadProject(PROJECT, REMOTE_VIEW);
    expect(pool.isWindowAttached(REMOTE_VIEW, PROJECT)).toBe(true);

    pool.evictProjectForRelocation(PROJECT);
    await pool.loadProject(PROJECT, LOCAL_WINDOW);
    // Still mapped to the project, but not a holder of the host now serving it.
    expect(pool.getHostForWindow(REMOTE_VIEW)).toBe(pool.getHostForProject(PROJECT));
    expect(pool.isWindowAttached(REMOTE_VIEW, PROJECT)).toBe(false);
    expect(pool.isWindowAttached(LOCAL_WINDOW, PROJECT)).toBe(true);
  });

  it("announces a freshly spawned host once it has loaded, and not a reused one", async () => {
    const emit = vi.fn();
    const pool = new WorkspaceHostPool({ config: {}, emit });
    await pool.loadProject(PROJECT, LOCAL_WINDOW);
    expect(emit).toHaveBeenCalledWith("host-spawned", {
      projectPath: PROJECT,
      host: pool.getHostForProject(PROJECT),
    });

    emit.mockClear();
    await pool.loadProject(PROJECT, REMOTE_VIEW);
    expect(emit).not.toHaveBeenCalledWith("host-spawned", expect.anything());
  });

  it("announces a prewarmed host once it has loaded", async () => {
    const emit = vi.fn();
    const pool = new WorkspaceHostPool({ config: {}, emit });
    pool.prewarmProject(PROJECT);
    expect(emit).not.toHaveBeenCalledWith("host-spawned", expect.anything());
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledWith("host-spawned", {
      projectPath: PROJECT,
      host: pool.getHostForProject(PROJECT),
    });
  });
});
