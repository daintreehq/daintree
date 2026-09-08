import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "events";

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

import { utilityProcess } from "electron";

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

describe("PtyClient projectId assignment", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;

  beforeEach(async () => {
    mockChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });

    (utilityProcess.fork as Mock).mockReturnValue(mockChild);

    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: {
        fork: vi.fn().mockReturnValue(mockChild),
      },
      dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
        on: vi.fn(),
        off: vi.fn(),
      },
    }));

    const module = await import("../PtyClient.js");
    PtyClientClass = module.PtyClient;

    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const createClient = () => {
    const client = new PtyClientClass();
    mockChild.emit("message", { type: "ready" });
    return client;
  };

  describe("getLiveWorkspaceIds (#12320)", () => {
    /**
     * The open-window manifest needs this because a project's agents outlive
     * its renderer: LRU eviction destroys the view and leaves the PTYs
     * running, so a manifest built from views alone drops exactly the
     * long-running projects a relaunch most needs to bring back.
     */
    it("reports every workspace that owns a tracked terminal, deduplicated", () => {
      const client = createClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t3", { cwd: "/b", cols: 80, rows: 24, projectId: "project-b" });

      expect(client.getLiveWorkspaceIds()).toEqual(new Set(["project-a", "project-b"]));
    });

    it("keeps a workspace while any of its terminals survives", () => {
      const client = createClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });

      mockChild.emit("message", { type: "exit", id: "t1", exitCode: 0 });

      expect(client.getLiveWorkspaceIds().has("project-a")).toBe(true);
    });

    it("drops a workspace once its last terminal exits", () => {
      const client = createClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      mockChild.emit("message", { type: "exit", id: "t1", exitCode: 0 });

      expect(client.getLiveWorkspaceIds().has("project-a")).toBe(false);
    });

    it("contributes nothing for a terminal with no owning workspace", () => {
      const client = createClient();
      client.spawn("t1", { cwd: "/tmp", cols: 80, rows: 24 });

      expect(client.getLiveWorkspaceIds()).toEqual(new Set());
    });

    it("answers without sending anything to the host", () => {
      // The manifest is written from the shutdown chain's synchronous prefix,
      // where an async round trip has no chance to answer before the process
      // ends.
      const client = createClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      mockChild.postMessage.mockClear();

      client.getLiveWorkspaceIds();

      expect(mockChild.postMessage).not.toHaveBeenCalled();
    });
  });

  it("defaults spawn() projectId to activeProjectId when omitted", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    mockChild.postMessage.mockClear();

    client.spawn("t1", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "spawn",
        id: "t1",
        options: expect.objectContaining({ projectId: "project-a" }),
      })
    );
  });

  it("does not override an explicit spawn() projectId", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    mockChild.postMessage.mockClear();

    client.spawn("t2", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      projectId: "explicit-project",
    });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "spawn",
        id: "t2",
        options: expect.objectContaining({ projectId: "explicit-project" }),
      })
    );
  });

  it("treats blank projectId as missing and falls back to activeProjectId", () => {
    const client = createClient();
    client.setActiveProject(1, "project-a");
    mockChild.postMessage.mockClear();

    client.spawn("t3", {
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      projectId: "  ",
    });

    expect(mockChild.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "spawn",
        id: "t3",
        options: expect.objectContaining({ projectId: "project-a" }),
      })
    );
  });
});
