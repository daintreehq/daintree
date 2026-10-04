import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../PtyClient.js";

// Project close with kill, Sleep, idle auto-close and hibernation kill a
// project's PTYs wholesale, without asking the preview service. PtyClient
// announces the kill first ("project-kill-requested"); these tests drive that
// announcement and the exits that follow it (#13170).

const scanOutputMock = vi.hoisted(() =>
  vi.fn<
    (
      data: string,
      buffer: string
    ) => { buffer: string; error?: { type: string; message: string } }
  >()
);

vi.mock("../UrlDetector.js", () => ({
  UrlDetector: class {
    scanOutput(data: string, buffer: string) {
      return scanOutputMock(data, buffer);
    }
  },
}));

const portFreeGate = vi.hoisted(() => ({
  pending: null as Promise<boolean> | null,
  reached: false,
}));

vi.mock("../DevPreviewPortAllocator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../DevPreviewPortAllocator.js")>();
  return {
    ...actual,
    waitForPortFree: async (...args: Parameters<typeof actual.waitForPortFree>) => {
      portFreeGate.reached = true;
      if (portFreeGate.pending) return portFreeGate.pending;
      return actual.waitForPortFree(...args);
    },
  };
});

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

import { DevPreviewSessionService } from "../DevPreviewSessionService.js";

type Listener = (...args: never[]) => void;

function mockHttpResponse(statusCode: number): void {
  const impl = ((
    _: unknown,
    __: unknown,
    cb: (res: { statusCode: number; resume: () => void }) => void
  ) => {
    const req = {
      on: () => req,
      end: () => cb({ statusCode, resume: () => {} }),
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

function createPtyClientMock() {
  const listeners = new Map<string, Set<Listener>>();
  const terminals = new Map<string, { projectId?: string; hasPty: boolean }>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  };

  return {
    listeners,
    on: vi.fn((event: string, callback: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(callback);
    }),
    off: vi.fn((event: string, callback: Listener) => {
      listeners.get(event)?.delete(callback);
    }),
    spawn: vi.fn((id: string, options: { projectId?: string }) => {
      terminals.set(id, { projectId: options.projectId, hasPty: true });
    }),
    kill: vi.fn((id: string) => {
      const terminal = terminals.get(id);
      if (terminal) terminal.hasPty = false;
    }),
    submit: vi.fn(),
    hasTerminal: vi.fn((id: string) => terminals.get(id)?.hasPty ?? false),
    setIpcDataMirror: vi.fn(),
    replayHistoryAsync: vi.fn(async () => 0),
    getTerminalAsync: vi.fn(async (id: string) => {
      const terminal = terminals.get(id);
      if (!terminal) return null;
      return { id, projectId: terminal.projectId, hasPty: terminal.hasPty, cwd: "/repo" };
    }),
    emitData(id: string, data: string) {
      emit("data", id, data);
    },
    emitExit(id: string, exitCode: number, signal?: number) {
      const terminal = terminals.get(id);
      if (terminal) terminal.hasPty = false;
      emit("exit", id, exitCode, signal);
    },
    /** What PtyClient does ahead of gracefulKillByProject / killByProject. */
    announceProjectKill(projectId: string) {
      emit("project-kill-requested", projectId);
    },
  };
}

describe("DevPreviewSessionService external project kills", () => {
  const requestA = {
    panelId: "panel-a",
    projectId: "project-a",
    cwd: "/repo",
    devCommand: "npm run dev",
  };
  const requestB = { ...requestA, panelId: "panel-b", projectId: "project-b" };

  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let service: DevPreviewSessionService;

  beforeEach(() => {
    portFreeGate.pending = null;
    portFreeGate.reached = false;
    scanOutputMock.mockImplementation((data, buffer) =>
      data.includes("missing deps")
        ? { buffer, error: { type: "missing-dependencies", message: "Cannot find module 'x'" } }
        : { buffer }
    );
    mockHttpResponse(200);
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(ptyClient as unknown as PtyClient, vi.fn());
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
  });

  it("does not reinstall a server that wanted dependencies when its project is killed", async () => {
    const started = await service.ensure(requestA);
    const devId = started.terminalId!;
    ptyClient.emitData(devId, "missing deps");
    const spawnsBefore = ptyClient.spawn.mock.calls.length;

    ptyClient.announceProjectKill("project-a");
    ptyClient.emitExit(devId, 129);

    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBefore);
    const state = service.getState(requestA);
    expect(state.status).not.toBe("installing");
    expect(state.terminalId).toBeNull();
  });

  it("does not start the dev server after an install that the project kill interrupted", async () => {
    const started = await service.ensure(requestA);
    ptyClient.emitData(started.terminalId!, "missing deps");
    ptyClient.emitExit(started.terminalId!, 1);
    const installId = service.getState(requestA).terminalId!;
    expect(service.getState(requestA).status).toBe("installing");
    const spawnsBefore = ptyClient.spawn.mock.calls.length;

    ptyClient.announceProjectKill("project-a");
    // An install that happened to finish cleanly as the kill landed.
    ptyClient.emitExit(installId, 0);
    // The respawn would still be resolving its port here, so the state is the
    // synchronous proof that none was started.
    expect(["installing", "starting"]).not.toContain(service.getState(requestA).status);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBefore);
    expect(service.getState(requestA).terminalId).toBeNull();
  });

  it("ignores output that was still in flight when the project was killed", async () => {
    const started = await service.ensure(requestA);
    const devId = started.terminalId!;
    const spawnsBefore = ptyClient.spawn.mock.calls.length;

    ptyClient.announceProjectKill("project-a");
    ptyClient.emitData(devId, "missing deps");
    ptyClient.emitExit(devId, 129);

    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBefore);
    expect(service.getState(requestA).terminalId).toBeNull();
  });

  it("settles a launch that had no terminal yet when the project is killed", async () => {
    await service.ensure(requestA);
    let releasePort!: (free: boolean) => void;
    portFreeGate.pending = new Promise<boolean>((resolve) => {
      releasePort = resolve;
    });

    const restart = service.restart(requestA);
    await vi.waitFor(() => expect(portFreeGate.reached).toBe(true));
    // Mid-restart: the old terminal is stopped and the new one not spawned.
    ptyClient.announceProjectKill("project-a");
    const settled = service.getState(requestA);
    expect(settled.status).toBe("stopped");
    expect(settled.isRestarting).toBe(false);

    releasePort(true);
    await restart;
  });

  it("leaves other projects' sessions to recover as usual", async () => {
    await service.ensure(requestA);
    const startedB = await service.ensure(requestB);
    ptyClient.emitData(startedB.terminalId!, "missing deps");
    const spawnsBefore = ptyClient.spawn.mock.calls.length;

    ptyClient.announceProjectKill("project-a");
    ptyClient.emitExit(startedB.terminalId!, 1);

    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBefore + 1);
    expect(service.getState(requestB).status).toBe("installing");
  });

  it("stands a restart down when the project is killed while it waits for the port", async () => {
    await service.ensure(requestA);
    let releasePort!: (free: boolean) => void;
    portFreeGate.pending = new Promise<boolean>((resolve) => {
      releasePort = resolve;
    });
    const spawnsBefore = ptyClient.spawn.mock.calls.length;

    const restart = service.restart(requestA);
    await vi.waitFor(() => expect(portFreeGate.reached).toBe(true));
    ptyClient.announceProjectKill("project-a");
    releasePort(true);
    const state = await restart;

    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsBefore);
    expect(state.status).toBe("stopped");
    expect(state.isRestarting).toBe(false);
  });

  it("stops listening for project kills once disposed", () => {
    expect(ptyClient.listeners.get("project-kill-requested")?.size).toBe(1);
    service.dispose();
    expect(ptyClient.listeners.get("project-kill-requested")?.size ?? 0).toBe(0);
  });
});
