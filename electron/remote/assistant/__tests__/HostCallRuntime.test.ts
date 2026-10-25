import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_LIST_PROJECTS_MAX,
  HostListResultSchema,
} from "../../../../shared/types/hostControl.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";

const RUN_A: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

function host(overrides: Partial<ObservedHost> = {}): ObservedHost {
  return {
    hostId: "studio",
    name: "studio-01",
    connection: { status: "disconnected" },
    lastSeenAt: null,
    summary: null,
    ...overrides,
  };
}

const CONNECTED = {
  status: "connected",
  rttMs: 12,
  handshake: {
    version: "1.0.0",
    commit: "abc1234",
    protocolVersion: 12,
    platform: "linux",
    arch: "x64",
  },
} as const;

describe("HostCallRuntime (#13493, #13496)", () => {
  let hosts: ObservedHost[];
  let runs: Map<string, OpenRun>;
  let control: Set<string>;
  let listHostProjects: ReturnType<
    typeof vi.fn<(hostId: string) => Promise<Array<{ id: string; name: string; path: string }>>>
  >;
  let runtime: HostCallRuntime;
  let clock: number;

  beforeEach(() => {
    clock = 1000;
    hosts = [host()];
    runs = new Map([["a", RUN_A]]);
    control = new Set(["studio"]);
    listHostProjects = vi.fn(async (_hostId: string) => [
      { id: "proj-2", name: "website", path: "/repos/website", frontendAttached: false },
      { id: "proj-3", name: "api", path: "/repos/api" },
    ]);
    runtime = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => hosts,
      now: () => clock,
      inLocalView: () => true,
      controlEnabled: (hostId) => control.has(hostId),
      listHostProjects,
    });
  });

  describe("who may call", () => {
    it("refuses a session with no run of its own here, in words naming who may call", async () => {
      runs.clear();
      await expect(runtime.list("a")).resolves.toEqual({
        ok: false,
        code: "NOT_ELIGIBLE",
        message: expect.stringMatching(/Daintree Assistant running on this machine/),
      });
    });

    it("offers nothing once disposed", async () => {
      runtime.dispose();
      expect(runtime.isCallReachable("a")).toBe(false);
      await expect(runtime.list("a")).resolves.toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    });
  });

  describe("host.list", () => {
    it("lists every host as observed, naming a connected controlled host's projects", async () => {
      hosts = [
        host({
          connection: CONNECTED,
          lastSeenAt: 900,
          summary: {
            sampledAt: 950,
            cpuPercent: 40,
            platform: "darwin",
            cpuLogicalCoreCount: 14,
            memoryTotalBytes: 32e9,
            memoryUsedBytes: 20e9,
            cpuLoadAverage1m: 6.4,
            cpuPerformanceCoreCount: 10,
            cpuEfficiencyCoreCount: 4,
            cpuPerformancePercent: 65,
            cpuEfficiencyPercent: 9.5,
            memoryPressure: null,
            thermal: "nominal",
            agentsObserved: { working: 2, waiting: 1, idle: 0 },
          } as never,
        }),
        host({ hostId: "off", name: "laptop", connection: CONNECTED }),
      ];
      const listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(HostListResultSchema.parse(listed.value)).toEqual(listed.value);
      expect(listed.value.hosts).toEqual([
        {
          hostId: "studio",
          name: "studio-01",
          connection: "connected",
          link: {
            status: "connected",
            attempt: null,
            restarting: false,
            hostModeOff: false,
            stoppedRetrying: null,
            disconnectedByPerson: false,
            quietSince: null,
            mismatch: null,
          },
          build: {
            source: "connected",
            handshake: {
              version: "1.0.0",
              commit: "abc1234",
              protocolVersion: 12,
              platform: "linux",
              arch: "x64",
            },
          },
          // The summary in this fixture names no CLIs: unknown, never "none installed".
          agentClis: { coverage: "unknown", sampledAt: 950, installed: [], omitted: 0 },
          rttMs: 12,
          lastSeenAt: 900,
          load: {
            sampledAt: 950,
            ageMs: 50,
            stale: false,
            platform: "darwin",
            cpuPercent: 40,
            cpuLogicalCores: 14,
            cpuBusyCores: 5.6,
            cpuIdleCores: 8.4,
            memoryTotalBytes: 32e9,
            memoryUsedBytes: 20e9,
            memoryAvailableBytes: 12e9,
            memoryCapacityReported: true,
            memoryPressure: null,
            thermal: "nominal",
          },
          agentsObserved: { working: 2, waiting: 1, idle: 0 },
          // As the host said it; an older host that didn't is unknown, not unattached.
          projects: [
            { projectId: "proj-2", name: "website", frontendAttached: false },
            { projectId: "proj-3", name: "api", frontendAttached: null },
          ],
          projectInventory: {
            complete: true,
            total: 2,
            offset: 0,
            omitted: 0,
            nextCursor: null,
            listChanged: false,
          },
          control: true,
        },
        {
          hostId: "off",
          name: "laptop",
          connection: "connected",
          link: {
            status: "connected",
            attempt: null,
            restarting: false,
            hostModeOff: false,
            stoppedRetrying: null,
            disconnectedByPerson: false,
            quietSince: null,
            mismatch: null,
          },
          build: {
            source: "connected",
            handshake: {
              version: "1.0.0",
              commit: "abc1234",
              protocolVersion: 12,
              platform: "linux",
              arch: "x64",
            },
          },
          agentClis: { coverage: "unknown", sampledAt: null, installed: [], omitted: 0 },
          rttMs: 12,
          lastSeenAt: null,
          load: null,
          agentsObserved: null,
          // Its switch is off, so nothing is read from it.
          projects: null,
          projectInventory: null,
          control: false,
        },
      ]);
      expect(listHostProjects).toHaveBeenCalledTimes(1);
    });

    describe("load", () => {
      const fresh = {
        sampledAt: 990,
        platform: "linux",
        cpuPercent: 50,
        cpuLogicalCoreCount: 8,
        memoryPressure: "warn",
        memoryUsedBytes: 4e9,
        memoryTotalBytes: 16e9,
        thermal: "fair",
      };

      async function loadOf(summary: object) {
        hosts = [host({ connection: CONNECTED, summary: summary as never })];
        const listed = await runtime.list("a");
        if (!listed.ok) throw new Error("refused");
        expect(HostListResultSchema.parse(listed.value)).toEqual(listed.value);
        return listed.value.hosts[0]?.load;
      }

      it("nulls the live figures of a stale sample but keeps what hardware fixes", async () => {
        const load = await loadOf({ ...fresh, sampledAt: 1000 - 16_000 });
        expect(load).toMatchObject({
          stale: true,
          ageMs: 16_000,
          cpuLogicalCores: 8,
          memoryTotalBytes: 16e9,
          cpuPercent: null,
          cpuBusyCores: null,
          cpuIdleCores: null,
          memoryUsedBytes: null,
          memoryAvailableBytes: null,
          memoryPressure: null,
          thermal: null,
        });
      });

      it("treats a timestamp from the future as unusable, not fresh", async () => {
        expect(await loadOf({ ...fresh, sampledAt: 1000 + 60_000 })).toMatchObject({
          stale: true,
          cpuPercent: null,
        });
      });

      it("gives no used or available memory for an older host, and no cores it never reported", async () => {
        const { cpuLogicalCoreCount: _omitted, ...older } = fresh;
        expect(await loadOf(older)).toMatchObject({
          stale: false,
          memoryCapacityReported: false,
          memoryUsedBytes: null,
          memoryAvailableBytes: null,
          memoryTotalBytes: 16e9,
          cpuLogicalCores: null,
          cpuBusyCores: null,
          cpuPercent: 50,
        });
      });

      it("keeps a measured zero apart from an unmeasured reading", async () => {
        expect(await loadOf({ ...fresh, cpuPercent: 0 })).toMatchObject({
          cpuBusyCores: 0,
          cpuIdleCores: 8,
        });
        expect(await loadOf({ ...fresh, cpuPercent: null, memoryUsedBytes: null })).toMatchObject({
          cpuBusyCores: null,
          cpuIdleCores: null,
          memoryUsedBytes: null,
          memoryAvailableBytes: null,
          memoryTotalBytes: 16e9,
        });
      });

      it("ages a sample by the time the whole answer took, not the time it was read", async () => {
        hosts = [
          host({ connection: CONNECTED, summary: { ...fresh, sampledAt: 1000 - 14_000 } as never }),
        ];
        listHostProjects.mockImplementation(async () => {
          clock += 5000;
          return [];
        });
        const listed = await runtime.list("a");
        if (!listed.ok) throw new Error("refused");
        expect(listed.value.hosts[0]?.load).toMatchObject({
          stale: true,
          ageMs: 19_000,
          cpuPercent: null,
        });
      });

      it("ages a sample's CLIs by the same clock as its load (#14461)", async () => {
        const agentClis = [{ agentId: "claude", version: "2.1.0" }];
        hosts = [
          host({
            connection: CONNECTED,
            summary: { ...fresh, sampledAt: 1000 - 14_000, agentClis } as never,
          }),
        ];
        listHostProjects.mockImplementation(async () => {
          clock += 5000;
          return [];
        });
        const listed = await runtime.list("a");
        if (!listed.ok) throw new Error("refused");
        expect(listed.value.hosts[0]?.agentClis).toEqual({
          coverage: "stale",
          sampledAt: 1000 - 14_000,
          installed: agentClis,
          omitted: 0,
        });
      });

      it("keeps a small positive load from rounding to idle-looking zero", async () => {
        expect(await loadOf({ ...fresh, cpuPercent: 0.4 })).toMatchObject({ cpuBusyCores: 0.03 });
      });

      it("lists a Linux host's raw readings and the scope they describe, with no invented bands", async () => {
        const linux = {
          ...fresh,
          memoryPressure: null,
          thermal: null,
          metricsScope: "cgroup",
          memoryPressureSomeAvg10: 2.5,
          temperatureCelsius: 55,
          temperatureZone: "x86_pkg_temp (thermal_zone0)",
        };
        expect(await loadOf(linux)).toMatchObject({
          memoryPressure: null,
          thermal: null,
          metricsScope: "cgroup",
          memoryPressureSomeAvg10: 2.5,
          temperatureCelsius: 55,
          temperatureZone: "x86_pkg_temp (thermal_zone0)",
        });
        expect(await loadOf({ ...linux, sampledAt: 1000 - 16_000 })).toMatchObject({
          stale: true,
          metricsScope: "cgroup",
          memoryPressureSomeAvg10: null,
          temperatureCelsius: null,
          temperatureZone: null,
        });
      });

      it("counts busy and idle cores against a cgroup's fractional quota", async () => {
        expect(await loadOf({ ...fresh, cpuPercent: 50, cpuCapacityCores: 1.5 })).toMatchObject({
          cpuLogicalCores: 8,
          cpuBusyCores: 0.75,
          cpuIdleCores: 0.75,
        });
      });

      it("omits the Linux readings a host never reported", async () => {
        const load = await loadOf(fresh);
        expect(load).not.toHaveProperty("metricsScope");
        expect(load).not.toHaveProperty("memoryPressureSomeAvg10");
        expect(load).not.toHaveProperty("temperatureCelsius");
      });
    });

    it("drops a disconnected host's agent tally and reads none of its projects", async () => {
      hosts = [host({ summary: { sampledAt: 1, agentsObserved: { working: 3 } } as never })];
      const listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts[0]).toMatchObject({
        connection: "disconnected",
        agentsObserved: null,
        projects: null,
      });
      expect(listHostProjects).not.toHaveBeenCalled();
    });

    describe("observed link, build and CLIs (#14461)", () => {
      const HANDSHAKE = CONNECTED.handshake;
      const CLIS = [
        { agentId: "claude", version: "2.1.0" },
        { agentId: "gemini", version: null },
      ];
      const LIVE_SUMMARY = {
        sampledAt: 990,
        platform: "linux",
        memoryPressure: null,
        thermal: null,
        agentClis: CLIS,
      } as never;

      it("tells apart the ways a host is down, carrying no transport text", async () => {
        hosts = [
          host({ hostId: "manual", disconnectedByPerson: true }),
          host({
            hostId: "mode-off",
            connection: {
              status: "unreachable",
              lastSeenAt: 500,
              detail: "no discovery file at /home/greg/.daintree/host.json",
              hostModeOff: true,
              stoppedRetrying: true,
            },
          }),
          host({
            hostId: "denied",
            connection: {
              status: "unreachable",
              lastSeenAt: null,
              detail: "Permission denied (publickey)",
              stoppedRetrying: true,
            },
          }),
          host({
            hostId: "old",
            connection: {
              status: "version-mismatch",
              mismatch: { kind: "protocol", local: 12, remote: 11 },
              remote: { ...HANDSHAKE, protocolVersion: 11 },
            },
          }),
        ];
        control = new Set();
        const listed = await runtime.list("a");
        if (!listed.ok) throw new Error("refused");
        expect(HostListResultSchema.parse(listed.value)).toEqual(listed.value);
        // The old projection, still there for older readers, says the same of all four.
        expect(new Set(listed.value.hosts.map((h) => h.connection))).toEqual(
          new Set(["disconnected"])
        );
        const links = listed.value.hosts.map((h) => h.link);
        expect(new Set(links.map((link) => JSON.stringify(link))).size).toBe(4);
        expect(links[0]).toMatchObject({ status: "disconnected", disconnectedByPerson: true });
        expect(links[1]).toMatchObject({ status: "unreachable", hostModeOff: true });
        expect(links[2]).toMatchObject({
          status: "unreachable",
          hostModeOff: false,
          stoppedRetrying: true,
        });
        expect(links[3]).toMatchObject({
          status: "version-mismatch",
          mismatch: { kind: "protocol", local: "12", remote: "11" },
        });
        expect(listed.value.hosts[3]?.build).toEqual({
          source: "rejected",
          handshake: { ...HANDSHAKE, protocolVersion: 11 },
        });
        const text = JSON.stringify(listed.value);
        expect(text).not.toContain("publickey");
        expect(text).not.toContain("discovery file");
      });

      it("keeps a connected host with another build connected, naming the difference", async () => {
        hosts = [
          host({
            connection: {
              ...CONNECTED,
              buildMismatch: { kind: "version", local: "1.0.1", remote: "1.0.0" },
            },
          }),
        ];
        const listed = await runtime.list("a");
        if (!listed.ok) throw new Error("refused");
        expect(listed.value.hosts[0]).toMatchObject({
          connection: "connected",
          link: {
            status: "connected",
            mismatch: { kind: "version", local: "1.0.1", remote: "1.0.0" },
          },
          build: { source: "connected", handshake: HANDSHAKE },
        });
      });

      it("lists a connected host's CLIs even when it has no projects registered", async () => {
        listHostProjects.mockResolvedValueOnce([]);
        hosts = [
          host({
            connection: CONNECTED,
            summary: LIVE_SUMMARY,
          }),
        ];
        const listed = await runtime.list("a");
        if (!listed.ok) throw new Error("refused");
        expect(HostListResultSchema.parse(listed.value)).toEqual(listed.value);
        expect(listed.value.hosts[0]).toMatchObject({
          projects: [],
          agentClis: { coverage: "observed", sampledAt: 990, installed: CLIS, omitted: 0 },
        });
      });

      it("keeps a disconnected host's CLIs as stale and its build as last seen", async () => {
        hosts = [
          host({
            lastHandshake: HANDSHAKE,
            summary: { sampledAt: 999, platform: "linux", agentClis: CLIS } as never,
          }),
          host({ hostId: "never", name: "new-box" }),
        ];
        control = new Set();
        const listed = await runtime.list("a");
        if (!listed.ok) throw new Error("refused");
        expect(listed.value.hosts[0]).toMatchObject({
          build: { source: "last-seen", handshake: HANDSHAKE },
          agentClis: { coverage: "stale", installed: CLIS },
        });
        // No summary ever: unknown, never an empty inventory.
        expect(listed.value.hosts[1]).toMatchObject({
          build: { source: "unknown", handshake: null },
          agentClis: { coverage: "unknown", sampledAt: null, installed: [] },
        });
      });

      it("keeps a host's switch off: its CLIs are listed, nothing is read from it", async () => {
        control = new Set();
        hosts = [
          host({
            connection: CONNECTED,
            summary: LIVE_SUMMARY,
          }),
        ];
        const listed = await runtime.list("a");
        if (!listed.ok) throw new Error("refused");
        expect(listed.value.hosts[0]).toMatchObject({
          control: false,
          projects: null,
          agentClis: { coverage: "observed" },
        });
        expect(listHostProjects).not.toHaveBeenCalled();
      });
    });

    describe("a host this Shell holds no link to", () => {
      function dialing(connect: (hostId: string) => Promise<unknown>): HostCallRuntime {
        return new HostCallRuntime({
          getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
          callerRun: (id) => runs.get(id) ?? null,
          client: () => null,
          hosts: () => hosts,
          inLocalView: () => true,
          controlEnabled: (hostId) => control.has(hostId),
          listHostProjects,
          connect,
        });
      }

      it("dials one with control on, and lists it as it is once connected", async () => {
        hosts = [host({ hostId: "studio" }), host({ hostId: "off", name: "laptop" })];
        const agentClis = [{ agentId: "codex", version: "0.9.1" }];
        const connect = vi.fn(async (hostId: string) => {
          hosts = hosts.map((h) =>
            h.hostId === hostId
              ? {
                  ...h,
                  connection: CONNECTED,
                  summary: {
                    // This runtime reads the real clock.
                    sampledAt: Date.now(),
                    platform: "linux",
                    memoryPressure: null,
                    thermal: null,
                    agentClis,
                  } as never,
                }
              : h
          );
        });
        const listed = await dialing(connect).list("a");
        if (!listed.ok) throw new Error("refused");
        expect(connect.mock.calls.map(([hostId]) => hostId)).toEqual(["studio"]);
        expect(listed.value.hosts[0]).toMatchObject({
          hostId: "studio",
          connection: "connected",
          link: { status: "connected" },
          build: { source: "connected", handshake: CONNECTED.handshake },
          agentClis: { coverage: "observed", installed: agentClis },
          projects: [
            { projectId: "proj-2", name: "website" },
            { projectId: "proj-3", name: "api" },
          ],
        });
        expect(listed.value.hosts[1]).toMatchObject({ connection: "disconnected", projects: null });
      });

      it("never redials a host whose link reported why it is down", async () => {
        hosts = [
          host({
            connection: { status: "unreachable", lastSeenAt: null, detail: "ssh: no route" },
          }),
        ];
        const connect = vi.fn(async () => undefined);
        const listed = await dialing(connect).list("a");
        if (!listed.ok) throw new Error("refused");
        expect(connect).not.toHaveBeenCalled();
        expect(listed.value.hosts[0]?.connection).toBe("disconnected");
      });

      it("waits for a dial up to its bound, then lists the host as disconnected", async () => {
        vi.useFakeTimers();
        try {
          const connect = vi.fn((_hostId: string) => new Promise<never>(() => {}));
          let settled = false;
          const pending = dialing(connect)
            .list("a")
            .finally(() => (settled = true));
          await vi.advanceTimersByTimeAsync(7_000);
          expect(connect).toHaveBeenCalledTimes(1);
          expect(settled).toBe(false);

          await vi.advanceTimersByTimeAsync(2_000);
          const listed = await pending;
          if (!listed.ok) throw new Error("refused");
          expect(listed.value.hosts[0]).toMatchObject({
            connection: "disconnected",
            projects: null,
          });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it("keeps the other hosts when one dial throws or rejects", async () => {
        hosts = [
          host({ hostId: "studio" }),
          host({ hostId: "laptop", name: "laptop" }),
          host({ hostId: "mini", name: "mini" }),
        ];
        control = new Set(["studio", "laptop", "mini"]);
        const connect = vi.fn(async (hostId: string) => {
          if (hostId === "laptop") throw new Error("no such transport");
          if (hostId === "mini") return Promise.reject(new Error("ssh refused"));
          hosts = hosts.map((h) => (h.hostId === hostId ? { ...h, connection: CONNECTED } : h));
        });
        const throwing = dialing((hostId) => {
          if (hostId === "laptop") throw new Error("thrown before a promise");
          return connect(hostId);
        });

        const listed = await throwing.list("a");

        if (!listed.ok) throw new Error(`refused: ${listed.code}`);
        expect(listed.value.hosts.map((h) => [h.hostId, h.connection])).toEqual([
          ["studio", "connected"],
          ["laptop", "disconnected"],
          ["mini", "disconnected"],
        ]);
      });
    });

    it("names no projects when the host can't say, and caps how many it names", async () => {
      hosts = [host({ connection: CONNECTED })];
      listHostProjects.mockRejectedValueOnce(new Error("link dropped"));
      let listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts[0]?.projects).toBeNull();

      listHostProjects.mockResolvedValueOnce(
        Array.from({ length: HOST_LIST_PROJECTS_MAX + 5 }, (_, index) => ({
          id: `p-${index}`,
          name: `Project ${index}`,
          path: `/repos/${index}`,
        }))
      );
      listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts[0]?.projects).toHaveLength(HOST_LIST_PROJECTS_MAX);
    });
  });
});
