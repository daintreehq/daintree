import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCallArgs } from "../../../../shared/types/hostControl.js";
import type { HostFleetTargetList } from "../../../../shared/types/ipc/hostMetrics.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import { RELAY_NOTICE_WINDOW_MS, type McpCallAnswer } from "../linkMethods.js";
import { LAUNCHED_AGENT_LISTING_GRACE_MS } from "../launchedAgents.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const CONNECTED = {
  status: "connected",
  rttMs: 5,
  handshake: { version: "0.50.0" },
} as unknown as ObservedHost["connection"];

function studio(connection: ObservedHost["connection"] = CONNECTED): ObservedHost {
  return { hostId: "studio", name: "studio-01", connection, lastSeenAt: null, summary: null };
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

describe("HostCallRuntime holding a host for agents its assistants launched (#16492)", () => {
  let hosts: ObservedHost[];
  let relayCall: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<McpCallAnswer>>>;
  let listAgentTargets: ReturnType<typeof vi.fn<(hostId: string) => Promise<HostFleetTargetList>>>;
  let mono: number;
  let ids: number;
  let runtime: HostCallRuntime;

  function makeRuntime(withList = true): HostCallRuntime {
    return new HostCallRuntime({
      getSessionLane: (id) => (id === "a" ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => (id === "a" ? RUN_A : null),
      client: () => ({ relayCall, throwawayCall: vi.fn() }) as never,
      hosts: () => hosts,
      inLocalView: () => true,
      controlEnabled: () => true,
      local: {
        name: () => "greg-mbp",
        projects: async () => [],
        relayCall: vi.fn(async () => launchedIn("local-1")),
      },
      ...(withList ? { listAgentTargets } : {}),
      newId: () => `00000000-0000-4000-8000-00000000000${++ids}`,
      now: () => 1_000_000 + mono,
      clock: () => ({ wall: 1_000_000 + mono, mono }),
    });
  }

  /** The idle sweep's ask, then the read it started landing. */
  async function sweep(): Promise<boolean> {
    const held = runtime.holdsLaunchedAgents("studio");
    await settle();
    return held;
  }

  beforeEach(() => {
    hosts = [studio()];
    relayCall = vi.fn(async () => launchedIn("t-1"));
    listAgentTargets = vi.fn(async () => listing(["t-1"]));
    mono = 50_000;
    ids = 0;
    runtime = makeRuntime();
  });

  it("holds a host while the agent launched there is listed, idle or not, and lets it go once it isn't", async () => {
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
    await runtime.call("a", LAUNCH, { tier: "core" });
    // No notice was asked for: nothing but the agent holds the link.
    expect(runtime.awaitsNotices("studio")).toBe(false);
    expect(runtime.hasCallInFlight("studio")).toBe(false);

    mono += LAUNCHED_AGENT_LISTING_GRACE_MS;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledWith("studio");
    expect(await sweep()).toBe(true);

    listAgentTargets.mockResolvedValue(listing(["someone-elses"]));
    mono += 30_000;
    // The read that lets it go answers after this ask.
    expect(await sweep()).toBe(true);
    expect(await sweep()).toBe(false);
    expect(runtime.holdsLaunchedAgents("other-host")).toBe(false);
  });

  it("lets nothing go on a list that is partial, fails or never answers", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    mono += LAUNCHED_AGENT_LISTING_GRACE_MS;

    listAgentTargets.mockResolvedValue(listing([], false));
    expect(await sweep()).toBe(true);
    mono += 30_000;
    listAgentTargets.mockRejectedValue(new Error("HOST_DISCONNECTED"));
    expect(await sweep()).toBe(true);
    mono += 30_000;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      listAgentTargets.mockImplementation(() => new Promise(() => {}));
      expect(runtime.holdsLaunchedAgents("studio")).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    expect(listAgentTargets).toHaveBeenCalledTimes(3);
    // The read that never answered is given up on, and the next can go out.
    listAgentTargets.mockResolvedValue(listing(["t-1"]));
    mono += 30_000;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(4);
  });

  it("never lets go of an agent on a list read before it could have shown", async () => {
    listAgentTargets.mockResolvedValue(listing([]));
    await runtime.call("a", LAUNCH, { tier: "core" });
    // Just answered: the host may not list it yet.
    expect(await sweep()).toBe(true);
    expect(await sweep()).toBe(true);
    mono += LAUNCHED_AGENT_LISTING_GRACE_MS;
    expect(await sweep()).toBe(true);
    expect(await sweep()).toBe(false);
  });

  it("reads a host at most once an interval, one read at a time, and only while its link is up", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    hosts = [studio({ status: "disconnected" })];
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).not.toHaveBeenCalled();

    hosts = [studio()];
    expect(await sweep()).toBe(true);
    mono += 10_000;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(1);
    mono += 20_000;
    expect(await sweep()).toBe(true);
    expect(listAgentTargets).toHaveBeenCalledTimes(2);

    let answer: (list: HostFleetTargetList) => void = () => {};
    listAgentTargets.mockImplementation(
      () => new Promise((resolve) => void (answer = resolve))
    );
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

  it("holds each agent a batch launched, and none for an item that failed or a launch that declined", async () => {
    relayCall.mockResolvedValueOnce({
      status: "done",
      result: {
        isError: false,
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
    mono += LAUNCHED_AGENT_LISTING_GRACE_MS;
    listAgentTargets.mockResolvedValue(listing(["t-3"]));
    expect(await sweep()).toBe(true);
    mono += 30_000;
    listAgentTargets.mockResolvedValue(listing([]));
    expect(await sweep()).toBe(true);
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

  it("holds nothing for a launch the host refused, nor for anything but a launch", async () => {
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
  });

  it("holds a launch whose answer was lost for the notice window, until a resend names its agent", async () => {
    relayCall.mockResolvedValueOnce({ status: "unknown" } as McpCallAnswer);
    const lost = await runtime.call("a", LAUNCH, { tier: "core" });
    const callId = (lost as { value: { callId: string } }).value.callId;
    // It may have started an agent this Shell can't name, so no list lets it go.
    listAgentTargets.mockResolvedValue(listing([]));
    mono += LAUNCHED_AGENT_LISTING_GRACE_MS;
    expect(await sweep()).toBe(true);

    await runtime.call("a", { ...LAUNCH, callId }, { tier: "core" });
    mono += 30_000;
    expect(await sweep()).toBe(true);
    mono += 30_000;
    expect(await sweep()).toBe(false);

    relayCall.mockResolvedValueOnce({ status: "unknown" } as McpCallAnswer);
    await runtime.call("a", LAUNCH, { tier: "core" });
    mono += RELAY_NOTICE_WINDOW_MS - 1;
    expect(await sweep()).toBe(true);
    mono += 1;
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });

  it("never brings back an agent seen ended when its answer comes again", async () => {
    const first = await runtime.call("a", LAUNCH, { tier: "core" });
    const callId = (first as { value: { callId: string } }).value.callId;
    mono += LAUNCHED_AGENT_LISTING_GRACE_MS;
    listAgentTargets.mockResolvedValue(listing([]));
    expect(await sweep()).toBe(true);
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);

    await runtime.call("a", { ...LAUNCH, callId }, { tier: "core" });
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });

  it("holds nothing for this machine's own launches, nor with no way to list a host's agents", async () => {
    await runtime.call("a", { ...LAUNCH, hostId: "local" }, { tier: "core" });
    expect(runtime.holdsLaunchedAgents("local")).toBe(false);

    runtime = makeRuntime(false);
    await runtime.call("a", LAUNCH, { tier: "core" });
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });

  it("forgets a removed host's agents, and everything once disposed", async () => {
    await runtime.call("a", LAUNCH, { tier: "core" });
    hosts = [];
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
    hosts = [studio()];
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);

    await runtime.call("a", LAUNCH, { tier: "core" });
    expect(runtime.holdsLaunchedAgents("studio")).toBe(true);
    runtime.dispose();
    expect(runtime.holdsLaunchedAgents("studio")).toBe(false);
  });
});
