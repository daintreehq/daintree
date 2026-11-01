import { beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({
  getTerminalAsync: vi.fn(),
  getAllTerminalsWithCompletenessAsync: vi.fn(),
  submit: vi.fn(),
}));
const lease = vi.hoisted(() => ({ holder: null as null | Record<string, unknown> }));

vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => pty,
  getWorkspaceClientRef: () => null,
}));
vi.mock("../../../services/AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () => ({ getHolder: () => lease.holder }),
  getDriveLeaseService: () => ({ getHolder: () => lease.holder }),
}));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: () => null },
}));
vi.mock("../../../services/projectAgentCounts.js", () => ({ classifyRun: () => null }));
vi.mock("../hostSources.js", () => ({ openProjects: () => [] }));

import {
  FLEET_SUBMIT_MAX_RETAINED,
  FleetSubmitLedger,
  callerDrives,
  listLocalFleetTargets,
  observeWorktreeRuns,
  submitLocalFleet,
} from "../hostOps.js";
import type { FleetRunRow } from "../../../../shared/types/ipc/fleet.js";
import { MAX_FLEET_TARGETS } from "../linkMethods.js";
import {
  FLEET_SAFE_RETRY_MS,
  FLEET_SUBMIT_RETENTION_MS,
} from "../../../../shared/config/fleetSubmitRetention.js";

function holder(endpointId: string, overrides: Record<string, unknown> = {}) {
  return {
    leaseId: 1,
    endpointId,
    clientId: "shell-a",
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  pty.getTerminalAsync.mockReset().mockResolvedValue({ id: "t1", projectId: "p1", hasPty: true });
  pty.submit.mockReset();
  lease.holder = null;
});

describe("fleet submit authorization", () => {
  it("lets anyone submit while nobody drives the project", async () => {
    await submitLocalFleet("t1", "go", { kind: "remote", sessionId: "sess-b" });
    expect(pty.submit).toHaveBeenCalledWith("t1", "go");
  });

  it("lets a session submit into a project one of its own views drives", async () => {
    lease.holder = holder("remote:sess-a:view-1");
    await submitLocalFleet("t1", "go", { kind: "remote", sessionId: "sess-a" });
    expect(pty.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses a session whose client id matches the driver's but whose session does not", async () => {
    // The driver's client id is only what its HELLO claimed; another Shell can claim it too.
    lease.holder = holder("remote:sess-a:view-1", { clientId: "shell-a" });
    await expect(
      submitLocalFleet("t1", "go", { kind: "remote", sessionId: "sess-b" })
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    // A session id that merely begins with the driver's is not the driver's.
    await expect(
      submitLocalFleet("t1", "go", { kind: "remote", sessionId: "sess" })
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(pty.submit).not.toHaveBeenCalled();
  });

  it("keeps a remote session out of a project this machine's own window drives, and vice versa", () => {
    const local = holder("local-view", { isHostLocal: true });
    expect(callerDrives(local, { kind: "local" })).toBe(true);
    expect(callerDrives(local, { kind: "remote", sessionId: "sess-a" })).toBe(false);
    expect(callerDrives(holder("remote:sess-a:v"), { kind: "local" })).toBe(false);
    expect(callerDrives(null, { kind: "local" })).toBe(true);
  });
});

describe("fleet submit opIds", () => {
  it("types a prompt once however often its opId is resent", async () => {
    const caller = { kind: "remote", sessionId: "sess-a" } as const;
    await submitLocalFleet("t1", "go", caller, "op-once");
    await submitLocalFleet("t1", "go", caller, "op-once");
    expect(pty.submit).toHaveBeenCalledTimes(1);
    await submitLocalFleet("t1", "go", caller, "op-twice");
    expect(pty.submit).toHaveBeenCalledTimes(2);
  });

  it("refuses an opId reused for a different prompt or terminal", async () => {
    const caller = { kind: "local" } as const;
    await submitLocalFleet("t1", "go", caller, "op-reuse");
    await expect(submitLocalFleet("t1", "stop", caller, "op-reuse")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(submitLocalFleet("t2", "go", caller, "op-reuse")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(pty.submit).toHaveBeenCalledTimes(1);
  });

  it("forgets a refusal, so a resend after the lease frees up runs", async () => {
    lease.holder = holder("remote:sess-a:view-1");
    const caller = { kind: "remote", sessionId: "sess-b" } as const;
    await expect(submitLocalFleet("t1", "go", caller, "op-later")).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    lease.holder = null;
    await submitLocalFleet("t1", "go", caller, "op-later");
    expect(pty.submit).toHaveBeenCalledTimes(1);
  });

  it("never drops a submit still running, so its resend joins it", async () => {
    let now = 0;
    const ledger = new FleetSubmitLedger(() => now, 1_000, 2);
    let release!: () => void;
    const slow = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const pending = ledger.run("slow", "t1", "x", slow);
    await ledger.run("fast", "t1", "x", async () => {});
    now = 5_000;
    const again = ledger.run("slow", "t1", "x", slow);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([pending, again]);
  });

  it("keeps every outcome for its retention, refusing new submits at the cap rather than evicting", async () => {
    let now = 0;
    const ledger = new FleetSubmitLedger(() => now, 1_000, 2);
    const work = vi.fn(async () => {});
    await ledger.run("a", "t1", "x", work);
    await ledger.run("b", "t1", "x", work);
    await expect(ledger.run("c", "t1", "x", work)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(work).toHaveBeenCalledTimes(2);
    // "a" is still on record, so its resend inside the retention types nothing.
    now = 999;
    await ledger.run("a", "t1", "x", work);
    expect(work).toHaveBeenCalledTimes(2);
    // Once the retention runs out the records go and new submits run again.
    now = 5_000;
    await ledger.run("c", "t1", "x", work);
    expect(work).toHaveBeenCalledTimes(3);
    expect(ledger.size).toBe(1);
  });

  it("keeps outcomes well past the Shell's safe-retry window, with a cap no realistic fleet reaches", () => {
    expect(FLEET_SAFE_RETRY_MS).toBeLessThan(FLEET_SUBMIT_RETENTION_MS);
    expect(FLEET_SUBMIT_RETENTION_MS - FLEET_SAFE_RETRY_MS).toBeGreaterThanOrEqual(60_000);
    expect(FLEET_SUBMIT_MAX_RETAINED).toBeGreaterThanOrEqual(10 * MAX_FLEET_TARGETS);
  });
});

describe("fleet target listing", () => {
  const agent = (id: string) => ({ id, projectId: "p1", agentState: "working", hasPty: true });

  it("reports a read with a shard that didn't answer as incomplete", async () => {
    pty.getAllTerminalsWithCompletenessAsync.mockResolvedValue({
      terminals: [agent("t1")],
      degraded: true,
      shardsTotal: 2,
      shardsFailed: 1,
    });
    const list = await listLocalFleetTargets();
    expect(list.complete).toBe(false);
    expect(list.targets.map((t) => t.terminalId)).toEqual(["t1"]);
  });

  it("reports a full read as complete, and one cut at the cap as incomplete", async () => {
    pty.getAllTerminalsWithCompletenessAsync.mockResolvedValue({
      terminals: [agent("t1")],
      degraded: false,
      shardsTotal: 1,
      shardsFailed: 0,
    });
    expect(await listLocalFleetTargets()).toMatchObject({ complete: true });
    pty.getAllTerminalsWithCompletenessAsync.mockResolvedValue({
      terminals: Array.from({ length: MAX_FLEET_TARGETS + 1 }, (_, i) => agent(`t${i}`)),
      degraded: false,
      shardsTotal: 1,
      shardsFailed: 0,
    });
    const capped = await listLocalFleetTargets();
    expect(capped.targets).toHaveLength(MAX_FLEET_TARGETS);
    expect(capped.complete).toBe(false);
  });
});

describe("observeWorktreeRuns", () => {
  function run(overrides: Partial<FleetRunRow>): FleetRunRow {
    return { runId: "t1", workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...overrides };
  }

  it("lists a worktree's agents most urgent first, each with its terminal and state", () => {
    const seen = observeWorktreeRuns([
      run({ runId: "t1", worktreeId: "/repo/a", agentState: "working" }),
      run({ runId: "t2", worktreeId: "/repo/a", agentState: "waiting", waitingReason: "error" }),
      run({ runId: "t3", worktreeId: "/repo/b", agentState: "working" }),
    ]);
    expect(seen.get("p1\n/repo/a")).toEqual([
      { terminalId: "t2", band: "blocked", agentState: "waiting" },
      { terminalId: "t1", band: "running", agentState: "working" },
    ]);
    expect(seen.get("p1\n/repo/b")).toEqual([
      { terminalId: "t3", band: "running", agentState: "working" },
    ]);
  });

  it("keys by project as well as worktree, and skips runs with no worktree", () => {
    const seen = observeWorktreeRuns([
      run({ runId: "t1", workspaceId: "p1", worktreeId: "/same", agentState: "working" }),
      run({ runId: "t2", workspaceId: "p2", worktreeId: "/same", agentState: "waiting" }),
      run({ runId: "t3", agentState: "waiting" }),
    ]);
    expect([...seen.keys()].sort()).toEqual(["p1\n/same", "p2\n/same"]);
    expect(seen.get("p1\n/same")?.[0]?.band).toBe("running");
  });

  it("settles equal bands on the lowest run id, whatever order they arrive in", () => {
    const a = run({ runId: "t9", worktreeId: "/w", agentState: "working" });
    const b = run({ runId: "t2", worktreeId: "/w", agentState: "directing" });
    expect(
      observeWorktreeRuns([a, b])
        .get("p1\n/w")
        ?.map((r) => r.terminalId)
    ).toEqual(["t2", "t9"]);
    expect(
      observeWorktreeRuns([b, a])
        .get("p1\n/w")
        ?.map((r) => r.terminalId)
    ).toEqual(["t2", "t9"]);
  });

  it("places a run by this host's own Canopy reading, beside the state it observed", () => {
    const asked = { kind: "asked", quote: "Run the migration?", readAt: 0, seen: false } as const;
    const seen = observeWorktreeRuns([
      run({ worktreeId: "/w", agentState: "waiting", waitingReason: "approval", canopy: asked }),
      // An unread hand-back would put it in review: the read ask is what idles it.
      run({
        runId: "t2",
        worktreeId: "/w",
        agentState: "completed",
        handBack: { stoppedAt: 0 },
        canopy: { ...asked, seen: true },
      }),
    ]);
    expect(seen.get("p1\n/w")).toEqual([
      { terminalId: "t1", band: "needs-you", agentState: "waiting" },
      { terminalId: "t2", band: "idle", agentState: "completed" },
    ]);
  });

  it("places an ask wait by the fallback when this host has no reading of it", () => {
    const wait = { agentState: "waiting", waitingReason: "approval", worktreeId: "/w" } as const;
    const seen = observeWorktreeRuns([
      run({ ...wait, wait: { stoppedAt: 0 } }),
      run({ ...wait, runId: "t2", wait: { stoppedAt: 0, seenAt: 1 } }),
    ]);
    expect(seen.get("p1\n/w")).toEqual([
      { terminalId: "t1", band: "review", agentState: "waiting" },
      { terminalId: "t2", band: "idle", agentState: "waiting" },
    ]);
  });
});
