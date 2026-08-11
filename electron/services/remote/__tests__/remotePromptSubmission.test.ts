import { describe, expect, it, vi } from "vitest";
import type { RemoteEnvelope } from "../../../../shared/types/remote/index.js";
import { RemoteIdempotencyConflictError } from "../RemoteMutationLedgerService.js";
import { RemotePromptSubmissionService } from "../RemotePromptSubmissionService.js";
import type { RemoteSession } from "../RemoteSessionRegistry.js";

function fixture() {
  const session = {
    id: "session-1",
    connection: { id: "connection-1" },
    deviceId: "device-1",
    capabilities: ["observe-projects", "prompt-agents"],
    state: "ready",
  } as RemoteSession;
  const sent: RemoteEnvelope[] = [];
  const details = {
    snapshot: vi.fn(async () => ({
      revision: 9,
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
  const pty = {
    getTerminalAsync: vi.fn(async () => ({
      id: "panel-1",
      projectId: "project-1",
      kind: "terminal",
      hasPty: true,
      isTrashed: false,
      launchGeneration: 4,
      launchAgentId: "codex",
    })),
    submitAcknowledged: vi.fn(async () => ({ accepted: true, launchGeneration: 4 })),
  };
  const capabilities = { authorize: vi.fn(() => ({ allowed: true as const, device: {} })) };
  const sessions = { get: vi.fn(() => session) };
  const mutations = {
    execute: vi.fn(async (_request, effect: () => Promise<unknown>) => ({
      replayed: false,
      result: await effect(),
    })),
    status: vi.fn(() => null),
  };
  const audit = { record: vi.fn() };
  const sender = {
    sendApplicationEnvelope: vi.fn((_connectionId: string, envelope: RemoteEnvelope) =>
      sent.push(envelope)
    ),
    sendApplicationError: vi.fn(),
  };
  const service = new RemotePromptSubmissionService(
    details as never,
    pty as never,
    capabilities as never,
    sessions as never,
    mutations as never,
    audit as never,
    sender
  );
  const request = {
    projectId: "project-1",
    worktreeId: "worktree-1",
    panelId: "panel-1",
    launchGeneration: 4,
    idempotencyKey: "prompt-1",
    text: "line one\nline two",
  };
  return {
    service,
    session,
    request,
    details,
    pty,
    capabilities,
    sessions,
    mutations,
    audit,
    sender,
    sent,
  };
}

describe("RemotePromptSubmissionService", () => {
  it("binds and submits one complete prompt to the acknowledged live PTY boundary", async () => {
    const f = fixture();

    await f.service.submit(f.session, "request-1", f.request);

    expect(f.pty.submitAcknowledged).toHaveBeenCalledOnce();
    expect(f.pty.submitAcknowledged).toHaveBeenCalledWith("panel-1", "line one\nline two", 4);
    expect(f.sent.at(-1)).toMatchObject({
      type: "prompt.result",
      requestId: "request-1",
      payload: { idempotencyKey: "prompt-1", disposition: "committed", resultCode: "queued" },
    });
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "prompt.submit.result", result: "committed" })
    );
    expect(JSON.stringify(f.audit.record.mock.calls)).not.toContain(f.request.text);
  });

  it("coalesces concurrent retries and never repeats the PTY side effect", async () => {
    const f = fixture();
    let execution: Promise<unknown> | null = null;
    f.mutations.execute.mockImplementation(async (_request, effect) => {
      const replayed = execution !== null;
      execution ??= effect();
      return { replayed, result: await execution };
    });

    await Promise.all([
      f.service.submit(f.session, "request-1", f.request),
      f.service.submit(f.session, "request-2", f.request),
    ]);

    expect(f.pty.submitAcknowledged).toHaveBeenCalledOnce();
    expect(f.sent).toHaveLength(2);
    expect(f.sent.every((item) => item.type === "prompt.result")).toBe(true);
  });

  it("persists an indeterminate outcome when PTY acknowledgement is lost", async () => {
    const f = fixture();
    f.pty.submitAcknowledged.mockRejectedValue(new Error("host restarted"));

    await f.service.submit(f.session, "request-1", f.request);

    expect(f.sent.at(-1)).toMatchObject({
      payload: { disposition: "unknown", resultCode: "internal-error" },
    });

    const completionFailure = fixture();
    completionFailure.mutations.execute.mockRejectedValue(new Error("ledger completion failed"));
    await completionFailure.service.submit(
      completionFailure.session,
      "request-2",
      completionFailure.request
    );
    expect(completionFailure.sent.at(-1)).toMatchObject({
      type: "prompt.result",
      payload: { disposition: "unknown", resultCode: "internal-error" },
    });
  });

  it("revalidates the full projection immediately before host submission", async () => {
    const f = fixture();
    f.details.validateBinding
      .mockReturnValueOnce({ ok: true })
      .mockReturnValueOnce({ ok: false, code: "RUN_GENERATION_CHANGED" } as never);

    await f.service.submit(f.session, "request-1", f.request);

    expect(f.details.validateBinding).toHaveBeenCalledTimes(2);
    expect(f.pty.submitAcknowledged).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toMatchObject({
      payload: { disposition: "rejected", resultCode: "stale-generation" },
    });
  });

  it("rejects projected non-live agents and revocation at final authorization", async () => {
    const nonLive = fixture();
    nonLive.details.snapshot.mockResolvedValue({
      revision: 10,
      agents: [
        {
          projectId: "project-1",
          worktreeId: "worktree-1",
          panelId: "panel-1",
          launchGeneration: 4,
          connectionState: "restored",
        },
      ],
    } as never);
    await nonLive.service.submit(nonLive.session, "non-live", nonLive.request);
    expect(nonLive.sent.at(-1)).toMatchObject({
      payload: { disposition: "rejected", resultCode: "not-live" },
    });
    expect(nonLive.pty.submitAcknowledged).not.toHaveBeenCalled();

    const revoked = fixture();
    revoked.capabilities.authorize
      .mockReturnValueOnce({ allowed: true, device: {} })
      .mockReturnValueOnce({ allowed: true, device: {} })
      .mockReturnValueOnce({ allowed: false, reason: "revoked" } as never);
    await revoked.service.submit(revoked.session, "revoked-late", revoked.request);
    expect(revoked.sent.at(-1)).toMatchObject({
      payload: { disposition: "rejected", resultCode: "revoked" },
    });
    expect(revoked.pty.submitAcknowledged).not.toHaveBeenCalled();

    const denied = fixture();
    denied.capabilities.authorize
      .mockReturnValueOnce({ allowed: true, device: {} })
      .mockReturnValueOnce({ allowed: true, device: {} })
      .mockReturnValueOnce({ allowed: false, reason: "capability-denied" } as never);
    await denied.service.submit(denied.session, "denied-late", denied.request);
    expect(denied.sent.at(-1)).toMatchObject({
      payload: { disposition: "rejected", resultCode: "capability-denied" },
    });
    expect(denied.pty.submitAcknowledged).not.toHaveBeenCalled();
  });

  it("fails stale, exited, mismatched, unauthorized, empty, oversized, and conflicting requests without input", async () => {
    const cases: Array<() => Promise<void>> = [];

    const stale = fixture();
    stale.details.validateBinding.mockReturnValue({
      ok: false,
      code: "RUN_GENERATION_CHANGED",
    } as never);
    cases.push(() => stale.service.submit(stale.session, "stale", stale.request));

    const exited = fixture();
    exited.pty.getTerminalAsync.mockResolvedValue({
      ...(await exited.pty.getTerminalAsync()),
      hasPty: false,
    });
    cases.push(() => exited.service.submit(exited.session, "exited", exited.request));

    const mismatch = fixture();
    mismatch.pty.getTerminalAsync.mockResolvedValue({
      ...(await mismatch.pty.getTerminalAsync()),
      projectId: "other-project",
    });
    cases.push(() => mismatch.service.submit(mismatch.session, "mismatch", mismatch.request));

    const unauthorized = fixture();
    unauthorized.capabilities.authorize.mockReturnValue({
      allowed: false,
      reason: "capability-denied",
    } as never);
    cases.push(() =>
      unauthorized.service.submit(unauthorized.session, "unauthorized", unauthorized.request)
    );

    const revoked = fixture();
    revoked.capabilities.authorize.mockReturnValue({
      allowed: false,
      reason: "revoked",
    } as never);
    cases.push(() => revoked.service.submit(revoked.session, "revoked", revoked.request));

    const empty = fixture();
    cases.push(() =>
      empty.service.submit(empty.session, "empty", { ...empty.request, text: "  \n" })
    );

    const oversized = fixture();
    cases.push(() =>
      oversized.service.submit(oversized.session, "oversized", {
        ...oversized.request,
        text: "😀".repeat(20_000),
      })
    );

    const conflict = fixture();
    conflict.mutations.execute.mockRejectedValue(new RemoteIdempotencyConflictError());
    cases.push(() => conflict.service.submit(conflict.session, "conflict", conflict.request));

    await Promise.all(cases.map((run) => run()));
    for (const item of [
      stale,
      exited,
      mismatch,
      unauthorized,
      revoked,
      empty,
      oversized,
      conflict,
    ]) {
      expect(item.pty.submitAcknowledged).not.toHaveBeenCalled();
    }
    expect(stale.sent.at(-1)).toMatchObject({
      payload: { disposition: "rejected", resultCode: "stale-generation" },
    });
    expect(exited.sent.at(-1)).toMatchObject({
      payload: { disposition: "rejected", resultCode: "not-live" },
    });
    expect(mismatch.sent.at(-1)).toMatchObject({
      payload: { disposition: "rejected", resultCode: "invalid-target" },
    });
    expect(unauthorized.sender.sendApplicationError).toHaveBeenCalledWith(
      "connection-1",
      "unauthorized",
      "FORBIDDEN",
      expect.any(String)
    );
    expect(revoked.sender.sendApplicationError).toHaveBeenCalledWith(
      "connection-1",
      "revoked",
      "DEVICE_REVOKED",
      expect.any(String)
    );
    expect(conflict.sender.sendApplicationError).toHaveBeenCalledWith(
      "connection-1",
      "conflict",
      "CONFLICT",
      expect.any(String)
    );
    expect(empty.sender.sendApplicationError).toHaveBeenCalledWith(
      "connection-1",
      "empty",
      "INVALID_REQUEST",
      expect.any(String)
    );
    expect(oversized.sender.sendApplicationError).toHaveBeenCalledWith(
      "connection-1",
      "oversized",
      "INVALID_REQUEST",
      expect.any(String)
    );
  });

  it("reconciles durable request status without submitting again", () => {
    const f = fixture();
    f.mutations.status.mockReturnValue({
      outcome: "committed",
      resultCode: "queued",
    } as never);

    f.service.status(f.session, "request-2", "prompt-1");

    expect(f.sent.at(-1)).toMatchObject({
      type: "request.status",
      payload: { idempotencyKey: "prompt-1", disposition: "committed", resultCode: "queued" },
    });
    expect(f.pty.submitAcknowledged).not.toHaveBeenCalled();
  });
});
