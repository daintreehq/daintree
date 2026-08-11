import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type AppDb } from "../../persistence/db.js";
import { remoteAuditEvents, remoteMutationLedger } from "../../persistence/schema.js";
import { createTerminalIOHandlers } from "../../../pty-host/handlers/terminalIO.js";
import type { HostContext } from "../../../pty-host/handlers/types.js";
import type { RemoteEnvelope } from "../../../../shared/types/remote/index.js";
import { RemoteAuditService, remoteContentMetadata } from "../RemoteAuditService.js";
import {
  MAX_REMOTE_IDEMPOTENCY_RECORDS,
  REMOTE_IDEMPOTENCY_TTL_MS,
  RemoteIdempotencyConflictError,
  RemoteMutationLedgerService,
  remoteMutationFingerprint,
} from "../RemoteMutationLedgerService.js";
import { RemotePromptSubmissionService } from "../RemotePromptSubmissionService.js";
import type { RemoteSession } from "../RemoteSessionRegistry.js";

const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

describe("remote mutation and audit persistence", () => {
  let directory: string;
  let db: AppDb;
  let sqlite: ReturnType<typeof openDb>["sqlite"];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "daintree-remote-ledger-"));
    const opened = openDb(path.join(directory, "test.db"), migrationsFolder);
    db = opened.db;
    sqlite = opened.sqlite;
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("replays the original terminal result after restart without repeating the side effect", async () => {
    const effect = vi.fn(async () => ({
      outcome: "committed" as const,
      resultCode: "queued" as const,
      createdResourceId: "panel-01",
    }));
    const request = {
      deviceId: "device-01",
      idempotencyKey: "mutation-01",
      operation: "agent.launch" as const,
      arguments: { projectId: "project-01", options: { agentId: "codex", model: undefined } },
    };

    const first = await new RemoteMutationLedgerService(db, () => 1_000).execute(request, effect);
    const replay = await new RemoteMutationLedgerService(db, () => 2_000).execute(
      {
        ...request,
        arguments: { options: { model: undefined, agentId: "codex" }, projectId: "project-01" },
      },
      effect
    );

    expect(first).toMatchObject({ replayed: false, result: { createdResourceId: "panel-01" } });
    expect(replay).toEqual({ replayed: true, result: first.result });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("returns a typed conflict when a device reuses a key for different canonical arguments", async () => {
    const service = new RemoteMutationLedgerService(db, () => 1_000);
    const base = {
      deviceId: "device-01",
      idempotencyKey: "mutation-01",
      operation: "prompt.submit" as const,
    };
    await service.execute(
      { ...base, arguments: { panelId: "panel-01", text: "first" } },
      async () => ({ outcome: "committed" })
    );

    await expect(
      service.execute(
        { ...base, arguments: { panelId: "panel-01", text: "different" } },
        async () => ({ outcome: "committed" })
      )
    ).rejects.toBeInstanceOf(RemoteIdempotencyConflictError);
  });

  it("reserves a requested panel ID durably across concurrent idempotency keys", async () => {
    let finish!: (result: { outcome: "committed"; createdResourceId: string }) => void;
    const pending = new Promise<{ outcome: "committed"; createdResourceId: string }>((resolve) => {
      finish = resolve;
    });
    const service = new RemoteMutationLedgerService(db, () => 1_000);
    const argumentsValue = { projectId: "project-01", requestedPanelId: "panel-reserved-01" };
    const first = service.execute(
      {
        deviceId: "device-01",
        idempotencyKey: "launch-first-01",
        operation: "agent.launch",
        arguments: argumentsValue,
      },
      () => pending
    );
    await vi.waitFor(() =>
      expect(
        sqlite
          .prepare("SELECT outcome FROM remote_mutation_ledger WHERE idempotency_key = ?")
          .get("launch-first-01")
      ).toMatchObject({ outcome: "pending" })
    );

    await expect(
      service.execute(
        {
          deviceId: "device-02",
          idempotencyKey: "launch-second-01",
          operation: "agent.launch",
          arguments: argumentsValue,
        },
        async () => ({ outcome: "committed" })
      )
    ).rejects.toBeInstanceOf(RemoteIdempotencyConflictError);
    finish({ outcome: "committed", createdResourceId: "panel-reserved-01" });
    await first;
  });

  it("atomically reconciles an ambiguous launch reservation without overwriting terminal results", () => {
    const request = {
      deviceId: "device-01",
      idempotencyKey: "launch-reconcile-01",
      operation: "agent.launch" as const,
      arguments: { projectId: "project-01", requestedPanelId: "panel-01" },
    };
    const digest = remoteMutationFingerprint(request.operation, request.arguments);
    sqlite
      .prepare(
        "INSERT INTO remote_mutation_ledger (device_id, idempotency_key, operation_type, argument_digest, outcome, result_code, created_at, expires_at) VALUES (?, ?, ?, ?, 'unknown', 'internal-error', ?, ?)"
      )
      .run(request.deviceId, request.idempotencyKey, request.operation, digest, 1_000, 99_999_999);
    const service = new RemoteMutationLedgerService(db, () => 2_000);

    expect(
      service.reconcile(request, {
        outcome: "committed",
        resultCode: "created",
        createdResourceId: "panel-01",
      })
    ).toEqual({
      outcome: "committed",
      resultCode: "created",
      createdResourceId: "panel-01",
    });
    expect(service.status(request.deviceId, request.idempotencyKey)).toEqual({
      outcome: "committed",
      resultCode: "created",
      createdResourceId: "panel-01",
    });
    expect(
      service.reconcile(request, { outcome: "rejected", resultCode: "invalid-target" })
    ).toMatchObject({ outcome: "committed", createdResourceId: "panel-01" });
    expect(() =>
      service.reconcile(
        { ...request, arguments: { projectId: "different-project" } },
        { outcome: "committed" }
      )
    ).toThrow(RemoteIdempotencyConflictError);
  });

  it("recovers a restart-orphaned pending launch and claims one proven-safe retry", async () => {
    const request = {
      deviceId: "device-01",
      idempotencyKey: "orphaned-launch-01",
      operation: "agent.launch" as const,
      arguments: { projectId: "project-01", requestedPanelId: "panel-01" },
    };
    const digest = remoteMutationFingerprint(request.operation, request.arguments);
    sqlite
      .prepare(
        "INSERT INTO remote_mutation_ledger (device_id, idempotency_key, operation_type, argument_digest, outcome, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
      )
      .run(request.deviceId, request.idempotencyKey, request.operation, digest, 1_000, 99_999_999);
    const service = new RemoteMutationLedgerService(db, () => 2_000);
    let finish!: (result: {
      outcome: "committed";
      resultCode: "created";
      createdResourceId: string;
    }) => void;
    const retryResult = new Promise<{
      outcome: "committed";
      resultCode: "created";
      createdResourceId: string;
    }>((resolve) => {
      finish = resolve;
    });
    const effect = vi.fn(() => retryResult);

    service.recoverInterrupted();
    expect(service.status(request.deviceId, request.idempotencyKey)).toMatchObject({
      outcome: "unknown",
      resultCode: "internal-error",
    });
    const retriedPromise = service.retryUnknown(request, effect);
    await vi.waitFor(() =>
      expect(
        sqlite
          .prepare("SELECT outcome FROM remote_mutation_ledger WHERE idempotency_key = ?")
          .get(request.idempotencyKey)
      ).toMatchObject({ outcome: "pending" })
    );
    const concurrent = await service.retryUnknown(request, effect);

    expect(concurrent).toEqual({
      replayed: true,
      result: { outcome: "unknown", resultCode: "commit-in-progress" },
    });
    expect(effect).toHaveBeenCalledOnce();
    finish({
      outcome: "committed",
      resultCode: "created",
      createdResourceId: "panel-01",
    });
    const retried = await retriedPromise;
    const replay = await service.retryUnknown(request, effect);

    expect(retried).toMatchObject({ replayed: false, result: { outcome: "committed" } });
    expect(replay).toMatchObject({ replayed: true, result: { outcome: "committed" } });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("reconciles durable status by device without creating or repeating a mutation", async () => {
    const service = new RemoteMutationLedgerService(db, () => 1_000);
    await service.execute(
      {
        deviceId: "device-01",
        idempotencyKey: "prompt-01",
        operation: "prompt.submit",
        arguments: { panelId: "panel-01", text: "hello" },
      },
      async () => ({ outcome: "committed", resultCode: "queued" })
    );

    expect(service.status("device-01", "prompt-01")).toEqual({
      outcome: "committed",
      resultCode: "queued",
    });
    expect(service.status("other-device", "prompt-01")).toBeNull();
    expect(service.status("device-01", "missing-key")).toBeNull();
  });

  it("composes the durable ledger and acknowledged host boundary across concurrency, restart, lost ACK, and conflict", async () => {
    const terminalSubmit = vi.fn();
    let hostResult: { accepted: boolean; launchGeneration: number; reason?: string } | null = null;
    let loseAcknowledgement = false;
    const hostHandlers = createTerminalIOHandlers({
      ptyManager: {
        getTerminal: vi.fn(() => ({ launchGeneration: 4, wasKilled: false, isExited: false })),
        isInTrash: vi.fn(() => false),
        submit: terminalSubmit,
      },
      sendEvent: vi.fn((event) => {
        if (event.type === "submit-result") hostResult = event;
      }),
    } as unknown as HostContext);
    const pty = {
      getTerminalAsync: vi.fn(async () => ({
        id: "panel-1",
        projectId: "project-1",
        kind: "terminal" as const,
        hasPty: true,
        isTrashed: false,
        launchGeneration: 4,
      })),
      submitAcknowledged: vi.fn(async (id: string, text: string, launchGeneration: number) => {
        hostResult = null;
        hostHandlers["submit-acknowledged"]({
          type: "submit-acknowledged",
          id,
          text,
          launchGeneration,
          requestId: "host-submit",
        });
        if (loseAcknowledgement) throw new Error("host result lost after queueing");
        if (!hostResult) throw new Error("host did not return a submit result");
        return hostResult;
      }),
    };
    const session = {
      id: "session-1",
      connection: { id: "connection-1" },
      deviceId: "device-1",
      capabilities: ["prompt-agents"],
      state: "ready",
    } as RemoteSession;
    const details = {
      snapshot: vi.fn(async () => ({
        revision: 1,
        agents: [
          {
            projectId: "project-1",
            worktreeId: "worktree-1",
            panelId: "panel-1",
            launchGeneration: 4,
            connectionState: "live",
          },
        ],
      })),
      validateBinding: vi.fn(() => ({ ok: true as const })),
    };
    const capabilities = { authorize: vi.fn(() => ({ allowed: true as const, device: {} })) };
    const sessions = { get: vi.fn(() => session) };
    const sent: RemoteEnvelope[] = [];
    const sender = {
      sendApplicationEnvelope: vi.fn((_connectionId: string, envelope: RemoteEnvelope) =>
        sent.push(envelope)
      ),
      sendApplicationError: vi.fn(),
    };
    const request = {
      projectId: "project-1",
      worktreeId: "worktree-1",
      panelId: "panel-1",
      launchGeneration: 4,
      idempotencyKey: "prompt-concurrent",
      text: "one durable prompt",
    };
    const createService = () =>
      new RemotePromptSubmissionService(
        details as never,
        pty as never,
        capabilities as never,
        sessions as never,
        new RemoteMutationLedgerService(db),
        { record: vi.fn() } as never,
        sender
      );

    const firstService = createService();
    await Promise.all([
      firstService.submit(session, "request-1", request),
      firstService.submit(session, "request-2", request),
    ]);
    expect(terminalSubmit).toHaveBeenCalledOnce();
    expect(terminalSubmit).toHaveBeenCalledWith("panel-1", "one durable prompt");
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ disposition: "committed" }) }),
        expect.objectContaining({ payload: expect.objectContaining({ disposition: "unknown" }) }),
      ])
    );

    await createService().submit(session, "request-after-restart", request);
    expect(terminalSubmit).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ payload: { disposition: "committed" } });

    loseAcknowledgement = true;
    const lostAck = { ...request, idempotencyKey: "prompt-lost-ack", text: "queue then lose ACK" };
    await createService().submit(session, "request-lost", lostAck);
    expect(terminalSubmit).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toMatchObject({ payload: { disposition: "unknown" } });
    loseAcknowledgement = false;
    await createService().submit(session, "request-lost-retry", lostAck);
    expect(terminalSubmit).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toMatchObject({ payload: { disposition: "unknown" } });

    await createService().submit(session, "request-conflict", {
      ...request,
      text: "different content",
    });
    expect(terminalSubmit).toHaveBeenCalledTimes(2);
    expect(sender.sendApplicationError).toHaveBeenCalledWith(
      "connection-1",
      "request-conflict",
      "CONFLICT",
      expect.any(String)
    );
  });

  it("never repeats or expiry-prunes an unresolved mutation", async () => {
    let now = 1_000;
    db.insert(remoteMutationLedger)
      .values({
        deviceId: "device-01",
        idempotencyKey: "pending-01",
        operationType: "prompt.submit",
        argumentDigest: remoteMutationFingerprint("prompt.submit", {}),
        outcome: "pending",
        createdAt: now,
        expiresAt: now + REMOTE_IDEMPOTENCY_TTL_MS,
      })
      .run();
    const service = new RemoteMutationLedgerService(db, () => now);
    const effect = vi.fn(async () => ({ outcome: "committed" as const }));
    const pending = await service.execute(
      {
        deviceId: "device-01",
        idempotencyKey: "pending-01",
        operation: "prompt.submit",
        arguments: {},
      },
      effect
    );
    expect(pending).toEqual({
      replayed: true,
      result: { outcome: "unknown", resultCode: "commit-in-progress" },
    });
    expect(effect).not.toHaveBeenCalled();

    now += REMOTE_IDEMPOTENCY_TTL_MS;
    await service.execute(
      {
        deviceId: "device-02",
        idempotencyKey: "fresh-01",
        operation: "prompt.submit",
        arguments: {},
      },
      effect
    );
    expect(
      sqlite
        .prepare("SELECT 1 FROM remote_mutation_ledger WHERE idempotency_key = ?")
        .get("pending-01")
    ).toBeDefined();
  });

  it("starts the 24-hour retention window when the mutation commits", async () => {
    let now = 1_000;
    const service = new RemoteMutationLedgerService(db, () => now);
    await service.execute(
      {
        deviceId: "device-01",
        idempotencyKey: "slow-01",
        operation: "agent.launch",
        arguments: { projectId: "project-01" },
      },
      async () => {
        now += REMOTE_IDEMPOTENCY_TTL_MS * 2;
        return { outcome: "committed", createdResourceId: "panel-01" };
      }
    );

    const row = sqlite
      .prepare(
        "SELECT committed_at AS committedAt, expires_at AS expiresAt FROM remote_mutation_ledger WHERE idempotency_key = 'slow-01'"
      )
      .get() as { committedAt: number; expiresAt: number };
    expect(row.expiresAt - row.committedAt).toBe(REMOTE_IDEMPOTENCY_TTL_MS);
  });

  it("keeps the durable ledger within its global count bound", async () => {
    const insert = sqlite.prepare(
      "INSERT INTO remote_mutation_ledger (device_id, idempotency_key, operation_type, argument_digest, outcome, created_at, expires_at) VALUES (?, ?, 'prompt.submit', ?, 'committed', ?, ?)"
    );
    sqlite.transaction(() => {
      for (let index = 0; index < MAX_REMOTE_IDEMPOTENCY_RECORDS; index += 1) {
        insert.run("seed-device", `seed-${index}`, `sha256:${index}`, index, 99_999_999);
      }
    })();

    await new RemoteMutationLedgerService(db, () => 20_000).execute(
      {
        deviceId: "device-new",
        idempotencyKey: "new-key",
        operation: "prompt.submit",
        arguments: { panelId: "panel-01" },
      },
      async () => ({ outcome: "committed" })
    );

    const count = sqlite.prepare("SELECT count(*) AS count FROM remote_mutation_ledger").get() as {
      count: number;
    };
    expect(count.count).toBeLessThanOrEqual(MAX_REMOTE_IDEMPOTENCY_RECORDS);
    expect(
      sqlite.prepare("SELECT 1 FROM remote_mutation_ledger WHERE idempotency_key = 'seed-0'").get()
    ).toBeUndefined();

    const pendingRequest = {
      deviceId: "pending-device",
      idempotencyKey: "pending-at-cap",
      operation: "prompt.submit" as const,
      arguments: { panelId: "panel-01" },
    };
    const digest = remoteMutationFingerprint(pendingRequest.operation, pendingRequest.arguments);
    sqlite
      .prepare(
        "INSERT INTO remote_mutation_ledger (device_id, idempotency_key, operation_type, argument_digest, outcome, created_at, expires_at) VALUES (?, ?, 'prompt.submit', ?, 'pending', ?, ?)"
      )
      .run(pendingRequest.deviceId, pendingRequest.idempotencyKey, digest, 30_000, 99_999_999);
    (
      new RemoteMutationLedgerService(db, () => 40_000) as unknown as {
        complete: (
          request: typeof pendingRequest,
          argumentDigest: string,
          result: { outcome: "committed" }
        ) => void;
      }
    ).complete(pendingRequest, digest, { outcome: "committed" });
    const afterConcurrentCommit = sqlite
      .prepare("SELECT count(*) AS count FROM remote_mutation_ledger WHERE outcome != 'pending'")
      .get() as { count: number };
    expect(afterConcurrentCommit.count).toBeLessThanOrEqual(MAX_REMOTE_IDEMPOTENCY_RECORDS);
  });

  it("stores only allow-listed audit metadata and content measurements", () => {
    const prompt = "secret prompt 😀\nwith interior text";
    const forbidden = [
      prompt,
      "console-output-canary",
      "pairing-secret-canary",
      "/Users/private/worktree",
      "TOKEN=private",
      "clipboard-canary",
    ];
    const audit = new RemoteAuditService(
      db,
      () => 7_000,
      () => "audit-01"
    );
    audit.record({
      actorDeviceId: "device-01",
      sessionId: "session-01",
      operation: "prompt.submit.result",
      result: "committed",
      targetProjectId: "project-01",
      targetWorktreeId: "worktree-01",
      targetPanelId: "panel-01",
      ...remoteContentMetadata(prompt),
      promptContent: prompt,
      consoleContent: forbidden[1],
      pairingSecret: forbidden[2],
      rawPath: forbidden[3],
      environmentValue: forbidden[4],
      clipboardContent: forbidden[5],
    } as Parameters<RemoteAuditService["record"]>[0]);

    const row = db.select().from(remoteAuditEvents).get();
    expect(row).toMatchObject({
      actorDeviceId: "device-01",
      operation: "prompt.submit.result",
      result: "committed",
      occurredAt: 7_000,
      targetPanelId: "panel-01",
      characterCount: 34,
      byteCount: Buffer.byteLength(prompt),
    });
    expect(row?.contentDigest).toMatch(/^sha256:/);
    const persisted = JSON.stringify(row);
    for (const value of forbidden) expect(persisted).not.toContain(value);

    audit.record({
      actorDeviceId: "/Users/private/device",
      operation: "authorization.failure",
      result: "denied",
    });
    expect(db.select().from(remoteAuditEvents).all()).toHaveLength(1);

    const columns = sqlite.pragma("table_info(remote_audit_events)") as Array<{ name: string }>;
    expect(columns.map(({ name }) => name).join(" ")).not.toMatch(
      /prompt|console|secret|private|token|path|environment|clipboard/i
    );
  });
});
