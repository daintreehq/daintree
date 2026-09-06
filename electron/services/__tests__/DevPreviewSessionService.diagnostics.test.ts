import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevPreviewSessionState } from "../../../shared/types/ipc/devPreview.js";
import type { DevPreviewManifestEntry } from "../DevPreviewManifestService.js";
import type { PtyClient } from "../PtyClient.js";
import { buildDevPreviewSubdomain } from "../../../shared/utils/devPreviewProxy.js";

// The diagnostics timeline is recorded at the lifecycle transition sites of
// DevPreviewSessionService. These tests drive the real service through the
// PTY mock and assert the ring's contents, bounds, and read snapshot — never
// the notification surfaces, which stay unchanged (all timeline events are
// Tier 0 by design).

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

type DataListener = (id: string, data: string | Uint8Array) => void;
type ExitListener = (id: string, exitCode: number, signal?: number) => void;
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
      return {
        id,
        projectId: terminal.projectId,
        hasPty: terminal.hasPty,
        cwd: "/repo",
        spawnedAt: Date.now(),
      };
    }),
    emitData(id: string, data: string | Uint8Array) {
      for (const listener of dataListeners) listener(id, data);
    },
    emitExit(id: string, exitCode: number, signal?: number) {
      const terminal = terminals.get(id);
      if (terminal) terminal.hasPty = false;
      for (const listener of exitListeners) listener(id, exitCode, signal);
    },
  };
}

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
