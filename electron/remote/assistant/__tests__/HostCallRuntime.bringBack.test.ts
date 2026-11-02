import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostBringBackResultSchema } from "../../../../shared/types/hostControl.js";
import type { HostBringBackAnswer } from "../../../../shared/types/hostWake.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";

const RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

function observed(hostId: string): ObservedHost {
  return {
    hostId,
    name: hostId,
    connection: { status: "unreachable", lastSeenAt: null, detail: "timed out" },
    lastSeenAt: null,
    summary: null,
  };
}

describe("HostCallRuntime host.bringBack (#16170)", () => {
  let runs: Map<string, OpenRun>;
  let bringBack: ReturnType<typeof vi.fn<(hostId: string) => Promise<HostBringBackAnswer>>>;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    runs = new Map([["a", { ...RUN }]]);
    bringBack = vi.fn(async () => ({
      status: "not_wakeable" as const,
      wake: "not_on_lan" as const,
      reached: false,
      startRequested: false,
      observed: "ssh: connect to host studio port 22: Operation timed out",
      elapsedMs: 10_300,
    }));
    runtime = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => [observed("studio"), observed("mini")],
      inLocalView: () => true,
      controlEnabled: (hostId) => hostId === "studio",
      bringBack,
    });
  });

  afterEach(() => {
    runtime.dispose();
  });

  it("brings back a host for this machine's running assistant, answering in the advertised shape", async () => {
    const outcome = await runtime.bringBack("a", { hostId: "studio" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(HostBringBackResultSchema.parse(outcome.value)).toEqual(outcome.value);
    expect(outcome.value).toMatchObject({
      outcome: "ok",
      answer: { status: "not_wakeable", wake: "not_on_lan" },
    });
    // What to do next is about the status it got, not a fixed line.
    expect(outcome.value.detail).toContain("wake");
    expect(bringBack).toHaveBeenCalledWith("studio");
  });

  it("refuses a session with no run here, and tries nothing for it", async () => {
    await expect(runtime.bringBack("stranger", { hostId: "studio" })).resolves.toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
    expect(bringBack).not.toHaveBeenCalled();
  });

  it("answers a host it can't try in the advertised shape too", async () => {
    for (const hostId of ["mini", "elsewhere", "local"]) {
      const outcome = await runtime.bringBack("a", { hostId });
      expect(outcome.ok, hostId).toBe(true);
      if (!outcome.ok) continue;
      expect(HostBringBackResultSchema.parse(outcome.value), hostId).toEqual(outcome.value);
      expect(outcome.value.answer, hostId).toBeNull();
    }
    expect(bringBack).not.toHaveBeenCalled();
  });

  it("is unsupported where the Shell can't bring hosts back", async () => {
    const bare = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => [observed("studio")],
      inLocalView: () => true,
      controlEnabled: () => true,
    });
    await expect(bare.bringBack("a", { hostId: "studio" })).resolves.toMatchObject({
      ok: true,
      value: { outcome: "unsupported", answer: null },
    });
    bare.dispose();
  });
});
