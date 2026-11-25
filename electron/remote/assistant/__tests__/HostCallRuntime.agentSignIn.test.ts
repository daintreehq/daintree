import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import { HostStartAgentSignInResultSchema } from "../../../../shared/types/hostControl.js";
import type { HostMetricsSummary } from "../../../../shared/types/remoteHosts.js";
import type { SignInOfferAnswer } from "../../canopy/client.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";

const RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};
const GLOBAL_RUN: OpenRun = {
  projectId: GLOBAL_ASSISTANT_ID,
  slot: 0,
  sessionId: "g",
  terminalId: "t-g",
  launchGeneration: 7,
};

function summary(agentIds: string[]): HostMetricsSummary {
  return {
    sampledAt: 1000,
    agentClis: agentIds.map((agentId) => ({ agentId, version: null })),
  } as HostMetricsSummary;
}

function host(hostId: string, overrides: Partial<ObservedHost> = {}): ObservedHost {
  return {
    hostId,
    name: hostId,
    connection: { status: "connected", rttMs: 3 } as ObservedHost["connection"],
    lastSeenAt: 1000,
    summary: summary(["claude", "codex"]),
    summaryFromCurrentLink: true,
    ...overrides,
  };
}

type Start = (request: {
  helpSessionId: string;
  hostId: string;
  agentId: string;
  signal?: AbortSignal;
}) => Promise<SignInOfferAnswer>;

describe("HostCallRuntime host.startAgentSignIn (#18197)", () => {
  let runs: Map<string, OpenRun>;
  let hosts: ObservedHost[];
  let start: ReturnType<typeof vi.fn<Start>>;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    runs = new Map([
      ["a", { ...RUN }],
      ["g", { ...GLOBAL_RUN }],
    ]);
    hosts = [
      host("studio"),
      host("mini"),
      host("asleep", { connection: { status: "disconnected" } as ObservedHost["connection"] }),
      host("rejoined", { summaryFromCurrentLink: false }),
      host("fresh", { summary: null }),
      host("detecting", { summary: summary([]) }),
    ];
    start = vi.fn<Start>(async () => "shown");
    runtime = new HostCallRuntime({
      getSessionLane: (id) => {
        const run = runs.get(id);
        return run ? { projectId: run.projectId, slot: run.slot } : null;
      },
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => hosts,
      inLocalView: () => true,
      controlEnabled: (hostId) => hostId !== "mini",
      startAgentSignIn: start,
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it("starts the CLI's sign-in in the caller's window and answers once that window opened it", async () => {
    const signal = new AbortController().signal;
    const outcome = await runtime.startAgentSignIn(
      "a",
      { hostId: "studio", agentId: "codex" },
      signal
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(HostStartAgentSignInResultSchema.parse(outcome.value)).toEqual(outcome.value);
    expect(outcome.value.outcome).toBe("ok");
    expect(start).toHaveBeenCalledWith({
      helpSessionId: "a",
      hostId: "studio",
      agentId: "codex",
      signal,
    });
  });

  it("reaches the global Assistant that is coordinating, and refuses one standing by", async () => {
    await expect(
      runtime.startAgentSignIn("g", { hostId: "studio", agentId: "claude" })
    ).resolves.toMatchObject({ ok: true, value: { outcome: "ok" } });
    expect(start).toHaveBeenCalledTimes(1);

    runs.set("g", { ...GLOBAL_RUN, standby: true });
    const outcome = await runtime.startAgentSignIn("g", { hostId: "studio", agentId: "claude" });
    expect(outcome).toMatchObject({ ok: true, value: { outcome: "policy_rejected" } });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("refuses a session with no run here, and starts nothing for it", async () => {
    await expect(
      runtime.startAgentSignIn("stranger", { hostId: "studio", agentId: "codex" })
    ).resolves.toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(start).not.toHaveBeenCalled();
  });

  it("starts nothing for a CLI the host's row in Settings wouldn't list", async () => {
    const cases: Array<[string, string, string]> = [
      ["local", "codex", "unsupported"],
      ["elsewhere", "codex", "not_found"],
      ["mini", "codex", "opted_out"],
      ["asleep", "codex", "disconnected"],
      // Kept from an earlier link: Settings shows no rows for it either.
      ["rejoined", "codex", "not_found"],
      ["fresh", "codex", "not_found"],
      ["detecting", "codex", "not_found"],
      ["studio", "gemini", "not_found"],
      // An exact id, never a name or a prefix of one.
      ["studio", "Codex", "not_found"],
      ["studio", "code", "not_found"],
    ];
    for (const [hostId, agentId, expected] of cases) {
      const outcome = await runtime.startAgentSignIn("a", { hostId, agentId });
      expect(outcome.ok, `${hostId}/${agentId}`).toBe(true);
      if (!outcome.ok) continue;
      expect(HostStartAgentSignInResultSchema.parse(outcome.value)).toEqual(outcome.value);
      expect(outcome.value.outcome, `${hostId}/${agentId}`).toBe(expected);
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("answers ok only when the window opened it, and never says the person is signed in", async () => {
    const answers: SignInOfferAnswer[] = [
      "shown",
      "withdrawn",
      "busy",
      "expired",
      "cancelled",
      "no_window",
      "unsupported",
      "disconnected",
      "rate_limited",
      "failed",
    ];
    const seen = new Map<string, string>();
    for (const answer of answers) {
      start.mockResolvedValueOnce(answer);
      const outcome = await runtime.startAgentSignIn("a", { hostId: "studio", agentId: "codex" });
      if (!outcome.ok) throw new Error(`refused for ${answer}`);
      expect(HostStartAgentSignInResultSchema.parse(outcome.value)).toEqual(outcome.value);
      seen.set(answer, outcome.value.outcome);
      expect(outcome.value.detail ?? "", answer).not.toMatch(/signed in|logged in|succeeded/i);
    }
    expect([...seen].filter(([, outcome]) => outcome === "ok").map(([answer]) => answer)).toEqual([
      "shown",
    ]);
  });

  it("is unsupported where the Shell can't start sign-ins on hosts", async () => {
    const bare = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => hosts,
      inLocalView: () => true,
      controlEnabled: () => true,
    });
    await expect(
      bare.startAgentSignIn("a", { hostId: "studio", agentId: "codex" })
    ).resolves.toMatchObject({ ok: true, value: { outcome: "unsupported" } });
    bare.dispose();
  });
});
