import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostProjectSummary } from "../../../../shared/types/ipc/remoteHosts.js";
import { MAX_LISTED_PROJECTS } from "../../host/linkMethods.js";
import { HostCallRuntime, type ObservedHost } from "../HostCallRuntime.js";

function observed(hostId: string, status: "connected" | "disconnected"): ObservedHost {
  return {
    hostId,
    name: `${hostId}-box`,
    connection:
      status === "connected"
        ? {
            status: "connected",
            rttMs: 12,
            handshake: {
              version: "1.0.0",
              commit: "abc1234",
              protocolVersion: 12,
              platform: "linux",
              arch: "x64",
            },
          }
        : { status: "disconnected" },
    lastSeenAt: 900,
    summary: null,
  };
}

function summaries(count: number, prefix: string): HostProjectSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: `Project ${index}`,
    path: `/repos/${index}`,
    frontendAttached: index === 0,
  }));
}

describe("HostCallRuntime.inventory (#14547)", () => {
  let hosts: ObservedHost[];
  let control: Set<string>;
  let remote: Map<string, HostProjectSummary[] | Error | "hang">;
  let connect: ReturnType<typeof vi.fn>;
  let localProjects: HostProjectSummary[] | "hang";
  let runtime: HostCallRuntime;

  beforeEach(() => {
    hosts = [];
    control = new Set();
    remote = new Map();
    localProjects = summaries(2, "local");
    connect = vi.fn(async () => undefined);
    runtime = new HostCallRuntime({
      // No caller at all: the snapshot is taken before any session exists.
      getSessionLane: () => null,
      callerRun: () => null,
      client: () => null,
      hosts: () => hosts,
      controlEnabled: (hostId) => control.has(hostId),
      connect,
      listHostProjects: async (hostId) => {
        const answer = remote.get(hostId) ?? [];
        if (answer === "hang") return new Promise(() => {});
        if (answer instanceof Error) throw answer;
        return answer;
      },
      local: {
        name: () => "greg-mbp",
        projects: async () => (localProjects === "hang" ? new Promise(() => {}) : localProjects),
        relayCall: vi.fn(),
      },
      now: () => 4242,
    });
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
  });

  it("names this machine first, then every host, with the projects of the ones it can see", async () => {
    hosts = [
      observed("h1", "connected"),
      observed("h2", "disconnected"),
      observed("h3", "connected"),
    ];
    control = new Set(["h1", "h2"]);
    remote.set("h1", summaries(3, "h1"));
    remote.set("h3", summaries(3, "h3"));

    const snapshot = await runtime.inventory();

    expect(snapshot.takenAt).toBe(4242);
    expect(snapshot.hosts.map((host) => host.hostId)).toEqual(["local", "h1", "h2", "h3"]);
    const [local, h1, h2, h3] = snapshot.hosts;
    expect(local).toMatchObject({ local: true, control: true, projectTotal: 2 });
    expect(local?.projects?.[0]).toEqual({
      projectId: "local-0",
      name: "Project 0",
      frontendAttached: true,
    });
    expect(h1).toMatchObject({ connection: "connected", control: true, projectTotal: 3 });
    expect(h1?.projects).toHaveLength(3);
    // Disconnected: named, never dialed, and no projects claimed.
    expect(h2).toMatchObject({ connection: "disconnected", control: true, projects: null });
    // Control off: its projects aren't read.
    expect(h3).toMatchObject({ control: false, projects: null });
    expect(connect).not.toHaveBeenCalled();
  });

  it("leaves a host's total unknown when it sent as many as a host ever sends", async () => {
    hosts = [observed("h1", "connected")];
    control = new Set(["h1"]);
    remote.set("h1", summaries(MAX_LISTED_PROJECTS, "h1"));
    const [, h1] = (await runtime.inventory()).hosts;
    expect(h1?.projects).toHaveLength(MAX_LISTED_PROJECTS);
    expect(h1?.projectTotal).toBeNull();
  });

  it("names a host whose projects failed or didn't come in time, with its projects unknown", async () => {
    vi.useFakeTimers();
    hosts = [observed("h1", "connected"), observed("h2", "connected")];
    control = new Set(["h1", "h2"]);
    remote.set("h1", new Error("link dropped"));
    remote.set("h2", "hang");
    localProjects = "hang";

    const pending = runtime.inventory();
    await vi.advanceTimersByTimeAsync(2_000);
    const snapshot = await pending;

    expect(snapshot.hosts.map((host) => [host.hostId, host.projects])).toEqual([
      ["local", null],
      ["h1", null],
      ["h2", null],
    ]);
  });

  it("claims no projects for a host that went while its list was read", async () => {
    hosts = [observed("h1", "connected")];
    control = new Set(["h1"]);
    remote.set("h1", summaries(2, "h1"));
    const original = hosts;
    let reads = 0;
    runtime.dispose();
    runtime = new HostCallRuntime({
      getSessionLane: () => null,
      callerRun: () => null,
      client: () => null,
      hosts: () => (reads++ === 0 ? original : [observed("h1", "disconnected")]),
      controlEnabled: () => true,
      listHostProjects: async () => summaries(2, "h1"),
    });
    const [h1] = (await runtime.inventory()).hosts;
    expect(h1).toMatchObject({ connection: "disconnected", projects: null, projectTotal: null });
  });
});
