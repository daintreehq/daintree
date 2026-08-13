import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import type { Project } from "../../../../shared/types/project.js";
import {
  REMOTE_GATEWAY_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  RemoteEnvelopeSchema,
  parseRemoteFrame,
  type RemoteEnvelope,
} from "../../../../shared/types/remote/index.js";
import type { WorktreeSnapshot } from "../../../../shared/types/workspace-host.js";
import { createRemoteApplicationHandler } from "../RemoteApplicationHandler.js";
import type { RemoteAuthenticationService } from "../RemoteAuthenticationService.js";
import { RemoteConsoleObservationService } from "../RemoteConsoleObservationService.js";
import {
  remoteMutationFingerprint,
  RemoteIdempotencyConflictError,
  type RemoteMutationExecution,
  type RemoteMutationRequest,
  type RemoteMutationResult,
} from "../RemoteMutationLedgerService.js";
import { RemoteProjectDetailProjectionService } from "../RemoteProjectDetailProjectionService.js";
import { RemoteProjectProjectionService } from "../RemoteProjectProjectionService.js";
import { RemoteProjectViewError } from "../RemoteProjectViewBroker.js";
import { RemotePromptSubmissionService } from "../RemotePromptSubmissionService.js";
import { RemoteProtocolRouter } from "../RemoteProtocolRouter.js";
import { RemoteSessionRegistry } from "../RemoteSessionRegistry.js";
import type { RemoteConnection } from "../RemoteConnection.js";

class TestConnection implements RemoteConnection {
  readonly events = new EventEmitter();
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;

  constructor(
    readonly id: string,
    readonly sourceAddress = "192.168.50.8"
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  onMessage(listener: (data: string) => void): () => void {
    this.events.on("message", listener);
    return () => this.events.off("message", listener);
  }

  onClose(listener: () => void): () => void {
    this.events.on("close", listener);
    return () => this.events.off("close", listener);
  }

  receive(value: unknown): void {
    this.events.emit("message", typeof value === "string" ? value : JSON.stringify(value));
  }
}

class MemoryMutationLedger {
  private readonly pending = new Map<string, Promise<RemoteMutationResult>>();

  constructor(
    private readonly records = new Map<
      string,
      { digest: string; operation: string; result: RemoteMutationResult }
    >()
  ) {}

  async execute(
    request: RemoteMutationRequest,
    effect: () => Promise<RemoteMutationResult>
  ): Promise<RemoteMutationExecution> {
    const key = `${request.deviceId}:${request.idempotencyKey}`;
    const digest = remoteMutationFingerprint(request.operation, request.arguments);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.digest !== digest || existing.operation !== request.operation) {
        throw new RemoteIdempotencyConflictError();
      }
      return { replayed: true, result: existing.result };
    }
    const current = this.pending.get(key);
    if (current) return { replayed: true, result: await current };
    const execution = effect();
    this.pending.set(key, execution);
    const result = await execution;
    this.records.set(key, { digest, operation: request.operation, result });
    this.pending.delete(key);
    return { replayed: false, result };
  }

  status(deviceId: string, idempotencyKey: string): RemoteMutationResult | null {
    return this.records.get(`${deviceId}:${idempotencyKey}`)?.result ?? null;
  }
}

interface HarnessOptions {
  ledgerRecords?: Map<string, { digest: string; operation: string; result: RemoteMutationResult }>;
  submit?: ReturnType<typeof vi.fn>;
}

function project(): Project {
  return {
    id: "project-portal",
    path: "/private/secret/repositories/portal",
    name: "Portal",
    emoji: "🌲",
    status: "background",
    lastOpened: 10,
  };
}

function worktree(): WorktreeSnapshot {
  return {
    id: "worktree-source-main",
    worktreeId: "worktree-source-main",
    path: "/private/secret/worktrees/portal-main",
    name: "Portal main",
    branch: "develop",
    isCurrent: false,
    isMainWorktree: true,
  };
}

function fleet(): FleetSnapshot {
  return {
    runs: [
      {
        runId: "panel-live",
        workspaceId: "project-portal",
        worktreeId: "worktree-source-main",
        agentId: "codex",
        agentState: "waiting",
        waitingReason: "prompt",
        since: 20,
        spawnedAt: 15,
        cwd: "/private/secret/worktrees/portal-main",
        title: "content-canary-from-terminal",
      },
    ],
    changedAt: 20,
    degraded: false,
    lastSuccessfulAt: 20,
  };
}

function request(sessionId: string, type: string, requestId: string, payload: unknown) {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    sessionId,
    kind: "request",
    type,
    requestId,
    payload,
  };
}

function frames(connection: TestConnection): RemoteEnvelope[] {
  return connection.sent.map((frame) => {
    const parsed = parseRemoteFrame(frame, 6 * 1024 * 1024);
    if (!parsed.ok) {
      const decoded = JSON.parse(frame) as { type?: string };
      const details = RemoteEnvelopeSchema.safeParse(decoded);
      throw new Error(
        `${parsed.error.code}:${decoded.type ?? "unknown"}:${details.success ? "valid" : JSON.stringify(details.error.issues)}`
      );
    }
    return parsed.envelope;
  });
}

function response(connection: TestConnection, requestId: string): RemoteEnvelope | undefined {
  return frames(connection).find(
    (item) => item.kind === "response" && item.requestId === requestId
  );
}

function createHarness(options: HarnessOptions = {}) {
  let generation = 4;
  let revoked = false;
  let authenticationExpired = false;
  const foregroundProjectId = "foreground-project";
  const workspaceReads: string[] = [];
  const projectSource = project();
  const fleetSource = fleet();
  const projects = {
    getAllProjects: () => [projectSource],
    getProjectById: (id: string) => (id === projectSource.id ? projectSource : null),
  };
  const projection = new RemoteProjectProjectionService(projects, {
    getLastBroadcast: () => fleetSource,
  });
  const detailProjection = new RemoteProjectDetailProjectionService(
    projects,
    {
      getAllStatesForProjectAsync: async (path) => {
        workspaceReads.push(path);
        return [worktree()];
      },
    },
    { getLastBroadcast: () => fleetSource },
    {
      get: () => ({
        projectId: projectSource.id,
        rendererGeneration: 7,
        revision: 11,
        status: "available" as const,
        panels: [
          {
            panelId: "panel-live",
            worktreeSourceId: "worktree-source-main",
            agentId: "codex",
            displayName: "Codex",
            title: "/private/secret/prompts/do-not-leak",
            spawnedAt: 15,
            spawnedRemotely: false,
            resumable: true,
            connectionState: "live" as const,
          },
        ],
      }),
    },
    { currentGeneration: () => generation }
  );
  const sessions = new RemoteSessionRegistry();
  const authentication = {
    authenticateClientChallenge: () =>
      authenticationExpired
        ? { authenticated: false as const, reason: "invalid" as const }
        : {
            authenticated: true as const,
            deviceId: "device-phone",
            capabilities: ["observe-projects", "prompt-agents"] as const,
            hostSignature: "host-signature-value",
          },
  } as unknown as RemoteAuthenticationService;
  const router = new RemoteProtocolRouter(sessions, authentication, "0.30.1");
  const ptyEvents = new EventEmitter();
  const observation = {
    mode: "snapshot" as "snapshot" | "resume" | "resync",
    throughSeq: 0,
    state: { data: "sanitized-console-snapshot", cols: 80, rows: 24 } as {
      data: string;
      cols: number;
      rows: number;
    } | null,
    chunks: [] as Array<{
      seq: number;
      data: string;
      encoding: "base64";
      bytes: number;
    }>,
    reason: undefined as "gap" | "generation-changed" | undefined,
  };
  const beginConsoleObservation = vi.fn(async () => ({ ...observation }));
  const endConsoleObservation = vi.fn();
  const pty = Object.assign(ptyEvents, { beginConsoleObservation, endConsoleObservation });
  let streamNumber = 0;
  const consoleObservation = new RemoteConsoleObservationService(
    detailProjection,
    pty,
    sessions,
    router,
    () => `stream-${++streamNumber}`
  );
  const submit =
    options.submit ??
    vi.fn(async () => ({ accepted: true as const, launchGeneration: generation }));
  const terminal = {
    getTerminalAsync: vi.fn(async () => ({
      id: "panel-live",
      projectId: projectSource.id,
      kind: "terminal" as const,
      hasPty: true,
      isTrashed: false,
      launchGeneration: generation,
      launchAgentId: "codex",
    })),
    submitAcknowledged: submit,
  };
  const capability = {
    authorize: vi.fn(() =>
      revoked
        ? { allowed: false as const, reason: "revoked" as const }
        : { allowed: true as const, device: {} }
    ),
  };
  const ledger = new MemoryMutationLedger(options.ledgerRecords);
  const auditRows: unknown[] = [];
  const prompts = new RemotePromptSubmissionService(
    detailProjection,
    terminal as never,
    capability as never,
    sessions,
    ledger as never,
    { record: (row: unknown) => auditRows.push(row) } as never,
    router
  );
  const launches = {
    launchable: vi.fn(),
    launch: vi.fn(),
    close: vi.fn(),
    status: vi.fn(),
  };
  const ensureBackgroundView = vi.fn(async (projectId: string) => ({
    projectId,
    webContentsId: 41,
    generation: 4,
    release: vi.fn(),
  }));
  const selected: Array<{ sessionId: string; projectId: string; revision: number }> = [];
  router.setApplicationHandler(
    createRemoteApplicationHandler({
      projection,
      detailProjection,
      detailSubscriptions: {
        select: (sessionId, projectId, revision) =>
          selected.push({ sessionId, projectId, revision }),
      },
      projectViews: { ensureBackgroundView },
      consoleObservation,
      prompts,
      launches,
      sender: router,
    })
  );

  async function connect(id = "connection-phone") {
    const connection = new TestConnection(id);
    router.attach(connection);
    connection.receive(
      request("pending", "session.hello", `hello-${id}`, {
        supportedProtocol: { min: 1, max: 1 },
        appVersion: "1.0.0",
        deviceId: "device-phone",
        challenge: `challenge-${id}`,
        signature: `signature-${id}`,
      })
    );
    await vi.waitFor(() => expect(connection.sent.length).toBeGreaterThan(0));
    const welcome = response(connection, `hello-${id}`);
    if (!welcome || welcome.type !== "session.welcome") return { connection, sessionId: null };
    connection.receive(request(welcome.sessionId, "session.ready", `ready-${id}`, { ready: true }));
    await vi.waitFor(() => expect(response(connection, `ready-${id}`)).toBeDefined());
    return { connection, sessionId: welcome.sessionId };
  }

  return {
    connect,
    router,
    sessions,
    detailProjection,
    consoleObservation,
    pty,
    observation,
    submit,
    auditRows,
    selected,
    ensureBackgroundView,
    workspaceReads,
    foregroundProjectId,
    setGeneration: (value: number) => {
      generation = value;
    },
    setRevoked: (value: boolean) => {
      revoked = value;
    },
    setAuthenticationExpired: (value: boolean) => {
      authenticationExpired = value;
    },
  };
}

describe("existing-agent remote vertical slice", () => {
  it("traverses one authenticated browse, open, console, and exactly-once prompt journey", async () => {
    const harness = createHarness();
    const { connection, sessionId } = await harness.connect();
    expect(sessionId).not.toBeNull();

    connection.receive(request(sessionId!, "projects.list", "list", {}));
    await vi.waitFor(() => expect(response(connection, "list")?.type).toBe("projects.list"));
    connection.receive(
      request(sessionId!, "project.open", "open", { projectId: "project-portal" })
    );
    await vi.waitFor(() => expect(response(connection, "open")?.type).toBe("project.snapshot"));
    const opened = response(connection, "open");
    if (!opened || opened.type !== "project.snapshot") throw new Error("Missing project snapshot");
    const agent = opened.payload.agents[0]!;

    connection.receive(
      request(sessionId!, "console.subscribe", "console", {
        projectId: agent.projectId,
        worktreeId: agent.worktreeId,
        panelId: agent.panelId,
        launchGeneration: agent.launchGeneration,
      })
    );
    await vi.waitFor(() => expect(response(connection, "console")?.type).toBe("console.snapshot"));
    harness.pty.emit("console-output", {
      id: agent.panelId,
      observerId: "stream-1",
      launchGeneration: agent.launchGeneration,
      seq: 1,
      data: Buffer.from("after-watermark").toString("base64"),
      encoding: "base64",
      bytes: Buffer.byteLength("after-watermark"),
    });
    await vi.waitFor(() =>
      expect(frames(connection).some((item) => item.type === "console.output")).toBe(true)
    );
    const prompt = {
      projectId: agent.projectId,
      worktreeId: agent.worktreeId,
      panelId: agent.panelId,
      launchGeneration: agent.launchGeneration,
      idempotencyKey: "prompt-once",
      text: "first line\nsecond line",
    };
    connection.receive(request(sessionId!, "prompt.submit", "prompt-a", prompt));
    connection.receive(request(sessionId!, "prompt.submit", "prompt-b", prompt));
    await vi.waitFor(() => expect(response(connection, "prompt-b")?.type).toBe("prompt.result"));

    expect(harness.submit).toHaveBeenCalledOnce();
    expect(harness.submit).toHaveBeenCalledWith("panel-live", prompt.text, 4);
    expect(response(connection, "prompt-a")).toMatchObject({
      payload: { disposition: "committed", resultCode: "queued" },
    });
    expect(response(connection, "prompt-b")).toMatchObject({
      payload: { disposition: "committed", resultCode: "queued" },
    });
    expect(harness.selected).toEqual([
      expect.objectContaining({ projectId: "project-portal", revision: opened.payload.revision }),
    ]);
    expect(harness.ensureBackgroundView).toHaveBeenCalledOnce();
    expect(harness.ensureBackgroundView).toHaveBeenCalledWith("project-portal");
  });

  it("redacts trust-boundary canaries and never changes the foreground project", async () => {
    const harness = createHarness();
    const { connection, sessionId } = await harness.connect();
    connection.receive(request(sessionId!, "projects.list", "list", {}));
    connection.receive(
      request(sessionId!, "project.open", "open", { projectId: "project-portal" })
    );
    await vi.waitFor(() => expect(response(connection, "open")?.type).toBe("project.snapshot"));
    const serialized = JSON.stringify({ frames: frames(connection), audit: harness.auditRows });

    for (const canary of [
      "/private/secret",
      "content-canary-from-terminal",
      "worktree-source-main",
      "rendererGeneration",
      "environment",
      "signature-connection-phone",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(harness.workspaceReads).toEqual(["/private/secret/repositories/portal"]);
    expect(harness.foregroundProjectId).toBe("foreground-project");
  });

  it("returns actionable resource pressure when a background project cannot be prepared", async () => {
    const harness = createHarness();
    harness.ensureBackgroundView.mockRejectedValueOnce(
      new RemoteProjectViewError("HOST_RESOURCE_PRESSURE", "Remote view capacity is busy")
    );
    const { connection, sessionId } = await harness.connect();

    connection.receive(
      request(sessionId!, "project.open", "open-pressure", { projectId: "project-portal" })
    );
    await vi.waitFor(() =>
      expect(
        frames(connection).find(
          (item) =>
            item.kind === "response" &&
            item.type === "request.error" &&
            item.requestId === "open-pressure"
        )
      ).toBeDefined()
    );

    expect(
      frames(connection).find(
        (item) =>
          item.kind === "response" &&
          item.type === "request.error" &&
          item.requestId === "open-pressure"
      )
    ).toMatchObject({
      payload: {
        code: "HOST_RESOURCE_PRESSURE",
        message: expect.stringContaining("Close an app on the host and retry"),
      },
    });
  });

  it("recovers console history atomically and drops only faulted streams", async () => {
    const harness = createHarness();
    const { connection, sessionId } = await harness.connect();
    connection.receive(
      request(sessionId!, "project.open", "open", { projectId: "project-portal" })
    );
    await vi.waitFor(() => expect(response(connection, "open")?.type).toBe("project.snapshot"));
    const opened = response(connection, "open");
    if (!opened || opened.type !== "project.snapshot") throw new Error("Missing project snapshot");
    const agent = opened.payload.agents[0]!;
    const target = {
      projectId: agent.projectId,
      worktreeId: agent.worktreeId,
      panelId: agent.panelId,
      launchGeneration: agent.launchGeneration,
    };

    connection.receive(request(sessionId!, "console.subscribe", "initial", target));
    await vi.waitFor(() => expect(response(connection, "initial")?.type).toBe("console.snapshot"));
    harness.pty.emit("console-invalidated", {
      id: "panel-live",
      observerId: "stream-1",
      launchGeneration: 4,
      reason: "host-restarted",
    });
    await vi.waitFor(() =>
      expect(frames(connection).some((item) => item.type === "console.resyncRequired")).toBe(true)
    );
    harness.observation.mode = "resume";
    harness.observation.state = null;
    harness.observation.throughSeq = 2;
    harness.observation.chunks = [
      { seq: 1, data: "YQ==", encoding: "base64", bytes: 1 },
      { seq: 2, data: "Yg==", encoding: "base64", bytes: 1 },
    ];
    connection.receive(
      request(sessionId!, "console.subscribe", "resume", { ...target, afterSeq: 0 })
    );
    await vi.waitFor(() => expect(response(connection, "resume")?.type).toBe("console.snapshot"));
    expect(response(connection, "resume")).toMatchObject({
      payload: { mode: "resume", throughSeq: 2, chunks: [{ seq: 1 }, { seq: 2 }] },
    });

    connection.bufferedAmount = REMOTE_GATEWAY_LIMITS.maxQueuedBytes;
    harness.pty.emit("console-output", {
      id: "panel-live",
      observerId: "stream-2",
      launchGeneration: 4,
      seq: 3,
      data: "Yw==",
      encoding: "base64",
      bytes: 1,
    });
    await vi.waitFor(() =>
      expect(
        frames(connection).filter((item) => item.type === "console.resyncRequired")
      ).toHaveLength(2)
    );
    expect(connection.closes).toEqual([]);
  });

  it("fails closed for restart replay, revocation, expired auth, stale generations, and malformed frames", async () => {
    const records = new Map<
      string,
      { digest: string; operation: string; result: RemoteMutationResult }
    >();
    const submit = vi.fn(async () => ({ accepted: true as const, launchGeneration: 4 }));
    const first = createHarness({ ledgerRecords: records, submit });
    const firstClient = await first.connect("connection-first");
    firstClient.connection.receive(
      request(firstClient.sessionId!, "project.open", "open-first", { projectId: "project-portal" })
    );
    await vi.waitFor(() =>
      expect(response(firstClient.connection, "open-first")?.type).toBe("project.snapshot")
    );
    const firstOpen = response(firstClient.connection, "open-first");
    if (!firstOpen || firstOpen.type !== "project.snapshot")
      throw new Error("Missing project snapshot");
    const agent = firstOpen.payload.agents[0]!;
    const prompt = {
      projectId: agent.projectId,
      worktreeId: agent.worktreeId,
      panelId: agent.panelId,
      launchGeneration: 4,
      idempotencyKey: "restart-key",
      text: "persist through restart",
    };
    firstClient.connection.receive(
      request(firstClient.sessionId!, "prompt.submit", "before-restart", prompt)
    );
    await vi.waitFor(() =>
      expect(response(firstClient.connection, "before-restart")?.type).toBe("prompt.result")
    );

    const restarted = createHarness({ ledgerRecords: records, submit });
    const restartedClient = await restarted.connect("connection-restarted");
    restartedClient.connection.receive(
      request(restartedClient.sessionId!, "prompt.submit", "after-restart", prompt)
    );
    await vi.waitFor(() =>
      expect(response(restartedClient.connection, "after-restart")?.type).toBe("prompt.result")
    );
    expect(submit).toHaveBeenCalledOnce();

    restarted.setGeneration(5);
    restartedClient.connection.receive(
      request(restartedClient.sessionId!, "console.subscribe", "stale", {
        projectId: agent.projectId,
        worktreeId: agent.worktreeId,
        panelId: agent.panelId,
        launchGeneration: 4,
      })
    );
    await vi.waitFor(() =>
      expect(response(restartedClient.connection, "stale")?.type).toBe("request.error")
    );
    expect(response(restartedClient.connection, "stale")).toMatchObject({
      payload: { code: "STALE_GENERATION" },
    });

    restarted.setRevoked(true);
    restartedClient.connection.receive(
      request(restartedClient.sessionId!, "prompt.submit", "revoked", {
        ...prompt,
        idempotencyKey: "revoked-key",
      })
    );
    await vi.waitFor(() =>
      expect(response(restartedClient.connection, "revoked")?.type).toBe("request.error")
    );
    expect(response(restartedClient.connection, "revoked")).toMatchObject({
      payload: { code: "DEVICE_REVOKED" },
    });

    restarted.setAuthenticationExpired(true);
    const expired = new TestConnection("connection-expired");
    restarted.router.attach(expired);
    expired.receive(
      request("pending", "session.hello", "hello-expired", {
        supportedProtocol: { min: 1, max: 1 },
        appVersion: "1.0.0",
        deviceId: "device-expired",
        challenge: "expired-challenge",
        signature: "expired-signature",
      })
    );
    await vi.waitFor(() => expect(expired.closes[0]?.reason).toBe("AUTHENTICATION_FAILED"));

    const malformed = new TestConnection("connection-malformed");
    restarted.router.attach(malformed);
    malformed.receive("{");
    await vi.waitFor(() => expect(malformed.closes[0]?.code).toBe(1008));
    const oversized = new TestConnection("connection-oversized");
    restarted.router.attach(oversized);
    oversized.receive("x".repeat(REMOTE_GATEWAY_LIMITS.maxFrameBytes + 1));
    await vi.waitFor(() => expect(oversized.closes[0]?.code).toBe(1009));
  });
});
