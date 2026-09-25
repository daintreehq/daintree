import { beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({
  getTerminalAsync: vi.fn(),
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

import { FleetSubmitLedger, callerDrives, submitLocalFleet } from "../hostOps.js";

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
    const ledger = new FleetSubmitLedger(() => now, 1_000, 1);
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

  it("keeps outcomes bounded and for a limited time", async () => {
    let now = 0;
    const ledger = new FleetSubmitLedger(() => now, 1_000, 2);
    const work = vi.fn(async () => {});
    await ledger.run("a", "t1", "x", work);
    await ledger.run("b", "t1", "x", work);
    await ledger.run("c", "t1", "x", work);
    expect(ledger.size).toBe(2);
    // "a" was evicted, so it runs again.
    await ledger.run("a", "t1", "x", work);
    expect(work).toHaveBeenCalledTimes(4);
    now = 5_000;
    await ledger.run("c", "t1", "x", work);
    expect(work).toHaveBeenCalledTimes(5);
    expect(ledger.size).toBe(1);
  });
});
