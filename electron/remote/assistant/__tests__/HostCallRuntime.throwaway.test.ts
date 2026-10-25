import { beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import { HostCallResultSchema, type HostCallArgs } from "../../../../shared/types/hostControl.js";
import { AppError } from "../../../utils/errorTypes.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import type { ThrowawayCallAnswer, ThrowawayCallPayload } from "../linkMethods.js";
import { createLocalMcpRelay, LOCAL_RELAY_SENDER_ID } from "../localMcpRelay.js";
import type { HostThrowawayExecutor } from "../throwawayRelay.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const STUDIO: ObservedHost = {
  hostId: "studio",
  name: "studio-01",
  connection: { status: "connected", rttMs: 5, handshake: { version: "0.50.0" } } as never,
  lastSeenAt: null,
  summary: null,
};

const RUN = {
  runId: "run-1",
  agentId: "claude",
  startedAt: 1_000,
  ageMs: 0,
  timeLimitMs: null,
  expiresAt: null,
  state: "running" as const,
  endedAt: null,
  endReason: null,
};

const LAUNCH: HostCallArgs = {
  hostId: "studio",
  throwaway: true,
  tool: "throwaway.launch",
  args: { agentId: "claude" },
};

const LAUNCHED: ThrowawayCallAnswer = {
  status: "done",
  result: { tool: "throwaway.launch", run: RUN },
};

describe("HostCallRuntime host.call to a throwaway target (#14446)", () => {
  let runs: Map<string, OpenRun>;
  let control: Set<string>;
  let relayCall: ReturnType<typeof vi.fn>;
  let throwawayCall: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<ThrowawayCallAnswer>>>;
  let executor: { run: ReturnType<typeof vi.fn<HostThrowawayExecutor["run"]>> } | null;
  let ids: number;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    runs = new Map([["a", RUN_A]]);
    control = new Set(["studio"]);
    relayCall = vi.fn();
    throwawayCall = vi.fn(async () => LAUNCHED);
    executor = { run: vi.fn<HostThrowawayExecutor["run"]>(async () => LAUNCHED) };
    ids = 0;
    const local = createLocalMcpRelay({
      machineName: () => "greg-mbp",
      hasProject: vi.fn(async () => true),
      openSession: vi.fn(async () => null),
      receiveNotices: vi.fn(),
      receiveApproval: vi.fn(),
      throwawayRuns: () => executor,
    });
    runtime = new HostCallRuntime({
      getSessionLane: (id) => {
        const run = runs.get(id);
        return run ? { projectId: run.projectId, slot: run.slot } : null;
      },
      callerRun: (id) => runs.get(id) ?? null,
      client: () => ({ relayCall, throwawayCall }) as never,
      hosts: () => [STUDIO],
      inLocalView: () => true,
      controlEnabled: (hostId) => control.has(hostId),
      local: {
        name: () => "greg-mbp",
        projects: async () => [],
        relayCall: vi.fn(),
        throwawayCall: (payload) => local.throwawayCall(payload),
      },
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    });
  });

  it("sends a host the throwaway call with no project, and answers with its run", async () => {
    const answer = await runtime.call("a", LAUNCH, { tier: "core" });
    expect(answer).toEqual({
      ok: true,
      value: {
        outcome: "ok",
        detail: null,
        retryAfterMs: null,
        callId: "00000000-0000-4000-8000-000000000001",
        result: { isError: false, structured: LAUNCHED.result, text: null },
      },
    });
    expect(HostCallResultSchema.parse((answer as { value: unknown }).value)).toBeTruthy();
    expect(relayCall).not.toHaveBeenCalled();
    expect(throwawayCall).toHaveBeenCalledTimes(1);
    const [hostId, payload, timeoutMs] = throwawayCall.mock.calls[0] as [
      string,
      ThrowawayCallPayload,
      number,
    ];
    expect(hostId).toBe("studio");
    expect(payload).toEqual({
      helpSessionId: "a",
      tier: "core",
      callId: "00000000-0000-4000-8000-000000000001",
      resend: false,
      call: { tool: "throwaway.launch", args: { agentId: "claude" } },
      runMs: expect.any(Number),
    });
    expect(payload).not.toHaveProperty("projectId");
    expect(timeoutMs).toBeGreaterThan(payload.runMs);
  });

  it("resends under a callId, and a newCallId is the caller's own first send", async () => {
    await runtime.call("a", { ...LAUNCH, callId: "c-1" }, { tier: "core" });
    await runtime.call("a", { ...LAUNCH, newCallId: "mine-1" }, { tier: "core" });
    const payloads = throwawayCall.mock.calls.map((call) => call[1] as ThrowawayCallPayload);
    expect(payloads.map(({ callId, resend }) => ({ callId, resend }))).toEqual([
      { callId: "c-1", resend: true },
      { callId: "mine-1", resend: false },
    ]);
  });

  it("refuses another session's newCallId while that call is out, sending nothing", async () => {
    let finish!: (answer: ThrowawayCallAnswer) => void;
    throwawayCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    runs.set("b", { ...RUN_A, sessionId: "b", slot: 1 });
    const first = runtime.call("a", { ...LAUNCH, newCallId: "mine-1" }, { tier: "core" });
    await vi.waitFor(() => expect(throwawayCall).toHaveBeenCalledTimes(1));
    expect(runtime.hasCallInFlight("studio")).toBe(true);
    await expect(
      runtime.call("b", { ...LAUNCH, newCallId: "mine-1" }, { tier: "core" })
    ).resolves.toMatchObject({ ok: true, value: { outcome: "conflict", callId: null } });
    finish(LAUNCHED);
    await first;
    expect(throwawayCall).toHaveBeenCalledTimes(1);
    expect(runtime.hasCallInFlight("studio")).toBe(false);
  });

  it("meets the same switches as a project call before anything is sent", async () => {
    control.clear();
    await expect(runtime.call("a", LAUNCH, { tier: "core" })).resolves.toMatchObject({
      ok: true,
      value: { outcome: "opted_out", callId: null, result: null },
    });
    await expect(
      runtime.call("a", { ...LAUNCH, hostId: "nowhere" }, { tier: "core" })
    ).resolves.toMatchObject({ ok: true, value: { outcome: "not_found", callId: null } });
    expect(throwawayCall).not.toHaveBeenCalled();
  });

  it("answers a host's refusals as the outcomes project calls use", async () => {
    const outcomes: unknown[] = [];
    for (const reason of ["control-off", "throwaway-off", "expiry-unsupported"] as const) {
      throwawayCall.mockResolvedValueOnce({ status: "refused", reason });
      const answer = await runtime.call("a", LAUNCH, { tier: "core" });
      outcomes.push((answer as { value: { outcome: string } }).value.outcome);
    }
    expect(outcomes).toEqual(["policy_rejected", "unsupported", "unsupported"]);
  });

  it("answers an older host's UNSUPPORTED as unsupported, naming its version", async () => {
    throwawayCall.mockRejectedValueOnce(new AppError({ code: "UNSUPPORTED", message: "old" }));
    await expect(runtime.call("a", LAUNCH, { tier: "core" })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: "unsupported",
        detail: expect.stringContaining("0.50.0"),
        callId: null,
      },
    });
  });

  it("keeps the callId of a call whose answer was lost, so it can be resent", async () => {
    throwawayCall.mockRejectedValueOnce(new AppError({ code: "OUTCOME_UNKNOWN", message: "lost" }));
    await expect(runtime.call("a", LAUNCH, { tier: "core" })).resolves.toMatchObject({
      ok: true,
      value: { outcome: "ambiguous", callId: "00000000-0000-4000-8000-000000000001" },
    });
    throwawayCall.mockResolvedValueOnce({ status: "unknown" });
    await expect(
      runtime.call("a", { ...LAUNCH, callId: "gone" }, { tier: "core" })
    ).resolves.toMatchObject({ ok: true, value: { outcome: "expired", callId: "gone" } });
  });

  it("answers a tool that ran and failed as its tool error", async () => {
    throwawayCall.mockResolvedValueOnce({ status: "failed", reason: "not-found" });
    const answer = await runtime.call(
      "a",
      { ...LAUNCH, tool: "throwaway.status", args: { runId: "someone-elses" } },
      { tier: "core" }
    );
    expect(answer).toMatchObject({
      ok: true,
      value: {
        outcome: "ok",
        result: { isError: true, structured: { code: "not-found" }, text: null },
      },
    });
  });

  it("refuses a project tool on the target, naming the throwaway tools", async () => {
    // Past the schema's own check, as a caller in process could send it.
    const answer = await runtime.call(
      "a",
      { ...LAUNCH, tool: "terminal.list", args: {} },
      {
        tier: "core",
      }
    );
    expect(answer).toMatchObject({
      ok: true,
      value: {
        outcome: "policy_rejected",
        detail: expect.stringContaining("throwaway.launch"),
        callId: null,
      },
    });
    expect(throwawayCall).not.toHaveBeenCalled();
  });

  it("lets the global assistant reach its own throwaway runs", async () => {
    runs.set("g", { ...RUN_A, projectId: GLOBAL_ASSISTANT_ID, sessionId: "g" });
    await expect(runtime.call("g", LAUNCH, { tier: "core" })).resolves.toMatchObject({
      ok: true,
      value: { outcome: "ok" },
    });
  });

  describe("on this machine", () => {
    const HERE: HostCallArgs = { ...LAUNCH, hostId: "local" };

    it("runs this machine's own throwaway runs in process, needing no switch", async () => {
      control.clear();
      await expect(runtime.call("a", HERE, { tier: "core" })).resolves.toMatchObject({
        ok: true,
        value: { outcome: "ok", result: { structured: LAUNCHED.result } },
      });
      expect(throwawayCall).not.toHaveBeenCalled();
      expect(executor!.run).toHaveBeenCalledWith(
        { senderId: LOCAL_RELAY_SENDER_ID, helpSessionId: "a" },
        { tool: "throwaway.launch", args: { agentId: "claude" } },
        expect.objectContaining({ callId: "00000000-0000-4000-8000-000000000001" })
      );
    });

    it("never launches twice for a resend of the same callId", async () => {
      await runtime.call("a", { ...HERE, newCallId: "mine-1" }, { tier: "core" });
      await runtime.call("a", { ...HERE, callId: "mine-1" }, { tier: "core" });
      expect(executor!.run).toHaveBeenCalledTimes(1);
    });

    it("answers unsupported while this machine runs no throwaway agents", async () => {
      executor = null;
      await expect(runtime.call("a", HERE, { tier: "core" })).resolves.toMatchObject({
        ok: true,
        value: { outcome: "unsupported" },
      });
    });
  });
});
