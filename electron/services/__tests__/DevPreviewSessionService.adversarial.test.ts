import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";
import type { PtyClient } from "../PtyClient.js";

const scanOutputMock = vi.hoisted(() =>
  vi.fn<
    (
      data: string,
      buffer: string
    ) => { buffer: string; url?: string; error?: { type: string; message: string } }
  >()
);

vi.mock("../UrlDetector.js", () => ({
  UrlDetector: class {
    scanOutput(data: string, buffer: string) {
      return scanOutputMock(data, buffer);
    }
  },
}));

vi.mock("node:http", () => ({ default: { request: vi.fn() }, request: vi.fn() }));
vi.mock("node:https", () => ({ default: { request: vi.fn() }, request: vi.fn() }));

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number) => void;
type TerminalRecord = {
  projectId?: string;
  hasPty: boolean;
};
type MockIncomingMessage = {
  statusCode?: number;
  resume: () => void;
};
type MockRequest = {
  on: (event: "error" | "timeout", handler: (...args: unknown[]) => void) => MockRequest;
  end: () => void;
  destroy: () => void;
};

function mockHttpResponse(statusCode: number): void {
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
  const terminals = new Map<string, TerminalRecord>();
  const holdAliveOnKill = new Set<string>();
  let lookupOverride:
    | ((id: string) => Promise<{
        id: string;
        projectId?: string;
        hasPty: boolean;
        cwd: string;
        spawnedAt: number;
      } | null>)
    | null = null;

  return {
    on: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") dataListeners.add(callback as DataListener);
      if (event === "exit") exitListeners.add(callback as ExitListener);
    }),
    off: vi.fn((event: string, callback: DataListener | ExitListener) => {
      if (event === "data") dataListeners.delete(callback as DataListener);
      if (event === "exit") exitListeners.delete(callback as ExitListener);
    }),
    spawn: vi.fn((id: string, options: { projectId?: string }) => {
      terminals.set(id, { projectId: options.projectId, hasPty: true });
    }),
    kill: vi.fn((id: string) => {
      const terminal = terminals.get(id);
      if (terminal && !holdAliveOnKill.has(id)) {
        terminal.hasPty = false;
      }
    }),
    submit: vi.fn(),
    hasTerminal: vi.fn((id: string) => terminals.get(id)?.hasPty ?? false),
    setIpcDataMirror: vi.fn(),
    replayHistoryAsync: vi.fn(async () => 0),
    getTerminalAsync: vi.fn(async (id: string) => {
      if (lookupOverride) {
        return lookupOverride(id);
      }
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
      for (const listener of dataListeners) {
        listener(id, data);
      }
    },
    emitExit(id: string, exitCode: number) {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.hasPty = false;
      }
      for (const listener of exitListeners) {
        listener(id, exitCode);
      }
    },
    holdOnKill(id: string) {
      holdAliveOnKill.add(id);
    },
    releaseHeldTerminal(id: string) {
      holdAliveOnKill.delete(id);
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.hasPty = false;
      }
    },
    setLookupOverride(
      fn: (id: string) => Promise<{
        id: string;
        projectId?: string;
        hasPty: boolean;
        cwd: string;
        spawnedAt: number;
      } | null>
    ) {
      lookupOverride = fn;
    },
    setTerminalProject(id: string, projectId?: string) {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.projectId = projectId;
      }
    },
  };
}

describe("DevPreviewSessionService adversarial", () => {
  const baseRequest = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
  };

  let service: (typeof import("../DevPreviewSessionService.js"))["DevPreviewSessionService"]["prototype"];
  let DevPreviewSessionServiceCtor: (typeof import("../DevPreviewSessionService.js"))["DevPreviewSessionService"];
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let onStateChanged: ReturnType<typeof vi.fn<(state: DevPreviewSessionState) => void>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
    scanOutputMock.mockImplementation((_data, buffer) => ({ buffer }));
    mockHttpResponse(200);
    ({ DevPreviewSessionService: DevPreviewSessionServiceCtor } =
      await import("../DevPreviewSessionService.js"));
    onStateChanged = vi.fn();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionServiceCtor(ptyClient as unknown as PtyClient, onStateChanged);
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("serializes ensure and stop for the same session key without leaving a respawn behind", async () => {
    const started = await service.ensure(baseRequest);
    const firstTerminalId = started.terminalId!;
    ptyClient.holdOnKill(firstTerminalId);

    const ensurePending = service.ensure({
      ...baseRequest,
      cwd: "/repo-next",
    });
    const stopPending = service.stop({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(1);

    ptyClient.releaseHeldTerminal(firstTerminalId);
    await vi.advanceTimersByTimeAsync(200);

    await expect(ensurePending).resolves.toMatchObject({ status: "starting" });
    await expect(stopPending).resolves.toMatchObject({ status: "stopped", terminalId: null });

    const finalState = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(finalState.status).toBe("stopped");
    expect(finalState.terminalId).toBeNull();
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale install exit respawn after restart", async () => {
    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("missing deps")) {
        return {
          buffer,
          error: { type: "missing-dependencies", message: "Install dependencies first" },
        };
      }
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    ptyClient.emitData(started.terminalId!, "missing deps");
    ptyClient.emitExit(started.terminalId!, 1);
    await Promise.resolve();

    const installState = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    const installTerminalId = installState.terminalId!;
    expect(installState.status).toBe("installing");

    vi.setSystemTime(new Date("2026-04-13T12:00:01.000Z"));
    const restarted = await service.restart({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    const restartedTerminalId = restarted.terminalId!;

    ptyClient.emitExit(installTerminalId, 0);

    const finalState = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(finalState.terminalId).toBe(restartedTerminalId);
    expect(finalState.terminalId).not.toBe(installTerminalId);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(3);
  });

  it("keeps same-panel sessions from different projects deterministic during concurrent ensure and stopByPanel", async () => {
    const first = await service.ensure({
      panelId: "shared-panel",
      projectId: "project-a",
      cwd: "/repo/a",
      devCommand: "npm run dev",
    });
    await service.ensure({
      panelId: "shared-panel",
      projectId: "project-b",
      cwd: "/repo/b",
      devCommand: "npm run dev",
    });

    ptyClient.holdOnKill(first.terminalId!);

    const ensurePending = service.ensure({
      panelId: "shared-panel",
      projectId: "project-a",
      cwd: "/repo/a-next",
      devCommand: "npm run dev",
    });
    const stopPending = service.stopByPanel({ panelId: "shared-panel" });

    await vi.advanceTimersByTimeAsync(200);
    ptyClient.releaseHeldTerminal(first.terminalId!);
    await vi.advanceTimersByTimeAsync(200);

    await expect(ensurePending).resolves.toMatchObject({ projectId: "project-a" });
    await expect(stopPending).resolves.toBeUndefined();

    expect(
      service.getState({ panelId: "shared-panel", projectId: "project-a" }).terminalId
    ).toBeNull();
    expect(
      service.getState({ panelId: "shared-panel", projectId: "project-b" }).terminalId
    ).toBeNull();
  });

  it("recovers from orphaned terminals whose project ownership no longer matches", async () => {
    const started = await service.ensure(baseRequest);
    const firstTerminalId = started.terminalId!;
    vi.setSystemTime(new Date("2026-04-13T12:00:01.000Z"));

    ptyClient.setLookupOverride(async (id) => {
      if (id === firstTerminalId) {
        return {
          id,
          projectId: "other-project",
          hasPty: true,
          cwd: "/repo",
          spawnedAt: Date.now(),
        };
      }
      return {
        id,
        projectId: baseRequest.projectId,
        hasPty: true,
        cwd: "/repo",
        spawnedAt: Date.now(),
      };
    });

    const recovered = await service.ensure(baseRequest);

    expect(recovered.terminalId).not.toBe(firstTerminalId);
    expect(ptyClient.setIpcDataMirror).toHaveBeenCalledWith(firstTerminalId, false);
    expect(ptyClient.spawn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated address-in-use errors from the same terminal output stream", async () => {
    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("EADDRINUSE")) {
        return {
          buffer,
          error: { type: "port-conflict", message: "Port 3000 is already in use" },
        };
      }
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    ptyClient.emitData(started.terminalId!, "EADDRINUSE");
    ptyClient.emitData(started.terminalId!, "EADDRINUSE");

    const errorStates = onStateChanged.mock.calls.filter(
      ([state]) =>
        state.status === "error" && state.error?.message === "Port 3000 is already in use"
    );
    expect(errorStates).toHaveLength(1);
  });

  it("suppresses late state changes after dispose while stop is still waiting for the terminal to die", async () => {
    const started = await service.ensure(baseRequest);
    const terminalId = started.terminalId!;
    ptyClient.holdOnKill(terminalId);

    const stopPromise = service.stop({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });

    await vi.advanceTimersByTimeAsync(100);
    const callCountBeforeDispose = onStateChanged.mock.calls.length;

    service.dispose();
    ptyClient.releaseHeldTerminal(terminalId);
    await vi.advanceTimersByTimeAsync(200);
    await expect(stopPromise).resolves.toMatchObject({ status: "stopped" });

    expect(onStateChanged.mock.calls).toHaveLength(callCountBeforeDispose);
    expect(ptyClient.off).toHaveBeenCalledTimes(2);
  });
});
