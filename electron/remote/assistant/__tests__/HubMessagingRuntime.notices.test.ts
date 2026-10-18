import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneWake } from "../../../services/mcp-server/terminalNotify.js";
import type { LaneRef, OpenRun } from "../AssistantMessagingPolicy.js";
import { HubMessagingRuntime, type ObservedHost } from "../HubMessagingRuntime.js";
import type { McpCallAnswer, RelayNotice } from "../linkMethods.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

function host(hostId: string, name: string): ObservedHost {
  return {
    hostId,
    name,
    assistantMessagingEnabled: false,
    connection: { status: "disconnected" },
    lastSeenAt: null,
    summary: null,
  };
}

const DONE: McpCallAnswer = {
  status: "done",
  result: { isError: false, structured: { launched: true }, text: null },
};

const LAUNCH = {
  hostId: "studio",
  projectId: "proj-2",
  tool: "agent.launch",
  args: { agentId: "claude", prompt: "fix it", notify: true },
};

describe("HubMessagingRuntime notices from hosts (#13500)", () => {
  let now: number;
  let runs: Map<string, OpenRun>;
  let control: Set<string>;
  let relayCall: ReturnType<typeof vi.fn>;
  let queued: Array<{
    lane: { helpSessionId: string; terminalId: string; projectId: string };
    wake: LaneWake;
  }>;
  let ids: number;
  let runtime: HubMessagingRuntime;

  const notice = (overrides: Partial<RelayNotice> = {}): RelayNotice => ({
    noticeId: "n-1",
    helpSessionId: "a",
    callId: "call-1",
    terminalId: "host-t-1",
    observation: { kind: "state", state: "waiting", waitingReason: "prompt", handback: false },
    ...overrides,
  });

  beforeEach(() => {
    now = Date.parse("2026-10-18T10:00:00Z");
    runs = new Map([["a", { ...RUN_A }]]);
    const lanes = new Map<string, LaneRef>([["a", { projectId: "proj-1", slot: 0 }]]);
    control = new Set(["studio", "other"]);
    relayCall = vi.fn(async () => DONE);
    queued = [];
    ids = 0;
    runtime = new HubMessagingRuntime({
      policy: { isSupported: () => true, checkHost: () => ({ ok: true }) },
      getSessionLane: (id) => lanes.get(id) ?? null,
      callerRun: (id) => runs.get(id) ?? null,
      client: () => ({ relayCall }) as never,
      hosts: () => [host("studio", "studio-01"), host("other", "studio-02")],
      inLocalView: () => true,
      controlEnabled: (hostId) => control.has(hostId),
      queueNotice: (lane, wake) => queued.push({ lane, wake }),
      newId: () => `call-${++ids}`,
      now: () => now,
    });
  });

  it("types a notice into the run whose call armed it, naming the host as this Shell knows it", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice()] });

    expect(queued).toHaveLength(1);
    const [{ lane, wake }] = queued;
    expect(lane).toEqual({ helpSessionId: "a", terminalId: "t-a", projectId: "proj-1" });
    expect(wake).toMatchObject({
      id: "n-1",
      kind: "notice",
      hostNotice: {
        hostName: "studio-01",
        notice: {
          terminalId: "host-t-1",
          observation: {
            kind: "state",
            state: "waiting",
            waitingReason: "prompt",
            handback: false,
          },
        },
      },
    });
    expect(wake.recheck()).toEqual({ kind: "ready" });
  });

  it("takes the host from the connection: a notice for a call to another host goes nowhere", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("other", { notices: [notice()] });
    expect(queued).toEqual([]);
  });

  it("types a resent notice once", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice()] });
    runtime.receiveNotices("studio", { notices: [notice()] });
    expect(queued).toHaveLength(1);
  });

  it("never lands a notice in a run that replaced the one that asked", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice({ noticeId: "n-1" })] });
    runs.set("a", { ...RUN_A, launchGeneration: 2 });

    expect(queued[0]!.wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
    runtime.receiveNotices("studio", { notices: [notice({ noticeId: "n-2" })] });
    expect(queued).toHaveLength(1);
  });

  it("takes nothing for a call that never asked for a notice", async () => {
    await runtime.call("a", { ...LAUNCH, tool: "terminal.list", args: {} }, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice()] });
    expect(queued).toEqual([]);
  });

  it("forgets a call the host refused, since it armed nothing", async () => {
    relayCall.mockResolvedValueOnce({ status: "refused", reason: "control-off" });
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice()] });
    expect(queued).toEqual([]);
    expect(runtime.awaitsNotices("studio")).toBe(false);
  });

  it("lets a later prompt to the same host terminal make a waiting notice stale", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice()] });
    now += 1_000;
    await runtime.call(
      "a",
      {
        ...LAUNCH,
        tool: "terminal.sendCommand",
        args: { terminalId: "host-t-1", command: "next" },
      },
      { tier: "core" }
    );
    expect(queued[0]!.wake.recheck()).toEqual({ kind: "unavailable", reason: "superseded" });
  });

  it("stops typing a host's notices once assistant control is off for it", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice()] });
    control.delete("studio");
    expect(queued[0]!.wake.recheck()).toEqual({ kind: "unavailable", reason: "control-off" });
  });

  it("keeps a notifyWhenIdle note on this Shell rather than reading it back from the host", async () => {
    await runtime.call(
      "a",
      {
        ...LAUNCH,
        tool: "terminal.notifyWhenIdle",
        args: { terminalId: "host-t-1", note: "the build" },
      },
      { tier: "core" }
    );
    runtime.receiveNotices("studio", { notices: [notice()] });
    expect(queued[0]!.wake.hostNotice?.notice.note).toBe("the build");
  });

  it("takes a notice that arrives before its call has answered", async () => {
    let answer!: (value: McpCallAnswer) => void;
    relayCall.mockImplementationOnce(
      () => new Promise<McpCallAnswer>((resolve) => (answer = resolve))
    );
    const call = runtime.call("a", LAUNCH, { tier: "core" });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    runtime.receiveNotices("studio", { notices: [notice()] });
    answer(DONE);
    await call;
    expect(queued).toHaveLength(1);
  });

  it("never pins a resend: a run that replaced the asker can't take over its call", async () => {
    runs.set("a", { ...RUN_A, launchGeneration: 2 });
    await runtime.call("a", { ...LAUNCH, callId: "call-old" }, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice({ callId: "call-old" })] });
    expect(queued).toEqual([]);
  });

  it("keeps the pin of a call whose tool failed, since a batch may have armed some of it", async () => {
    relayCall.mockResolvedValueOnce({
      status: "done",
      result: { isError: true, structured: null, text: "timed out" },
    });
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice()] });
    expect(queued).toHaveLength(1);
  });

  it("types a send's own notice, however soon it comes", async () => {
    await runtime.call(
      "a",
      {
        ...LAUNCH,
        tool: "terminal.sendCommandOwned",
        args: { terminalId: "host-t-1", command: "go", notify: true },
      },
      { tier: "core" }
    );
    runtime.receiveNotices("studio", { notices: [notice()] });
    expect(queued[0]!.wake.recheck()).toEqual({ kind: "ready" });
  });

  it("leaves a waiting notice alone for a prompt that was resent or refused", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    runtime.receiveNotices("studio", { notices: [notice()] });
    now += 1_000;
    const prompt = {
      ...LAUNCH,
      tool: "terminal.sendCommandOwned",
      args: { terminalId: "host-t-1", command: "next" },
    };
    await runtime.call("a", { ...prompt, callId: "call-earlier" }, { tier: "core" });
    relayCall.mockResolvedValueOnce({ status: "refused", reason: "control-off" });
    await runtime.call("a", prompt, { tier: "core" });
    expect(queued[0]!.wake.recheck()).toEqual({ kind: "ready" });
  });

  it("holds its host's link while a recent call may still send a notice", async () => {
    expect(runtime.awaitsNotices("studio")).toBe(false);
    await runtime.call("a", LAUNCH, { tier: "core" });
    expect(runtime.awaitsNotices("studio")).toBe(true);
    expect(runtime.awaitsNotices("other")).toBe(false);

    now += 2 * 60 * 60_000 + 1;
    expect(runtime.awaitsNotices("studio")).toBe(false);
  });

  it("lets the link go once the run that asked is gone", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    runs.delete("a");
    expect(runtime.awaitsNotices("studio")).toBe(false);
  });
});
