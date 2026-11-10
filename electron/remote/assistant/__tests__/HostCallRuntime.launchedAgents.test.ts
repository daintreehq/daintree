import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCallArgs } from "../../../../shared/types/hostControl.js";
import type { HostFleetTargetList } from "../../../../shared/types/ipc/hostMetrics.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import { RELAY_NOTICE_WINDOW_MS, type McpCallAnswer } from "../linkMethods.js";
import { LAUNCHED_AGENT_GONE_MS, LAUNCHED_AGENT_UNLISTED_MS } from "../launchedAgents.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};
const RUN_B: OpenRun = { ...RUN_A, slot: 1, sessionId: "b", terminalId: "t-b" };

const CONNECTED = {
  status: "connected",
  rttMs: 5,
  handshake: { version: "0.50.0" },
} as unknown as ObservedHost["connection"];

function observed(
  hostId: string,
  connection: ObservedHost["connection"] = CONNECTED
): ObservedHost {
  return { hostId, name: `${hostId}-01`, connection, lastSeenAt: null, summary: null };
}

const LAUNCH: HostCallArgs = {
  hostId: "studio",
  projectId: "proj-2",
  tool: "agent.launch",
  args: { agentId: "claude", prompt: "Fix the flaky test" },
};

const launchedIn = (terminalId: string): McpCallAnswer => ({
  status: "done",
  result: {
    isError: false,
    structured: { launched: true, terminalId, location: "grid", spawnStatus: null },
    text: null,
  },
});

const listing = (terminalIds: string[], complete = true): HostFleetTargetList => ({
  targets: terminalIds.map((terminalId) => ({
    hostId: "studio",
    terminalId,
    title: "Claude",
    projectId: "proj-2",
    projectName: "helios",
    agentId: "claude",
    agentState: "idle",
  })),
  complete,
});

/** Lets a read's answer land: it settles a few promise hops after it was asked for. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

const callIdOf = (outcome: unknown): string =>
  (outcome as { value: { callId: string } }).value.callId;

describe("HostCallRuntime holding a host for agents its assistants launched (#16492)", () => {
  let hosts: ObservedHost[];
  let control: Set<string>;
  let relayCall: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<McpCallAnswer>>>;
  let localRelay: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<McpCallAnswer>>>;
  let listAgentTargets: ReturnType<typeof vi.fn<(hostId: string) => Promise<HostFleetTargetList>>>;
  let mono: number;
  let ids: number;
  let runtime: HostCallRuntime;

  function makeRuntime(withList = true): HostCallRuntime {
    const runs = new Map([
      ["a", RUN_A],
      ["b", RUN_B],
    ]);
    return new HostCallRuntime({
      getSessionLane: (id) => {
        const run = runs.get(id);
        return run ? { projectId: run.projectId, slot: run.slot } : null;
      },
      callerRun: (id) => runs.get(id) ?? null,
      client: () => ({ relayCall, throwawayCall: vi.fn() }) as never,
      hosts: () => hosts,
      inLocalView: () => true,
      controlEnabled: (hostId) => control.has(hostId),
      local: { name: () => "greg-mbp", projects: async () => [], relayCall: localRelay },
      ...(withList ? { listAgentTargets } : {}),
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
      now: () => 1_000_000 + mono,
      clock: () => ({ wall: 1_000_000 + mono, mono }),
    });
  }

  /** The idle sweep's ask, then the read it started landing. */
  async function sweep(hostId = "studio"): Promise<boolean> {
    const held = runtime.holdsLaunchedAgents(hostId);
    await settle();
    return held;
  }

  /** Full lists missing what the host listed before, for as long as it takes to count as ended. */
  async function goneFor(terminalIds: string[] = []): Promise<void> {
    listAgentTargets.mockResolvedValue(listing(terminalIds));
    for (const step of [30_000, LAUNCHED_AGENT_GONE_MS]) {
      mono += step;
      expect(await sweep()).toBe(true);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hosts = [observed("studio")];
    control = new Set(["studio", "other"]);
    relayCall = vi.fn(async () => launchedIn("t-1"));
    localRelay = vi.fn(async () => launchedIn("local-1"));
    listAgentTargets = vi.fn(async () => listing(["t-1"]));
    mono = 50_000;
    ids = 0;
    runtime = makeRuntime();
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
  });

  it("holds a host while the agent launched there is listed, idle or not, and lets it go once it isn't", async () => {
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
    await runtime.call("a", LAUNCH, { tier: "core" });
    // No notice was asked for: nothing but the agent holds the link.
    expect(runtime.awaitsNotices("studio")).toBe(false);
    expect(runtime.hasCallInFlight("studio")).toBe(false);

    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledWith("studio");
    // Every read that answered left no timer behind.
    expect(vi.getTimerCount()).toBe(0);

    // Listed before: one full list without it may be a restart's gap, so it
    // ends only once lists have gone without it for a while.
    listAgentTargets.mockResolvedValue(listing(["someone-elses"]));
    mono += 30_000;
    expect(await sweep()).toBe(true);
    mono += LAUNCHED_AGENT_GONE_MS - 1;
    expect(await sweep()).toBe(true);
    expect(await sweep()).toBe(true);
    mono += 30_000;
    // The read that says it ended answers after this ask.
    expect(await sweep()).toBe(true);
    expect(await sweep()).toBe(false);
    expect(runtime.holdsLaunchedAgents("other")).toBe(false);
  });

  it("holds each agent a batch launched, and none for an item that failed or a launch that declined", async () => {
    relayCall.mockResolvedValueOnce({
      status: "done",
      result: {
        isError: true,
        structured: {
          results: [
            { target: "claude", ok: true, result: { launched: true, terminalId: "t-1" } },
            { target: "codex", ok: false, error: { code: "missing-cli" } },
            { target: "gemini", ok: true, result: { launched: true, terminalId: "t-3" } },
          ],
        },
        text: null,
      },
    });
    await runtime.call(
      "a",
      { ...LAUNCH, tool: "agent.launchMany", args: { agentIds: ["claude", "codex", "gemini"] } },
      { tier: "core" }
    );
    listAgentTargets.mockResolvedValue(listing(["t-1", "t-3"]));
    expect(await sweep()).toBe(true);
    await goneFor(["t-1"]);
    // t-3 ended; t-1 alone still holds the host.
    expect(await sweep()).toBe(true);
    await goneFor();
    expect(await sweep()).toBe(false);

    relayCall.mockResolvedValueOnce({
      status: "done",
      result: {
        isError: false,
        structured: { launched: false, terminalId: null, spawnStatus: "missing-cli" },
        text: null,
      },
    });
    await runtime.call("a", LAUNCH, { tier: "core" });
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });

  it("lets nothing go on a list that is partial, fails or never answers in time", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    expect(await sweep()).toBe(true);

    listAgentTargets.mockResolvedValue(listing([], false));
    mono += 30_000;
    expect(await sweep()).toBe(true);
    listAgentTargets.mockRejectedValue(new Error("HOST_DISCONNECTED"));
    mono += 30_000;
    expect(await sweep()).toBe(true);

    let late: (list: HostFleetTargetList) => void = () => {};
    listAgentTargets.mockImplementation(() => new Promise((resolve) => void (late = resolve)));
    mono += 30_000;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(9_999);
    mono += 30_000;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    // Given up on: its answer coming after lets nothing go, and a new read can go out.
    late(listing([]));
    await settle();
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(5);
  });

  it("gives an agent the host has never listed time to start, from when the read was asked for", async () => {
    let answer: (list: HostFleetTargetList) => void = () => {};
    listAgentTargets.mockImplementation(() => new Promise((resolve) => void (answer = resolve)));
    await runtime.call("a", LAUNCH, { tier: "core" });
    // Its pane may still be waiting to start: a list without it lets nothing go.
    expect(await sweep()).toBe(true);
    answer(listing([]));
    await settle();

    mono += LAUNCHED_AGENT_UNLISTED_MS - 1;
    expect(await sweep()).toBe(true);
    // Asked for before its time was up, answered after: still not the end of it.
    mono += 10_000;
    answer(listing([]));
    await settle();
    expect(await sweep()).toBe(true);

    listAgentTargets.mockResolvedValue(listing([]));
    mono += 30_000;
    expect(await sweep()).toBe(true);
    expect(await sweep()).toBe(false);
  });

  it("reads a host at most once an interval, one read at a time, and only while its link is up", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    hosts = [observed("studio", { status: "disconnected" })];
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).not.toHaveBeenCalled();

    hosts = [observed("studio")];
    expect(await sweep()).toBe(true);
    mono += 29_999;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(1);
    mono += 1;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(2);

    let answer: (list: HostFleetTargetList) => void = () => {};
    listAgentTargets.mockImplementation(() => new Promise((resolve) => void (answer = resolve)));
    mono += 30_000;
    expect(await sweep()).toBe(true);
    mono += 60_000;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(3);
    answer(listing(["t-1"]));
    await settle();
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(4);
  });

  it("holds nothing for a launch refused here or by the host, nor for anything but a launch", async () => {
    control.delete("studio");
    const off = await runtime.call("a", LAUNCH, { tier: "core" });
    expect(off).toMatchObject({ ok: true, value: { outcome: "opted_out" } });
    expect(relayCall).not.toHaveBeenCalled();
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
    control.add("studio");

    relayCall.mockResolvedValueOnce({ status: "refused", reason: "control-off" });
    await runtime.call("a", LAUNCH, { tier: "core" });
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);

    relayCall.mockResolvedValueOnce(launchedIn("t-9"));
    await runtime.call(
      "a",
      { ...LAUNCH, tool: "terminal.list", args: { owned: true } },
      { tier: "core" }
    );
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
    expect(listAgentTargets).not.toHaveBeenCalled();
  });

  it("holds a launch whose answer was lost or unreadable for the notice window, until a resend names its agent", async () => {
    relayCall.mockResolvedValueOnce({ status: "unknown" });
    const lost = await runtime.call("a", LAUNCH, { tier: "core" });
    // It may have started an agent this Shell can't name, so no list lets it go.
    listAgentTargets.mockResolvedValue(listing([]));
    mono += LAUNCHED_AGENT_UNLISTED_MS;
    expect(await sweep()).toBe(true);

    listAgentTargets.mockResolvedValue(listing(["t-1"]));
    await runtime.call("a", { ...LAUNCH, callId: callIdOf(lost) }, { tier: "core" });
    mono += 30_000;
    expect(await sweep()).toBe(true);
    await goneFor();
    expect(await sweep()).toBe(false);

    // A tool that threw after it was dispatched answers with nothing readable.
    relayCall.mockResolvedValueOnce({
      status: "done",
      result: { isError: true, structured: null, text: '{"code":"EXECUTION_ERROR"}' },
    });
    await runtime.call("a", LAUNCH, { tier: "core" });
    mono += RELAY_NOTICE_WINDOW_MS - 1;
    expect(await sweep()).toBe(true);
    mono += 1;
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });

  it("never lets another session or host take over a lost launch's call id", async () => {
    hosts = [observed("studio"), observed("other")];
    relayCall.mockResolvedValueOnce({ status: "unknown" });
    const lost = await runtime.call("a", LAUNCH, { tier: "core" });
    const callId = callIdOf(lost);

    for (const [session, hostId] of [
      ["b", "studio"],
      ["a", "other"],
    ] as const) {
      const taken = await runtime.call(
        session,
        { ...LAUNCH, hostId, newCallId: callId },
        { tier: "core" }
      );
      expect(taken).toMatchObject({ ok: true, value: { outcome: "conflict", callId: null } });
    }
    expect(relayCall).toHaveBeenCalledTimes(1);
    expect(runtime.holdsLaunchedAgents("studio")).toBe(true);
    expect(runtime.holdsLaunchedAgents("other")).toBe(false);
  });

  it("never brings back an agent seen ended when its answer comes again", async () => {
    const first = await runtime.call("a", LAUNCH, { tier: "core" });
    expect(await sweep()).toBe(true);
    await goneFor();
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);

    await runtime.call("a", { ...LAUNCH, callId: callIdOf(first) }, { tier: "core" });
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });

  it("holds nothing for this machine's own launches, nor with no way to list a host's agents", async () => {
    hosts = [observed("local"), observed("studio")];
    const local = await runtime.call("a", { ...LAUNCH, hostId: "local" }, { tier: "core" });
    expect(local).toMatchObject({ ok: true, value: { outcome: "ok" } });
    expect(localRelay).toHaveBeenCalledTimes(1);
    expect(await sweep("local")).toBe(false);
    expect(listAgentTargets).not.toHaveBeenCalled();

    runtime.dispose();
    runtime = makeRuntime(false);
    await runtime.call("a", LAUNCH, { tier: "core" });
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });

  it("forgets a removed host's launches and its read, and everything once disposed", async () => {
    relayCall.mockResolvedValueOnce({ status: "unknown" });
    await runtime.call("a", LAUNCH, { tier: "core" });
    let answer: (list: HostFleetTargetList) => void = () => {};
    listAgentTargets.mockImplementation(() => new Promise((resolve) => void (answer = resolve)));
    expect(await sweep()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    hosts = [];
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    hosts = [observed("studio")];
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);

    listAgentTargets.mockResolvedValue(listing(["t-1"]));
    await runtime.call("a", LAUNCH, { tier: "core" });
    // A fresh read goes out at once, and the old one answering late changes nothing.
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(2);
    answer(listing([]));
    await settle();

    listAgentTargets.mockImplementation(() => new Promise(() => {}));
    mono += 30_000;
    expect(await sweep()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    runtime.dispose();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });
});
