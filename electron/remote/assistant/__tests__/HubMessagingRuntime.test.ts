import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import type { ExchangeRecord } from "../../exchange/types.js";
import {
  AssistantMessagingPolicy,
  type HostCheck,
  type HostCheckResult,
  type LaneRef,
  type MessagingDenial,
  type OpenRun,
} from "../AssistantMessagingPolicy.js";
import { RetryWindowPassedError } from "../AssistantExchangeClient.js";
import type { AssistantShellRoutes } from "../AssistantShellRoutes.js";
import { LANE_NOT_RUNNING_MESSAGE } from "../hostExchanges.js";
import {
  HOST_LIST_PROJECTS_MAX,
  HostListAssistantsResultSchema,
  HostListResultSchema,
  HostReadQuotaResultSchema,
  HostStartAssistantResultSchema,
} from "../../../../shared/types/hostMessaging.js";
import {
  HUB_SENDS_PER_HOST_PER_MINUTE,
  HUB_SENDS_PER_MINUTE,
  HubMessagingRuntime,
  projectTree,
  type ObservedHost,
} from "../HubMessagingRuntime.js";

function run(projectId: string, slot: number, sessionId: string): OpenRun {
  return { projectId, slot, sessionId, terminalId: `t-${sessionId}`, launchGeneration: 1 };
}

/** One assistant here, a sibling slot in its project, and one in another project. */
const RUN_A = run("proj-1", 0, "a");
const RUN_SIBLING = run("proj-1", 1, "sibling");
const RUN_OTHER_PROJECT = run("proj-3", 0, "other-project");

function record(overrides: Partial<ExchangeRecord> = {}): ExchangeRecord {
  return {
    taskId: "host-task-1",
    senderId: "sender",
    messageId: "task-1",
    contextId: "ctx-1",
    referenceTaskIds: [],
    receiver: { hostId: "local", laneId: "proj-2:0", enrollmentGeneration: "gen-2" },
    state: "submitted",
    outcome: null,
    bodyDigest: "d",
    bodyBytes: 5,
    replyDigest: null,
    replyBytes: null,
    delivery: {
      attemptedAt: null,
      acceptedAt: 10,
      wakeTypedAt: null,
      inboxFetchedAt: null,
      replyReceivedAt: null,
      ambiguousAt: null,
    },
    cancelRequestedAt: null,
    createdAt: 10,
    updatedAt: 10,
    expiresAt: 10_000_000,
    terminalAt: null,
    tombstonedAt: null,
    revision: 1,
    ...overrides,
  };
}

function host(overrides: Partial<ObservedHost> = {}): ObservedHost {
  return {
    hostId: "studio",
    name: "studio-01",
    assistantMessagingEnabled: true,
    connection: { status: "disconnected" },
    lastSeenAt: null,
    summary: null,
    ...overrides,
  };
}

const SEND = {
  hostId: "studio",
  projectId: "proj-2",
  slot: 0,
  generation: "gen-2",
  text: "hello",
};

describe("HubMessagingRuntime (#13336)", () => {
  let clock: number;
  let hosts: ObservedHost[];
  let runs: Map<string, OpenRun>;
  let lanes: Map<string, LaneRef>;
  let routes: { remember: ReturnType<typeof vi.fn<AssistantShellRoutes["remember"]>> };
  let denial: MessagingDenial | null;
  let checks: HostCheck[];
  let client: {
    listLanes: ReturnType<typeof vi.fn>;
    readQuota: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    getResponses: ReturnType<typeof vi.fn>;
    listChanges: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    known: ReturnType<typeof vi.fn>;
  };
  let runtime: HubMessagingRuntime;
  let hostProjects: ReturnType<typeof vi.fn>;
  let startEnabled: boolean;
  let starter: { start: ReturnType<typeof vi.fn> } | null;
  let ids: number;
  let sleep: (ms: number) => Promise<void>;

  beforeEach(() => {
    clock = 1_000_000;
    ids = 0;
    sleep = async (ms) => {
      clock += ms;
    };
    hosts = [host()];
    runs = new Map([
      ["a", RUN_A],
      ["sibling", RUN_SIBLING],
      ["other-project", RUN_OTHER_PROJECT],
    ]);
    // "remote-view" is a live session whose run a remote Shell's view holds: no caller run here.
    lanes = new Map([
      ["a", { projectId: "proj-1", slot: 0 }],
      ["sibling", { projectId: "proj-1", slot: 1 }],
      ["other-project", { projectId: "proj-3", slot: 0 }],
      ["remote-view", { projectId: "proj-4", slot: 0 }],
    ]);
    routes = { remember: vi.fn<AssistantShellRoutes["remember"]>() };
    denial = null;
    checks = [];
    client = {
      listLanes: vi.fn(async () => ({
        lanes: [{ projectId: "proj-2", slot: 0, generation: "gen-2", available: true }],
        assistants: [{ projectId: "proj-2", slot: 0, agentId: "codex" }],
      })),
      readQuota: vi.fn(async () => ({
        status: "ok",
        planType: "pro",
        windows: [
          { usedPercent: 42, windowDurationMins: 300, resetsAt: 990_000 },
          { usedPercent: 7.5, windowDurationMins: 10_080, resetsAt: null },
        ],
        fetchedAt: 980_000,
      })),
      send: vi.fn(async (_hostId: string, payload: { messageId: string; contextId: string }) => ({
        status: "accepted",
        disposition: "created",
        record: record({ messageId: payload.messageId, contextId: payload.contextId }),
      })),
      get: vi.fn(async () => record()),
      getResponses: vi.fn(async () => []),
      listChanges: vi.fn(async () => ({ records: [], cursor: 0, hasMore: false, reset: false })),
      cancel: vi.fn(async () => record({ cancelRequestedAt: 20 })),
      known: vi.fn(() => null),
    };
    hostProjects = vi.fn(async () => [
      { id: "proj-9", name: "notes", path: "/repos/notes" },
      { id: "proj-2", name: "website", path: "/repos/website" },
    ]);
    startEnabled = true;
    starter = {
      start: vi.fn(async () => ({
        status: "ready",
        projectId: "proj-2",
        slot: 1,
        agentId: "claude",
        generation: "gen-new",
        available: true,
        started: true,
      })),
    };
    runtime = new HubMessagingRuntime({
      listHostProjects: hostProjects as never,
      startEnabled: () => startEnabled,
      starter: () => starter as never,
      policy: {
        isSupported: () => true,
        checkHost: (check: HostCheck): HostCheckResult => {
          checks.push(check);
          if (denial === "paused" && (check.kind === "reply" || check.kind === "inspect")) {
            return { ok: true };
          }
          if (denial === "not-accepting" && check.kind !== "admit") return { ok: true };
          return denial ? { ok: false, reason: denial } : { ok: true };
        },
      },
      getSessionLane: (id) => lanes.get(id) ?? null,
      callerRun: (id) => runs.get(id) ?? null,
      routes,
      client: () => client as never,
      hosts: () => hosts,
      now: () => clock,
      newId: () => `id-${++ids}`,
      sleep: (ms) => sleep(ms),
      pollIntervalMs: 1_000,
    });
  });

  describe("who may call", () => {
    const tools = (session: string) => [
      runtime.list(session),
      runtime.listAssistants(session, { hostId: "studio" }),
      runtime.readQuota(session, { hostId: "studio" }),
      runtime.startAssistant(session, { hostId: "studio", projectId: "proj-2" }),
      runtime.sendMessage(session, SEND),
      runtime.getTask(session, { hostId: "studio", taskId: "task-1" }),
      runtime.listTasks(session, { hostId: "studio" }),
      runtime.cancelTask(session, { hostId: "studio", taskId: "task-1" }),
    ];

    it.each(["a", "sibling", "other-project"])(
      "is any assistant running on this machine: every tool answers for %s",
      async (session) => {
        expect(runtime.isAvailable(session)).toBe(true);
        const [listed, ...rest] = await Promise.all(tools(session));
        expect(listed).toMatchObject({ ok: true, value: { hosts: [{ hostId: "studio" }] } });
        for (const result of rest) {
          expect(result).toMatchObject({ ok: true, value: { outcome: "ok" } });
        }
      }
    );

    it("refuses a session with no run of its own here, in words naming who may call", async () => {
      for (const session of ["remote-view", "stranger"]) {
        expect(runtime.isAvailable(session)).toBe(false);
        for (const result of await Promise.all(tools(session))) {
          expect(result).toEqual({
            ok: false,
            code: "NOT_ELIGIBLE",
            message:
              "Only a Daintree Assistant running on this machine can reach assistants on other hosts.",
          });
        }
      }
      expect(client.send).not.toHaveBeenCalled();
      expect(starter?.start).not.toHaveBeenCalled();
    });

    it("lists no lane as taking messages while this Shell has messaging paused", async () => {
      denial = "paused";
      await expect(runtime.listAssistants("a", { hostId: "studio" })).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: "ok",
          projects: [{ assistants: [{ slot: 0, available: false }] }, { assistants: [] }],
        },
      });
      denial = null;
      await expect(runtime.listAssistants("a", { hostId: "studio" })).resolves.toMatchObject({
        value: { projects: [{ assistants: [{ slot: 0, available: true }] }, { assistants: [] }] },
      });
    });

    it("is hidden until a host exists", () => {
      hosts = [];
      expect(runtime.isAvailable("a")).toBe(false);
      expect(runtime.isReachable("a")).toBe(false);
      expect(runtime.isReachable("remote-view")).toBe(false);
    });

    it("is reachable from any live session's lane while a host exists, before its run is confirmed", async () => {
      expect(runtime.isReachable("remote-view")).toBe(true);
      expect(runtime.isReachable("sibling")).toBe(true);
      expect(runtime.isReachable("stranger")).toBe(false);
      await expect(runtime.list("remote-view")).resolves.toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });
    });

    it("tells a caller this machine's setting is off as opted_out, never NOT_ELIGIBLE", async () => {
      denial = "not-accepting";
      const sent = await runtime.sendMessage("a", SEND);
      expect(sent).toMatchObject({ ok: true, value: { outcome: "opted_out", taskId: null } });
      if (!sent.ok) throw new Error("refused outright");
      expect(sent.value.detail).toContain("Accept messages from other machines");
      await expect(
        runtime.startAssistant("a", { hostId: "studio", projectId: "proj-2" })
      ).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: "opted_out",
          detail: expect.stringContaining("Accept messages from other machines"),
        },
      });
      expect(client.send).not.toHaveBeenCalled();
      expect(starter?.start).not.toHaveBeenCalled();
    });

    it("with the real policy and the setting off, reads and cancels reach the client but new messages don't", async () => {
      const policy = new AssistantMessagingPolicy({
        getRunningLaneSession: () => null,
        getLiveGeneration: () => null,
        isHostMessagingEnabled: () => true,
        acceptsRemoteMessages: () => false,
        onSessionEnded: () => () => {},
        platform: "darwin",
      });
      const real = new HubMessagingRuntime({
        policy,
        listHostProjects: hostProjects as never,
        startEnabled: () => startEnabled,
        starter: () => starter as never,
        getSessionLane: (id) => lanes.get(id) ?? null,
        callerRun: (id) => runs.get(id) ?? null,
        routes,
        client: () => client as never,
        hosts: () => hosts,
        now: () => clock,
        newId: () => `id-${++ids}`,
        sleep: (ms) => sleep(ms),
      });
      expect(real.isAvailable("a")).toBe(true);
      await expect(real.list("a")).resolves.toMatchObject({
        ok: true,
        value: { hosts: [{ hostId: "studio" }] },
      });
      for (const result of await Promise.all([
        real.listAssistants("a", { hostId: "studio" }),
        real.readQuota("a", { hostId: "studio" }),
        real.getTask("a", { hostId: "studio", taskId: "task-1" }),
        real.listTasks("a", { hostId: "studio" }),
        real.cancelTask("a", { hostId: "studio", taskId: "task-1" }),
      ])) {
        expect(result).toMatchObject({ ok: true, value: { outcome: "ok" } });
      }
      expect(client.listLanes).toHaveBeenCalledWith("studio");
      expect(client.readQuota).toHaveBeenCalledWith("studio");
      expect(client.get).toHaveBeenCalledWith("studio", "task-1");
      expect(client.listChanges).toHaveBeenCalled();
      expect(client.cancel).toHaveBeenCalledWith("studio", "task-1");

      for (const result of await Promise.all([
        real.sendMessage("a", SEND),
        real.startAssistant("a", { hostId: "studio", projectId: "proj-2" }),
      ])) {
        expect(result).toMatchObject({
          ok: true,
          value: {
            outcome: "opted_out",
            detail: expect.stringContaining("Accept messages from other machines"),
          },
        });
      }
      expect(client.send).not.toHaveBeenCalled();
      expect(starter?.start).not.toHaveBeenCalled();
      expect(routes.remember).not.toHaveBeenCalled();
      real.dispose();
      policy.dispose();
    });

    it("offers nothing once disposed", async () => {
      runtime.dispose();
      expect(runtime.isAvailable("a")).toBe(false);
      expect(runtime.isReachable("a")).toBe(false);
      await expect(runtime.list("a")).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });
    });
  });

  describe("tasks belong to the Shell", () => {
    it("lets one assistant look up, list and cancel a task another sent", async () => {
      const sent = await runtime.sendMessage("a", { ...SEND, taskId: "shared-task" });
      expect(sent).toMatchObject({ ok: true, value: { outcome: "ok", taskId: "shared-task" } });
      client.get.mockResolvedValueOnce(record({ messageId: "shared-task" }));
      client.listChanges.mockResolvedValueOnce({
        records: [record({ messageId: "shared-task" })],
        cursor: 1,
        hasMore: false,
        reset: false,
      });
      client.cancel.mockResolvedValueOnce(
        record({ messageId: "shared-task", cancelRequestedAt: 20 })
      );

      await expect(
        runtime.getTask("other-project", { hostId: "studio", taskId: "shared-task" })
      ).resolves.toMatchObject({
        ok: true,
        value: { outcome: "ok", task: { taskId: "shared-task" } },
      });
      await expect(runtime.listTasks("sibling", { hostId: "studio" })).resolves.toMatchObject({
        ok: true,
        value: { outcome: "ok", tasks: [{ taskId: "shared-task" }] },
      });
      await expect(
        runtime.cancelTask("other-project", { hostId: "studio", taskId: "shared-task" })
      ).resolves.toMatchObject({
        ok: true,
        value: { outcome: "ok", task: { taskId: "shared-task", cancelRequestedAt: 20 } },
      });
      expect(client.get).toHaveBeenCalledWith("studio", "shared-task");
      expect(client.cancel).toHaveBeenCalledWith("studio", "shared-task");
    });
  });

  describe("host.listAssistants", () => {
    it("lists the host's projects with the assistants in each, in the advertised shape", async () => {
      const listed = await runtime.listAssistants("a", { hostId: "studio" });
      if (!listed.ok) throw new Error("refused");
      expect(HostListAssistantsResultSchema.parse(listed.value)).toEqual({
        outcome: "ok",
        detail: null,
        retryAfterMs: null,
        projects: [
          {
            projectId: "proj-2",
            name: "website",
            path: "/repos/website",
            assistants: [
              { slot: 0, agentId: "codex", attached: null, generation: "gen-2", available: true },
            ],
          },
          { projectId: "proj-9", name: "notes", path: "/repos/notes", assistants: [] },
        ],
        projectsOmitted: 0,
      });
      // host.list then names the lane's project from that listing, without asking again.
      const hostList = await runtime.list("a");
      if (!hostList.ok) throw new Error("refused");
      expect(HostListResultSchema.parse(hostList.value).hosts[0]?.lanes).toEqual([
        {
          projectId: "proj-2",
          projectName: "website",
          slot: 0,
          generation: "gen-2",
          available: true,
          agentId: "codex",
        },
      ]);
      expect(hostProjects).toHaveBeenCalledTimes(1);
    });

    it("still lists the assistants, unnamed, when the host's projects can't be read", async () => {
      hostProjects.mockRejectedValueOnce(new Error("HOST_DISCONNECTED"));
      const listed = await runtime.listAssistants("a", { hostId: "studio" });
      if (!listed.ok) throw new Error("refused");
      expect(HostListAssistantsResultSchema.parse(listed.value).projects).toEqual([
        {
          projectId: "proj-2",
          name: null,
          path: null,
          assistants: [
            { slot: 0, agentId: "codex", attached: null, generation: "gen-2", available: true },
          ],
        },
      ]);
    });

    it("refuses in the advertised shape", async () => {
      denial = "host-disabled";
      const refused = await runtime.listAssistants("a", { hostId: "studio" });
      if (!refused.ok) throw new Error("refused outright");
      expect(HostListAssistantsResultSchema.parse(refused.value)).toMatchObject({
        outcome: "opted_out",
        projects: null,
        projectsOmitted: 0,
      });
      client.listLanes.mockRejectedValueOnce(
        new AppError({ code: "HOST_DISCONNECTED", message: "link dropped" })
      );
      denial = null;
      const failed = await runtime.listAssistants("a", { hostId: "studio" });
      if (!failed.ok) throw new Error("refused outright");
      expect(HostListAssistantsResultSchema.parse(failed.value)).toMatchObject({
        outcome: "disconnected",
        projects: null,
        projectsOmitted: 0,
      });
    });
  });

  describe("host.readQuota", () => {
    it("passes the host's reading through, stamped with when this Shell received it", async () => {
      const read = await runtime.readQuota("a", { hostId: "studio" });
      if (!read.ok) throw new Error("refused");
      expect(HostReadQuotaResultSchema.parse(read.value)).toEqual({
        outcome: "ok",
        detail: null,
        retryAfterMs: null,
        codex: {
          status: "ok",
          planType: "pro",
          windows: [
            { usedPercent: 42, windowDurationMins: 300, resetsAt: 990_000 },
            { usedPercent: 7.5, windowDurationMins: 10_080, resetsAt: null },
          ],
          fetchedAt: 980_000,
        },
        observedAt: clock,
      });
      expect(client.readQuota).toHaveBeenCalledWith("studio");

      client.readQuota.mockResolvedValueOnce({
        status: "unavailable",
        reason: "read-failed",
        fetchedAt: 980_000,
      });
      await expect(runtime.readQuota("a", { hostId: "studio" })).resolves.toMatchObject({
        value: {
          outcome: "ok",
          codex: { status: "unavailable", reason: "read-failed" },
          observedAt: clock,
        },
      });
    });

    it("reads only an opted-in host it knows, and reads through a pause", async () => {
      await expect(runtime.readQuota("remote-view", { hostId: "studio" })).resolves.toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });
      await expect(runtime.readQuota("a", { hostId: "elsewhere" })).resolves.toMatchObject({
        value: { outcome: "not_found", codex: null, observedAt: null },
      });
      denial = "host-disabled";
      const off = await runtime.readQuota("a", { hostId: "studio" });
      if (!off.ok) throw new Error("refused outright");
      expect(HostReadQuotaResultSchema.parse(off.value)).toMatchObject({
        outcome: "opted_out",
        codex: null,
        observedAt: null,
      });
      expect(client.readQuota).not.toHaveBeenCalled();

      denial = "paused";
      await expect(runtime.readQuota("a", { hostId: "studio" })).resolves.toMatchObject({
        value: { outcome: "ok", codex: { status: "ok" } },
      });
    });

    it("names a host it couldn't ask, and one too old to answer, in the advertised shape", async () => {
      client.readQuota.mockRejectedValueOnce(
        new AppError({ code: "HOST_DISCONNECTED", message: "link dropped" })
      );
      await expect(runtime.readQuota("a", { hostId: "studio" })).resolves.toMatchObject({
        value: { outcome: "disconnected", codex: null, observedAt: null },
      });

      client.readQuota.mockRejectedValueOnce(
        new AppError({ code: "OUTCOME_UNKNOWN", message: "no answer within 30000 ms" })
      );
      // A read that went unanswered sent nothing, so it's never reported as an ambiguous message.
      await expect(runtime.readQuota("a", { hostId: "studio" })).resolves.toMatchObject({
        value: { outcome: "disconnected", codex: null },
      });

      client.readQuota.mockRejectedValueOnce(
        new AppError({ code: "UNSUPPORTED", message: "unknown method" })
      );
      const old = await runtime.readQuota("a", { hostId: "studio" });
      if (!old.ok) throw new Error("refused outright");
      expect(HostReadQuotaResultSchema.parse(old.value)).toMatchObject({
        outcome: "unsupported",
        detail: expect.stringContaining("Codex quota"),
        codex: null,
      });

      client.readQuota.mockRejectedValueOnce(
        new AppError({ code: "INTERNAL", message: "invalid answer" })
      );
      await expect(runtime.readQuota("a", { hostId: "studio" })).resolves.toMatchObject({
        ok: false,
        code: "UNAVAILABLE",
      });
    });
  });

  describe("host.startAssistant", () => {
    const args = { hostId: "studio", projectId: "proj-2", agentId: "claude" };

    it("starts and enrolls one, answering with what a message to it needs", async () => {
      const started = await runtime.startAssistant("a", args);
      if (!started.ok) throw new Error("refused");
      expect(HostStartAssistantResultSchema.parse(started.value)).toEqual({
        outcome: "ok",
        detail: null,
        retryAfterMs: null,
        assistant: {
          projectId: "proj-2",
          slot: 1,
          agentId: "claude",
          generation: "gen-new",
          available: true,
          started: true,
        },
      });
      expect(starter?.start).toHaveBeenCalledWith(
        "studio",
        "proj-2",
        expect.objectContaining({ agentId: "claude", authorized: expect.any(Function) })
      );
    });

    it("remembers the started assistant's lane as the caller's route, and nothing on a refusal", async () => {
      starter!.start.mockResolvedValueOnce({ status: "refused", reason: "no-slot" });
      await runtime.startAssistant("sibling", args);
      expect(routes.remember).not.toHaveBeenCalled();

      await runtime.startAssistant("sibling", args);
      // The started lane, as the starter reported it (slot 1), not the project asked for.
      expect(routes.remember).toHaveBeenCalledTimes(1);
      expect(routes.remember).toHaveBeenCalledWith(
        "studio",
        { projectId: "proj-2", slot: 1 },
        RUN_SIBLING
      );
    });

    it("hands the starter a consent check it reads live, so turning it off mid-start stops it", async () => {
      await runtime.startAssistant("a", args);
      const { authorized } = starter!.start.mock.calls[0]![2] as { authorized: () => boolean };
      expect(authorized()).toBe(true);
      startEnabled = false;
      expect(authorized()).toBe(false);
      startEnabled = true;
      denial = "paused";
      expect(authorized()).toBe(false);
      denial = null;
      expect(authorized()).toBe(true);
      // The same session answering in a relaunched run is no longer the caller that asked.
      runs.set("a", { ...RUN_A, launchGeneration: 2 });
      expect(authorized()).toBe(false);
      runs.set("a", RUN_A);
      expect(authorized()).toBe(true);
      runs.delete("a");
      expect(authorized()).toBe(false);
    });

    it("needs the person's per-host consent, on top of messaging, and isn't paused past", async () => {
      startEnabled = false;
      const off = await runtime.startAssistant("a", args);
      if (!off.ok) throw new Error("refused outright");
      expect(HostStartAssistantResultSchema.parse(off.value)).toMatchObject({
        outcome: "opted_out",
        detail: expect.stringContaining("Starting assistants is turned off"),
        assistant: null,
      });
      startEnabled = true;
      denial = "paused";
      await expect(runtime.startAssistant("a", args)).resolves.toMatchObject({
        value: { outcome: "paused", assistant: null },
      });
      expect(starter?.start).not.toHaveBeenCalled();
      await expect(runtime.startAssistant("remote-view", args)).resolves.toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });
    });

    it("says why a start didn't happen in fixed words", async () => {
      starter!.start.mockResolvedValueOnce({ status: "refused", reason: "no-window" });
      const refused = await runtime.startAssistant("a", args);
      if (!refused.ok) throw new Error("refused outright");
      expect(HostStartAssistantResultSchema.parse(refused.value)).toMatchObject({
        outcome: "lane_unavailable",
        detail: expect.stringContaining("No window here shows this host"),
        assistant: null,
      });
      starter = null;
      await expect(runtime.startAssistant("a", args)).resolves.toMatchObject({
        value: { outcome: "unsupported", assistant: null },
      });
    });
  });

  describe("host.list", () => {
    it("lists only opted-in hosts, as observed, with null where nothing was measured", async () => {
      hosts = [
        host({
          connection: {
            status: "connected",
            rttMs: 12,
            handshake: {} as never,
          },
          lastSeenAt: 900,
          summary: {
            sampledAt: 950,
            cpuPercent: 40,
            memoryPressure: null,
            thermal: "nominal",
            agentsObserved: { working: 2, waiting: 1, idle: 0 },
          } as never,
        }),
        host({ hostId: "off", assistantMessagingEnabled: false }),
      ];
      const listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts).toEqual([
        {
          hostId: "studio",
          name: "studio-01",
          connection: "connected",
          rttMs: 12,
          lastSeenAt: 900,
          load: { sampledAt: 950, cpuPercent: 40, memoryPressure: null, thermal: "nominal" },
          agentsObserved: { working: 2, waiting: 1, idle: 0 },
          lanes: null,
          lanesObservedAt: null,
        },
      ]);
    });

    it("drops a disconnected host's agent tally and reports the lanes it last listed", async () => {
      hosts = [host({ summary: { sampledAt: 1, agentsObserved: { working: 3 } } as never })];
      await runtime.listAssistants("a", { hostId: "studio" });
      clock += 5;
      const listed = await runtime.list("a");
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.hosts[0]).toMatchObject({
        connection: "disconnected",
        agentsObserved: null,
        lanes: [
          {
            projectId: "proj-2",
            projectName: "website",
            slot: 0,
            generation: "gen-2",
            available: true,
            agentId: "codex",
          },
        ],
        lanesObservedAt: 1_000_000,
      });
      expect(client.listLanes).toHaveBeenCalledTimes(1);
    });
  });

  describe("host.sendMessage", () => {
    it("returns the receipt at once, its taskId the message id", async () => {
      const sent = await runtime.sendMessage("a", SEND);
      expect(sent).toMatchObject({
        ok: true,
        value: {
          outcome: "ok",
          taskId: "id-1",
          contextId: "id-1",
          wait: "none",
          task: { taskId: "id-1", hostTaskId: "host-task-1", state: "submitted" },
        },
      });
      expect(client.send).toHaveBeenCalledWith(
        "studio",
        expect.objectContaining({ messageId: "id-1", body: "hello", referenceTaskIds: [] }),
        RUN_A
      );
    });

    it("binds the send to the caller's run and remembers its route once the host took it", async () => {
      routes.remember.mockImplementation(() => {
        expect(client.send).toHaveBeenCalledTimes(1);
      });
      await expect(runtime.sendMessage("other-project", SEND)).resolves.toMatchObject({
        ok: true,
        value: { outcome: "ok" },
      });
      expect(routes.remember).toHaveBeenCalledTimes(1);
      expect(routes.remember).toHaveBeenCalledWith(
        "studio",
        { projectId: "proj-2", slot: 0 },
        RUN_OTHER_PROJECT
      );
      expect(client.send.mock.calls[0]![2]).toEqual(RUN_OTHER_PROJECT);
    });

    it("remembers the route for a fresh send whose answer was lost: the host may have it", async () => {
      client.send.mockResolvedValueOnce({ status: "unknown", messageId: "maybe" });
      await expect(runtime.sendMessage("sibling", SEND)).resolves.toMatchObject({
        value: { outcome: "ambiguous" },
      });
      expect(routes.remember).toHaveBeenCalledWith(
        "studio",
        { projectId: "proj-2", slot: 0 },
        RUN_SIBLING
      );
    });

    it("leaves the route alone for a resend whose answer was lost: it may be another assistant's", async () => {
      client.send.mockResolvedValueOnce({ status: "unknown", messageId: "maybe" });
      await expect(
        runtime.sendMessage("sibling", { ...SEND, taskId: "maybe" })
      ).resolves.toMatchObject({ value: { outcome: "ambiguous" } });
      expect(routes.remember).not.toHaveBeenCalled();
    });

    it("keeps the first asker's route when another assistant resends its message", async () => {
      await runtime.sendMessage("a", { ...SEND, taskId: "t-shared" });
      client.send.mockImplementationOnce(
        async (_hostId: string, payload: { messageId: string }) => ({
          status: "accepted",
          disposition: "existing",
          record: record({ messageId: payload.messageId }),
        })
      );
      await expect(
        runtime.sendMessage("other-project", { ...SEND, taskId: "t-shared" })
      ).resolves.toMatchObject({ value: { outcome: "ok", taskId: "t-shared" } });
      expect(client.send).toHaveBeenCalledTimes(2);
      expect(routes.remember).toHaveBeenCalledTimes(1);
      expect(routes.remember).toHaveBeenCalledWith(
        "studio",
        { projectId: "proj-2", slot: 0 },
        RUN_A
      );
    });

    it.each([
      ["a taskId conflict", new AppError({ code: "VALIDATION", message: "reused" }), "conflict"],
      ["a send past its retry window", new RetryWindowPassedError("task-1"), "expired"],
      [
        "the host's refusal",
        new AppError({ code: "PERMISSION", message: "not enrolled" }),
        "policy_rejected",
      ],
    ])("remembers no route for %s", async (_label, error, outcome) => {
      client.send.mockRejectedValueOnce(error);
      await expect(runtime.sendMessage("a", SEND)).resolves.toMatchObject({
        value: { outcome },
      });
      expect(client.send).toHaveBeenCalledTimes(1);
      expect(routes.remember).not.toHaveBeenCalled();
    });

    it("remembers no route for a send it refused before sending", async () => {
      denial = "host-disabled";
      await runtime.sendMessage("a", SEND);
      await runtime.sendMessage("a", { ...SEND, text: "\u0001".repeat(16_000) });
      expect(routes.remember).not.toHaveBeenCalled();
    });

    it("reports a send whose answer was lost as ambiguous, never as a failure", async () => {
      client.send.mockResolvedValueOnce({ status: "unknown", messageId: "retry-me" });
      const sent = await runtime.sendMessage("a", { ...SEND, taskId: "retry-me" });
      expect(sent).toMatchObject({
        ok: true,
        value: { outcome: "ambiguous", taskId: "retry-me", task: null },
      });
      if (sent.ok) expect(sent.value.detail).toContain("before sending again");

      client.send.mockRejectedValueOnce(new Error("socket hung up"));
      await expect(runtime.sendMessage("a", SEND)).resolves.toMatchObject({
        ok: true,
        value: { outcome: "ambiguous" },
      });
    });

    it.each([
      [new AppError({ code: "HOST_DISCONNECTED", message: "x" }), "disconnected"],
      [new AppError({ code: "UNSUPPORTED", message: "x" }), "unsupported"],
      [new AppError({ code: "STALE_GENERATION", message: "x" }), "lane_unavailable"],
      [new AppError({ code: "PERMISSION", message: LANE_NOT_RUNNING_MESSAGE }), "lane_unavailable"],
      [new AppError({ code: "PERMISSION", message: "not enrolled" }), "policy_rejected"],
      [new RetryWindowPassedError("task-1"), "expired"],
      // A host's refusal names the caller's own taskId, whatever words it holds.
      [new AppError({ code: "VALIDATION", message: "past its retry window reused" }), "conflict"],
    ])("names %s as %s", async (error, outcome) => {
      client.send.mockRejectedValueOnce(error);
      await expect(runtime.sendMessage("a", SEND)).resolves.toMatchObject({
        ok: true,
        value: { outcome },
      });
    });

    it("hands back no taskId when the host refused before recording anything", async () => {
      client.send.mockRejectedValueOnce(
        new AppError({ code: "PERMISSION", message: "not enrolled" })
      );
      await expect(runtime.sendMessage("a", SEND)).resolves.toMatchObject({
        value: { outcome: "policy_rejected", taskId: null, contextId: null },
      });
      // Unknown outcomes keep theirs: the message may be on the host.
      client.send.mockRejectedValueOnce(new AppError({ code: "HOST_DISCONNECTED", message: "x" }));
      const disconnected = await runtime.sendMessage("a", SEND);
      expect(disconnected.ok && disconnected.value.taskId).not.toBeNull();
      // A resend keeps its id: an earlier attempt under it may still be on the host.
      client.send.mockRejectedValueOnce(
        new AppError({ code: "PERMISSION", message: "not enrolled" })
      );
      await expect(
        runtime.sendMessage("a", { ...SEND, taskId: "task-resent" })
      ).resolves.toMatchObject({ value: { outcome: "policy_rejected", taskId: "task-resent" } });
      client.send.mockRejectedValueOnce(new AppError({ code: "UNSUPPORTED", message: "x" }));
      const unsupported = await runtime.sendMessage("a", SEND);
      expect(unsupported.ok && unsupported.value.taskId).not.toBeNull();
    });

    it("names the policy's refusals without sending", async () => {
      denial = "host-disabled";
      await expect(runtime.sendMessage("a", SEND)).resolves.toMatchObject({
        value: { outcome: "opted_out", taskId: null },
      });
      denial = "paused";
      await expect(runtime.sendMessage("a", SEND)).resolves.toMatchObject({
        value: { outcome: "paused" },
      });
      await expect(
        runtime.sendMessage("a", { ...SEND, hostId: "unknown-host" })
      ).resolves.toMatchObject({ value: { outcome: "not_found" } });
      expect(client.send).not.toHaveBeenCalled();
    });

    it("refuses a body the inbox can't hold whole before spending a send", async () => {
      const result = await runtime.sendMessage("a", { ...SEND, text: "\u0001".repeat(16_000) });
      expect(result).toMatchObject({ ok: true, value: { outcome: "too_large", taskId: null } });
      expect(client.send).not.toHaveBeenCalled();
    });

    it("limits sends per host as a result naming when to retry", async () => {
      for (let i = 0; i < HUB_SENDS_PER_HOST_PER_MINUTE; i++) {
        await expect(runtime.sendMessage("a", SEND)).resolves.toMatchObject({
          value: { outcome: "ok" },
        });
      }
      const limited = await runtime.sendMessage("a", SEND);
      expect(limited).toMatchObject({ ok: true, value: { outcome: "rate_limited" } });
      if (!limited.ok) throw new Error("refused");
      expect(limited.value.retryAfterMs).toBeGreaterThan(0);
      expect(client.send).toHaveBeenCalledTimes(HUB_SENDS_PER_HOST_PER_MINUTE);

      clock += limited.value.retryAfterMs!;
      await expect(runtime.sendMessage("a", SEND)).resolves.toMatchObject({
        value: { outcome: "ok" },
      });
    });

    it("shares one Shell-wide send budget between every assistant here", async () => {
      // Spread across hosts so the per-host limit never binds first.
      const perHost = HUB_SENDS_PER_HOST_PER_MINUTE;
      hosts = Array.from({ length: Math.ceil(HUB_SENDS_PER_MINUTE / perHost) + 1 }, (_, i) =>
        host({ hostId: `h-${i}` })
      );
      for (let i = 0; i < HUB_SENDS_PER_MINUTE; i++) {
        const session = i % 2 === 0 ? "a" : "other-project";
        await expect(
          runtime.sendMessage(session, { ...SEND, hostId: `h-${Math.floor(i / perHost)}` })
        ).resolves.toMatchObject({ value: { outcome: "ok" } });
      }
      // A second assistant gets no budget of its own: the next send from either is limited.
      for (const session of ["a", "sibling"]) {
        const limited = await runtime.sendMessage(session, {
          ...SEND,
          hostId: `h-${hosts.length - 1}`,
        });
        expect(limited).toMatchObject({ ok: true, value: { outcome: "rate_limited" } });
        if (!limited.ok) throw new Error("refused");
        expect(limited.value.retryAfterMs).toBeGreaterThan(0);
      }
      expect(client.send).toHaveBeenCalledTimes(HUB_SENDS_PER_MINUTE);
    });

    it("resends under the same taskId with the same contextId, so the host sees one message", async () => {
      await runtime.sendMessage("a", { ...SEND, taskId: "t-9" });
      await runtime.sendMessage("a", { ...SEND, taskId: "t-9" });
      const contexts = client.send.mock.calls.map(([, payload]) => payload.contextId);
      expect(contexts).toEqual(["t-9", "t-9"]);
    });

    it("looks at least once on a wait shorter than one poll", async () => {
      client.get.mockResolvedValueOnce(record({ state: "input-required" }));
      await expect(runtime.sendMessage("a", { ...SEND, waitMs: 200 })).resolves.toMatchObject({
        value: { wait: "settled", task: { state: "input-required" } },
      });
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("stops waiting once the caller's run is replaced", async () => {
      client.get.mockImplementation(async () => {
        runs.set("a", { ...RUN_A, terminalId: "t-relaunched", launchGeneration: 2 });
        return record({ state: "working" });
      });
      const sent = await runtime.sendMessage("a", { ...SEND, waitMs: 20_000 });
      expect(sent).toMatchObject({ value: { wait: "timed_out" } });
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("holds two waits at once, from any callers, and returns the next send without waiting", async () => {
      const held: Array<() => void> = [];
      sleep = () => new Promise<void>((resolve) => held.push(resolve));
      client.get.mockResolvedValue(record({ state: "working" }));
      const first = runtime.sendMessage("a", { ...SEND, waitMs: 10_000 });
      const second = runtime.sendMessage("sibling", { ...SEND, waitMs: 10_000 });
      await vi.waitFor(() => expect(held).toHaveLength(2));

      await expect(
        runtime.sendMessage("other-project", { ...SEND, waitMs: 10_000 })
      ).resolves.toMatchObject({ ok: true, value: { outcome: "ok", wait: "skipped" } });
      expect(client.send).toHaveBeenCalledTimes(3);

      // One wait settles and frees its place for the next caller's.
      client.get.mockResolvedValue(record({ state: "completed" }));
      held.shift()!();
      await expect(first).resolves.toMatchObject({ value: { wait: "settled" } });
      const fourth = runtime.sendMessage("other-project", { ...SEND, waitMs: 10_000 });
      await vi.waitFor(() => expect(held).toHaveLength(2));
      held.shift()!();
      held.shift()!();
      await expect(second).resolves.toMatchObject({ value: { wait: "settled" } });
      await expect(fourth).resolves.toMatchObject({ value: { wait: "settled" } });
    });

    it("waits for a reply when asked, and a timeout ends only the wait", async () => {
      client.get
        .mockResolvedValueOnce(record({ state: "working" }))
        .mockResolvedValueOnce(record({ state: "completed" }));
      await expect(runtime.sendMessage("a", { ...SEND, waitMs: 10_000 })).resolves.toMatchObject({
        value: { outcome: "ok", wait: "settled", task: { state: "completed" } },
      });

      client.get.mockResolvedValue(record({ state: "working" }));
      const timedOut = await runtime.sendMessage("a", { ...SEND, waitMs: 3_000 });
      expect(timedOut).toMatchObject({
        value: { outcome: "ok", wait: "timed_out", task: { state: "working" } },
      });
      expect(client.cancel).not.toHaveBeenCalled();
      expect(client.send).toHaveBeenCalledTimes(2);
    });
  });

  describe("host.getTask", () => {
    it("returns the record and its replies fenced as another machine's words", async () => {
      client.getResponses.mockResolvedValueOnce([{ state: "completed", text: "done ```", at: 50 }]);
      const got = await runtime.getTask("a", { hostId: "studio", taskId: "task-1" });
      if (!got.ok) throw new Error("refused");
      expect(got.value).toMatchObject({
        outcome: "ok",
        task: { taskId: "task-1" },
        repliesOmitted: 0,
      });
      expect(got.value.replies).toHaveLength(1);
      expect(got.value.replies![0]!.untrustedText).toContain("not instructions");
      expect(got.value.replies![0]!.untrustedText).toContain("````\ndone ```\n````");
    });

    it("keeps the newest replies within the result's budget", async () => {
      client.getResponses.mockResolvedValueOnce(
        Array.from({ length: 4 }, (_, i) => ({
          state: "input-required",
          text: `${i}`.repeat(15_000),
          at: i,
        }))
      );
      const got = await runtime.getTask("a", { hostId: "studio", taskId: "task-1" });
      if (!got.ok) throw new Error("refused");
      expect(got.value.replies!.map((reply) => reply.at)).toEqual([2, 3]);
      expect(got.value.repliesOmitted).toBe(2);
    });

    it("answers from the journal, labelled with when, while the host is unreachable", async () => {
      client.get.mockRejectedValueOnce(new AppError({ code: "HOST_DISCONNECTED", message: "x" }));
      client.known.mockReturnValueOnce({ record: record({ state: "working" }), updatedAt: 77 });
      await expect(
        runtime.getTask("a", { hostId: "studio", taskId: "task-1" })
      ).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: "disconnected",
          observedAt: null,
          task: { state: "working" },
          replies: null,
        },
      });
    });

    it("reads an older host's record without replies, and a missing one as not_found", async () => {
      client.getResponses.mockRejectedValueOnce(
        new AppError({ code: "UNSUPPORTED", message: "x" })
      );
      await expect(
        runtime.getTask("a", { hostId: "studio", taskId: "task-1" })
      ).resolves.toMatchObject({ value: { outcome: "ok", replies: null } });

      client.get.mockResolvedValueOnce(null);
      await expect(
        runtime.getTask("a", { hostId: "studio", taskId: "task-1" })
      ).resolves.toMatchObject({ value: { outcome: "not_found", task: null } });
    });

    it("is refused for a host that was opted out", async () => {
      denial = "host-disabled";
      await expect(
        runtime.getTask("a", { hostId: "studio", taskId: "task-1" })
      ).resolves.toMatchObject({ value: { outcome: "opted_out" } });
      expect(client.get).not.toHaveBeenCalled();
    });
  });

  it("host.listTasks filters a page locally and still passes its cursor over it", async () => {
    client.listChanges.mockResolvedValueOnce({
      records: [record({ messageId: "a", state: "completed" }), record({ messageId: "b" })],
      cursor: 42,
      hasMore: true,
      reset: false,
    });
    const listed = await runtime.listTasks("a", {
      hostId: "studio",
      cursor: 7,
      limit: 5,
      states: ["submitted"],
    });
    expect(client.listChanges).toHaveBeenCalledWith("studio", 7, 5);
    expect(listed).toMatchObject({
      value: { outcome: "ok", cursor: 42, hasMore: true, tasks: [{ taskId: "b" }] },
    });
  });

  it("host.cancelTask records the request even while messaging is paused", async () => {
    denial = "paused";
    await expect(
      runtime.cancelTask("a", { hostId: "studio", taskId: "task-1" })
    ).resolves.toMatchObject({ value: { outcome: "ok", task: { cancelRequestedAt: 20 } } });
    expect(checks.at(-1)).toEqual({ hostId: "studio", kind: "reply" });
  });

  it("refuses with fixed words when a host call fails in a way nothing names", async () => {
    client.listLanes.mockRejectedValueOnce(new Error("/Users/someone/secret broke"));
    const listed = await runtime.listAssistants("a", { hostId: "studio" });
    expect(listed).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    if (!listed.ok) expect(listed.message).not.toContain("secret");
  });
});

describe("projectTree", () => {
  const summary = (id: string, name: string) => ({ id, name, path: `/repos/${name}` });

  it("names each assistant's project, lists projects with assistants first, and keeps the host's order", () => {
    const tree = projectTree(
      {
        lanes: [
          { projectId: "b", slot: 1, generation: "gen-b1", available: true, agentId: "codex" },
        ],
        assistants: [
          { projectId: "b", slot: 1, agentId: "codex" },
          { projectId: "b", slot: 0, agentId: "codex" },
        ],
      },
      [summary("a", "alpha"), summary("b", "beta"), summary("c", "gamma")],
      false
    );
    expect(tree.projects).toEqual([
      {
        projectId: "b",
        name: "beta",
        path: "/repos/beta",
        assistants: [
          { slot: 0, agentId: "codex", attached: null, generation: null, available: false },
          { slot: 1, agentId: "codex", attached: null, generation: "gen-b1", available: true },
        ],
      },
      { projectId: "a", name: "alpha", path: "/repos/alpha", assistants: [] },
      { projectId: "c", name: "gamma", path: "/repos/gamma", assistants: [] },
    ]);
    expect(tree.lanes).toEqual([
      {
        projectId: "b",
        projectName: "beta",
        slot: 1,
        generation: "gen-b1",
        available: true,
        agentId: "codex",
      },
    ]);
  });

  it("orders projects with assistants by the host's own order, and lists a repeated project once", () => {
    const tree = projectTree(
      {
        lanes: [],
        assistants: [
          { projectId: "c", slot: 0, agentId: "claude" },
          { projectId: "a", slot: 0, agentId: "codex" },
        ],
      },
      [summary("a", "alpha"), summary("b", "beta"), summary("a", "alpha"), summary("c", "gamma")],
      false
    );
    expect(tree.projects.map((project) => project.projectId)).toEqual(["a", "c", "b"]);
    expect(tree.omitted).toBe(0);
  });

  it("passes on whether each assistant is pinned to a view, as the host reported it", () => {
    const tree = projectTree(
      {
        lanes: [],
        assistants: [
          { projectId: "a", slot: 0, agentId: "codex", attached: false },
          { projectId: "a", slot: 1, agentId: "codex", attached: true },
        ],
      },
      [summary("a", "alpha")],
      false
    );
    expect(tree.projects[0]!.assistants.map((assistant) => assistant.attached)).toEqual([
      false,
      true,
    ]);
  });

  it("keeps an enrolled lane whose assistant isn't running, and one in a project the host didn't name", () => {
    const tree = projectTree(
      { lanes: [{ projectId: "scratch", slot: 2, generation: "gen-s", available: false }] },
      [],
      false
    );
    expect(tree.projects).toEqual([
      {
        projectId: "scratch",
        name: null,
        path: null,
        assistants: [
          { slot: 2, agentId: null, attached: null, generation: "gen-s", available: false },
        ],
      },
    ]);
  });

  it("marks nothing available while paused, and counts the projects past the cap", () => {
    const many = Array.from({ length: HOST_LIST_PROJECTS_MAX + 3 }, (_, i) =>
      summary(`p${i}`, `project-${i}`)
    );
    const tree = projectTree(
      {
        lanes: [{ projectId: "p60", slot: 0, generation: "g", available: true, agentId: "claude" }],
        assistants: [{ projectId: "p60", slot: 0, agentId: "claude" }],
      },
      [...many, summary("p60", "late")],
      true
    );
    expect(tree.projects[0]).toMatchObject({
      projectId: "p60",
      assistants: [{ available: false }],
    });
    expect(tree.projects).toHaveLength(HOST_LIST_PROJECTS_MAX);
    expect(tree.omitted).toBe(many.length + 1 - HOST_LIST_PROJECTS_MAX);
  });
});
