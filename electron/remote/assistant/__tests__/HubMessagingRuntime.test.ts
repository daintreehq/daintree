import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import type { ExchangeRecord } from "../../exchange/types.js";
import type {
  EnrollmentResult,
  HostCheck,
  LaneEnrollment,
  MessagingDenial,
} from "../AssistantMessagingPolicy.js";
import { RetryWindowPassedError } from "../AssistantExchangeClient.js";
import { LANE_NOT_RUNNING_MESSAGE } from "../hostExchanges.js";
import {
  HOST_LIST_PROJECTS_MAX,
  HostListAssistantsResultSchema,
  HostListResultSchema,
} from "../../../../shared/types/hostMessaging.js";
import {
  HUB_SENDS_PER_HOST_PER_MINUTE,
  HubMessagingRuntime,
  projectTree,
  type ObservedHost,
} from "../HubMessagingRuntime.js";

const HUB: LaneEnrollment = {
  projectId: "proj-1",
  slot: 0,
  generation: "hub-gen",
  sessionId: "hub",
  terminalId: "t-hub",
  launchGeneration: 1,
  enrolledBy: { kind: "local" },
  enrolledAt: 1,
};

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
  let hub: LaneEnrollment | null;
  let lanes: Map<string, { projectId: string; slot: number }>;
  let denial: MessagingDenial | null;
  let checks: HostCheck[];
  let client: {
    listLanes: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    getResponses: ReturnType<typeof vi.fn>;
    listChanges: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    known: ReturnType<typeof vi.fn>;
  };
  let runtime: HubMessagingRuntime;
  let hostProjects: ReturnType<typeof vi.fn>;
  let ids: number;

  beforeEach(() => {
    clock = 1_000_000;
    ids = 0;
    hosts = [host()];
    hub = HUB;
    lanes = new Map([
      ["hub", { projectId: "proj-1", slot: 0 }],
      ["other-lane", { projectId: "proj-1", slot: 1 }],
    ]);
    denial = null;
    checks = [];
    client = {
      listLanes: vi.fn(async () => ({
        lanes: [{ projectId: "proj-2", slot: 0, generation: "gen-2", available: true }],
        assistants: [{ projectId: "proj-2", slot: 0, agentId: "codex" }],
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
    runtime = new HubMessagingRuntime({
      listHostProjects: hostProjects as never,
      policy: {
        isSupported: () => true,
        getHub: () => hub,
        checkHost: (check: HostCheck): EnrollmentResult => {
          checks.push(check);
          if (denial === "paused" && (check.kind === "reply" || check.kind === "inspect")) {
            return { ok: true, enrollment: HUB };
          }
          return denial ? { ok: false, reason: denial } : { ok: true, enrollment: HUB };
        },
      },
      getSessionLane: (id) => lanes.get(id) ?? null,
      client: () => client as never,
      hosts: () => hosts,
      now: () => clock,
      newId: () => `id-${++ids}`,
      sleep: async (ms) => {
        clock += ms;
      },
      pollIntervalMs: 1_000,
    });
  });

  describe("who may call", () => {
    it("is the session the hub was enrolled with, and no other lane or session", async () => {
      expect(runtime.isAvailable("hub")).toBe(true);
      expect(runtime.isAvailable("other-lane")).toBe(false);
      expect(runtime.isAvailable("stranger")).toBe(false);
      await expect(runtime.list("other-lane")).resolves.toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });

      // A relaunched hub holds a new session; the old one's bearer reaches nothing.
      hub = { ...HUB, sessionId: "hub-2" };
      lanes.set("hub-2", { projectId: "proj-1", slot: 0 });
      expect(runtime.isAvailable("hub")).toBe(false);
      expect(runtime.isAvailable("hub-2")).toBe(true);
    });

    it("lists no lane as taking messages while this Shell has messaging paused", async () => {
      denial = "paused";
      await expect(runtime.listAssistants("hub", { hostId: "studio" })).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: "ok",
          projects: [{ assistants: [{ slot: 0, available: false }] }, { assistants: [] }],
        },
      });
      denial = null;
      await expect(runtime.listAssistants("hub", { hostId: "studio" })).resolves.toMatchObject({
        value: { projects: [{ assistants: [{ slot: 0, available: true }] }, { assistants: [] }] },
      });
    });

    it("is hidden until a host exists", () => {
      hosts = [];
      expect(runtime.isAvailable("hub")).toBe(false);
      expect(runtime.isReachable("hub")).toBe(false);
    });

    it("is reachable from any lane's session while a host exists, though only the hub may call", async () => {
      expect(runtime.isReachable("other-lane")).toBe(true);
      expect(runtime.isReachable("stranger")).toBe(false);
      await expect(runtime.list("other-lane")).resolves.toMatchObject({
        ok: false,
        code: "NOT_ELIGIBLE",
      });
    });

    it("offers nothing once disposed", async () => {
      runtime.dispose();
      expect(runtime.isAvailable("hub")).toBe(false);
      await expect(runtime.list("hub")).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });
    });
  });

  describe("host.listAssistants", () => {
    it("lists the host's projects with the assistants in each, in the advertised shape", async () => {
      const listed = await runtime.listAssistants("hub", { hostId: "studio" });
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
            assistants: [{ slot: 0, agentId: "codex", generation: "gen-2", available: true }],
          },
          { projectId: "proj-9", name: "notes", path: "/repos/notes", assistants: [] },
        ],
        projectsOmitted: 0,
      });
      // host.list then names the lane's project from that listing, without asking again.
      const hostList = await runtime.list("hub");
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
      const listed = await runtime.listAssistants("hub", { hostId: "studio" });
      if (!listed.ok) throw new Error("refused");
      expect(HostListAssistantsResultSchema.parse(listed.value).projects).toEqual([
        {
          projectId: "proj-2",
          name: null,
          path: null,
          assistants: [{ slot: 0, agentId: "codex", generation: "gen-2", available: true }],
        },
      ]);
    });

    it("refuses in the advertised shape", async () => {
      denial = "host-disabled";
      const refused = await runtime.listAssistants("hub", { hostId: "studio" });
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
      const failed = await runtime.listAssistants("hub", { hostId: "studio" });
      if (!failed.ok) throw new Error("refused outright");
      expect(HostListAssistantsResultSchema.parse(failed.value)).toMatchObject({
        outcome: "disconnected",
        projects: null,
        projectsOmitted: 0,
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
      const listed = await runtime.list("hub");
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
      await runtime.listAssistants("hub", { hostId: "studio" });
      clock += 5;
      const listed = await runtime.list("hub");
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
      const sent = await runtime.sendMessage("hub", SEND);
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
        expect.objectContaining({ messageId: "id-1", body: "hello", referenceTaskIds: [] })
      );
    });

    it("reports a send whose answer was lost as ambiguous, never as a failure", async () => {
      client.send.mockResolvedValueOnce({ status: "unknown", messageId: "retry-me" });
      const sent = await runtime.sendMessage("hub", { ...SEND, taskId: "retry-me" });
      expect(sent).toMatchObject({
        ok: true,
        value: { outcome: "ambiguous", taskId: "retry-me", task: null },
      });
      if (sent.ok) expect(sent.value.detail).toContain("before sending again");

      client.send.mockRejectedValueOnce(new Error("socket hung up"));
      await expect(runtime.sendMessage("hub", SEND)).resolves.toMatchObject({
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
      await expect(runtime.sendMessage("hub", SEND)).resolves.toMatchObject({
        ok: true,
        value: { outcome },
      });
    });

    it("hands back no taskId when the host refused before recording anything", async () => {
      client.send.mockRejectedValueOnce(
        new AppError({ code: "PERMISSION", message: "not enrolled" })
      );
      await expect(runtime.sendMessage("hub", SEND)).resolves.toMatchObject({
        value: { outcome: "policy_rejected", taskId: null, contextId: null },
      });
      // Unknown outcomes keep theirs: the message may be on the host.
      client.send.mockRejectedValueOnce(new AppError({ code: "HOST_DISCONNECTED", message: "x" }));
      const disconnected = await runtime.sendMessage("hub", SEND);
      expect(disconnected.ok && disconnected.value.taskId).not.toBeNull();
      // A resend keeps its id: an earlier attempt under it may still be on the host.
      client.send.mockRejectedValueOnce(
        new AppError({ code: "PERMISSION", message: "not enrolled" })
      );
      await expect(
        runtime.sendMessage("hub", { ...SEND, taskId: "task-resent" })
      ).resolves.toMatchObject({ value: { outcome: "policy_rejected", taskId: "task-resent" } });
      client.send.mockRejectedValueOnce(new AppError({ code: "UNSUPPORTED", message: "x" }));
      const unsupported = await runtime.sendMessage("hub", SEND);
      expect(unsupported.ok && unsupported.value.taskId).not.toBeNull();
    });

    it("names the policy's refusals without sending", async () => {
      denial = "host-disabled";
      await expect(runtime.sendMessage("hub", SEND)).resolves.toMatchObject({
        value: { outcome: "opted_out", taskId: null },
      });
      denial = "paused";
      await expect(runtime.sendMessage("hub", SEND)).resolves.toMatchObject({
        value: { outcome: "paused" },
      });
      await expect(
        runtime.sendMessage("hub", { ...SEND, hostId: "unknown-host" })
      ).resolves.toMatchObject({ value: { outcome: "not_found" } });
      expect(client.send).not.toHaveBeenCalled();
    });

    it("refuses a body the inbox can't hold whole before spending a send", async () => {
      const result = await runtime.sendMessage("hub", { ...SEND, text: "\u0001".repeat(16_000) });
      expect(result).toMatchObject({ ok: true, value: { outcome: "too_large", taskId: null } });
      expect(client.send).not.toHaveBeenCalled();
    });

    it("limits sends per host as a result naming when to retry", async () => {
      for (let i = 0; i < HUB_SENDS_PER_HOST_PER_MINUTE; i++) {
        await expect(runtime.sendMessage("hub", SEND)).resolves.toMatchObject({
          value: { outcome: "ok" },
        });
      }
      const limited = await runtime.sendMessage("hub", SEND);
      expect(limited).toMatchObject({ ok: true, value: { outcome: "rate_limited" } });
      if (!limited.ok) throw new Error("refused");
      expect(limited.value.retryAfterMs).toBeGreaterThan(0);
      expect(client.send).toHaveBeenCalledTimes(HUB_SENDS_PER_HOST_PER_MINUTE);

      clock += limited.value.retryAfterMs!;
      await expect(runtime.sendMessage("hub", SEND)).resolves.toMatchObject({
        value: { outcome: "ok" },
      });
    });

    it("resends under the same taskId with the same contextId, so the host sees one message", async () => {
      await runtime.sendMessage("hub", { ...SEND, taskId: "t-9" });
      await runtime.sendMessage("hub", { ...SEND, taskId: "t-9" });
      const contexts = client.send.mock.calls.map(([, payload]) => payload.contextId);
      expect(contexts).toEqual(["t-9", "t-9"]);
    });

    it("looks at least once on a wait shorter than one poll", async () => {
      client.get.mockResolvedValueOnce(record({ state: "input-required" }));
      await expect(runtime.sendMessage("hub", { ...SEND, waitMs: 200 })).resolves.toMatchObject({
        value: { wait: "settled", task: { state: "input-required" } },
      });
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("stops waiting once the caller is no longer the hub", async () => {
      client.get.mockImplementation(async () => {
        hub = { ...HUB, sessionId: "hub-2" };
        return record({ state: "working" });
      });
      const sent = await runtime.sendMessage("hub", { ...SEND, waitMs: 20_000 });
      expect(sent).toMatchObject({ value: { wait: "timed_out" } });
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("waits for a reply when asked, and a timeout ends only the wait", async () => {
      client.get
        .mockResolvedValueOnce(record({ state: "working" }))
        .mockResolvedValueOnce(record({ state: "completed" }));
      await expect(runtime.sendMessage("hub", { ...SEND, waitMs: 10_000 })).resolves.toMatchObject({
        value: { outcome: "ok", wait: "settled", task: { state: "completed" } },
      });

      client.get.mockResolvedValue(record({ state: "working" }));
      const timedOut = await runtime.sendMessage("hub", { ...SEND, waitMs: 3_000 });
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
      const got = await runtime.getTask("hub", { hostId: "studio", taskId: "task-1" });
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
      const got = await runtime.getTask("hub", { hostId: "studio", taskId: "task-1" });
      if (!got.ok) throw new Error("refused");
      expect(got.value.replies!.map((reply) => reply.at)).toEqual([2, 3]);
      expect(got.value.repliesOmitted).toBe(2);
    });

    it("answers from the journal, labelled with when, while the host is unreachable", async () => {
      client.get.mockRejectedValueOnce(new AppError({ code: "HOST_DISCONNECTED", message: "x" }));
      client.known.mockReturnValueOnce({ record: record({ state: "working" }), updatedAt: 77 });
      await expect(
        runtime.getTask("hub", { hostId: "studio", taskId: "task-1" })
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
        runtime.getTask("hub", { hostId: "studio", taskId: "task-1" })
      ).resolves.toMatchObject({ value: { outcome: "ok", replies: null } });

      client.get.mockResolvedValueOnce(null);
      await expect(
        runtime.getTask("hub", { hostId: "studio", taskId: "task-1" })
      ).resolves.toMatchObject({ value: { outcome: "not_found", task: null } });
    });

    it("is refused for a host that was opted out", async () => {
      denial = "host-disabled";
      await expect(
        runtime.getTask("hub", { hostId: "studio", taskId: "task-1" })
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
    const listed = await runtime.listTasks("hub", {
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
      runtime.cancelTask("hub", { hostId: "studio", taskId: "task-1" })
    ).resolves.toMatchObject({ value: { outcome: "ok", task: { cancelRequestedAt: 20 } } });
    expect(checks.at(-1)).toEqual({ hostId: "studio", kind: "reply" });
  });

  it("refuses with fixed words when a host call fails in a way nothing names", async () => {
    client.listLanes.mockRejectedValueOnce(new Error("/Users/someone/secret broke"));
    const listed = await runtime.listAssistants("hub", { hostId: "studio" });
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
          { slot: 0, agentId: "codex", generation: null, available: false },
          { slot: 1, agentId: "codex", generation: "gen-b1", available: true },
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
        assistants: [{ slot: 2, agentId: null, generation: "gen-s", available: false }],
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
