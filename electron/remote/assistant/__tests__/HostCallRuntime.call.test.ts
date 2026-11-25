import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import { HostCallResultSchema } from "../../../../shared/types/hostControl.js";
import {
  HostCallRuntime,
  relayRunMs,
  type ObservedHost,
  type OpenRun,
} from "../HostCallRuntime.js";
import {
  MAX_RELAY_ARGS_BYTES,
  MAX_RELAY_RUN_MS,
  RelayCancelUnconfirmedError,
  type McpCallAnswer,
} from "../linkMethods.js";
import { DEFAULT_TERMINAL_EXIT_WAIT_MS } from "../../../../shared/types/terminalExitWait.js";
import { CLAUDE_UPDATE_AFTER_APPROVAL_MS } from "../../../../shared/types/claudeUpdateApply.js";
import {
  MCP_DISPATCH_TIMEOUT_MS,
  MCP_REMOTE_CONFIRM_MARGIN_MS,
  MCP_REMOTE_DISPATCH_TIMEOUT_MS,
} from "../../../../shared/config/mcpConfirmWindow.js";
import { LAUNCH_SETUP_WAIT_DEFAULT_MS } from "../../../../shared/utils/launchInNewWorktree.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

function host(overrides: Partial<ObservedHost> = {}): ObservedHost {
  return {
    hostId: "studio",
    name: "studio-01",
    connection: { status: "disconnected" },
    lastSeenAt: null,
    summary: null,
    ...overrides,
  };
}

const CALL = {
  hostId: "studio",
  projectId: "proj-2",
  tool: "terminal.list",
  args: { owned: true },
};
const DONE: McpCallAnswer = {
  status: "done",
  result: { isError: false, structured: { terminals: [] }, text: null },
};

describe("HostCallRuntime host.call (#13493)", () => {
  let hosts: ObservedHost[];
  let runs: Map<string, OpenRun>;
  let lanes: Map<string, { projectId: string; slot: number }>;
  let localViews: Set<string>;
  let control: Set<string>;
  let relayCall: ReturnType<typeof vi.fn>;
  let ids: number;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    hosts = [host()];
    runs = new Map([["a", RUN_A]]);
    lanes = new Map([
      ["a", { projectId: "proj-1", slot: 0 }],
      ["starting", { projectId: "proj-1", slot: 1 }],
      ["remote-view", { projectId: "proj-4", slot: 0 }],
    ]);
    localViews = new Set(["a", "starting"]);
    control = new Set(["studio"]);
    relayCall = vi.fn(async () => DONE);
    ids = 0;
    runtime = new HostCallRuntime({
      getSessionLane: (id) => lanes.get(id) ?? null,
      callerRun: (id) => runs.get(id) ?? null,
      client: () => ({ relayCall }) as never,
      hosts: () => hosts,
      inLocalView: (id) => localViews.has(id),
      controlEnabled: (hostId) => control.has(hostId),
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    });
  });

  describe("who is offered it", () => {
    it("lists it for an assistant in this machine's own view from its start, hosts or not", () => {
      hosts = [];
      expect(runtime.isCallReachable("a")).toBe(true);
      // Provisioned, its run not confirmed yet: still offered, for clients that list once.
      expect(runtime.isCallReachable("starting")).toBe(true);
    });

    it("never lists it for an assistant a remote Shell's view runs here, or for a stranger", () => {
      expect(runtime.isCallReachable("remote-view")).toBe(false);
      expect(runtime.isCallReachable("nobody")).toBe(false);
    });

    it("refuses a caller that isn't one of this machine's running assistants, sending nothing", async () => {
      await expect(runtime.call("remote-view", CALL, { tier: "core" })).resolves.toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });
      expect(relayCall).not.toHaveBeenCalled();
    });
  });

  it("tells each host it asked to hold a message that its session ended, once (#16187)", async () => {
    const throwawayRelease = vi.fn(async () => {});
    runtime = new HostCallRuntime({
      getSessionLane: (id) => lanes.get(id) ?? null,
      callerRun: (id) => runs.get(id) ?? null,
      client: () => ({ relayCall, throwawayRelease }) as never,
      hosts: () => [host(), host({ hostId: "laptop", name: "laptop" })],
      inLocalView: (id) => localViews.has(id),
      controlEnabled: () => true,
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
    });
    const send = (hostId: string, args: Record<string, unknown>) =>
      runtime.call(
        "a",
        {
          hostId,
          projectId: "proj-2",
          tool: "terminal.sendCommandOwned",
          args: { terminalId: "t-1", command: "go", generation: 1, ...args },
        },
        { tier: "core" }
      );
    await send("studio", { whenBusy: "queue" });
    await send("studio", { whenBusy: "queue" });
    // A send that holds nothing leaves its host nothing to drop.
    await send("laptop", {});

    runtime.endHelpSession("a");
    expect(throwawayRelease).toHaveBeenCalledTimes(1);
    expect(throwawayRelease).toHaveBeenCalledWith("studio", { helpSessionId: "a" });

    runtime.endHelpSession("a");
    expect(throwawayRelease).toHaveBeenCalledTimes(1);
  });

  it("sends the call with a fresh callId, the caller's help session and tier, and returns the host's result", async () => {
    const settled = await runtime.call("a", CALL, { tier: "full" });

    expect(settled).toEqual({
      ok: true,
      value: {
        outcome: "ok",
        detail: null,
        retryAfterMs: null,
        callId: "00000000-0000-4000-8000-000000000001",
        result: DONE.result,
      },
    });
    if (!settled.ok) throw new Error("refused");
    expect(HostCallResultSchema.safeParse(settled.value).success).toBe(true);
    expect(relayCall).toHaveBeenCalledWith(
      "studio",
      {
        helpSessionId: "a",
        projectId: "proj-2",
        tier: "full",
        callId: "00000000-0000-4000-8000-000000000001",
        resend: false,
        tool: "terminal.list",
        args: { owned: true },
        runMs: relayRunMs("terminal.list", { owned: true }),
      },
      expect.any(Number),
      // No cancel to carry: the caller's context had no signal.
      undefined
    );
    const [, payload, timeoutMs] = relayCall.mock.calls[0] as [string, { runMs: number }, number];
    expect(timeoutMs).toBeGreaterThan(payload.runMs);
  });

  it("sends a given callId as a resend", async () => {
    await runtime.call("a", { ...CALL, callId: "earlier" }, { tier: "core" });
    expect(relayCall.mock.calls[0]![1]).toMatchObject({ callId: "earlier", resend: true });
  });

  it("sends the caller's own newCallId as a first send under that id (#14240)", async () => {
    const settled = await runtime.call("a", { ...CALL, newCallId: "mine-1" }, { tier: "core" });

    expect(relayCall.mock.calls[0]![1]).toMatchObject({ callId: "mine-1", resend: false });
    expect(settled).toMatchObject({ ok: true, value: { outcome: "ok", callId: "mine-1" } });
  });

  it("never lets a newCallId take over a call another session or host has out under it", async () => {
    let finish!: (answer: McpCallAnswer) => void;
    relayCall.mockImplementationOnce(
      () => new Promise<McpCallAnswer>((resolve) => (finish = resolve))
    );
    runs.set("b", { ...RUN_A, sessionId: "b", terminalId: "t-b" });
    lanes.set("b", { projectId: "proj-1", slot: 1 });
    hosts = [host(), host({ hostId: "lab", name: "lab-01" })];
    control.add("lab");
    const first = runtime.call("a", { ...CALL, newCallId: "shared" }, { tier: "core" });

    const otherSession = await runtime.call(
      "b",
      { ...CALL, newCallId: "shared" },
      { tier: "core" }
    );
    const otherHost = await runtime.call(
      "a",
      { ...CALL, hostId: "lab", newCallId: "shared" },
      { tier: "core" }
    );
    finish(DONE);

    expect(otherSession).toMatchObject({ ok: true, value: { outcome: "conflict", callId: null } });
    expect(otherHost).toMatchObject({ ok: true, value: { outcome: "conflict", callId: null } });
    expect(relayCall).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toMatchObject({ ok: true, value: { outcome: "ok" } });
  });

  it("resends a newCallId this Shell already sent, so a forgotten one never starts again", async () => {
    const SEND = {
      ...CALL,
      tool: "terminal.sendCommandOwned",
      args: { terminalId: "t-1", command: "x" },
    };
    await runtime.call("a", { ...SEND, newCallId: "mine-1" }, { tier: "core" });
    relayCall.mockResolvedValueOnce({ status: "unknown" });
    const repeat = await runtime.call("a", { ...SEND, newCallId: "mine-1" }, { tier: "core" });

    expect(relayCall.mock.calls[1]![1]).toMatchObject({ callId: "mine-1", resend: true });
    expect(repeat).toMatchObject({ ok: true, value: { outcome: "expired", callId: "mine-1" } });
  });

  it("keeps a settled prompt's newCallId to the session that sent it", async () => {
    const SEND = {
      ...CALL,
      tool: "terminal.sendCommandOwned",
      args: { terminalId: "t-1", command: "x" },
    };
    runs.set("b", { ...RUN_A, sessionId: "b", terminalId: "t-b" });
    lanes.set("b", { projectId: "proj-1", slot: 1 });
    await runtime.call("a", { ...SEND, newCallId: "mine-1" }, { tier: "core" });

    const other = await runtime.call("b", { ...SEND, newCallId: "mine-1" }, { tier: "core" });

    expect(other).toMatchObject({ ok: true, value: { outcome: "conflict", callId: null } });
    expect(relayCall).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown host, and one whose control switch is off, sending nothing", async () => {
    await expect(
      runtime.call("a", { ...CALL, hostId: "nowhere" }, { tier: "core" })
    ).resolves.toMatchObject({ ok: true, value: { outcome: "not_found", callId: null } });
    control.clear();
    await expect(runtime.call("a", CALL, { tier: "core" })).resolves.toMatchObject({
      ok: true,
      value: { outcome: "opted_out", callId: null, result: null },
    });
    expect(relayCall).not.toHaveBeenCalled();
  });

  it("refuses arguments too large to send", async () => {
    const big = { text: "x".repeat(MAX_RELAY_ARGS_BYTES) };
    await expect(
      runtime.call("a", { ...CALL, args: big }, { tier: "core" })
    ).resolves.toMatchObject({ ok: true, value: { outcome: "too_large", callId: null } });
    expect(relayCall).not.toHaveBeenCalled();
  });

  describe("outcomes", () => {
    const failWith = (code: string) =>
      relayCall.mockRejectedValueOnce(new AppError({ code: code as never, message: code }));

    it("is ambiguous, with the callId to resend, when the answer was lost on the way", async () => {
      failWith("OUTCOME_UNKNOWN");
      await expect(runtime.call("a", CALL, { tier: "core" })).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: "ambiguous",
          callId: "00000000-0000-4000-8000-000000000001",
          result: null,
        },
      });
    });

    describe("a call its caller cancelled (#17985)", () => {
      const ID = "00000000-0000-4000-8000-000000000001";

      it("sends nothing and says nothing ran when cancelled before it went out", async () => {
        const controller = new AbortController();
        controller.abort();
        const settled = await runtime.call("a", CALL, { tier: "core", signal: controller.signal });

        expect(relayCall).not.toHaveBeenCalled();
        if (!settled.ok) throw new Error("refused");
        expect(HostCallResultSchema.safeParse(settled.value).success).toBe(true);
        expect(settled.value).toMatchObject({
          outcome: "ok",
          callId: null,
          result: { isError: true, structured: { code: "CANCELLED", dispatched: false } },
        });
        // A resend learns nothing of the call it resends, which may have run.
        const resent = await runtime.call(
          "a",
          { ...CALL, callId: "earlier" },
          { tier: "core", signal: controller.signal }
        );
        expect(resent).toMatchObject({
          ok: true,
          value: { outcome: "ambiguous", callId: "earlier", result: null },
        });
        expect(relayCall).not.toHaveBeenCalled();
      });

      it("says a resend the link stopped short learned nothing, keeping its callId", async () => {
        failWith("CANCELLED");
        await expect(
          runtime.call(
            "a",
            { ...CALL, callId: "earlier" },
            { tier: "core", signal: new AbortController().signal }
          )
        ).resolves.toMatchObject({
          ok: true,
          value: { outcome: "ambiguous", callId: "earlier", result: null },
        });
      });

      it("hands the caller's signal to the link, and reads a cancel the link stopped short as unsent", async () => {
        const controller = new AbortController();
        failWith("CANCELLED");
        await expect(
          runtime.call("a", CALL, { tier: "core", signal: controller.signal })
        ).resolves.toMatchObject({
          ok: true,
          value: { outcome: "ok", callId: null, result: { structured: { dispatched: false } } },
        });
        const cancel = relayCall.mock.calls[0]![3] as { signal: AbortSignal; onCancel: unknown };
        expect(cancel.signal).toBe(controller.signal);
        expect(cancel.onCancel).toEqual(expect.any(Function));
      });

      it("remembers a call whose cancel went out past its answer, for that host and session only", async () => {
        const controller = new AbortController();
        // As the link client does once the call is out: the cancel goes, and says so.
        relayCall.mockImplementationOnce(
          async (
            _hostId: string,
            _payload: unknown,
            _timeoutMs: number,
            cancel?: { signal: AbortSignal; onCancel?: () => void }
          ) => {
            controller.abort();
            cancel?.onCancel?.();
            return { status: "cancelled", dispatch: "after" } satisfies McpCallAnswer;
          }
        );

        await runtime.call("a", CALL, { tier: "core", signal: controller.signal });
        await runtime.call("a", { ...CALL, args: { owned: false } }, { tier: "core" });

        expect(runtime.cancelledRelayedCall("studio", { callId: ID, helpSessionId: "a" })).toBe(
          true
        );
        expect(runtime.cancelledRelayedCall("studio", { callId: ID, helpSessionId: "other" })).toBe(
          false
        );
        expect(runtime.cancelledRelayedCall("laptop", { callId: ID, helpSessionId: "a" })).toBe(
          false
        );
        // A call nobody cancelled is nothing to refuse.
        expect(
          runtime.cancelledRelayedCall("studio", {
            callId: "00000000-0000-4000-8000-000000000002",
            helpSessionId: "a",
          })
        ).toBe(false);
      });

      it("forgets a first send's cancel when the send never went out", async () => {
        const controller = new AbortController();
        // Cancelled while an older host refused the first method: the cancel went, the call never did.
        relayCall.mockImplementationOnce(
          async (
            _hostId: string,
            _payload: unknown,
            _timeoutMs: number,
            cancel?: { signal: AbortSignal; onCancel?: () => void }
          ) => {
            controller.abort();
            cancel?.onCancel?.();
            throw new AppError({ code: "CANCELLED", message: "not sent" });
          }
        );

        await runtime.call("a", CALL, { tier: "core", signal: controller.signal });

        expect(runtime.cancelledRelayedCall("studio", { callId: ID, helpSessionId: "a" })).toBe(
          false
        );
      });

      it("says nothing ran when the host stopped it before its tool, keeping the callId", async () => {
        relayCall.mockResolvedValueOnce({ status: "cancelled", dispatch: "before" });
        await expect(runtime.call("a", CALL, { tier: "core" })).resolves.toMatchObject({
          ok: true,
          value: {
            outcome: "ok",
            callId: ID,
            result: { isError: true, structured: { code: "CANCELLED", dispatched: false } },
          },
        });
      });

      it("is ambiguous when the host stopped it after its tool had it", async () => {
        relayCall.mockResolvedValueOnce({ status: "cancelled", dispatch: "after" });
        const settled = await runtime.call("a", CALL, { tier: "core" });
        expect(settled).toMatchObject({
          ok: true,
          value: { outcome: "ambiguous", callId: ID, result: null },
        });
        if (!settled.ok) throw new Error("refused");
        expect(settled.value.detail).toMatch(/may have acted/);
      });

      it("keeps what a call that ran past an unconfirmed cancel answered, and says it as unknown", async () => {
        const noteAnswered = vi.fn();
        runtime = new HostCallRuntime({
          getSessionLane: (id) => lanes.get(id) ?? null,
          callerRun: (id) => runs.get(id) ?? null,
          client: () => ({ relayCall }) as never,
          hosts: () => hosts,
          inLocalView: (id) => localViews.has(id),
          controlEnabled: (hostId) => control.has(hostId),
          noteAnswered,
          newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
        });
        relayCall.mockRejectedValueOnce(new RelayCancelUnconfirmedError(DONE));

        const settled = await runtime.call("a", CALL, { tier: "core" });

        expect(settled).toMatchObject({
          ok: true,
          value: { outcome: "ambiguous", callId: ID, result: null },
        });
        if (!settled.ok) throw new Error("refused");
        expect(settled.value.detail).toMatch(/didn't confirm/);
        expect(noteAnswered).toHaveBeenCalledWith(
          expect.objectContaining({ tool: "terminal.list", structured: { terminals: [] } })
        );
      });

      it("trusts a host's own cancelled answer even when its cancel's answer was lost", async () => {
        relayCall.mockRejectedValueOnce(
          new RelayCancelUnconfirmedError({ status: "cancelled", dispatch: "before" })
        );
        await expect(runtime.call("a", CALL, { tier: "core" })).resolves.toMatchObject({
          ok: true,
          value: { outcome: "ok", callId: ID, result: { structured: { dispatched: false } } },
        });
        relayCall.mockRejectedValueOnce(
          new RelayCancelUnconfirmedError({ status: "cancelled", dispatch: "after" })
        );
        const after = await runtime.call("a", CALL, { tier: "core" });
        if (!after.ok) throw new Error("refused");
        expect(after.value).toMatchObject({ outcome: "ambiguous", result: null });
        expect(after.value.detail).toMatch(/told the tool to stop/);
      });

      it("is ambiguous, saying the host didn't confirm it stopped, when the cancel wasn't taken", async () => {
        relayCall.mockRejectedValueOnce(new RelayCancelUnconfirmedError());
        const settled = await runtime.call("a", CALL, { tier: "core" });
        expect(settled).toMatchObject({
          ok: true,
          value: { outcome: "ambiguous", callId: ID, result: null },
        });
        if (!settled.ok) throw new Error("refused");
        expect(settled.value.detail).toMatch(/didn't confirm/);
      });
    });

    it("is ambiguous when something unreadable came back after the call was sent", async () => {
      relayCall.mockRejectedValueOnce(new AppError({ code: "INTERNAL", message: "bad answer" }));
      await expect(runtime.call("a", CALL, { tier: "core" })).resolves.toMatchObject({
        ok: true,
        value: { outcome: "ambiguous", callId: "00000000-0000-4000-8000-000000000001" },
      });
    });

    it("says a first send never left when the host was unreachable, but keeps a resend's id", async () => {
      failWith("HOST_DISCONNECTED");
      await expect(runtime.call("a", CALL, { tier: "core" })).resolves.toMatchObject({
        ok: true,
        value: { outcome: "disconnected", callId: null },
      });
      failWith("HOST_DISCONNECTED");
      await expect(
        runtime.call("a", { ...CALL, callId: "earlier" }, { tier: "core" })
      ).resolves.toMatchObject({ ok: true, value: { outcome: "disconnected", callId: "earlier" } });
    });

    it("names the host and the version it runs when it can't run relayed calls", async () => {
      hosts = [
        host({
          connection: {
            status: "connected",
            rttMs: 3,
            handshake: { version: "0.44.0" } as never,
          },
        }),
      ];
      failWith("UNSUPPORTED");
      const settled = await runtime.call("a", CALL, { tier: "core" });
      if (!settled.ok) throw new Error("refused");
      expect(settled.value.outcome).toBe("unsupported");
      expect(settled.value.detail).toContain("studio-01");
      expect(settled.value.detail).toContain("0.44.0");
    });

    it.each([
      [{ status: "unknown" } as const, "expired"],
      [{ status: "conflict" } as const, "conflict"],
      [{ status: "refused", reason: "control-off" } as const, "policy_rejected"],
      [{ status: "refused", reason: "no-project" } as const, "not_found"],
      [{ status: "refused", reason: "server-off" } as const, "unsupported"],
    ])("reads the host's %o as %s", async (answer, outcome) => {
      relayCall.mockResolvedValueOnce(answer);
      const settled = await runtime.call("a", { ...CALL, callId: "earlier" }, { tier: "core" });
      expect(settled).toMatchObject({
        ok: true,
        value: { outcome, callId: "earlier", result: null },
      });
      if (!settled.ok) throw new Error("refused");
      expect(settled.value.detail).toEqual(expect.any(String));
    });
  });

  it("points a call the host's MCP server couldn't take at its MCP settings there (#18187)", async () => {
    relayCall.mockResolvedValueOnce({ status: "refused", reason: "server-off" });
    const settled = await runtime.call("a", CALL, { tier: "core" });
    if (!settled.ok) throw new Error("refused");
    expect(settled.value.outcome).toBe("unsupported");
    expect(settled.value.detail).toContain("Settings → Integrations → MCP server on that host");
    // Something to check, never a claim: a session that failed to open answers the same.
    expect(settled.value.detail).not.toMatch(/\bis off\b/);
  });

  it("believes a host's dialog only while a call to it is out", async () => {
    let release!: (answer: McpCallAnswer) => void;
    relayCall.mockReturnValueOnce(new Promise<McpCallAnswer>((resolve) => (release = resolve)));
    expect(runtime.hasCallInFlight("studio")).toBe(false);
    const call = runtime.call("a", CALL, { tier: "core" });
    await vi.waitFor(() => expect(runtime.hasCallInFlight("studio")).toBe(true));
    release(DONE);
    await call;
    expect(runtime.hasCallInFlight("studio")).toBe(false);
  });

  it("lists every host with its control switch as the person set it", async () => {
    hosts = [host(), host({ hostId: "other", name: "other" })];
    control = new Set(["studio"]);
    const listed = await runtime.list("a");
    if (!listed.ok) throw new Error("refused");
    expect(listed.value.hosts.map((entry) => [entry.hostId, entry.control])).toEqual([
      ["studio", true],
      ["other", false],
    ]);
  });

  it("reports an answered call with where it ran and when it was asked, for a schedule's run (#16169)", async () => {
    const noteAnswered = vi.fn();
    const launched: McpCallAnswer = {
      status: "done",
      result: { isError: false, structured: { launched: true, terminalId: "t-w" }, text: null },
    };
    let answer!: (value: McpCallAnswer) => void;
    relayCall
      .mockReturnValueOnce(new Promise<McpCallAnswer>((resolve) => (answer = resolve)))
      .mockResolvedValueOnce({ status: "refused", reason: "control-off" })
      .mockResolvedValueOnce(launched);
    let clock = 5_000;
    runtime = new HostCallRuntime({
      getSessionLane: (id) => lanes.get(id) ?? null,
      callerRun: (id) => runs.get(id) ?? null,
      client: () => ({ relayCall }) as never,
      hosts: () => hosts,
      inLocalView: (id) => localViews.has(id),
      controlEnabled: (hostId) => control.has(hostId),
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
      now: () => clock,
      noteAnswered,
    });
    const launch = { ...CALL, tool: "agent.launch", args: { agentId: "codex" } };

    const first = runtime.call("a", launch, { tier: "full" });
    await vi.waitFor(() => expect(relayCall).toHaveBeenCalledTimes(1));
    // The answer comes later: the call still dates from when it was sent.
    clock = 9_000;
    answer(launched);
    const settled = await first;
    expect(noteAnswered).toHaveBeenCalledWith({
      helpSessionId: "a",
      hostId: "studio",
      hostName: "studio-01",
      projectId: "proj-2",
      tool: "agent.launch",
      args: { agentId: "codex" },
      structured: { launched: true, terminalId: "t-w" },
      askedAt: 5_000,
    });

    // A refused call ran nothing, so it says nothing.
    await runtime.call("a", launch, { tier: "full" });
    expect(noteAnswered).toHaveBeenCalledTimes(1);

    // A resend that gets the answer back still dates from the first send.
    if (!settled.ok || settled.value.callId === null) throw new Error("not sent");
    noteAnswered.mockClear();
    clock = 20_000;
    await runtime.call("a", { ...launch, callId: settled.value.callId }, { tier: "full" });
    expect(noteAnswered).toHaveBeenCalledTimes(1);
    expect(noteAnswered).toHaveBeenCalledWith(expect.objectContaining({ askedAt: 5_000 }));

    // So does a retry under the caller's own id, once nothing here holds the call.
    const ownId = "00000000-0000-4000-8000-0000000000aa";
    relayCall.mockResolvedValueOnce(launched).mockResolvedValueOnce(launched);
    clock = 30_000;
    await runtime.call("a", { ...launch, newCallId: ownId }, { tier: "full" });
    noteAnswered.mockClear();
    clock = 40_000;
    await runtime.call("a", { ...launch, newCallId: ownId }, { tier: "full" });
    expect(noteAnswered).toHaveBeenCalledTimes(1);
    expect(noteAnswered).toHaveBeenCalledWith(expect.objectContaining({ askedAt: 30_000 }));

    // The same id on another host is another call, with a time of its own.
    hosts = [host(), host({ hostId: "other", name: "other-01" })];
    control.add("other");
    relayCall.mockResolvedValueOnce(launched);
    noteAnswered.mockClear();
    clock = 50_000;
    await runtime.call("a", { ...launch, hostId: "other", newCallId: ownId }, { tier: "full" });
    expect(noteAnswered).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "other", askedAt: 50_000 })
    );
  });
});

describe("relayRunMs", () => {
  it("gives a call at least the time a dispatch and a confirmation take", () => {
    expect(relayRunMs("terminal.list", {})).toBe(relayRunMs("terminal.list", { timeoutMs: 1 }));
    expect(relayRunMs("terminal.list", {})).toBeGreaterThanOrEqual(60_000);
  });

  it("outlasts the host's whole wait on a confirmation here, with room for the answer (#15699)", () => {
    // The host's MCP call runs for runMs; its wait on this Shell's dialog ends inside that.
    expect(relayRunMs("worktree.delete", {}) - MCP_REMOTE_CONFIRM_MARGIN_MS).toBeGreaterThan(
      MCP_REMOTE_DISPATCH_TIMEOUT_MS
    );
    // A short wait the call asks for doesn't shorten it.
    expect(relayRunMs("worktree.delete", { timeoutMs: 5_000 })).toBe(
      relayRunMs("worktree.delete", {})
    );
  });

  it("gives a retirement its exit wait and then a whole confirmation (#15737)", () => {
    // The wait runs before the delete's confirmation, so neither may eat the other's time.
    expect(relayRunMs("worktree.retireOwned", { timeoutMs: 60_000 })).toBeGreaterThan(
      60_000 + MCP_REMOTE_DISPATCH_TIMEOUT_MS
    );
    // Every millisecond of wait it asks for is added, and none asked means the default wait.
    expect(
      relayRunMs("worktree.retireOwned", { timeoutMs: 50_000 }) -
        relayRunMs("worktree.retireOwned", { timeoutMs: 20_000 })
    ).toBe(30_000);
    expect(relayRunMs("worktree.retireOwned", {})).toBe(
      relayRunMs("worktree.retireOwned", { timeoutMs: DEFAULT_TERMINAL_EXIT_WAIT_MS })
    );
  });

  it("gives a Claude Code update a whole confirmation and then its wait and read (#17908)", () => {
    // The host types `/restart` only while the answer can still reach this
    // Shell, so the call must outlast the confirmation, the wait and the read.
    expect(
      relayRunMs("terminal.applyClaudeUpdateOwned", {}) - MCP_REMOTE_CONFIRM_MARGIN_MS
    ).toBeGreaterThan(MCP_REMOTE_DISPATCH_TIMEOUT_MS + CLAUDE_UPDATE_AFTER_APPROVAL_MS);
    // Exactly the wait, the line going in and the read on top of a plain confirmation.
    expect(
      relayRunMs("terminal.applyClaudeUpdateOwned", {}) -
        relayRunMs("terminal.restartOnPresetOwned", {})
    ).toBe(CLAUDE_UPDATE_AFTER_APPROVAL_MS);
  });

  it("leaves a call that never asks anyone its own floor", () => {
    expect(relayRunMs("throwaway.launch", {}, 90_000)).toBe(90_000);
    expect(relayRunMs("throwaway.launch", { timeoutMs: 1_000 }, 90_000)).toBe(90_000);
    expect(relayRunMs("throwaway.launch", {}, 90_000)).toBeLessThan(
      relayRunMs("throwaway.launch", {})
    );
    expect(relayRunMs("throwaway.launch", { timeoutMs: 600_000 }, 90_000)).toBeGreaterThan(600_000);
  });

  it("runs past the longest wait the call's own arguments ask for", () => {
    expect(relayRunMs("terminal.waitUntilIdle", { timeoutMs: 600_000 })).toBeGreaterThan(600_000);
    expect(relayRunMs("agent.launch", { waitForReply: true, waitSeconds: 1_200 })).toBeGreaterThan(
      1_200_000
    );
    // A check with no timeout of its own runs to its default.
    expect(relayRunMs("project.runCheck", {})).toBeGreaterThan(relayRunMs("terminal.list", {}));
  });

  it("gives a new-worktree launch its setup wait and its reply wait back to back (#15738)", () => {
    expect(
      relayRunMs("agent.launchInNewWorktree", {
        setupTimeoutMs: 400_000,
        waitForReply: true,
        waitSeconds: 1_200,
      })
    ).toBeGreaterThan(400_000 + 1_200_000);
    // With no budget named, the setup wait it will still run counts.
    expect(
      relayRunMs("agent.launchInNewWorktree", { waitForReply: true, waitSeconds: 1_200 })
    ).toBeGreaterThan(LAUNCH_SETUP_WAIT_DEFAULT_MS + 1_200_000);
    // Each wait moves it by exactly its own length: summed, not the larger.
    const at = (setupTimeoutMs: number, waitSeconds: number) =>
      relayRunMs("agent.launchInNewWorktree", { setupTimeoutMs, waitForReply: true, waitSeconds });
    expect(at(500_000, 1_200) - at(400_000, 1_200)).toBe(100_000);
    expect(at(400_000, 1_300) - at(400_000, 1_200)).toBe(100_000);
    // A setup wait alone, and room for the create and launch dispatches around it.
    expect(relayRunMs("agent.launchInNewWorktree", { setupTimeoutMs: 600_000 })).toBeGreaterThan(
      600_000 + 2 * MCP_DISPATCH_TIMEOUT_MS
    );
    expect(at(600_000, 1_800)).toBeLessThan(MAX_RELAY_RUN_MS);
  });

  it("never asks the host for more than it allows", () => {
    expect(relayRunMs("project.runCheck", { timeoutMs: 10 * 60 * 60_000 })).toBe(MAX_RELAY_RUN_MS);
  });
});
