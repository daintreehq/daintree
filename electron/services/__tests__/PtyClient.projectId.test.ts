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
    vi.useFakeTimers();

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
