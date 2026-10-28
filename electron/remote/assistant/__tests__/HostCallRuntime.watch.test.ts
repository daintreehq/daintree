import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneWake } from "../../../services/mcp-server/terminalNotify.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import type { HostWatchListener } from "../HostWatches.js";

const RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

describe("HostCallRuntime host.watch (#14463)", () => {
  let runs: Map<string, OpenRun>;
  let hosts: ObservedHost[];
  let listener: HostWatchListener | null;
  let queued: LaneWake[];
  let connect: ReturnType<typeof vi.fn<(hostId: string, timeoutMs: number) => Promise<unknown>>>;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    vi.useFakeTimers();
    runs = new Map([["a", { ...RUN }]]);
    hosts = [
      {
        hostId: "studio",
        name: "studio-01",
        connection: { status: "disconnected" },
        lastSeenAt: null,
        summary: null,
      },
    ];
    listener = null;
    queued = [];
    connect = vi.fn(async () => undefined);
    runtime = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => hosts,
      inLocalView: () => true,
      controlEnabled: () => true,
      connect,
      queueNotice: (_lane, wake) => queued.push(wake),
      watchHosts: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      newId: () => "1",
    });
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
  });

  const arm = (helpSessionId = "a") =>
    runtime.watch(helpSessionId, { operation: "arm", hostId: "studio", connection: "connected" });

  it("arms for the calling run only, and refuses a session with no run here", async () => {
    await expect(arm("stranger")).resolves.toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(listener).toBeNull();
    const armed = await arm();
    expect(armed).toMatchObject({ ok: true, value: { outcome: "ok", armed: true } });
    expect(listener).not.toBeNull();
  });

  it("never dials the host it watches", async () => {
    await expect(arm()).resolves.toMatchObject({ ok: true, value: { armed: true } });
    vi.advanceTimersByTime(60 * 60_000);
    expect(connect).not.toHaveBeenCalled();
  });

  it("lets go of what it heard when the session ends, is relaunched, or the runtime goes", async () => {
    await arm();
    runtime.endHelpSession("a");
    expect(listener).toBeNull();

    await arm();
    expect(listener).not.toBeNull();
    runtime.retireWatches("a");
    expect(listener).toBeNull();

    await arm();
    expect(listener).not.toBeNull();
    runtime.dispose();
    expect(listener).toBeNull();
    expect(queued).toEqual([]);
  });
});
