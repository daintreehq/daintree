import { describe, expect, it, vi } from "vitest";
import type {
  RemoteEnvelope,
  RemoteLaunchAgentRequest,
} from "../../../../shared/types/remote/index.js";
import {
  MAX_CONCURRENT_REMOTE_LAUNCHES,
  RemoteAgentLaunchService,
} from "../RemoteAgentLaunchService.js";
import {
  remoteMutationFingerprint,
  RemoteIdempotencyConflictError,
  type RemoteMutationExecution,
  type RemoteMutationRequest,
  type RemoteMutationResult,
} from "../RemoteMutationLedgerService.js";
import type { RemoteSession } from "../RemoteSessionRegistry.js";
import { RemoteRendererBridgeError } from "../RemoteRendererBridge.js";

interface LedgerRecord {
  digest: string;
  operation: string;
  result: RemoteMutationResult;
}

interface RendererTestPanel {
  panelId: string;
  worktreeSourceId: string;
  agentId: string;
  launchGeneration?: number;
  placement?: "grid" | "dock";
  displayName: string;
  title: string;
  spawnedRemotely: boolean;
  resumable: boolean;
  connectionState: "starting";
}

class MemoryLedger {
  readonly records = new Map<string, LedgerRecord>();
  private readonly pending = new Set<string>();

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
    if (this.pending.has(key)) {
      return {
        replayed: true,
        result: { outcome: "unknown", resultCode: "commit-in-progress" },
      };
    }
    this.pending.add(key);
    const result = await effect();
    this.pending.delete(key);
    this.records.set(key, { digest, operation: request.operation, result });
    return { replayed: false, result };
  }

  status(deviceId: string, idempotencyKey: string): RemoteMutationResult | null {
    return this.records.get(`${deviceId}:${idempotencyKey}`)?.result ?? null;
  }

  reconcile(request: RemoteMutationRequest, result: RemoteMutationResult): RemoteMutationResult {
    const key = `${request.deviceId}:${request.idempotencyKey}`;
    const digest = remoteMutationFingerprint(request.operation, request.arguments);
    const existing = this.records.get(key);
    if (existing && (existing.digest !== digest || existing.operation !== request.operation)) {
      throw new RemoteIdempotencyConflictError();
    }
    if (existing?.result.outcome === "committed" || existing?.result.outcome === "rejected") {
      return existing.result;
    }
    this.records.set(key, { digest, operation: request.operation, result });
    return result;
  }

  async retryUnknown(
    request: RemoteMutationRequest,
    effect: () => Promise<RemoteMutationResult>
  ): Promise<RemoteMutationExecution> {
    const key = `${request.deviceId}:${request.idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing?.result.outcome !== "unknown") {
      return {
        replayed: true,
        result: existing?.result ?? { outcome: "unknown", resultCode: "internal-error" },
      };
    }
    this.records.delete(key);
    return this.execute(request, effect);
  }
}

const launchRequest: RemoteLaunchAgentRequest = {
  projectId: "project-1",
  worktreeId: "remote-worktree-1",
  agentId: "codex",
  requestedPanelId: "remote-panel-1",
  idempotencyKey: "launch-key-1",
  prompt: "Inspect the current changes",
  modelId: "gpt-5",
  name: "Remote review",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  let revoked = false;
  let sourceWorktreeId: string | null = "source-worktree-1";
  let generation: number | undefined = 9;
  const panels: RendererTestPanel[] = [];
  const release = vi.fn();
  const ensureBackgroundView = vi.fn(async () => ({
    projectId: "project-1",
    webContentsId: 17,
    generation: 4,
    release,
  }));
  const getLaunchableAgents = vi.fn(async (_lease, worktreeId: string) => ({
    projectId: "project-1",
    worktreeId,
    agents: [
      {
        agentId: "codex",
        displayName: "Codex",
        supportsPrompt: true,
        modelIds: ["gpt-5"],
      },
    ],
  }));
  const getPanelProjection = vi.fn(async () => ({
    projectId: "project-1",
    status: "available" as const,
    panels: [...panels],
  }));
  const launchAgent = vi.fn(async (_lease, input) => {
    panels.push({
      panelId: input.requestedPanelId,
      worktreeSourceId: input.worktreeId,
      agentId: input.agentId,
      launchGeneration: generation ?? 0,
      placement: "grid",
      displayName: "Codex",
      title: input.name ?? "Codex",
      spawnedRemotely: true,
      resumable: true,
      connectionState: "starting",
    });
    return {
      projectId: "project-1",
      worktreeId: input.worktreeId,
      requestedPanelId: input.requestedPanelId,
      panelId: input.requestedPanelId,
      launchGeneration: generation ?? 0,
      placement: "grid" as const,
      spawnStatus: "starting" as const,
      source: "remote" as const,
      persistent: true as const,
      focusPolicy: "preserve" as const,
    };
  });
  const session = {
    id: "session-1",
    connection: { id: "connection-1" },
    state: "ready",
    deviceId: "device-1",
    capabilities: ["launch-agents"],
    subscriptions: new Map(),
    pendingSubscriptions: new Set(),
    requestTimes: [],
  } as unknown as RemoteSession;
  const envelopes: RemoteEnvelope[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  const auditRows: unknown[] = [];
  const ledger = new MemoryLedger();
  const resolveWorktreeSource = vi.fn(async () => sourceWorktreeId);
  const isDeviceLaunchWithinRate = vi.fn(() => true);
  const sessionsByConnection = new Map([[session.connection.id, session]]);
  const service = new RemoteAgentLaunchService(
    {
      resolveWorktreeSource,
      currentGeneration: vi.fn(() => generation),
    },
    { ensureBackgroundView },
    { getPanelProjection, getLaunchableAgents, launchAgent },
    {
      authorize: vi.fn(() =>
        revoked
          ? { allowed: false as const, reason: "revoked" as const }
          : { allowed: true as const, device: {} as never }
      ),
    } as never,
    {
      get: vi.fn((connectionId: string) => sessionsByConnection.get(connectionId) ?? null),
      isDeviceLaunchWithinRate,
    },
    ledger as never,
    { record: (row: unknown) => auditRows.push(row) } as never,
    {
      sendApplicationEnvelope: (_connectionId, envelope) => envelopes.push(envelope),
      sendApplicationError: (_connectionId, _requestId, code, message) =>
        errors.push({ code, message }),
    }
  );

  return {
    service,
    session,
    envelopes,
    errors,
    auditRows,
    ledger,
    panels,
    release,
    ensureBackgroundView,
    getLaunchableAgents,
    getPanelProjection,
    launchAgent,
    resolveWorktreeSource,
    isDeviceLaunchWithinRate,
    addSession: (deviceId: string, index: number) => {
      const added = {
        ...session,
        id: `session-${index}`,
        connection: { ...session.connection, id: `connection-${index}` },
        deviceId,
      } as RemoteSession;
      sessionsByConnection.set(added.connection.id, added);
      return added;
    },
    setRevoked: (value: boolean) => {
      revoked = value;
    },
    setSourceWorktreeId: (value: string | null) => {
      sourceWorktreeId = value;
    },
    setGeneration: (value: number | undefined) => {
      generation = value;
    },
  };
}

function result(h: ReturnType<typeof harness>, requestId: string) {
  const envelope = h.envelopes.find(
    (candidate): candidate is Extract<RemoteEnvelope, { kind: "response" }> =>
      candidate.kind === "response" && candidate.requestId === requestId
  );
  return envelope?.payload;
}

describe("RemoteAgentLaunchService", () => {
  it("launches one persistent remote panel with stable identity and the prompt inside the boundary", async () => {
    const h = harness();

    await h.service.launch(h.session, "request-1", launchRequest);

    expect(h.launchAgent).toHaveBeenCalledOnce();
    expect(h.launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", generation: 4 }),
      expect.objectContaining({
        worktreeId: "source-worktree-1",
        requestedPanelId: "remote-panel-1",
        prompt: "Inspect the current changes",
        modelId: "gpt-5",
      })
    );
    expect(result(h, "request-1")).toEqual({
      idempotencyKey: "launch-key-1",
      requestedPanelId: "remote-panel-1",
      panelId: "remote-panel-1",
      launchGeneration: 9,
      projectId: "project-1",
      worktreeId: "remote-worktree-1",
      agentId: "codex",
      placement: "grid",
      spawnStatus: "starting",
      disposition: "created",
    });
    expect(h.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.auditRows)).not.toContain("Inspect the current changes");
    expect(JSON.stringify(h.auditRows)).toContain("characterCount");
  });

  it("deduplicates sequential replay and returns the persisted panel identity", async () => {
    const h = harness();

    await h.service.launch(h.session, "first", launchRequest);
    await h.service.launch(h.session, "retry", launchRequest);

    expect(h.launchAgent).toHaveBeenCalledOnce();
    expect(result(h, "retry")).toMatchObject({
      panelId: "remote-panel-1",
      launchGeneration: 9,
      disposition: "existing",
    });
  });

  it("does not dispatch a concurrent retry while the first launch is unresolved", async () => {
    const h = harness();
    const pending = deferred<Awaited<ReturnType<typeof h.launchAgent>>>();
    h.launchAgent.mockImplementationOnce(() => pending.promise);

    const first = h.service.launch(h.session, "first", launchRequest);
    await vi.waitFor(() => expect(h.launchAgent).toHaveBeenCalledOnce());
    await h.service.launch(h.session, "retry", launchRequest);

    expect(h.launchAgent).toHaveBeenCalledOnce();
    expect(result(h, "retry")).toMatchObject({
      disposition: "unknown",
      resultCode: "commit-in-progress",
    });
    pending.resolve({
      projectId: "project-1",
      worktreeId: "source-worktree-1",
      requestedPanelId: "remote-panel-1",
      panelId: "remote-panel-1",
      launchGeneration: 9,
      placement: "grid",
      spawnStatus: "starting",
      source: "remote",
      persistent: true,
      focusPolicy: "preserve",
    });
    await first;
  });

  it("atomically reserves the requested panel ID across different mutation keys", async () => {
    const h = harness();
    const pending = deferred<Awaited<ReturnType<typeof h.launchAgent>>>();
    h.launchAgent.mockImplementationOnce(() => pending.promise);

    const first = h.service.launch(h.session, "first", launchRequest);
    await vi.waitFor(() => expect(h.launchAgent).toHaveBeenCalledOnce());
    await h.service.launch(h.session, "collision", {
      ...launchRequest,
      idempotencyKey: "different-launch-key",
    });

    expect(h.launchAgent).toHaveBeenCalledOnce();
    expect(h.errors.at(-1)?.code).toBe("NOT_FOUND");
    pending.resolve({
      projectId: "project-1",
      worktreeId: "source-worktree-1",
      requestedPanelId: "remote-panel-1",
      panelId: "remote-panel-1",
      launchGeneration: 9,
      placement: "grid",
      spawnStatus: "starting",
      source: "remote",
      persistent: true,
      focusPolicy: "preserve",
    });
    await first;
  });

  it("enforces per-device concurrent launch admission through final dispatch", async () => {
    const h = harness();
    const firstPending = deferred<Awaited<ReturnType<typeof h.launchAgent>>>();
    const secondPending = deferred<Awaited<ReturnType<typeof h.launchAgent>>>();
    h.launchAgent
      .mockImplementationOnce(() => firstPending.promise)
      .mockImplementationOnce(() => secondPending.promise);
    const requestFor = (index: number): RemoteLaunchAgentRequest => ({
      ...launchRequest,
      requestedPanelId: `remote-panel-${index}`,
      idempotencyKey: `launch-key-${index}`,
    });

    const first = h.service.launch(h.session, "first", requestFor(1));
    await vi.waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(1));
    const second = h.service.launch(h.session, "second", requestFor(2));
    await vi.waitFor(() => expect(h.launchAgent).toHaveBeenCalledTimes(2));
    await h.service.launch(h.session, "third", requestFor(3));

    expect(h.launchAgent).toHaveBeenCalledTimes(2);
    expect(h.errors.at(-1)?.code).toBe("RATE_LIMITED");
    firstPending.resolve({
      projectId: "project-1",
      worktreeId: "source-worktree-1",
      requestedPanelId: "remote-panel-1",
      panelId: "remote-panel-1",
      launchGeneration: 9,
      placement: "grid",
      spawnStatus: "starting",
      source: "remote",
      persistent: true,
      focusPolicy: "preserve",
    });
    secondPending.resolve({
      projectId: "project-1",
      worktreeId: "source-worktree-1",
      requestedPanelId: "remote-panel-2",
      panelId: "remote-panel-2",
      launchGeneration: 9,
      placement: "grid",
      spawnStatus: "starting",
      source: "remote",
      persistent: true,
      focusPolicy: "preserve",
    });
    await Promise.all([first, second]);
  });

  it("enforces the global launch cap across independent devices", async () => {
    const h = harness();
    const pending = Array.from({ length: MAX_CONCURRENT_REMOTE_LAUNCHES }, () =>
      deferred<Awaited<ReturnType<typeof h.launchAgent>>>()
    );
    h.launchAgent.mockImplementation((_lease, _input) => {
      const index = h.launchAgent.mock.calls.length - 1;
      return pending[index]!.promise;
    });
    const requests = pending.map((_entry, index) => ({
      session: h.addSession(`device-global-${index}`, 100 + index),
      request: {
        ...launchRequest,
        requestedPanelId: `global-panel-${index}`,
        idempotencyKey: `global-key-${index}`,
      },
    }));
    const active = requests.map(({ session, request }, index) =>
      h.service.launch(session, `global-${index}`, request)
    );
    await vi.waitFor(() =>
      expect(h.launchAgent).toHaveBeenCalledTimes(MAX_CONCURRENT_REMOTE_LAUNCHES)
    );
    const overflowSession = h.addSession("device-global-overflow", 999);

    await h.service.launch(overflowSession, "global-overflow", {
      ...launchRequest,
      requestedPanelId: "global-panel-overflow",
      idempotencyKey: "global-key-overflow",
    });

    expect(h.launchAgent).toHaveBeenCalledTimes(MAX_CONCURRENT_REMOTE_LAUNCHES);
    expect(h.errors.at(-1)?.code).toBe("RATE_LIMITED");
    pending.forEach((entry, index) =>
      entry.resolve({
        projectId: "project-1",
        worktreeId: "source-worktree-1",
        requestedPanelId: `global-panel-${index}`,
        panelId: `global-panel-${index}`,
        launchGeneration: 9,
        placement: "grid",
        spawnStatus: "starting",
        source: "remote",
        persistent: true,
        focusPolicy: "preserve",
      })
    );
    await Promise.all(active);
  });

  it("reconciles a restart record and a renderer failure after creation without launching again", async () => {
    const restarted = harness();
    restarted.panels.push({
      panelId: "remote-panel-1",
      worktreeSourceId: "source-worktree-1",
      agentId: "codex",
      launchGeneration: 9,
      placement: "grid",
      displayName: "Codex",
      title: "Remote review",
      spawnedRemotely: true,
      resumable: true,
      connectionState: "starting",
    });
    const mutation: RemoteMutationRequest = {
      deviceId: "device-1",
      idempotencyKey: launchRequest.idempotencyKey,
      operation: "agent.launch",
      arguments: launchRequest,
    };
    restarted.ledger.records.set("device-1:launch-key-1", {
      digest: remoteMutationFingerprint(mutation.operation, mutation.arguments),
      operation: mutation.operation,
      result: { outcome: "unknown", resultCode: "internal-error" },
    });

    await restarted.service.launch(restarted.session, "restart", launchRequest);

    expect(restarted.launchAgent).not.toHaveBeenCalled();
    expect(result(restarted, "restart")).toMatchObject({
      panelId: "remote-panel-1",
      disposition: "existing",
    });
    expect(restarted.ledger.status("device-1", "launch-key-1")?.outcome).toBe("committed");

    const failedResponse = harness();
    failedResponse.launchAgent.mockImplementationOnce(async (_lease, input) => {
      failedResponse.panels.push({
        panelId: input.requestedPanelId,
        worktreeSourceId: input.worktreeId,
        agentId: input.agentId,
        launchGeneration: 9,
        placement: "grid",
        displayName: "Codex",
        title: "Remote review",
        spawnedRemotely: true,
        resumable: true,
        connectionState: "starting",
      });
      throw new RemoteRendererBridgeError("ACTION_FAILED", "renderer rejected the result");
    });

    await failedResponse.service.launch(failedResponse.session, "failure", launchRequest);

    expect(failedResponse.launchAgent).toHaveBeenCalledOnce();
    expect(result(failedResponse, "failure")).toMatchObject({
      panelId: "remote-panel-1",
      disposition: "created",
    });
  });

  it("retries an ambiguous failure only after a live projection proves no panel was created", async () => {
    const h = harness();
    h.launchAgent.mockRejectedValueOnce(new Error("renderer disconnected"));

    await h.service.launch(h.session, "first", launchRequest);
    await h.service.launch(h.session, "retry", launchRequest);

    expect(h.launchAgent).toHaveBeenCalledTimes(2);
    expect(result(h, "first")).toMatchObject({ disposition: "unknown" });
    expect(result(h, "retry")).toMatchObject({
      panelId: "remote-panel-1",
      disposition: "created",
    });
  });

  it.each([
    ["desktop provenance", (panel: RendererTestPanel) => (panel.spawnedRemotely = false)],
    ["wrong worktree", (panel: RendererTestPanel) => (panel.worktreeSourceId = "other-worktree")],
    ["wrong agent", (panel: RendererTestPanel) => (panel.agentId = "claude")],
    ["missing placement", (panel: RendererTestPanel) => delete panel.placement],
    ["generation mismatch", (panel: RendererTestPanel) => (panel.launchGeneration = 8)],
  ])("does not reconcile or retry a reused ID with %s", async (_label, mutate) => {
    const h = harness();
    h.launchAgent.mockRejectedValueOnce(new Error("renderer disconnected"));
    await h.service.launch(h.session, "first", launchRequest);
    const panel: (typeof h.panels)[number] = {
      panelId: "remote-panel-1",
      worktreeSourceId: "source-worktree-1",
      agentId: "codex",
      launchGeneration: 9,
      placement: "grid",
      displayName: "Codex",
      title: "Remote launch",
      spawnedRemotely: true,
      resumable: true,
      connectionState: "starting",
    };
    mutate(panel);
    h.panels.push(panel);

    await h.service.launch(h.session, "retry", launchRequest);

    expect(h.launchAgent).toHaveBeenCalledOnce();
    expect(result(h, "retry")).toMatchObject({ disposition: "unknown" });
  });

  it("fails closed for invalid targets, unsupported models, revocation, and missing generations", async () => {
    const invalid = harness();
    invalid.setSourceWorktreeId(null);
    await invalid.service.launch(invalid.session, "invalid", launchRequest);
    expect(invalid.launchAgent).not.toHaveBeenCalled();
    expect(invalid.errors.at(-1)?.code).toBe("NOT_FOUND");

    const unsupported = harness();
    await unsupported.service.launch(unsupported.session, "unsupported", {
      ...launchRequest,
      modelId: "unsupported-model",
    });
    expect(unsupported.launchAgent).not.toHaveBeenCalled();
    expect(unsupported.errors.at(-1)?.code).toBe("NOT_FOUND");

    const unsupportedAgent = harness();
    await unsupportedAgent.service.launch(unsupportedAgent.session, "unsupported-agent", {
      ...launchRequest,
      agentId: "unknown-agent",
    });
    expect(unsupportedAgent.launchAgent).not.toHaveBeenCalled();
    expect(unsupportedAgent.errors.at(-1)?.code).toBe("NOT_FOUND");

    const revoked = harness();
    revoked.ensureBackgroundView.mockImplementationOnce(async () => {
      revoked.setRevoked(true);
      return { projectId: "project-1", webContentsId: 17, generation: 4, release: revoked.release };
    });
    await revoked.service.launch(revoked.session, "revoked", launchRequest);
    expect(revoked.launchAgent).not.toHaveBeenCalled();
    expect(revoked.errors.at(-1)?.code).toBe("DEVICE_REVOKED");

    const revokedAtDispatch = harness();
    revokedAtDispatch.resolveWorktreeSource.mockImplementation(async () => {
      if (revokedAtDispatch.resolveWorktreeSource.mock.calls.length === 3) {
        revokedAtDispatch.setRevoked(true);
      }
      return "source-worktree-1";
    });
    await revokedAtDispatch.service.launch(
      revokedAtDispatch.session,
      "revoked-at-dispatch",
      launchRequest
    );
    expect(revokedAtDispatch.launchAgent).not.toHaveBeenCalled();
    expect(revokedAtDispatch.errors.at(-1)?.code).toBe("DEVICE_REVOKED");

    const expiredAdmission = harness();
    expiredAdmission.ensureBackgroundView.mockImplementationOnce(async () => {
      expiredAdmission.isDeviceLaunchWithinRate.mockReturnValue(false);
      return {
        projectId: "project-1",
        webContentsId: 17,
        generation: 4,
        release: expiredAdmission.release,
      };
    });
    await expiredAdmission.service.launch(
      expiredAdmission.session,
      "expired-admission",
      launchRequest
    );
    expect(expiredAdmission.ensureBackgroundView).toHaveBeenCalledOnce();
    expect(expiredAdmission.launchAgent).not.toHaveBeenCalled();
    expect(expiredAdmission.errors.at(-1)?.code).toBe("RATE_LIMITED");

    const noGeneration = harness();
    noGeneration.setGeneration(undefined);
    await noGeneration.service.launch(noGeneration.session, "no-generation", launchRequest);
    expect(noGeneration.launchAgent).toHaveBeenCalledOnce();
    expect(result(noGeneration, "no-generation")).toMatchObject({ disposition: "unknown" });
  });

  it("returns only the authorized project-scoped launch catalog", async () => {
    const h = harness();

    await h.service.launchable(h.session, "catalog", {
      projectId: "project-1",
      worktreeId: "remote-worktree-1",
    });

    expect(h.getLaunchableAgents).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1" }),
      "source-worktree-1"
    );
    expect(result(h, "catalog")).toMatchObject({
      projectId: "project-1",
      worktreeId: "remote-worktree-1",
      agents: [{ agentId: "codex" }],
    });
  });

  it("waits for Main to observe the renderer-minted launch generation", async () => {
    const h = harness();
    h.setGeneration(undefined);
    h.launchAgent.mockImplementationOnce(async (_lease, input) => {
      setTimeout(() => h.setGeneration(9), 0);
      return {
        projectId: "project-1",
        worktreeId: input.worktreeId,
        requestedPanelId: input.requestedPanelId,
        panelId: input.requestedPanelId,
        launchGeneration: 9,
        placement: "grid",
        spawnStatus: "starting",
        source: "remote",
        persistent: true,
        focusPolicy: "preserve",
      };
    });

    await h.service.launch(h.session, "generation-settle", launchRequest);

    expect(result(h, "generation-settle")).toMatchObject({
      disposition: "created",
      panelId: launchRequest.requestedPanelId,
      launchGeneration: 9,
    });
  });

  it("rematerializes a stale renderer once before returning the launch catalog", async () => {
    const h = harness();
    h.getLaunchableAgents.mockRejectedValueOnce(
      new RemoteRendererBridgeError("UNAVAILABLE", "Project renderer is unavailable")
    );

    await h.service.launchable(h.session, "catalog-retry", {
      projectId: "project-1",
      worktreeId: "remote-worktree-1",
    });

    expect(h.ensureBackgroundView).toHaveBeenCalledTimes(2);
    expect(h.getLaunchableAgents).toHaveBeenCalledTimes(2);
    expect(h.resolveWorktreeSource).toHaveBeenCalledTimes(3);
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(result(h, "catalog-retry")).toMatchObject({ agents: [{ agentId: "codex" }] });
    expect(h.errors).toEqual([]);
  });
});
