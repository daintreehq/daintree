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
    spawn: vi.fn((id: string, spawnOptions: { projectId?: string }) => {
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
