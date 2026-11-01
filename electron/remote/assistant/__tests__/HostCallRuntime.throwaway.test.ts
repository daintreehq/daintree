import { beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import { HostCallResultSchema, type HostCallArgs } from "../../../../shared/types/hostControl.js";
import { AppError } from "../../../utils/errorTypes.js";
import {
  HostCallRuntime,
  relayRunMs,
  type ObservedHost,
  type OpenRun,
} from "../HostCallRuntime.js";
import type { HostThrowawayRun } from "../../../../shared/types/hostThrowaway.js";
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
  let executor: {
    run: ReturnType<typeof vi.fn<HostThrowawayExecutor["run"]>>;
    endOwner: ReturnType<typeof vi.fn<HostThrowawayExecutor["endOwner"]>>;
  } | null;
  let ids: number;
  let now: number;
  let mono: number;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    runs = new Map([["a", RUN_A]]);
    control = new Set(["studio"]);
    relayCall = vi.fn();
    throwawayCall = vi.fn(async () => LAUNCHED);
    executor = {
      run: vi.fn<HostThrowawayExecutor["run"]>(async () => LAUNCHED),
      endOwner: vi.fn<HostThrowawayExecutor["endOwner"]>(),
    };
    ids = 0;
    now = 1_000_000;
    mono = 50_000;
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
      now: () => now,
      clock: () => ({ wall: now, mono }),
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
    // It never raises a confirmation, so it isn't given the wait for one (#15699),
    // but keeps room for its own dispatch and the trip.
    expect(payload.runMs).toBeLessThan(relayRunMs("throwaway.launch", {}));
    expect(payload.runMs).toBeGreaterThanOrEqual(60_000);
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

  it("lets go of the host once every send settles, whatever came back", async () => {
    const gates: Array<() => void> = [];
    throwawayCall.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          gates.push(() => reject(new AppError({ code: "OUTCOME_UNKNOWN", message: "lost" })));
        })
    );
    const first = runtime.call("a", { ...LAUNCH, callId: "c-1" }, { tier: "core" });
    const second = runtime.call("a", { ...LAUNCH, callId: "c-2" }, { tier: "core" });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[0]!();
    await first;
    // The other send is still out: the host's link is still in use.
    expect(runtime.hasCallInFlight("studio")).toBe(true);
    gates[1]!();
    await second;
    expect(runtime.hasCallInFlight("studio")).toBe(false);
    throwawayCall.mockRejectedValueOnce(new AppError({ code: "HOST_DISCONNECTED", message: "x" }));
    await runtime.call("a", LAUNCH, { tier: "core" });
    expect(runtime.hasCallInFlight("studio")).toBe(false);
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

  it("answers an unreadable screen as its own tool error, never a blank result (#14460)", async () => {
    throwawayCall.mockResolvedValueOnce({ status: "failed", reason: "output-unavailable" });
    const answer = await runtime.call(
      "a",
      { ...LAUNCH, tool: "throwaway.output", args: { runId: "run-1" } },
      { tier: "core" }
    );
    expect(answer).toMatchObject({
      ok: true,
      value: {
        outcome: "ok",
        result: {
          isError: true,
          structured: { code: "output-unavailable", message: expect.any(String) },
          text: null,
        },
      },
    });
    if (!answer.ok) throw new Error("expected an answer");
    expect(answer.value).not.toHaveProperty("result.structured.content");
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

  describe("keeping a host's link while a run may still be going (#15878)", () => {
    const TEN_MINUTES = 10 * 60_000;
    const LONG_LAUNCH: HostCallArgs = {
      ...LAUNCH,
      args: { agentId: "claude", timeLimitMs: TEN_MINUTES },
    };
    const run = (fields: Partial<HostThrowawayRun> & { ageMs: number }): HostThrowawayRun => ({
      ...RUN,
      startedAt: 5_000,
      timeLimitMs: TEN_MINUTES,
      expiresAt: 5_000 + TEN_MINUTES,
      ...fields,
    });
    const launched = (ageMs = 0): ThrowawayCallAnswer => ({
      status: "done",
      result: { tool: "throwaway.launch", run: run({ ageMs }) },
    });
    const read = (fields: Partial<HostThrowawayRun> & { ageMs: number }): ThrowawayCallAnswer => ({
      status: "done",
      result: { tool: "throwaway.status", run: run(fields) },
    });
    const exited = (ageMs: number) =>
      read({ ageMs, state: "exited", endedAt: 5_000 + ageMs, endReason: "exit" });
    const status = (runId = "run-1"): HostCallArgs => ({
      ...LAUNCH,
      tool: "throwaway.status",
      args: { runId },
    });
    const lost = () => new AppError({ code: "OUTCOME_UNKNOWN", message: "lost" });
    const sends = () =>
      throwawayCall.mock.calls.map(([, payload]) => {
        const { callId, resend } = payload as ThrowawayCallPayload;
        return { callId, resend };
      });
    const advance = (ms: number) => {
      now += ms;
      mono += ms;
    };
    const held = () => runtime.holdsThrowawayRuns("studio");

    it("holds the host after the launch answers, until the run's time limit", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      expect(runtime.hasCallInFlight("studio")).toBe(false);
      expect(runtime.awaitsNotices("studio")).toBe(false);
      expect(held()).toBe(true);
      expect(runtime.holdsThrowawayRuns("elsewhere")).toBe(false);
      advance(TEN_MINUTES - 1);
      expect(held()).toBe(true);
      advance(1);
      expect(held()).toBe(false);
    });

    it("counts what was left of the limit when the host first read the run", async () => {
      throwawayCall.mockResolvedValueOnce(read({ ageMs: 4 * 60_000 }));
      await runtime.call("a", status(), { tier: "core" });
      advance(6 * 60_000 - 1);
      expect(held()).toBe(true);
      advance(1);
      expect(held()).toBe(false);
    });

    it("never lets a later reading move the bound, whatever the host's clock did", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      advance(60_000);
      // The host's wall clock stepped forward eight minutes; its limit's timer didn't.
      throwawayCall.mockResolvedValueOnce(read({ ageMs: 9 * 60_000 }));
      await runtime.call("a", status(), { tier: "core" });
      advance(9 * 60_000 - 1);
      expect(held()).toBe(true);
    });

    it("never stretches a run for an answer the host replays from its record", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", { ...LONG_LAUNCH, newCallId: "mine-1" }, { tier: "core" });
      advance(8 * 60_000);
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", { ...LONG_LAUNCH, callId: "mine-1" }, { tier: "core" });
      expect(sends()).toEqual([
        { callId: "mine-1", resend: false },
        { callId: "mine-1", resend: true },
      ]);
      advance(2 * 60_000);
      expect(held()).toBe(false);
    });

    it("keeps a run past its limit over, for a replay of its launch", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", { ...LONG_LAUNCH, newCallId: "mine-1" }, { tier: "core" });
      advance(TEN_MINUTES);
      expect(held()).toBe(false);
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", { ...LONG_LAUNCH, callId: "mine-1" }, { tier: "core" });
      expect(held()).toBe(false);
    });

    it("lets go of a run once an answer shows it over, and never takes it back", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      throwawayCall.mockResolvedValueOnce(read({ ageMs: 500 }));
      await runtime.call("a", { ...status(), newCallId: "old-read" }, { tier: "core" });
      throwawayCall.mockResolvedValueOnce(exited(1_000));
      await runtime.call("a", status(), { tier: "core" });
      expect(held()).toBe(false);
      // The host answers the resend from its record of the read while it was going.
      throwawayCall.mockResolvedValueOnce(read({ ageMs: 500 }));
      await runtime.call("a", { ...status(), callId: "old-read" }, { tier: "core" });
      expect(sends().slice(1)).toEqual([
        { callId: "old-read", resend: false },
        expect.objectContaining({ resend: false }),
        { callId: "old-read", resend: true },
      ]);
      expect(held()).toBe(false);
    });

    it("lets go of a run the host no longer has or whose process ended, and keeps the others", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      throwawayCall.mockResolvedValueOnce({
        status: "done",
        result: { tool: "throwaway.launch", run: run({ runId: "run-2", ageMs: 0 }) },
      });
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      throwawayCall.mockResolvedValueOnce({ status: "failed", reason: "not-found" });
      await runtime.call("a", status("run-1"), { tier: "core" });
      expect(held()).toBe(true);
      throwawayCall.mockResolvedValueOnce({ status: "failed", reason: "exited" });
      await runtime.call(
        "a",
        { ...LAUNCH, tool: "throwaway.sendCommand", args: { runId: "run-2", command: "ls" } },
        { tier: "core" }
      );
      expect(held()).toBe(false);
    });

    it("keeps a run whose close failed, and lets go once it closes", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      const close: HostCallArgs = { ...LAUNCH, tool: "throwaway.close", args: { runId: "run-1" } };
      throwawayCall.mockResolvedValueOnce({ status: "failed", reason: "close-failed" });
      await runtime.call("a", close, { tier: "core" });
      expect(held()).toBe(true);
      throwawayCall.mockResolvedValueOnce({
        status: "done",
        result: {
          tool: "throwaway.close",
          closed: true,
          run: run({ ageMs: 4_000, state: "closed", endedAt: 9_000, endReason: "close" }),
        },
      });
      await runtime.call("a", close, { tier: "core" });
      expect(held()).toBe(false);
    });

    it("holds a launch whose answer was lost for its limit past the call's own allowance", async () => {
      throwawayCall.mockRejectedValueOnce(lost());
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      const allowanceMs = throwawayCall.mock.calls[0]![2] as number;
      advance(TEN_MINUTES + allowanceMs - 1);
      expect(held()).toBe(true);
      advance(1);
      expect(held()).toBe(false);
    });

    it("holds a lost launch for what was left once a resend reads its run", async () => {
      throwawayCall.mockRejectedValueOnce(lost());
      await runtime.call("a", { ...LONG_LAUNCH, newCallId: "mine-1" }, { tier: "core" });
      advance(8 * 60_000);
      // The host got to it late: the run started just now.
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", { ...LONG_LAUNCH, callId: "mine-1" }, { tier: "core" });
      advance(TEN_MINUTES - 1);
      expect(held()).toBe(true);
      advance(1);
      expect(held()).toBe(false);
    });

    it("holds nothing for a launch that never ran", async () => {
      throwawayCall.mockRejectedValueOnce(
        new AppError({ code: "HOST_DISCONNECTED", message: "not sent" })
      );
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      expect(held()).toBe(false);
      throwawayCall.mockResolvedValueOnce({ status: "refused", reason: "throwaway-off" });
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      expect(held()).toBe(false);
      throwawayCall.mockResolvedValueOnce({ status: "failed", reason: "launch-failed" });
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      expect(held()).toBe(false);
    });

    it("keeps a lost launch held through resends that show nothing about it", async () => {
      throwawayCall.mockRejectedValueOnce(lost());
      await runtime.call("a", { ...LONG_LAUNCH, newCallId: "mine-1" }, { tier: "core" });
      const allowanceMs = throwawayCall.mock.calls[0]![2] as number;
      throwawayCall
        .mockRejectedValueOnce(new AppError({ code: "HOST_DISCONNECTED", message: "not sent" }))
        .mockResolvedValueOnce({ status: "refused", reason: "throwaway-off" })
        .mockResolvedValueOnce({ status: "unknown" })
        .mockResolvedValueOnce({ status: "conflict" });
      for (let i = 0; i < 4; i++) {
        advance(60_000);
        await runtime.call("a", { ...LONG_LAUNCH, callId: "mine-1" }, { tier: "core" });
        expect(held()).toBe(true);
      }
      expect(
        sends()
          .slice(1)
          .every(({ resend }) => resend)
      ).toBe(true);
      // Still the first send's bound: no resend moved it.
      advance(TEN_MINUTES + allowanceMs - 4 * 60_000 - 1);
      expect(held()).toBe(true);
      advance(1);
      expect(held()).toBe(false);
    });

    describe("from a host before time limits", () => {
      const legacy = (
        fields: Partial<HostThrowawayRun> & { ageMs: number }
      ): ThrowawayCallAnswer => ({
        status: "done",
        result: { tool: "throwaway.status", run: { ...RUN, ...fields } },
      });

      it("holds its run until its session ends", async () => {
        throwawayCall.mockResolvedValueOnce(LAUNCHED);
        await runtime.call("a", LAUNCH, { tier: "core" });
        advance(60 * 60_000);
        expect(held()).toBe(true);
        runtime.endHelpSession("a");
        expect(held()).toBe(false);
      });

      it("lets go of its run once seen over, for good", async () => {
        throwawayCall.mockResolvedValueOnce(LAUNCHED);
        await runtime.call("a", LAUNCH, { tier: "core" });
        throwawayCall.mockResolvedValueOnce(legacy({ ageMs: 9_000 }));
        await runtime.call("a", { ...status(), newCallId: "old-read" }, { tier: "core" });
        expect(held()).toBe(true);
        throwawayCall.mockResolvedValueOnce(
          legacy({ ageMs: 9_000, state: "exited", endedAt: 10_000, endReason: "exit" })
        );
        await runtime.call("a", status(), { tier: "core" });
        expect(held()).toBe(false);
        throwawayCall.mockResolvedValueOnce(legacy({ ageMs: 9_000 }));
        await runtime.call("a", { ...status(), callId: "old-read" }, { tier: "core" });
        expect(held()).toBe(false);
      });
    });

    it("never lets go early when the wall clock steps forward", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      now += 60 * 60_000;
      expect(held()).toBe(true);
    });

    it("lets go of the host once the help session that launched it ends", async () => {
      throwawayCall.mockResolvedValueOnce(launched());
      await runtime.call("a", LONG_LAUNCH, { tier: "core" });
      runtime.endHelpSession("a");
      expect(held()).toBe(false);
    });

    it.each([
      ["a launch", LONG_LAUNCH, launched()],
      ["a status read", status(), read({ ageMs: 0 })],
    ])(
      "holds nothing for %s whose answer lands after its session ended",
      async (_, args, answer) => {
        let finish!: (answer: ThrowawayCallAnswer) => void;
        throwawayCall.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            })
        );
        const pending = runtime.call("a", args, { tier: "core" });
        await vi.waitFor(() => expect(throwawayCall).toHaveBeenCalledTimes(1));
        runtime.endHelpSession("a");
        finish(answer);
        await pending;
        expect(held()).toBe(false);
      }
    );

    it("holds no link for a run on this machine", async () => {
      await runtime.call("a", { ...LONG_LAUNCH, hostId: "local" }, { tier: "core" });
      expect(runtime.holdsThrowawayRuns("local")).toBe(false);
      expect(held()).toBe(false);
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
