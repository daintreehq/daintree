import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import { HostCallResultSchema } from "../../../../shared/types/hostControl.js";
import {
  HostCallRuntime,
  relayRunMs,
  type ObservedHost,
  type OpenRun,
} from "../HostCallRuntime.js";
import { MAX_RELAY_ARGS_BYTES, MAX_RELAY_RUN_MS, type McpCallAnswer } from "../linkMethods.js";

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
      expect.any(Number)
    );
    const [, payload, timeoutMs] = relayCall.mock.calls[0] as [string, { runMs: number }, number];
    expect(timeoutMs).toBeGreaterThan(payload.runMs);
  });

  it("sends a given callId as a resend", async () => {
    await runtime.call("a", { ...CALL, callId: "earlier" }, { tier: "core" });
    expect(relayCall.mock.calls[0]![1]).toMatchObject({ callId: "earlier", resend: true });
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
});

describe("relayRunMs", () => {
  it("gives a call at least the time a dispatch and a confirmation take", () => {
    expect(relayRunMs("terminal.list", {})).toBe(relayRunMs("terminal.list", { timeoutMs: 1 }));
    expect(relayRunMs("terminal.list", {})).toBeGreaterThanOrEqual(60_000);
  });

  it("runs past the longest wait the call's own arguments ask for", () => {
    expect(relayRunMs("terminal.waitUntilIdle", { timeoutMs: 600_000 })).toBeGreaterThan(600_000);
    expect(relayRunMs("agent.launch", { waitForReply: true, waitSeconds: 1_200 })).toBeGreaterThan(
      1_200_000
    );
    // A check with no timeout of its own runs to its default.
    expect(relayRunMs("project.runCheck", {})).toBeGreaterThan(relayRunMs("terminal.list", {}));
  });

  it("never asks the host for more than it allows", () => {
    expect(relayRunMs("project.runCheck", { timeoutMs: 10 * 60 * 60_000 })).toBe(MAX_RELAY_RUN_MS);
  });
});
