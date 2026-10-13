import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";
import type { DevPreviewManifestEntry } from "../DevPreviewManifestService.js";
import type { PtyClient } from "../PtyClient.js";
import { buildDevPreviewSubdomain } from "../../../shared/utils/devPreviewProxy.js";

const scanOutputMock = vi.hoisted(() =>
  vi.fn<
    (
      data: string,
      buffer: string
    ) => {
      buffer: string;
      url?: string;
      error?: { type: string; message: string };
      readyMarker?: boolean;
    }
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
type ExitListener = (id: string, exitCode: number, signal?: number) => void;
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
    emitExit(id: string, exitCode: number, signal?: number) {
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.hasPty = false;
      }
      for (const listener of exitListeners) {
        listener(id, exitCode, signal);
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

  it("re-probes immediately when a readiness marker arrives during the poll interval", async () => {
    // Every HEAD attempt fails, so the readiness poll stays in its sleep
    // window between attempts and never resolves on its own.
    const impl = ((_: unknown, __: unknown, _cb: (res: MockIncomingMessage) => void) => {
      const req: MockRequest = {
        on: (event, handler) => {
          if (event === "error") setTimeout(() => handler(new Error("ECONNREFUSED")), 0);
          return req;
        },
        end: () => {},
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);

    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("http://localhost")) return { buffer, url: "http://localhost:3000/" };
      if (data.includes("ready in")) return { buffer, readyMarker: true };
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    ptyClient.emitData(started.terminalId!, "Local: http://localhost:3000/");
    await vi.advanceTimersByTimeAsync(10);
    const callsAfterUrl = vi.mocked(http.request).mock.calls.length;
    expect(callsAfterUrl).toBeGreaterThanOrEqual(1);

    // Marker arrives well before the 500ms poll interval would retry — the
    // fast-path must abort the sleeping poll and re-probe right away.
    ptyClient.emitData(started.terminalId!, "VITE v6.0.0  ready in 200 ms");
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(http.request).mock.calls.length).toBeGreaterThan(callsAfterUrl);
  });

  it("handles a readiness marker that arrives before the URL without breaking startup", async () => {
    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("ready in")) return { buffer, readyMarker: true };
      if (data.includes("http://localhost")) return { buffer, url: "http://localhost:3000/" };
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    ptyClient.emitData(started.terminalId!, "VITE v6.0.0  ready in 200 ms");
    await vi.advanceTimersByTimeAsync(10);
    ptyClient.emitData(started.terminalId!, "Local: http://localhost:3000/");
    await vi.advanceTimersByTimeAsync(10);

    const finalState = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(finalState.status).toBe("running");
    expect(finalState.url).toBe("http://localhost:3000/");
  });

  it("aborts the readiness poll when an error is detected so it cannot overwrite the error state", async () => {
    let failHead = true;
    const impl = ((_: unknown, __: unknown, cb: (res: MockIncomingMessage) => void) => {
      const req: MockRequest = {
        on: (event, handler) => {
          if (event === "error" && failHead) {
            setTimeout(() => handler(new Error("ECONNREFUSED")), 0);
          }
          return req;
        },
        end: () => {
          if (!failHead) cb({ statusCode: 200, resume: () => {} });
        },
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);

    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("http://localhost")) return { buffer, url: "http://localhost:3000/" };
      if (data.includes("missing deps")) {
        return {
          buffer,
          error: { type: "missing-dependencies", message: "Install dependencies first" },
        };
      }
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    ptyClient.emitData(started.terminalId!, "Local: http://localhost:3000/");
    await vi.advanceTimersByTimeAsync(10); // first HEAD fails, poll enters its sleep

    ptyClient.emitData(started.terminalId!, "missing deps");
    // HEAD would now succeed — but the error detection must have aborted the
    // poll, so it can never flip the session back to "running".
    failHead = false;
    await vi.advanceTimersByTimeAsync(1000);

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    // Missing dependencies are observed, not yet acted on — the install only
    // starts once the command exits, so the session is still "starting".
    expect(state.status).toBe("starting");
    expect(state.error?.type).toBe("missing-dependencies");
  });

  it("lets a fresh URL's readiness marker accelerate again after a prior marker", async () => {
    const impl = ((_: unknown, __: unknown, _cb: (res: MockIncomingMessage) => void) => {
      const req: MockRequest = {
        on: (event, handler) => {
          if (event === "error") setTimeout(() => handler(new Error("ECONNREFUSED")), 0);
          return req;
        },
        end: () => {},
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);

    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("localhost:3001")) return { buffer, url: "http://localhost:3001/" };
      if (data.includes("localhost:3000")) return { buffer, url: "http://localhost:3000/" };
      if (data.includes("ready in")) return { buffer, readyMarker: true };
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    ptyClient.emitData(started.terminalId!, "Local: http://localhost:3000/");
    await vi.advanceTimersByTimeAsync(10);
    ptyClient.emitData(started.terminalId!, "VITE v6.0.0  ready in 200 ms");
    await vi.advanceTimersByTimeAsync(10);

    // Port change → new poll. markerSeen must reset so the new ready line
    // accelerates the new poll too.
    ptyClient.emitData(started.terminalId!, "Port in use, switching to http://localhost:3001/");
    await vi.advanceTimersByTimeAsync(10);
    const callsBeforeSecondMarker = vi.mocked(http.request).mock.calls.length;
    ptyClient.emitData(started.terminalId!, "VITE v6.0.0  ready in 180 ms");
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(http.request).mock.calls.length).toBeGreaterThan(callsBeforeSecondMarker);
  });

  // #12299: the predicted-port path polls the allocator's URL but never sets
  // pendingUrl (two recovery paths read that field as "a URL was seen in
  // output"), so marker acceleration was gated off for the whole common case
  // where the framework prints its ready line before its URL line.
  it("lets a readiness marker accelerate a predicted-port poll with no URL in output", async () => {
    const impl = ((_: unknown, __: unknown, _cb: (res: MockIncomingMessage) => void) => {
      const req: MockRequest = {
        on: (event, handler) => {
          if (event === "error") setTimeout(() => handler(new Error("ECONNREFUSED")), 0);
          return req;
        },
        end: () => {},
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);

    // No URL is ever detected — only the ready marker.
    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("ready in")) return { buffer, readyMarker: true };
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    // Let the predicted-port poll start and settle into its poll interval.
    await vi.advanceTimersByTimeAsync(50);
    const callsBeforeMarker = vi.mocked(http.request).mock.calls.length;
    expect(callsBeforeMarker).toBeGreaterThan(0);

    ptyClient.emitData(started.terminalId!, "VITE v6.0.0  ready in 200 ms");
    await vi.advanceTimersByTimeAsync(10);

    expect(vi.mocked(http.request).mock.calls.length).toBeGreaterThan(callsBeforeMarker);
  });

  // The terminal must stay attached for this to reach the guard at all — a
  // stopped session is filtered out much earlier, and stop() clears
  // predictedUrl too. An output error is the case that leaves predictedUrl set
  // and readinessAbort null on a live terminal.
  it("ignores a readiness marker when no readiness poll is in flight", async () => {
    const impl = ((_: unknown, __: unknown, _cb: (res: MockIncomingMessage) => void) => {
      const req: MockRequest = {
        on: (event, handler) => {
          if (event === "error") setTimeout(() => handler(new Error("ECONNREFUSED")), 0);
          return req;
        },
        end: () => {},
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);

    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("ready in")) return { buffer, readyMarker: true };
      if (data.includes("Cannot find module")) {
        return {
          buffer,
          error: { type: "missing-dependencies", message: "Cannot find module 'x'" },
        };
      }
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    await vi.advanceTimersByTimeAsync(50);

    // Aborts the poll and nulls readinessAbort, without exiting the terminal.
    ptyClient.emitData(started.terminalId!, "Error: Cannot find module 'x'");
    await vi.advanceTimersByTimeAsync(10);
    const callsAfterError = vi.mocked(http.request).mock.calls.length;

    ptyClient.emitData(started.terminalId!, "VITE v6.0.0  ready in 200 ms");
    await vi.advanceTimersByTimeAsync(50);

    // predictedUrl is still set, so only the liveness check stops the marker
    // from resurrecting a probe the error deliberately cancelled.
    expect(vi.mocked(http.request).mock.calls.length).toBe(callsAfterError);
    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.error?.type).toBe("missing-dependencies");
  });

  // #12299: the 5xx latch is carried across re-probes within a launch, so it
  // must die with the launch. Inheriting it would make a healthy restart wait an
  // extra poll round for a compiling shell the previous launch saw.
  it("does not inherit a previous launch's 5xx history across a restart", async () => {
    let status = 500;
    const impl = ((_: unknown, __: unknown, cb: (res: MockIncomingMessage) => void) => {
      const req: MockRequest = {
        on: () => req,
        end: () => setTimeout(() => cb({ statusCode: status, resume: () => {} }), 0),
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);

    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("localhost:3000")) return { buffer, url: "http://localhost:3000/" };
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    ptyClient.emitData(started.terminalId!, "Local: http://localhost:3000/");
    // Let the launch observe a 5xx and latch it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId }).status
    ).toBe("starting");

    // A restart is a new launch; its server is healthy from the first response.
    status = 200;
    await service.restart({ panelId: baseRequest.panelId, projectId: baseRequest.projectId });
    const restarted = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    ptyClient.emitData(restarted.terminalId!, "Local: http://localhost:3000/");

    // Under an inherited latch the first 200 would only arm a confirmation and
    // this would still be "starting" until another poll round.
    await vi.advanceTimersByTimeAsync(100);
    expect(
      service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId }).status
    ).toBe("running");
  });

  // #12299: every marker- or URL-triggered re-probe used to hand
  // waitForServerReady a fresh READINESS_TIMEOUT_MS, so the 30s the error
  // message quotes could stretch to a multiple of itself. One budget per launch.
  it("does not extend the readiness budget across re-probes", async () => {
    const impl = ((_: unknown, __: unknown, _cb: (res: MockIncomingMessage) => void) => {
      const req: MockRequest = {
        on: (event, handler) => {
          if (event === "error") setTimeout(() => handler(new Error("ECONNREFUSED")), 0);
          return req;
        },
        end: () => {},
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);

    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("localhost:3001")) return { buffer, url: "http://localhost:3001/" };
      if (data.includes("localhost:3000")) return { buffer, url: "http://localhost:3000/" };
      if (data.includes("ready in")) return { buffer, readyMarker: true };
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    await vi.advanceTimersByTimeAsync(50);

    // Each of these replaces the in-flight wait. Under the old code every one
    // of them restarted the 30s clock.
    ptyClient.emitData(started.terminalId!, "Local: http://localhost:3000/");
    await vi.advanceTimersByTimeAsync(10_000);
    ptyClient.emitData(started.terminalId!, "VITE v6.0.0  ready in 200 ms");
    await vi.advanceTimersByTimeAsync(10_000);
    ptyClient.emitData(started.terminalId!, "Port taken, using http://localhost:3001/");
    await vi.advanceTimersByTimeAsync(9_000);

    // Still inside the original 30s — the launch has not given up yet.
    expect(
      service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId }).status
    ).toBe("starting");

    // Crossing the ORIGINAL deadline ends it, rather than a fourth fresh 30s.
    await vi.advanceTimersByTimeAsync(3_000);
    const after = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(after.status).toBe("error");
    expect(after.error?.message).toContain("did not respond");
  });

  // #12299: the readiness budget is per launch, but an output error aborts the
  // poll without ending the launch. If the spent deadline survived, the next
  // probe would inherit ~0ms and report "did not respond within 30 seconds"
  // without having waited at all.
  it("does not charge a new readiness probe for time spent in an error state", async () => {
    let failHttp = true;
    const impl = ((_: unknown, __: unknown, cb: (res: MockIncomingMessage) => void) => {
      const req: MockRequest = {
        on: (event, handler) => {
          if (event === "error" && failHttp) {
            setTimeout(() => handler(new Error("ECONNREFUSED")), 0);
          }
          return req;
        },
        end: () => {
          if (!failHttp) setTimeout(() => cb({ statusCode: 200, resume: () => {} }), 0);
        },
        destroy: () => {},
      };
      return req;
    }) as unknown as typeof http.request;
    vi.mocked(http.request).mockImplementation(impl);

    scanOutputMock.mockImplementation((data, buffer) => {
      if (data.includes("localhost:3000")) return { buffer, url: "http://localhost:3000/" };
      if (data.includes("Cannot find module")) {
        return {
          buffer,
          error: { type: "missing-dependencies", message: "Cannot find module 'x'" },
        };
      }
      return { buffer };
    });

    const started = await service.ensure(baseRequest);
    await vi.advanceTimersByTimeAsync(50);

    // An output error aborts the in-flight poll but leaves the launch alive.
    ptyClient.emitData(started.terminalId!, "Error: Cannot find module 'x'");
    await vi.advanceTimersByTimeAsync(10);

    // The session then sits in that state for longer than the whole budget.
    await vi.advanceTimersByTimeAsync(60_000);

    // A URL now shows up (a replay after remount, or the server recovering),
    // but the server needs several seconds before it answers. A probe charged
    // the spent budget would have given up long before that — so the wait here
    // is what proves the budget was genuinely restored, not merely non-zero.
    ptyClient.emitData(started.terminalId!, "Local: http://localhost:3000/");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(
      service.getState({ panelId: baseRequest.panelId, projectId: baseRequest.projectId }).status
    ).toBe("starting");

    failHttp = false;
    await vi.advanceTimersByTimeAsync(1_000);

    const state = service.getState({
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
    });
    expect(state.status).toBe("running");
    expect(state.url).toBe("http://localhost:3000/");
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
    // data, data-mirror, exit, and project-kill-requested listeners all detach on dispose.
    expect(ptyClient.off).toHaveBeenCalledTimes(4);
  });
});

// The diagnostics timeline is recorded at the lifecycle transition sites of
// DevPreviewSessionService. These tests drive the real service through the
// PTY mock and assert the ring's contents, bounds, and read snapshot — never
// the notification surfaces, which stay unchanged (all timeline events are
// Tier 0 by design).

describe("DevPreviewSessionService diagnostics", () => {
  const baseRequest = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/repo",
    devCommand: "npm run dev",
  };
  const stateRequest = { panelId: baseRequest.panelId, projectId: baseRequest.projectId };
  const subdomain = buildDevPreviewSubdomain(baseRequest.projectId, baseRequest.panelId);

  let service: (typeof import("../DevPreviewSessionService.js"))["DevPreviewSessionService"]["prototype"];
  let DevPreviewSessionServiceCtor: (typeof import("../DevPreviewSessionService.js"))["DevPreviewSessionService"];
  let DIAGNOSTIC_RING_MAX: number;
  let ptyClient: ReturnType<typeof createPtyClientMock>;
  let onStateChanged: ReturnType<typeof vi.fn<(state: DevPreviewSessionState) => void>>;

  beforeEach(async () => {
    scanOutputMock.mockImplementation((_data, buffer) => ({ buffer }));
    mockHttpResponse(200);
    const mod = await import("../DevPreviewSessionService.js");
    DevPreviewSessionServiceCtor = mod.DevPreviewSessionService;
    DIAGNOSTIC_RING_MAX = mod.DIAGNOSTIC_RING_MAX;
    onStateChanged = vi.fn();
    ptyClient = createPtyClientMock();
    service = new DevPreviewSessionServiceCtor(ptyClient as unknown as PtyClient, onStateChanged);
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
  });

  function eventTypes(): string[] {
    return service.getDiagnostics(stateRequest).events.map((event) => event.type);
  }

  it("records the ensure → spawn → url → running lifecycle in order with monotonic seq", async () => {
    const started = await service.ensure(baseRequest);
    const terminalId = started.terminalId!;

    scanOutputMock.mockImplementation((_data, buffer) => ({
      buffer,
      url: "http://localhost:4173",
    }));
    ptyClient.emitData(terminalId, "ready at http://localhost:4173\n");

    await vi.waitFor(() => {
      expect(service.getState(stateRequest).status).toBe("running");
    });

    const snapshot = service.getDiagnostics(stateRequest);
    const types = snapshot.events.map((event) => event.type);
    const expectedOrder = [
      "ensure-requested",
      "config-changed",
      "port-allocated",
      "spawned",
      "url-detected",
      "readiness-probe-succeeded",
    ] as const;
    let cursor = -1;
    for (const expected of expectedOrder) {
      const index = types.indexOf(expected, cursor + 1);
      expect(index, `${expected} should appear after index ${cursor}`).toBeGreaterThan(cursor);
      cursor = index;
    }

    const seqs = snapshot.events.map((event) => event.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }

    // One spawn lifecycle = one generation, from port allocation onward.
    const portAllocated = snapshot.events.find((event) => event.type === "port-allocated")!;
    const spawned = snapshot.events.find((event) => event.type === "spawned")!;
    expect(portAllocated.generation).toBe(spawned.generation);

    expect(snapshot.status).toBe("running");
    expect(snapshot.detectedUrl).toMatch(/^http:\/\/localhost:4173\/?$/);
    expect(snapshot.allocatedPort).not.toBeNull();
    expect(snapshot.restoredFromManifest).toBe(false);
  });

  // #12299: "command launched" and "server responding" have to be separate
  // observations rather than things inferred from the poll's outcome.
  describe("startup observations (#12299)", () => {
    it("records command-submitted and first-output once per launch", async () => {
      const started = await service.ensure(baseRequest);
      const terminalId = started.terminalId!;

      expect(eventTypes().filter((t) => t === "command-submitted")).toHaveLength(1);
      expect(eventTypes()).not.toContain("first-output");

      ptyClient.emitData(terminalId, "starting up\n");
      ptyClient.emitData(terminalId, "still starting\n");

      expect(eventTypes().filter((t) => t === "first-output")).toHaveLength(1);
    });

    it("does not count an empty chunk as first output", async () => {
      const started = await service.ensure(baseRequest);
      ptyClient.emitData(started.terminalId!, "");
      expect(eventTypes()).not.toContain("first-output");
    });

    it("names the predicted URL as the probe's first candidate", async () => {
      await service.ensure(baseRequest);
      await vi.waitFor(() => {
        expect(eventTypes()).toContain("candidate-url-chosen");
      });
      const chosen = service
        .getDiagnostics(stateRequest)
        .events.filter((event) => event.type === "candidate-url-chosen");
      expect(chosen[0]).toMatchObject({ source: "predicted" });
    });

    it("records the URL from output as an output-sourced candidate", async () => {
      const started = await service.ensure(baseRequest);
      scanOutputMock.mockImplementation((_data, buffer) => ({
        buffer,
        url: "http://localhost:4173",
      }));
      ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

      await vi.waitFor(() => {
        expect(service.getState(stateRequest).status).toBe("running");
      });

      const chosen = service
        .getDiagnostics(stateRequest)
        .events.filter((event) => event.type === "candidate-url-chosen");
      expect(chosen.some((event) => "source" in event && event.source === "output")).toBe(true);
    });

    it("records a settled HTTP attempt with its status and budget", async () => {
      const started = await service.ensure(baseRequest);
      scanOutputMock.mockImplementation((_data, buffer) => ({
        buffer,
        url: "http://localhost:4173",
      }));
      ptyClient.emitData(started.terminalId!, "ready at http://localhost:4173\n");

      await vi.waitFor(() => {
        expect(service.getState(stateRequest).status).toBe("running");
      });

      const attempt = service
        .getDiagnostics(stateRequest)
        .events.find((event) => event.type === "readiness-http-attempt");
      expect(attempt).toMatchObject({ outcome: "reachable", status: 200, attempt: 1 });
    });

    it("records a recognized ready marker", async () => {
      const started = await service.ensure(baseRequest);
      scanOutputMock.mockImplementation((_data, buffer) => ({ buffer, readyMarker: true }));
      ptyClient.emitData(started.terminalId!, "VITE v8.0.1 ready in 87 ms\n");

      const recognized = service
        .getDiagnostics(stateRequest)
        .events.filter((event) => event.type === "marker-recognized");
      expect(recognized).toHaveLength(1);
      expect(recognized[0]).toMatchObject({ marker: "ready" });
    });
  });

  it("records a repeat ensure as configChanged:false without a second spawn", async () => {
    await service.ensure(baseRequest);
    const spawnsAfterFirst = ptyClient.spawn.mock.calls.length;
    await service.ensure(baseRequest);

    expect(ptyClient.spawn.mock.calls.length).toBe(spawnsAfterFirst);
    const ensures = service
      .getDiagnostics(stateRequest)
      .events.filter((event) => event.type === "ensure-requested");
    expect(ensures).toHaveLength(2);
    expect(ensures[0]).toMatchObject({ configChanged: true });
    expect(ensures[1]).toMatchObject({ configChanged: false });
    expect(eventTypes().filter((type) => type === "spawned")).toHaveLength(1);
  });

  it("names the changed fields on a config change", async () => {
    await service.ensure(baseRequest);
    await service.ensure({ ...baseRequest, devCommand: "npm run start" });

    const changes = service
      .getDiagnostics(stateRequest)
      .events.filter((event) => event.type === "config-changed");
    expect(changes[changes.length - 1]).toMatchObject({ changed: ["devCommand"] });
  });

  it("records command-invalid instead of spawning for a rejected command", async () => {
    const state = await service.ensure({ ...baseRequest, devCommand: "npm run dev\necho hi" });

    expect(state.status).toBe("error");
    const types = eventTypes();
    expect(types).toContain("command-invalid");
    expect(types).not.toContain("spawned");
  });

  it("caps free-text detail fields", async () => {
    const started = await service.ensure(baseRequest);
    scanOutputMock.mockImplementation((_data, buffer) => ({
      buffer,
      error: { type: "unknown", message: "x".repeat(1000) },
    }));
    ptyClient.emitData(started.terminalId!, "boom");

    const event = service
      .getDiagnostics(stateRequest)
      .events.find((entry) => entry.type === "output-error");
    expect(event).toBeDefined();
    expect(event!.type === "output-error" && event!.message.length).toBeLessThanOrEqual(200);
  });

  it("bounds the ring at DIAGNOSTIC_RING_MAX and keeps the newest events", async () => {
    await service.ensure(baseRequest);
    // Alternating causes defeat coalescing so every report is its own event.
    for (let i = 0; i < DIAGNOSTIC_RING_MAX + 40; i++) {
      service.recordProxyDiagnostic({
        subdomain,
        kind: "http",
        cause: i % 2 === 0 ? "upstream-refused" : "upstream-error",
      });
    }

    const snapshot = service.getDiagnostics(stateRequest);
    expect(snapshot.events).toHaveLength(DIAGNOSTIC_RING_MAX);
    // Eviction shows as a seq gap at the head, not silence.
    expect(snapshot.events[0]!.seq).toBeGreaterThan(0);
    const last = snapshot.events[snapshot.events.length - 1]!;
    expect(last.type).toBe("proxy-502");
  });

  it("coalesces consecutive identical proxy failures into one counted event", async () => {
    await service.ensure(baseRequest);
    for (let i = 0; i < 5; i++) {
      service.recordProxyDiagnostic({
        subdomain,
        kind: "http",
        cause: "upstream-refused",
        code: "ECONNREFUSED",
      });
    }

    const proxyEvents = service
      .getDiagnostics(stateRequest)
      .events.filter((event) => event.type === "proxy-502");
    expect(proxyEvents).toHaveLength(1);
    expect(proxyEvents[0]!.count).toBe(5);
  });

  it("does not coalesce proxy failures with different errno codes", async () => {
    await service.ensure(baseRequest);
    service.recordProxyDiagnostic({
      subdomain,
      kind: "http",
      cause: "upstream-error",
      code: "ECONNRESET",
    });
    service.recordProxyDiagnostic({
      subdomain,
      kind: "http",
      cause: "upstream-error",
      code: "EPIPE",
    });

    const proxyEvents = service
      .getDiagnostics(stateRequest)
      .events.filter((event) => event.type === "proxy-502");
    expect(proxyEvents).toHaveLength(2);
  });

  it("does not coalesce proxy failures across a restart's generation bump", async () => {
    await service.ensure(baseRequest);
    service.recordProxyDiagnostic({ subdomain, kind: "http", cause: "not-running" });
    await service.restart(stateRequest);
    service.recordProxyDiagnostic({ subdomain, kind: "http", cause: "not-running" });

    const proxyEvents = service
      .getDiagnostics(stateRequest)
      .events.filter((event) => event.type === "proxy-502");
    expect(proxyEvents).toHaveLength(2);
    expect(proxyEvents[1]!.generation).toBeGreaterThan(proxyEvents[0]!.generation);
  });

  it("keeps a returned snapshot stable when later reports coalesce in place", async () => {
    await service.ensure(baseRequest);
    service.recordProxyDiagnostic({ subdomain, kind: "http", cause: "upstream-refused" });

    const before = service.getDiagnostics(stateRequest);
    const beforeEvent = before.events.find((event) => event.type === "proxy-502")!;
    expect(beforeEvent.count).toBeUndefined();

    service.recordProxyDiagnostic({ subdomain, kind: "http", cause: "upstream-refused" });

    // The earlier snapshot must not have been mutated by the coalesced repeat.
    expect(beforeEvent.count).toBeUndefined();
    const after = service
      .getDiagnostics(stateRequest)
      .events.find((event) => event.type === "proxy-502")!;
    expect(after.count).toBe(2);
  });

  it("drops proxy reports whose subdomain matches no session", async () => {
    await service.ensure(baseRequest);
    const before = service.getDiagnostics(stateRequest).events.length;

    expect(() =>
      service.recordProxyDiagnostic({
        subdomain: "dp-nope-nope",
        kind: "http",
        cause: "no-session",
      })
    ).not.toThrow();
    expect(service.getDiagnostics(stateRequest).events.length).toBe(before);
  });

  it("classifies upstream resolution for live, stopped, restored, and unknown panels", async () => {
    const started = await service.ensure(baseRequest);

    // Starting (no detected URL yet): dial the allocated port over plain HTTP.
    const startingResolution = service.resolveUpstream(subdomain);
    expect(startingResolution.kind).toBe("ok");

    scanOutputMock.mockImplementation((_data, buffer) => ({
      buffer,
      url: "https://localhost:8443",
    }));
    ptyClient.emitData(started.terminalId!, "ready\n");
    await vi.waitFor(() => {
      expect(service.getState(stateRequest).status).toBe("running");
    });
    expect(service.resolveUpstream(subdomain)).toEqual({
      kind: "ok",
      port: 8443,
      isHttps: true,
    });

    await service.stop(stateRequest);
    expect(service.resolveUpstream(subdomain)).toEqual({
      kind: "not-running",
      status: "stopped",
    });

    expect(service.resolveUpstream("dp-nope-nope")).toEqual({ kind: "unknown-subdomain" });
  });

  it("resolves a restore placeholder as not-running with restored-stopped status", () => {
    service.dispose();
    const entry: DevPreviewManifestEntry = {
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
      worktreeId: "wt-1",
      cwd: "/repo",
      devCommand: "npm run dev",
      turbopackEnabled: true,
      lastKnownPort: 5173,
      capturedAt: Date.now(),
    };
    service = new DevPreviewSessionServiceCtor(ptyClient as unknown as PtyClient, onStateChanged, [
      entry,
    ]);

    expect(service.resolveUpstream(subdomain)).toEqual({
      kind: "not-running",
      status: "restored-stopped",
    });
    const snapshot = service.getDiagnostics(stateRequest);
    expect(snapshot.status).toBe("restored-stopped");
    expect(snapshot.restoredFromManifest).toBe(true);
    expect(snapshot.events).toHaveLength(0);
  });

  it("records manifest-restored when an ensure supersedes a restore placeholder", async () => {
    service.dispose();
    const entry: DevPreviewManifestEntry = {
      panelId: baseRequest.panelId,
      projectId: baseRequest.projectId,
      worktreeId: "wt-1",
      cwd: "/repo",
      devCommand: "npm run dev",
      turbopackEnabled: true,
      lastKnownPort: 5173,
      capturedAt: Date.now(),
    };
    service = new DevPreviewSessionServiceCtor(ptyClient as unknown as PtyClient, onStateChanged, [
      entry,
    ]);

    await service.ensure(baseRequest);

    const snapshot = service.getDiagnostics(stateRequest);
    expect(snapshot.events.map((event) => event.type)).toContain("manifest-restored");
    expect(snapshot.restoredFromManifest).toBe(true);
  });

  it("keeps the timeline readable after hibernation deletes the session", async () => {
    await service.ensure(baseRequest);
    await service.stopByProject(baseRequest.projectId);

    const snapshot = service.getDiagnostics(stateRequest);
    expect(snapshot.status).toBe("stopped");
    const stops = snapshot.events.filter((event) => event.type === "stop-requested");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ context: "project-hibernated" });
  });

  it("records restart-requested with the tier that was invoked", async () => {
    await service.ensure(baseRequest);
    await service.restart(stateRequest);
    await service.restartAndClearCache(stateRequest);

    const restarts = service
      .getDiagnostics(stateRequest)
      .events.filter((event) => event.type === "restart-requested");
    expect(restarts.map((event) => event.type === "restart-requested" && event.mode)).toEqual([
      "restart",
      "clear-cache",
    ]);
  });

  it("records terminal-exited with exit code and signal", async () => {
    const started = await service.ensure(baseRequest);
    ptyClient.emitExit(started.terminalId!, 137, 9);

    const exited = service
      .getDiagnostics(stateRequest)
      .events.find((event) => event.type === "terminal-exited");
    expect(exited).toMatchObject({ exitCode: 137, signal: 9 });
  });

  it("records the install cycle and crash-loop backoff", async () => {
    scanOutputMock.mockImplementation((data, buffer) => {
      if (typeof data === "string" && data.includes("missing deps")) {
        return {
          buffer,
          error: { type: "missing-dependencies", message: "Cannot find module 'react'" },
        };
      }
      return { buffer };
    });

    const started = await service.ensure(baseRequest);

    // First cycle: immediate reinstall (no backoff event).
    ptyClient.emitData(started.terminalId!, "missing deps");
    ptyClient.emitExit(started.terminalId!, 1);
    expect(service.getState(stateRequest).status).toBe("installing");
    const installId = service.getState(stateRequest).terminalId!;

    // Install succeeds -> dev server respawns (fast, so still inside the
    // crash-loop window).
    ptyClient.emitExit(installId, 0);
    await vi.waitFor(() => {
      expect(service.getState(stateRequest).terminalId).not.toBe(installId);
      expect(service.getState(stateRequest).terminalId).not.toBeNull();
    });

    // Second fast cycle: reinstall goes behind the geometric backoff.
    const devId = service.getState(stateRequest).terminalId!;
    ptyClient.emitData(devId, "missing deps");
    ptyClient.emitExit(devId, 1);

    const types = eventTypes();
    expect(types).toContain("install-started");
    expect(types).toContain("install-completed");
    const backoff = service
      .getDiagnostics(stateRequest)
      .events.find((event) => event.type === "crash-loop-backoff");
    expect(backoff).toMatchObject({ attempt: 2 });
    expect(service.getDiagnostics(stateRequest).crashLoop.backoffPending).toBe(true);
  });

  it("returns an empty snapshot for a panel that never existed", () => {
    const snapshot = service.getDiagnostics({ panelId: "ghost", projectId: "nowhere" });

    expect(snapshot.status).toBe("stopped");
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.allocatedPort).toBeNull();
    expect(snapshot.detectedUrl).toBeNull();
    expect(snapshot.upstream).toEqual({ kind: "unknown-subdomain" });
    expect(snapshot.crashLoop).toEqual({ count: 0, stopped: false, backoffPending: false });
  });

  it("rejects malformed diagnostics requests", () => {
    expect(() => service.getDiagnostics({ panelId: "", projectId: baseRequest.projectId })).toThrow(
      "panelId is required"
    );
    expect(() => service.getDiagnostics({ panelId: baseRequest.panelId, projectId: "  " })).toThrow(
      "projectId is required"
    );
  });

  it("clears all rings on dispose", async () => {
    await service.ensure(baseRequest);
    expect(service.getDiagnostics(stateRequest).events.length).toBeGreaterThan(0);

    service.dispose();

    expect(service.getDiagnostics(stateRequest).events).toHaveLength(0);
  });
});
