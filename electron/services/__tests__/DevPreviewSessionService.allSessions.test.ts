import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevPreviewSessionService } from "../DevPreviewSessionService.js";
import * as portAllocator from "../DevPreviewPortAllocator.js";
import type { PtyClient } from "../PtyClient.js";
import type { DevPreviewManifestEntry } from "../DevPreviewManifestService.js";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

vi.mock("ws", () => {
  class WebSocketMock {
    once(event: "open" | "error" | "close", listener: () => void) {
      if (event === "error") queueMicrotask(() => listener());
      return this;
    }
    terminate() {}
    constructor() {}
  }
  return { default: WebSocketMock };
});

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number) => void;
type MockIncomingMessage = { statusCode?: number; resume: () => void };
type MockRequest = {
  on: (event: "error" | "timeout", handler: (...args: unknown[]) => void) => MockRequest;
  end: () => void;
  destroy: () => void;
};

function mockHttpResponse(statusCode: number) {
  const impl = ((_: unknown, __: unknown, cb: (res: MockIncomingMessage) => void) => {
    const req: MockRequest = {
      on: () => req,
      end: () => cb({ statusCode, resume: () => {} }),
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

function mockHttpError() {
  const impl = ((_: unknown, __: unknown, ___: unknown) => {
    let errorHandler: ((error: Error) => void) | undefined;
    const req: MockRequest = {
      on: (event, handler) => {
        if (event === "error") errorHandler = handler as (error: Error) => void;
        return req;
      },
      end: () => errorHandler?.(new Error("ECONNREFUSED")),
      destroy: () => {},
    };
    return req;
  }) as unknown as typeof http.request;
  vi.mocked(http.request).mockImplementation(impl);
  vi.mocked(https.request).mockImplementation(impl);
}

function createPtyClientMock() {
  const dataListeners = new Set<DataListener>();
  const exitListeners = new Set<ExitListener>();
  const terminals = new Map<string, { projectId?: string; hasPty: boolean }>();

  return {
    on: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") dataListeners.add(callback as DataListener);
      if (event === "exit") exitListeners.add(callback as ExitListener);
    }),
    off: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") dataListeners.delete(callback as DataListener);
      if (event === "exit") exitListeners.delete(callback as ExitListener);
    }),
    spawn: vi.fn((id: string, spawnOptions: { projectId?: string; args?: string[] }) => {
      terminals.set(id, { projectId: spawnOptions.projectId, hasPty: true });
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
      return {
        id,
        projectId: terminal.projectId,
        hasPty: terminal.hasPty,
        cwd: "/repo",
        spawnedAt: Date.now(),
      };
    }),
    emitData(id: string, data: string | Uint8Array) {
      for (const callback of dataListeners) callback(id, data);
    },
  };
}

function manifestEntry(overrides: Partial<DevPreviewManifestEntry> = {}): DevPreviewManifestEntry {
  return {
    panelId: "restored-panel",
    projectId: "project-1",
    worktreeId: "wt-restored",
    cwd: "/repo",
    devCommand: "npm run dev",
    turbopackEnabled: true,
    lastKnownPort: 3000,
    capturedAt: 42,
    ...overrides,
  };
}

describe("DevPreviewSessionService — cross-worktree snapshot", () => {
  const baseRequest = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
    worktreeId: "wt-1",
  };

  let onStateChanged: ReturnType<typeof vi.fn<(state: DevPreviewSessionState) => void>>;
  let onAllSessionsChanged: ReturnType<typeof vi.fn<(sessions: DevPreviewSessionState[]) => void>>;
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let service: DevPreviewSessionService;

  beforeEach(() => {
    onStateChanged = vi.fn<(state: DevPreviewSessionState) => void>();
    onAllSessionsChanged = vi.fn<(sessions: DevPreviewSessionState[]) => void>();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(
      ptyClient as unknown as PtyClient,
      onStateChanged,
      [],
      () => {},
      onAllSessionsChanged
    );
    mockHttpResponse(200);
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("getAllSessions returns every live session", async () => {
    // No server answers, so nothing can graduate out of "starting" while the
    // second ensure awaits command normalization.
    mockHttpError();
    await service.ensure(baseRequest);
    await service.ensure({ ...baseRequest, panelId: "panel-2", worktreeId: "wt-2" });

    const sessions = service.getAllSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.panelId).sort()).toEqual(["panel-1", "panel-2"]);
    expect(sessions.every((s) => s.status === "starting")).toBe(true);
  });

  it("getAllSessions includes restore placeholders not yet superseded", () => {
    service.dispose();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(
      ptyClient as unknown as PtyClient,
      onStateChanged,
      [manifestEntry()],
      () => {},
      onAllSessionsChanged
    );

    const sessions = service.getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      panelId: "restored-panel",
      worktreeId: "wt-restored",
      status: "restored-stopped",
      updatedAt: 42,
    });
  });

  it("getAllSessions does not duplicate a restored entry once a live session supersedes it", async () => {
    service.dispose();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(
      ptyClient as unknown as PtyClient,
      onStateChanged,
      [manifestEntry({ panelId: "panel-1", worktreeId: "wt-1" })],
      () => {},
      onAllSessionsChanged
    );

    await service.ensure(baseRequest);

    const sessions = service.getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("starting");
  });

  it("fires onAllSessionsChanged with a full snapshot on state transitions", async () => {
    await service.ensure(baseRequest);

    expect(onAllSessionsChanged).toHaveBeenCalled();
    const lastSnapshot = onAllSessionsChanged.mock.calls.at(-1)?.[0] as DevPreviewSessionState[];
    expect(Array.isArray(lastSnapshot)).toBe(true);
    expect(lastSnapshot.some((s) => s.panelId === "panel-1")).toBe(true);
  });

  it("fires onAllSessionsChanged for compile-timer transitions that bypass updateSession", async () => {
    vi.useFakeTimers();
    const state = await service.ensure(baseRequest);
    const terminalId = state.terminalId!;
    onAllSessionsChanged.mockClear();

    // Emit a compile marker, then advance past the arm debounce so the
    // direct emitStateChanged() path in the compile timer runs.
    ptyClient.emitData(terminalId, "compiling...\n");
    await vi.advanceTimersByTimeAsync(1200);

    expect(onAllSessionsChanged).toHaveBeenCalled();
  });

  it("derives lastOutput from the buffer, ANSI-stripped and length-capped", async () => {
    const state = await service.ensure(baseRequest);
    const terminalId = state.terminalId!;

    ptyClient.emitData(terminalId, "\x1b[32mwaiting for changes\x1b[0m\n");
    expect(service.getAllSessions()[0]?.lastOutput).toBe("waiting for changes");

    const longLine = "x".repeat(300);
    ptyClient.emitData(terminalId, `${longLine}\n`);
    expect(service.getAllSessions()[0]?.lastOutput).toHaveLength(120);
  });

  it("uses the last non-empty line, skipping trailing blank lines", async () => {
    const state = await service.ensure(baseRequest);
    const terminalId = state.terminalId!;

    ptyClient.emitData(terminalId, "first line\nsecond line\n   \n");
    expect(service.getAllSessions()[0]?.lastOutput).toBe("second line");
  });

  it("reports the final carriage-return progress segment for lastOutput", async () => {
    const state = await service.ensure(baseRequest);
    const terminalId = state.terminalId!;

    ptyClient.emitData(terminalId, "Compiling 10%\rCompiling 90%\rDone!\n");
    expect(service.getAllSessions()[0]?.lastOutput).toBe("Done!");
  });

  it("restartByWorktree spawns a restore placeholder via ensure", async () => {
    service.dispose();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(
      ptyClient as unknown as PtyClient,
      onStateChanged,
      [manifestEntry({ panelId: "panel-1", worktreeId: "wt-1" })],
      () => {},
      onAllSessionsChanged
    );

    const state = await service.restartByWorktree("wt-1");

    expect(state.status).toBe("starting");
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);
    const sessions = service.getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("starting");
  });

  it("restartByWorktree returns a stopped placeholder for an unknown worktree", async () => {
    const state = await service.restartByWorktree("does-not-exist");
    expect(state.status).toBe("stopped");
    expect(ptyClient.spawn).not.toHaveBeenCalled();
  });

  it("stopByWorktree broadcasts after removing a restore-only placeholder", async () => {
    service.dispose();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionService(
      ptyClient as unknown as PtyClient,
      onStateChanged,
      [manifestEntry({ panelId: "panel-r", worktreeId: "wt-r" })],
      () => {},
      onAllSessionsChanged
    );
    onAllSessionsChanged.mockClear();

    await service.stopByWorktree("wt-r");

    expect(onAllSessionsChanged).toHaveBeenCalled();
    const last = onAllSessionsChanged.mock.calls.at(-1)?.[0] as DevPreviewSessionState[];
    expect(last).toHaveLength(0);
  });

  it("omits lastOutput once a session is stopped", async () => {
    vi.spyOn(portAllocator, "waitForPortFree").mockResolvedValue(true);
    const state = await service.ensure(baseRequest);
    const terminalId = state.terminalId!;
    ptyClient.emitData(terminalId, "some output\n");

    await service.stop({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });

    const session = service.getAllSessions().find((s) => s.panelId === "panel-1");
    expect(session?.status).toBe("stopped");
    expect(session?.lastOutput).toBeUndefined();
  });
});
