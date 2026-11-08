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
    static holdNextLoad = false;
    gitBacked: boolean | null = null;
    disposed = false;
    private failLoad: boolean;
    private heldLoad: Promise<void> | null = null;
    releaseLoad: () => void = () => undefined;

    constructor(projectPath: string) {
      super();
      this.projectPath = projectPath;
      this.failLoad = MockWorkspaceHostProcess.failNextLoad;
      MockWorkspaceHostProcess.failNextLoad = false;
      if (MockWorkspaceHostProcess.holdNextLoad) {
        this.heldLoad = new Promise((resolve) => {
          this.releaseLoad = resolve;
        });
        MockWorkspaceHostProcess.holdNextLoad = false;
      }
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
        if (this.heldLoad) await this.heldLoad;
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
import {
  clearCheckoutPending,
  markCheckoutPending,
  resetCheckoutGateForTests,
} from "../projectClone/checkoutGate.js";

const PROJECT = path.resolve("/srv/cloning-folder");
const OTHER = path.resolve("/srv/ready-folder");
const WINDOW_A = 1;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WorkspaceClient with a project still awaiting its clone (#16352)", () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    hosts.length = 0;
    MockWorkspaceHostProcess.nextVerdict = true;
    resetCheckoutGateForTests();
    client = new WorkspaceClient({});
  });

  afterEach(() => {
    client.dispose();
    resetCheckoutGateForTests();
  });

  it("refuses to load a folder git is still writing, and lets the window go", async () => {
    await client.loadProject(OTHER, WINDOW_A);
    markCheckoutPending("p-clone", PROJECT);

    await expect(client.loadProject(PROJECT, WINDOW_A)).rejects.toMatchObject({
      code: "PROJECT_NOT_READY",
    });

    // No host was ever forked for the clone's folder.
    expect(hosts.map((host) => host.projectPath)).toEqual([OTHER]);
    // The window no longer receives the other project's worktree events.
    expect(client.isWindowAttached(WINDOW_A, OTHER)).toBe(false);
    await tick();
  });

  it("lets go of the window for good: a load it superseded can't come back later", async () => {
    MockWorkspaceHostProcess.holdNextLoad = true;
    const stale = client.loadProject(OTHER, WINDOW_A);
    await tick();
    markCheckoutPending("p-clone", PROJECT);
    await expect(client.loadProject(PROJECT, WINDOW_A)).rejects.toMatchObject({
      code: "PROJECT_NOT_READY",
    });
    const next = path.resolve("/srv/next-folder");
    await client.loadProject(next, WINDOW_A);

    hosts[0]!.releaseLoad();
    await stale.catch(() => undefined);
    await tick();

    expect(client.isWindowAttached(WINDOW_A, next)).toBe(true);
    expect(client.isWindowAttached(WINDOW_A, OTHER)).toBe(false);
  });

  it("never prewarms a host for it", () => {
    markCheckoutPending("p-clone", PROJECT);
    client.prewarmProject(PROJECT);
    expect(hosts).toHaveLength(0);
  });

  it("loads it like any project once the clone has landed", async () => {
    markCheckoutPending("p-clone", PROJECT);
    clearCheckoutPending("p-clone");

    await client.loadProject(PROJECT, WINDOW_A);

    expect(client.isWindowAttached(WINDOW_A, PROJECT)).toBe(true);
  });
});
