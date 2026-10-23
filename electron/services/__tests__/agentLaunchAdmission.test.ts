import { describe, expect, it, vi } from "vitest";

vi.mock("../../window/serviceRefs.js", () => ({ getPtyClient: () => null }));
vi.mock("../SystemMemoryPressureMonitor.js", () => ({
  checkKernelPressureCritical: vi.fn().mockResolvedValue(false),
}));

import {
  AGENT_LAUNCH_RESERVATION_TTL_MS,
  createAgentLaunchAdmission,
  isLiveAgentTerminal,
  readEffectiveMemoryTotalBytes,
  type AgentCountableTerminal,
  type AgentLaunchAdmissionSources,
} from "../agentLaunchAdmission.js";
import { agentLaunchLimit } from "../../../shared/config/agentLaunchCapacity.js";

const GIB = 1024 ** 3;
// A host whose memory allows exactly two agents.
const TWO_AGENT_TOTAL = (() => {
  for (let gb = 1; gb < 64; gb += 1) if (agentLaunchLimit(gb * GIB) === 2) return gb * GIB;
  throw new Error("no two-agent total");
})();

const agent = (id: string, extra: Partial<AgentCountableTerminal> = {}): AgentCountableTerminal => ({
  id,
  launchAgentId: "claude",
  hasPty: true,
  ...extra,
});

function harness(overrides: Partial<AgentLaunchAdmissionSources> = {}) {
  let terminals: AgentCountableTerminal[] = [];
  let degraded = false;
  let now = 1_000;
  const sources: AgentLaunchAdmissionSources = {
    readTerminals: async () => ({ terminals, degraded }),
    readMemoryTotalBytes: async () => TWO_AGENT_TOTAL,
    isKernelCritical: async () => false,
    now: () => now,
    ...overrides,
  };
  return {
    admission: createAgentLaunchAdmission(sources),
    setTerminals: (next: AgentCountableTerminal[]) => (terminals = next),
    setDegraded: (next: boolean) => (degraded = next),
    advance: (ms: number) => (now += ms),
  };
}

describe("isLiveAgentTerminal", () => {
  it("counts a live agent launch whatever its state, and nothing else", () => {
    expect(isLiveAgentTerminal(agent("a"))).toBe(true);
    expect(isLiveAgentTerminal(agent("a", { hasPty: undefined }))).toBe(true);
    expect(isLiveAgentTerminal({ id: "shell", hasPty: true })).toBe(false);
    expect(isLiveAgentTerminal(agent("a", { hasPty: false }))).toBe(false);
    expect(isLiveAgentTerminal(agent("a", { isExited: true }))).toBe(false);
    expect(isLiveAgentTerminal(agent("a", { isAssistantTerminal: true }))).toBe(false);
    // The agent quit and left its shell: a shell costs little.
    expect(isLiveAgentTerminal(agent("a", { agentState: "exited" }))).toBe(false);
    expect(isLiveAgentTerminal(agent("a", { agentState: "idle" }))).toBe(true);
  });
});

describe("agent launch admission (#14221)", () => {
  it("admits launches up to the host's limit and holds the next, counting every project", async () => {
    const h = harness();
    h.setTerminals([agent("live-1"), { id: "shell" }, agent("gone", { isExited: true })]);

    const first = await h.admission.request("new-1");
    expect(first.holdReason).toBeNull();
    expect(first.observation.runningAgents).toBe(1);

    const second = await h.admission.request("new-2");
    expect(second.holdReason).toBe("agent-capacity");
    expect(second.observation).toMatchObject({
      runningAgents: 1,
      startingAgents: 1,
      agentLaunchLimit: 2,
      memoryTotalBytes: TWO_AGENT_TOTAL,
    });
  });

  it("lets only one of two launches racing for the last place through", async () => {
    const h = harness();
    h.setTerminals([agent("live-1")]);

    const results = await Promise.all([h.admission.request("a"), h.admission.request("b")]);

    expect(results.filter((r) => r.holdReason === null)).toHaveLength(1);
    expect(results.filter((r) => r.holdReason === "agent-capacity")).toHaveLength(1);
  });

  it("stops counting an admitted launch as starting once it shows up live", async () => {
    const h = harness();
    await h.admission.request("a");
    h.setTerminals([agent("a")]);

    const observed = await h.admission.observe();

    expect(observed).toMatchObject({ runningAgents: 1, startingAgents: 0 });
  });

  it("lets an admitted launch that never spawned give its place back", async () => {
    const h = harness();
    h.setTerminals([agent("live-1")]);
    await h.admission.request("never-spawned");
    expect((await h.admission.request("next")).holdReason).toBe("agent-capacity");

    h.advance(AGENT_LAUNCH_RESERVATION_TTL_MS);

    expect((await h.admission.request("next")).holdReason).toBeNull();
  });

  it("never counts a launch against itself when it asks again", async () => {
    const h = harness();
    h.setTerminals([agent("live-1")]);
    await h.admission.request("a");

    expect((await h.admission.request("a")).holdReason).toBeNull();
  });

  it("frees a place when an agent's terminal exits", async () => {
    const h = harness();
    h.setTerminals([agent("live-1"), agent("live-2")]);
    expect((await h.admission.request("a")).holdReason).toBe("agent-capacity");

    h.setTerminals([agent("live-1"), agent("live-2", { isExited: true })]);

    expect((await h.admission.request("a")).holdReason).toBeNull();
  });

  it("never holds on a count it couldn't take: a shard that didn't answer, or no PTY client", async () => {
    const h = harness();
    h.setTerminals([agent("1"), agent("2"), agent("3")]);
    h.setDegraded(true);
    const degraded = await h.admission.request("a");
    expect(degraded.holdReason).toBeNull();
    expect(degraded.observation.runningAgents).toBeNull();

    const noPty = harness({ readTerminals: async () => null });
    expect((await noPty.admission.request("a")).holdReason).toBeNull();

    const failing = harness({ readTerminals: () => Promise.reject(new Error("down")) });
    expect((await failing.admission.request("a")).holdReason).toBeNull();
  });

  it("never holds on capacity when memory is unknown, but still holds at critical pressure", async () => {
    const unknown = harness({ readMemoryTotalBytes: async () => null });
    unknown.setTerminals([agent("1"), agent("2"), agent("3")]);
    const open = await unknown.admission.request("a");
    expect(open.holdReason).toBeNull();
    expect(open.observation.agentLaunchLimit).toBeNull();

    const critical = harness({
      readMemoryTotalBytes: async () => null,
      isKernelCritical: async () => true,
    });
    expect((await critical.admission.request("a")).holdReason).toBe("kernel-critical");
  });

  it("admits a launch whose terminal another view already started, however full the host", async () => {
    const h = harness();
    h.setTerminals([agent("live-1"), agent("adopt-me")]);

    const admission = await h.admission.request("adopt-me");

    expect(admission.holdReason).toBeNull();
    // Attaching starts nothing, so it holds no place: once it exits, its place is free.
    h.setTerminals([agent("live-1")]);
    expect((await h.admission.request("next")).holdReason).toBeNull();
  });

  it("admits an already-running terminal even at critical pressure", async () => {
    const h = harness({ isKernelCritical: async () => true });
    h.setTerminals([agent("adopt-me")]);

    expect((await h.admission.request("adopt-me")).holdReason).toBeNull();
    expect((await h.admission.request("fresh")).holdReason).toBe("kernel-critical");
  });

  it("judges each read in turn, so an older read never undercounts a launch a newer one saw", async () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const answers: Array<(terminals: AgentCountableTerminal[]) => void> = [];
    const h = harness({
      readTerminals: () =>
        new Promise((resolve) =>
          answers.push((terminals) => resolve({ terminals, degraded: false }))
        ),
    });
    // Limit two, one running: A takes the last place.
    const admitA = h.admission.request("a");
    await flush();
    answers.shift()!([agent("live-1")]);
    expect((await admitA).holdReason).toBeNull();

    // B reads before A is live; an observation that sees A live comes after.
    const requestB = h.admission.request("b");
    const observed = h.admission.observe();
    await flush();
    expect(answers).toHaveLength(1);
    answers.shift()!([agent("live-1")]);
    await flush();
    answers.shift()!([agent("live-1"), agent("a")]);
    await observed;

    expect((await requestB).holdReason).toBe("agent-capacity");
  });

  it("reserves nothing while it only observes", async () => {
    const h = harness();
    h.setTerminals([agent("live-1")]);
    await h.admission.observe();
    await h.admission.observe();

    expect((await h.admission.request("a")).holdReason).toBeNull();
  });
});

describe("readEffectiveMemoryTotalBytes", () => {
  it("is the machine's memory off Linux", async () => {
    const readText = vi.fn();
    await expect(readEffectiveMemoryTotalBytes(readText, "darwin", () => 36 * GIB)).resolves.toBe(
      36 * GIB
    );
    expect(readText).not.toHaveBeenCalled();
  });

  it("takes the tightest cgroup memory.max on the process's own cgroup or an ancestor", async () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/user.slice/app.scope\n",
      "/sys/fs/cgroup/user.slice/memory.max": `${16 * GIB}\n`,
      "/sys/fs/cgroup/user.slice/app.scope/memory.max": "max\n",
    };
    const readText = async (file: string) => files[file] ?? null;

    await expect(readEffectiveMemoryTotalBytes(readText, "linux", () => 64 * GIB)).resolves.toBe(
      16 * GIB
    );
  });

  it("reads a container's limit at the cgroup root", async () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": `${8 * GIB}\n`,
    };
    const readText = async (file: string) => files[file] ?? null;

    await expect(readEffectiveMemoryTotalBytes(readText, "linux", () => 64 * GIB)).resolves.toBe(
      8 * GIB
    );
  });

  it("keeps the machine's memory when a cgroup allows more, or there is no v2 cgroup", async () => {
    const roomy = async (file: string) =>
      file === "/proc/self/cgroup" ? "0::/a\n" : file.endsWith("memory.max") ? `${128 * GIB}` : null;
    await expect(readEffectiveMemoryTotalBytes(roomy, "linux", () => 32 * GIB)).resolves.toBe(
      32 * GIB
    );
    await expect(
      readEffectiveMemoryTotalBytes(async () => null, "linux", () => 32 * GIB)
    ).resolves.toBe(32 * GIB);
  });

  it("is unknown, never zero, when the machine's memory can't be read", async () => {
    await expect(readEffectiveMemoryTotalBytes(async () => null, "darwin", () => 0)).resolves.toBe(
      null
    );
  });
});
