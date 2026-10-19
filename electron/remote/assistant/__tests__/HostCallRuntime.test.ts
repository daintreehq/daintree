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

const CONNECTED = { status: "connected", rttMs: 12, handshake: {} as never } as const;

describe("HostCallRuntime (#13493, #13496)", () => {
  let hosts: ObservedHost[];
  let runs: Map<string, OpenRun>;
  let control: Set<string>;
  let listHostProjects: ReturnType<
    typeof vi.fn<(hostId: string) => Promise<Array<{ id: string; name: string; path: string }>>>
  >;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    hosts = [host()];
    runs = new Map([["a", RUN_A]]);
    control = new Set(["studio"]);
    listHostProjects = vi.fn(async (_hostId: string) => [
      { id: "proj-2", name: "website", path: "/repos/website" },
      { id: "proj-3", name: "api", path: "/repos/api" },
    ]);
    runtime = new HostCallRuntime({
      getSessionLane: (id) => (runs.has(id) ? { projectId: "proj-1", slot: 0 } : null),
      callerRun: (id) => runs.get(id) ?? null,
      client: () => null,
      hosts: () => hosts,
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
          rttMs: 12,
          lastSeenAt: 900,
          load: { sampledAt: 950, cpuPercent: 40, memoryPressure: null, thermal: "nominal" },
          agentsObserved: { working: 2, waiting: 1, idle: 0 },
          projects: [
            { projectId: "proj-2", name: "website" },
            { projectId: "proj-3", name: "api" },
          ],
          control: true,
        },
        {
          hostId: "off",
          name: "laptop",
          connection: "connected",
          rttMs: 12,
          lastSeenAt: null,
          load: null,
          agentsObserved: null,
          // Its switch is off, so nothing is read from it.
          projects: null,
          control: false,
        },
      ]);
      expect(listHostProjects).toHaveBeenCalledTimes(1);
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
        const connect = vi.fn(async (hostId: string) => {
          hosts = hosts.map((h) => (h.hostId === hostId ? { ...h, connection: CONNECTED } : h));
        });
        const listed = await dialing(connect).list("a");
        if (!listed.ok) throw new Error("refused");
        expect(connect.mock.calls.map(([hostId]) => hostId)).toEqual(["studio"]);
        expect(listed.value.hosts[0]).toMatchObject({
          hostId: "studio",
          connection: "connected",
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
