import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hosts, MockWorkspaceHostProcess } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");

  interface Request {
    requestId: string;
    type: string;
  }

  class MockWorkspaceHostProcess extends EventEmitter {
    projectPath: string;
    /** What the next host spawned for a path will answer, set by the test. */
    static nextVerdict: boolean | null = false;
    static failNextLoad = false;
    gitBacked: boolean | null = null;
    disposed = false;
    private failLoad: boolean;

    constructor(projectPath: string) {
      super();
      this.projectPath = projectPath;
      this.failLoad = MockWorkspaceHostProcess.failNextLoad;
      MockWorkspaceHostProcess.failNextLoad = false;
      hosts.push(this);
    }

    waitForReady = vi.fn(async () => undefined);
    isReady = () => !this.disposed;
    generateRequestId = () => `req-${Math.random().toString(36).slice(2)}`;
    send = vi.fn();
    setLogLevelOverrides = vi.fn();
    relayFetchThrottle = vi.fn();
    setWorkspacePowerPolicy = vi.fn();
    flushWorkspacePowerPolicy = vi.fn();
    dispose = vi.fn(() => {
      this.disposed = true;
    });

    // Mirrors WorkspaceService: the verdict is fixed by the one load-project
    // the process ever runs.
    sendWithResponse = vi.fn(async (request: Request) => {
      if (request.type === "load-project") {
        if (this.failLoad) throw new Error("load failed");
        this.gitBacked = MockWorkspaceHostProcess.nextVerdict;
        return {};
      }
      if (request.type === "get-all-states") {
        return {
          states: this.gitBacked ? [{ path: this.projectPath, isMainWorktree: true }] : [],
          gitBacked: this.gitBacked,
        };
      }
      return {};
    });

    loads(): number {
      return this.sendWithResponse.mock.calls.filter(([req]) => req.type === "load-project").length;
    }
  }

  const hosts: MockWorkspaceHostProcess[] = [];
  return { hosts, MockWorkspaceHostProcess };
});

vi.mock("../WorkspaceHostProcess.js", () => ({
  WorkspaceHostProcess: MockWorkspaceHostProcess,
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }));
vi.mock("../events.js", () => ({ events: { emit: vi.fn() } }));
vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getProjectSettings: vi.fn().mockResolvedValue({ runCommands: [] }),
    resolveProjectIdForPath: vi.fn((p: string) => `id-for-${p}`),
  },
}));
vi.mock("../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import path from "node:path";
import { WorkspaceClient } from "../WorkspaceClient.js";

const PROJECT = path.resolve("/srv/fresh-folder");
const WINDOW_A = 1;
const WINDOW_B = 2;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WorkspaceClient.refreshProjectAfterGitInit (#14178)", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    hosts.length = 0;
    MockWorkspaceHostProcess.nextVerdict = false;
    MockWorkspaceHostProcess.failNextLoad = false;
    client = new WorkspaceClient({});
  });

  afterEach(() => {
    client.dispose();
  });

  function entry() {
    return client["pool"].entries.get(PROJECT)!;
  }

  it("replaces a host that loaded the folder before it was a repository", async () => {
    await client.loadProject(PROJECT, WINDOW_A);
    await client.loadProject(PROJECT, WINDOW_B);
    const before = entry();
    const oldHost = hosts[0];
    expect(
      await client.getAllStatesWithGitBackedForProjectAsync(PROJECT, before.projectId)
    ).toEqual({ states: [], gitBacked: false });

    // git init + initial commit happen here; the folder now probes as a repository.
    MockWorkspaceHostProcess.nextVerdict = true;
    const restarted = vi.fn();
    client.on("host-restarted", restarted);

    await expect(client.refreshProjectAfterGitInit(PROJECT)).resolves.toBe(true);
    await entry().currentReadyPromise;
    await tick();

    expect(oldHost.dispose).toHaveBeenCalledWith("git-initialized");
    const newHost = hosts[1];
    expect(newHost.loads()).toBe(1);
    // Same entry, same holders: neither window has to re-attach.
    expect(entry()).toBe(before);
    expect(entry().windowIds).toEqual(new Set([WINDOW_A, WINDOW_B]));
    expect(entry().refCount).toBe(2);
    expect(client.getHostForWindow(WINDOW_B)).toBe(newHost);
    // Announced like a crash restart so every view's port is re-brokered.
    expect(restarted).toHaveBeenCalledWith({ projectPath: PROJECT, host: newHost });

    // The Retry that follows reuses the fresh host and sees the main worktree.
    await expect(client.loadProject(PROJECT, WINDOW_A)).resolves.toBe("warm");
    expect(
      await client.getAllStatesWithGitBackedForProjectAsync(PROJECT, before.projectId)
    ).toEqual({ states: [{ path: PROJECT, isMainWorktree: true }], gitBacked: true });
  });

  it("serves a project switch onto the folder from the replacement", async () => {
    // Prewarmed or retained from an earlier visit, held by no window.
    client.prewarmProject(PROJECT);
    await entry().currentReadyPromise;
    MockWorkspaceHostProcess.nextVerdict = true;

    await client.refreshProjectAfterGitInit(PROJECT);
    await expect(client.loadProject(PROJECT, WINDOW_A)).resolves.toBe("warm");

    expect(hosts).toHaveLength(2);
    expect(client.getHostForWindow(WINDOW_A)).toBe(hosts[1]);
    expect(hosts[1].gitBacked).toBe(true);
  });

  it("leaves a dormant replacement in the background", async () => {
    client.prewarmProject(PROJECT);
    await entry().currentReadyPromise;
    MockWorkspaceHostProcess.nextVerdict = true;

    await client.refreshProjectAfterGitInit(PROJECT);
    await entry().currentReadyPromise;
    await tick();

    expect(hosts[1].send).toHaveBeenCalledWith({ type: "background" });
  });

  it("does nothing when no host holds the folder", async () => {
    await expect(client.refreshProjectAfterGitInit(PROJECT)).resolves.toBe(false);
    expect(hosts).toHaveLength(0);
  });

  it("keeps a host that already sees a repository", async () => {
    MockWorkspaceHostProcess.nextVerdict = true;
    await client.loadProject(PROJECT, WINDOW_A);

    await expect(client.refreshProjectAfterGitInit(PROJECT)).resolves.toBe(false);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].dispose).not.toHaveBeenCalled();
  });

  it("keeps a host whose verdict is unknown", async () => {
    MockWorkspaceHostProcess.nextVerdict = null;
    await client.loadProject(PROJECT, WINDOW_A);

    await expect(client.refreshProjectAfterGitInit(PROJECT)).resolves.toBe(false);
    expect(hosts).toHaveLength(1);
  });

  it("replaces once when two refreshes race", async () => {
    await client.loadProject(PROJECT, WINDOW_A);
    MockWorkspaceHostProcess.nextVerdict = true;

    const results = await Promise.all([
      client.refreshProjectAfterGitInit(PROJECT),
      client.refreshProjectAfterGitInit(PROJECT),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(hosts).toHaveLength(2);
  });

  it("ignores the replaced host's last events", async () => {
    await client.loadProject(PROJECT, WINDOW_A);
    MockWorkspaceHostProcess.nextVerdict = true;
    await client.refreshProjectAfterGitInit(PROJECT);
    await entry().currentReadyPromise;
    const crash = vi.fn();
    client.on("host-crash", crash);

    hosts[0].emit("host-crash", 1);
    hosts[0].emit("restarted");
    await tick();

    expect(crash).not.toHaveBeenCalled();
    expect(hosts[0].loads()).toBe(1);
  });

  it("leaves a replacement that failed to load for the next load to respawn", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await client.loadProject(PROJECT, WINDOW_A);
    MockWorkspaceHostProcess.nextVerdict = true;
    MockWorkspaceHostProcess.failNextLoad = true;

    await client.refreshProjectAfterGitInit(PROJECT);
    await entry().currentReadyPromise.catch(() => undefined);
    await tick();

    await expect(client.loadProject(PROJECT, WINDOW_A)).resolves.toBe("cold");
    expect(hosts[1].dispose).toHaveBeenCalledWith("ready-failed");
    expect(client.getHostForWindow(WINDOW_A)).toBe(hosts[2]);
    expect(hosts[2].gitBacked).toBe(true);
    consoleError.mockRestore();
  });
});
