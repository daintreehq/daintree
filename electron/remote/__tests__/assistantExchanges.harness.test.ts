import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness/fakeElectron.js")).electronMock);

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: () => true,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => "corr-harness",
}));

vi.mock("../../store.js", async () => ({
  store: (await import("./harness/harnessState.js")).memoryStore,
}));

vi.mock("../../services/ProjectStore.js", async () => ({
  projectStore: (await import("./harness/harnessState.js")).memoryProjectStore,
}));

vi.mock("../../boot/hostServices.js", () => ({
  isWorkspaceClientStarting: () => false,
  ensureWorkspaceClient: async () => undefined,
}));

vi.mock("../host/hostCommands.js", async () => {
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    runCommand: async () => ({ code: 1, stdout: "", stderr: "not in the harness" }),
    spawnOwnedProcess: (file: string, args: readonly string[]) => {
      const record = { file, args, killed: false };
      harnessState.spawned.push(record);
      return { kill: () => (record.killed = true), onExit: () => undefined };
    },
  };
});

vi.mock("../client/initClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../client/initClient.js")>();
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    ...original,
    initRemoteHostsClient: (...args: Parameters<typeof original.initRemoteHostsClient>) => {
      const client = original.initRemoteHostsClient(...args);
      harnessState.client = client;
      return client;
    },
  };
});

vi.mock("../../ipc/handlers/app/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/handlers/app/state.js")>()),
  readShellHydrateFields: () => ({ safeMode: false, crashCount: 0 }),
}));

vi.mock("../../services/PluginService.js", async () => ({
  pluginService: (await import("./harness/fakePluginService.js")).fakePluginService,
}));

/** The assistants running on the host, by `projectId#slot`: what enrollment checks against. */
const lanes = vi.hoisted(
  () =>
    new Map<string, { sessionId: string; terminalId: string; projectViewWebContentsId: number }>()
);
vi.mock("../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    addSessionEndedListener: () => () => {},

    addSessionReattachedListener: () => () => {},
    getRunningLaneSession: (projectId: string, slot: number) =>
      lanes.get(`${projectId}#${slot}`) ?? null,
    listRunningLanes: () =>
      [...lanes.keys()].map((key) => {
        const [projectId, slot] = key.split("#");
        return { projectId: projectId!, slot: Number(slot), agentId: "claude" };
      }),
    getSessionLane: (sessionId: string) => {
      for (const [key, lane] of lanes) {
        if (lane.sessionId !== sessionId) continue;
        const [projectId, slot] = key.split("#");
        return { projectId: projectId!, slot: Number(slot) };
      }
      return null;
    },
    getAssistantBackends: () => [],
    helpSessionRefsForWebContentsId: () => [],
    revokeByWebContentsId: async () => undefined,
    revokeSession: async () => undefined,
    setMessagingReach: () => {},
    setRunbooksHostState: () => {},
  },
}));

/** The host's own Codex reading; nothing here spawns a Codex app server. */
const codexQuota = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../services/codex/CodexQuotaService.js", () => ({
  readCodexQuota: codexQuota.read,
}));

/**
 * The app database both the host's exchange store and this Shell's journal
 * use. Host and Shell share one process here, as they share one file; their
 * tables are apart. A file on disk, so a restart reopens what was written.
 */
const db = vi.hoisted(() => ({ sqlite: null as import("better-sqlite3").Database | null }));
vi.mock("../../services/persistence/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/persistence/db.js")>()),
  getSharedSqlite: () => db.sqlite,
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { assistantSlotKey } from "../../../shared/config/assistantSlots.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { openDb } from "../../services/persistence/db.js";
import { AppError } from "../../utils/errorTypes.js";
import { AssistantExchangeClient } from "../assistant/AssistantExchangeClient.js";
import { OPEN_LANE_GENERATION } from "../assistant/AssistantMessagingPolicy.js";
import { AssistantLinkMethod, type AssistantSendPayload } from "../assistant/linkMethods.js";
import { LinkClient } from "../client/LinkClient.js";
import { createDirectTransport } from "../client/transport.js";
import { AssistantExchangeJournal } from "../exchange/AssistantExchangeJournal.js";
import { AssistantExchangeStore } from "../exchange/AssistantExchangeStore.js";
import { getLocalHandshakeInfo } from "../handshakeInfo.js";
import { hostSocketLocation } from "../host/hostSocketPath.js";
import type { LinkSession } from "../link/session.js";
import { requireRemoteService } from "../runtime.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../services/persistence/migrations");
const TEST_TIMEOUT_MS = 60_000;
const SHELL_B = "shell-b";

let h: RemoteHarness | null = null;
let dir: string;
const cleanups: Array<() => unknown> = [];
const opened: Database.Database[] = [];

function openFile(name: string): Database.Database {
  const sqlite = openDb(path.join(dir, name), migrationsFolder).sqlite;
  opened.push(sqlite);
  return sqlite;
}

function closeAll(): void {
  for (const sqlite of opened.splice(0)) if (sqlite.open) sqlite.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-exchanges-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
  db.sqlite = null;
  lanes.clear();
  closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function harness(): Promise<RemoteHarness> {
  h = await startRemoteHarness();
  await h.connect();
  return h;
}

async function restartHarness(): Promise<RemoteHarness> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
  return harness();
}

/**
 * Assistants running on the host, this Shell's hub enrolled on itself, and
 * messaging to the host turned on. Proj-2's slots are the host's lanes.
 */
function prepare(r: RemoteHarness): void {
  (r.pty.client as unknown as { getLiveGeneration(id: string): number }).getLiveGeneration = () =>
    1;
  for (const [projectId, slot] of [
    ["proj-1", 0],
    ["proj-2", 0],
    ["proj-2", 1],
  ] as const) {
    const sessionId = `help-${projectId}-${slot}`;
    lanes.set(`${projectId}#${slot}`, {
      sessionId,
      terminalId: `t-${sessionId}`,
      projectViewWebContentsId: 1,
    });
  }
  const shell = requireRemoteService("assistantMessagingPolicy");
  expect(shell.enroll({ projectId: "proj-1", slot: 0 }, { kind: "local" }).ok).toBe(true);
  harnessState.client!.registry.update({ hostId: HOST_ID, assistantMessagingEnabled: true });
}

/** The host's link session id for a Shell, as only the host knows it. */
function hostSessionOf(r: RemoteHarness, clientId: string | null): string {
  const ctx = r
    .server()
    .sessions.find((s) =>
      clientId === null ? s.client.clientId !== SHELL_B : s.client.clientId === clientId
    );
  if (!ctx) throw new Error(`no host session for ${clientId ?? "this Shell"}`);
  return ctx.sessionId;
}

/** What a person does on the host: let one Shell's session reach a lane. */
function enrollOnHost(linkSessionId: string, slot: number): string {
  const result = requireRemoteService("assistantMessagingPolicy").enroll(
    { projectId: "proj-2", slot },
    { kind: "remote", linkSessionId }
  );
  if (!result.ok) throw new Error(`enroll refused: ${result.reason}`);
  return result.enrollment.generation;
}

function message(overrides: Partial<AssistantSendPayload> = {}): AssistantSendPayload {
  return {
    messageId: "m-1",
    contextId: "ctx-1",
    referenceTaskIds: [],
    projectId: "proj-2",
    slot: 0,
    generation: "unset",
    body: "please rebase the release branch",
    ...overrides,
  };
}

interface ShellB {
  client: AssistantExchangeClient;
  journal: AssistantExchangeJournal;
  link: LinkClient;
  /** While set, the next SEND reaches the host and its answer is lost on the way back. */
  loseNextSendAnswer: boolean;
  /** While set, the host's change announcements reach Shell B and are dropped. */
  deaf: boolean;
}

/**
 * A second Shell on the same host over its own link, with its own journal.
 * It claims this Shell's machine name and device id: a claim is not who it is.
 */
async function startShellB(r: RemoteHarness, journalDb: Database.Database): Promise<ShellB> {
  const discoveryPath = hostSocketLocation({
    platform: "darwin",
    userDataDir: path.join(r.dir, "host"),
  }).discoveryPath;
  const mine = r.server().sessions.find((s) => s.client.clientId !== SHELL_B)!.client;
  const link = new LinkClient({
    hostId: HOST_ID,
    transport: createDirectTransport({ discoveryPath }),
    handshake: getLocalHandshakeInfo(),
    client: {
      clientId: SHELL_B,
      clientName: mine.clientName,
      platform: mine.platform,
      ...(mine.deviceId ? { deviceId: mine.deviceId } : {}),
    },
  });
  const listeners = new Set<(hostId: string, session: LinkSession) => void>();
  const deafened = (session: LinkSession): LinkSession =>
    new Proxy(session, {
      get(target, key, receiver) {
        if (key !== "registerCallHandler") return Reflect.get(target, key, receiver) as unknown;
        return (method: string, schema: never, handler: (payload: unknown) => unknown) =>
          target.registerCallHandler(method, schema, (payload: unknown) =>
            method === AssistantLinkMethod.EXCHANGE_CHANGED && shell.deaf ? null : handler(payload)
          );
      },
    });
  link.onSession(({ session }) => {
    for (const listener of listeners) listener(HOST_ID, deafened(session));
  });
  const journal = new AssistantExchangeJournal(journalDb);
  const shell: ShellB = {
    client: null as never,
    journal,
    link,
    loseNextSendAnswer: false,
    deaf: false,
  };
  const lossy = (session: LinkSession): LinkSession =>
    new Proxy(session, {
      get(target, key, receiver) {
        if (key !== "call") return Reflect.get(target, key, receiver) as unknown;
        return async (method: string, payload: unknown, options?: object) => {
          const answer = await target.call(method, payload, options);
          if (method === AssistantLinkMethod.SEND && shell.loseNextSendAnswer) {
            shell.loseNextSendAnswer = false;
            throw new AppError({ code: "OUTCOME_UNKNOWN", message: "answer lost on the way back" });
          }
          return answer;
        };
      },
    });
  shell.client = new AssistantExchangeClient({
    journal,
    session: async () => (link.session ? lossy(link.session) : null),
    onSessionOpened: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  shell.client.start();
  link.start();
  await waitUntil(() => link.session?.isOpen === true, "Shell B's session");
  cleanups.push(async () => {
    shell.client.dispose();
    await link.stop();
  });
  return shell;
}

function shellA(): AssistantExchangeClient {
  return requireRemoteService("assistantExchangeClient");
}

describe("assistant exchanges over the real link", () => {
  it("hands the hub the host's Codex quota as the host read it (#13392)", async () => {
    db.sqlite = openFile("app.db");
    const r = await harness();
    prepare(r);
    const reading = {
      status: "ok",
      planType: "pro",
      windows: [
        { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_700_000_000_000 },
        { usedPercent: 7.5, windowDurationMins: 10_080, resetsAt: null },
      ],
      fetchedAt: 1_699_999_000_000,
    };
    codexQuota.read.mockResolvedValueOnce(reading);
    await expect(shellA().readQuota(HOST_ID)).resolves.toEqual(reading);

    const unavailable = { status: "unavailable", reason: "read-failed", fetchedAt: 1 };
    codexQuota.read.mockResolvedValueOnce(unavailable);
    await expect(shellA().readQuota(HOST_ID)).resolves.toEqual(unavailable);
    expect(codexQuota.read).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("routes nothing it can't show it started, and never a lane another Shell holds (#13392)", async () => {
    db.sqlite = openFile("app.db");
    const r = await harness();
    prepare(r);
    const a = shellA();
    const policy = requireRemoteService("assistantMessagingPolicy");
    await expect(
      a.enrollStarted(HOST_ID, { projectId: "proj-2", slot: 1, sessionId: "not-that-run" })
    ).resolves.toEqual({ status: "wrong-session", lane: null });

    // The right session id, but that run wasn't started through one of this Shell's views:
    // its own messages never come here, though this Shell can message it like any (#13467).
    await expect(
      a.enrollStarted(HOST_ID, { projectId: "proj-2", slot: 1, sessionId: "help-proj-2-1" })
    ).resolves.toEqual({ status: "wrong-session", lane: null });
    const listed = await a.listLanes(HOST_ID);
    expect(listed.lanes).toEqual([]);
    expect(listed.open).toContainEqual(
      expect.objectContaining({ projectId: "proj-2", slot: 1, generation: OPEN_LANE_GENERATION })
    );
    expect(policy.getEnrollment({ projectId: "proj-2", slot: 1 })).toBeNull();

    // Slot 0's own messages go to another Shell's session: never taken.
    enrollOnHost("another-shell-session", 0);
    await expect(
      a.enrollStarted(HOST_ID, { projectId: "proj-2", slot: 0, sessionId: "help-proj-2-0" })
    ).resolves.toEqual({ status: "occupied", lane: null });
    expect(policy.getEnrollment({ projectId: "proj-2", slot: 0 })?.enrolledBy).toEqual({
      kind: "remote",
      linkSessionId: "another-shell-session",
    });
  }, 30_000);

  it(
    "hands a message to the lane's inbox and the lane's reply back to the Shell (#13336)",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      const generation = enrollOnHost(hostSessionOf(r, null), 0);
      const sent = await shellA().send(HOST_ID, message({ generation }));
      if (sent.status !== "accepted") throw new Error("not accepted");

      const lane = requireRemoteService("assistantMessagingRuntime");
      const inbox = lane.getInbox("help-proj-2-0", {});
      if (!inbox.ok) throw new Error(`inbox refused: ${inbox.code}`);
      expect(inbox.value.messages).toHaveLength(1);
      expect(inbox.value.messages[0]).toMatchObject({
        taskId: sent.record.taskId,
        messageId: "m-1",
        provenance: { sendingLane: "hub", hopCount: 1 },
      });
      expect(inbox.value.messages[0]!.untrustedBody).toContain("please rebase the release branch");
      // Only the lane it was addressed to reads it.
      const sibling = lane.getInbox("help-proj-2-1", {});
      expect(sibling.ok && sibling.value.messages).toEqual([]);

      expect(
        lane.reply("help-proj-2-0", {
          taskId: sent.record.taskId,
          state: "completed",
          text: "rebased onto develop",
        }).ok
      ).toBe(true);
      expect(await shellA().getResponses(HOST_ID, "m-1")).toEqual([
        { state: "completed", text: "rebased onto develop", at: expect.any(Number) },
      ]);
      expect((await shellA().get(HOST_ID, "m-1"))?.state).toBe("completed");
      // Another Shell, authenticated as another sender, reads none of this exchange's replies.
      const b = await startShellB(r, openFile("shell-b.db"));
      expect(await b.client.getResponses(HOST_ID, "m-1")).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "lists, sends, reads, lists changes and cancels with no window bound to the host",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      const generation = enrollOnHost(hostSessionOf(r, null), 0);
      expect(getEndpointRegistry().getRemote()).toHaveLength(0);

      const a = shellA();
      // Over the real link: every running lane is open to this Shell, under its stable
      // address and naming its agent (#13467).
      const listed = await a.listLanes(HOST_ID);
      const lane0 = {
        projectId: "proj-2",
        slot: 0,
        generation: OPEN_LANE_GENERATION,
        available: true,
        agentId: "claude",
      };
      expect(listed.open!.map((lane) => assistantSlotKey(lane.projectId, lane.slot))).toEqual(
        listed.assistants!.map((lane) => assistantSlotKey(lane.projectId, lane.slot))
      );
      expect(listed.open).toContainEqual(lane0);
      // What an older Shell reads, and owns: the lanes whose own messages come to it.
      expect(listed.lanes).toEqual([lane0]);
      expect(listed.assistants).toContainEqual({ projectId: "proj-2", slot: 0, agentId: "claude" });

      // An older Shell names the generation it was enrolled under: filed at the open address.
      const sent = await a.send(HOST_ID, message({ generation }));
      expect(sent).toMatchObject({
        status: "accepted",
        disposition: "created",
        record: {
          messageId: "m-1",
          state: "submitted",
          receiver: {
            laneId: assistantSlotKey("proj-2", 0),
            enrollmentGeneration: OPEN_LANE_GENERATION,
          },
        },
      });
      if (sent.status !== "accepted") return;
      // Who sent it is the host's derivation of this Shell's credential, never anything it said.
      expect(sent.record.senderId).toMatch(/^[0-9a-f]{64}$/);

      const again = await a.send(HOST_ID, message({ generation }));
      expect(again).toMatchObject({
        disposition: "existing",
        record: { taskId: sent.record.taskId },
      });
      expect((await a.get(HOST_ID, "m-1"))?.taskId).toBe(sent.record.taskId);
      expect(await a.get(HOST_ID, "never-sent")).toBeNull();

      const changes = await a.listChanges(HOST_ID, 0);
      expect(changes.records.map((record) => record.messageId)).toEqual(["m-1"]);
      expect(await a.listChanges(HOST_ID, changes.cursor)).toMatchObject({ records: [] });

      // Nothing has left for the lane yet, so canceling cancels.
      expect(await a.cancel(HOST_ID, "m-1")).toMatchObject({ state: "canceled" });
      const next = await a.listChanges(HOST_ID, changes.cursor);
      expect(next.records.map((record) => record.state)).toEqual(["canceled"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "tells the sending Shell when its exchange changes on the host, and wakes its hub",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      const b = await startShellB(r, openFile("shell-b.db"));
      const generation = enrollOnHost(hostSessionOf(r, null), 0);
      const a = shellA();
      const wake = vi.spyOn(requireRemoteService("assistantLaneWaker"), "wake");
      const sent = await a.send(HOST_ID, message({ generation }));
      if (sent.status !== "accepted") throw new Error("not accepted");
      // Authenticated as itself, on the same host.
      await b.client.listChanges(HOST_ID, 0);

      // The receiving lane's own tools write through a store of their own.
      new AssistantExchangeStore(db.sqlite).recordDelivery(
        { kind: "receiver", ...sent.record.receiver },
        { senderId: sent.record.senderId, messageId: "m-1" },
        "reply-received",
        { body: "done" }
      );

      const journal = new AssistantExchangeJournal(db.sqlite!);
      await waitUntil(
        () => journal.get(HOST_ID, "m-1")?.record?.state === "completed",
        "the journal to hear of the reply"
      );
      const hub = requireRemoteService("assistantMessagingPolicy").getHub()!;
      expect(wake).toHaveBeenCalledWith(
        expect.objectContaining({
          lane: { projectId: hub.projectId, slot: hub.slot },
          generation: hub.generation,
          shell: { kind: "local" },
          exchangeId: sent.record.taskId,
          kind: "update",
        })
      );
      // Another Shell on the same host hears nothing of it.
      expect(b.journal.list(HOST_ID)).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "keeps two Shells on one host apart, even when one claims to be the other",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      const b = await startShellB(r, openFile("shell-b.db"));
      const laneA = enrollOnHost(hostSessionOf(r, null), 0);
      const a = shellA();

      // Both reach the lane whichever Shell started it (#13467); only A hears from it.
      const routed = async (client: AssistantExchangeClient) =>
        (await client.listLanes(HOST_ID)).lanes.some(
          (lane) => lane.projectId === "proj-2" && lane.slot === 0
        );
      expect(await routed(a)).toBe(true);
      expect(await routed(b.client)).toBe(false);

      // The same messageId from each, to the same assistant at once, is two exchanges, one each.
      const fromA = await a.send(HOST_ID, message({ generation: laneA }));
      const fromB = await b.client.send(HOST_ID, message({ generation: OPEN_LANE_GENERATION }));
      if (fromA.status !== "accepted" || fromB.status !== "accepted")
        throw new Error("not accepted");
      expect(fromA.disposition).toBe("created");
      expect(fromB.disposition).toBe("created");
      expect(fromB.record.taskId).not.toBe(fromA.record.taskId);
      expect(fromB.record.senderId).not.toBe(fromA.record.senderId);

      // Each reads, lists and cancels only its own.
      expect((await b.client.get(HOST_ID, "m-1"))?.taskId).toBe(fromB.record.taskId);
      expect(
        (await b.client.listChanges(HOST_ID, 0)).records.map((record) => record.taskId)
      ).toEqual([fromB.record.taskId]);
      await b.client.cancel(HOST_ID, "m-1");
      expect(await a.get(HOST_ID, "m-1")).toMatchObject({
        taskId: fromA.record.taskId,
        state: "submitted",
        cancelRequestedAt: null,
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "resolves a send whose answer was lost by looking its messageId up, never by sending it again",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      const b = await startShellB(r, openFile("shell-b.db"));
      const generation = enrollOnHost(hostSessionOf(r, SHELL_B), 1);
      const payload = message({ messageId: "lost", slot: 1, generation });
      // Only a lookup settles a lost answer here, not a change the host announces.
      b.deaf = true;

      b.loseNextSendAnswer = true;
      expect(await b.client.send(HOST_ID, payload)).toEqual({
        status: "unknown",
        messageId: "lost",
      });
      expect(b.journal.unresolved(HOST_ID)).toEqual(["lost"]);

      // Sent again by whoever asked: the host's record answers, nothing new is created.
      const resent = await b.client.send(HOST_ID, payload);
      expect(resent).toMatchObject({ status: "accepted", disposition: "existing" });
      expect(b.journal.unresolved(HOST_ID)).toEqual([]);
      const onHost = (await b.client.listChanges(HOST_ID, 0)).records.filter(
        (record) => record.messageId === "lost"
      );
      expect(onHost).toHaveLength(1);

      // The same id for a different message is refused, and the journal keeps what the host took.
      await expect(
        b.client.send(HOST_ID, { ...payload, body: "something else entirely" })
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(b.journal.get(HOST_ID, "lost")?.record?.taskId).toBe(onHost[0]!.taskId);

      // The link drops; the next session settles the rest as it opens: one the
      // host has, and one it never got.
      b.loseNextSendAnswer = true;
      await b.client.send(HOST_ID, { ...payload, messageId: "lost-2" });
      b.journal.noteSending(HOST_ID, "never-arrived");
      await b.link.stop();
      b.link.start();
      await waitUntil(
        () => b.journal.unresolved(HOST_ID).length === 0,
        "Shell B's next session to settle its unresolved sends"
      );
      expect(b.journal.get(HOST_ID, "lost-2")?.record?.state).toBe("submitted");
      expect(b.journal.get(HOST_ID, "never-arrived")).toBeNull();
      expect(b.journal.cursor(HOST_ID)).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "keeps every exchange, and whose it is, across a restart of both Shells and the host",
    async () => {
      db.sqlite = openFile("app.db");
      let r = await harness();
      prepare(r);
      let b = await startShellB(r, openFile("shell-b.db"));
      const laneA = enrollOnHost(hostSessionOf(r, null), 0);
      const fromA = await shellA().send(HOST_ID, message({ generation: laneA }));
      const fromB = await b.client.send(
        HOST_ID,
        message({ slot: 1, generation: OPEN_LANE_GENERATION })
      );
      if (fromA.status !== "accepted" || fromB.status !== "accepted")
        throw new Error("not accepted");
      await shellA().reconcile(HOST_ID);
      const cursorBefore = new AssistantExchangeJournal(db.sqlite).cursor(HOST_ID);
      expect(cursorBefore).toBeGreaterThan(0);

      // Everything stops; only what's on disk survives.
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      await h?.dispose();
      h = null;
      // Each lane's wake is typed while neither Shell is connected: changes they
      // have yet to hear of.
      const store = new AssistantExchangeStore(db.sqlite);
      for (const { record } of [fromA, fromB]) {
        store.recordDelivery(
          { kind: "receiver", ...record.receiver },
          { senderId: record.senderId, messageId: record.messageId },
          "wake-typed"
        );
      }
      closeAll();
      db.sqlite = openFile("app.db");
      r = await restartHarness();
      prepare(r);
      b = await startShellB(r, openFile("shell-b.db"));

      const a = shellA();
      // Each Shell's new session read on from its saved cursor as it opened, with no call made.
      const journalA = new AssistantExchangeJournal(db.sqlite);
      await waitUntil(
        () =>
          journalA.get(HOST_ID, "m-1")?.record?.delivery.wakeTypedAt != null &&
          b.journal.get(HOST_ID, "m-1")?.record?.delivery.wakeTypedAt != null,
        "both Shells to reconcile as their sessions open"
      );
      expect(journalA.cursor(HOST_ID)).toBeGreaterThan(cursorBefore);
      expect(journalA.get(HOST_ID, "m-1")?.record?.taskId).toBe(fromA.record.taskId);
      expect(b.journal.get(HOST_ID, "m-1")?.record?.taskId).toBe(fromB.record.taskId);
      expect(await a.get(HOST_ID, "m-1")).toMatchObject({ taskId: fromA.record.taskId });
      expect(await b.client.get(HOST_ID, "m-1")).toMatchObject({ taskId: fromB.record.taskId });

      // Nothing to redo after the restart (#13467): the lanes are open again as they run,
      // a new message under the address it was listed goes through, and a resend of one
      // already taken still answers from its record.
      expect((await a.listLanes(HOST_ID)).open).toContainEqual(
        expect.objectContaining({ projectId: "proj-2", slot: 0, available: true })
      );
      expect(await a.send(HOST_ID, message({ messageId: "m-2", generation: laneA }))).toMatchObject(
        { status: "accepted", disposition: "created" }
      );
      expect(await a.send(HOST_ID, message({ generation: laneA }))).toMatchObject({
        disposition: "existing",
        record: { taskId: fromA.record.taskId },
      });

      // Still apart: B's cancel reaches only B's exchange, and with its wake
      // already typed it is a recorded request, not a cancellation.
      await b.client.cancel(HOST_ID, "m-1");
      expect(await a.get(HOST_ID, "m-1")).toMatchObject({ cancelRequestedAt: null });
      const canceled = await b.client.get(HOST_ID, "m-1");
      expect(canceled?.state).toBe("submitted");
      expect(canceled?.cancelRequestedAt).not.toBeNull();
    },
    TEST_TIMEOUT_MS
  );

  it(
    "knows a sender only by the credential its session presented, never by anything in a payload",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      const generation = enrollOnHost(hostSessionOf(r, null), 0);
      const fromA = await shellA().send(HOST_ID, message({ generation }));
      if (fromA.status !== "accepted") throw new Error("not accepted");
      const b = await startShellB(r, openFile("shell-b.db"));
      const raw = b.link.session!;
      const call = (method: string, payload: unknown) => raw.call(method, payload);

      // Unauthenticated, nothing answers.
      for (const [method, payload] of [
        [AssistantLinkMethod.SEND, message({ slot: 1, generation: "g" })],
        [AssistantLinkMethod.GET_EXCHANGE, { messageId: "m-1" }],
        [AssistantLinkMethod.LIST_EXCHANGES, { cursor: 0 }],
        [AssistantLinkMethod.CANCEL_EXCHANGE, { messageId: "m-1" }],
      ] as const) {
        await expect(call(method, payload)).rejects.toMatchObject({ code: "PERMISSION" });
      }
      // Naming a sender, even A's own, is not a way in.
      await expect(
        call(AssistantLinkMethod.GET_EXCHANGE, {
          messageId: "m-1",
          senderId: fromA.record.senderId,
        })
      ).rejects.toMatchObject({ code: "VALIDATION" });

      const mine = "b".repeat(43);
      await call(AssistantLinkMethod.AUTHENTICATE, { credential: mine });
      await call(AssistantLinkMethod.AUTHENTICATE, { credential: mine });
      await expect(
        call(AssistantLinkMethod.AUTHENTICATE, { credential: "c".repeat(43) })
      ).rejects.toMatchObject({ code: "PERMISSION" });
      expect(await call(AssistantLinkMethod.GET_EXCHANGE, { messageId: "m-1" })).toBeNull();
      expect(await call(AssistantLinkMethod.LIST_EXCHANGES, { cursor: 0 })).toMatchObject({
        records: [],
      });
      await expect(
        call(AssistantLinkMethod.CANCEL_EXCHANGE, { messageId: "m-1" })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await shellA().get(HOST_ID, "m-1")).toMatchObject({ cancelRequestedAt: null });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "reads a host without these calls as not supporting assistant messaging, not as a failure",
    async () => {
      // No database on the host side: nothing is registered, as on a host from before.
      db.sqlite = null;
      const r = await harness();
      const b = await startShellB(r, openFile("shell-b.db"));

      const sent = b.client.send(HOST_ID, message({ generation: "gen" }));
      await expect(sent).rejects.toBeInstanceOf(AppError);
      await expect(sent).rejects.toMatchObject({
        code: "UNSUPPORTED",
        userMessage: "This host doesn't support assistant messaging.",
      });
      expect(b.journal.list(HOST_ID)).toEqual([]);
      await expect(b.client.reconcile(HOST_ID)).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS
  );

  it(
    "lets a host's lane message this Shell's hub and reads the hub's reply back (#13338)",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      enrollOnHost(hostSessionOf(r, null), 0);
      const runtime = requireRemoteService("assistantMessagingRuntime");
      // The hub has the inbox tools but no hub of its own to write to.
      expect(runtime.isSendAvailable("help-proj-1-0")).toBe(false);
      expect(runtime.isSendAvailable("help-proj-2-0")).toBe(true);

      const sent = runtime.sendMessage("help-proj-2-0", {
        text: "migration landed on feature/x, studio-04 can start",
      });
      if (!sent.ok) throw new Error(`send refused: ${sent.code}`);
      expect(sent.value).toMatchObject({ hopCount: 1, state: "waiting-for-hub" });

      const hubInbox = () => {
        const inbox = runtime.getInbox("help-proj-1-0", {});
        if (!inbox.ok) throw new Error(`hub inbox refused: ${inbox.code}`);
        return inbox.value.messages;
      };
      await waitUntil(() => hubInbox().length === 1, "the message in the hub's inbox");
      const [message] = hubInbox();
      expect(message).toMatchObject({
        messageId: sent.value.messageId,
        contextId: sent.value.contextId,
        provenance: { sendingLane: "slot 0 of project proj-2", hopCount: 1 },
      });
      expect(message!.untrustedBody).toContain("studio-04 can start");
      // The host lane's own inbox is untouched: this went to the hub only.
      const own = runtime.getInbox("help-proj-2-0", {});
      expect(own.ok && own.value.messages).toEqual([]);

      expect(
        runtime.reply("help-proj-1-0", {
          taskId: message!.taskId,
          state: "completed",
          text: "thanks, starting studio-04",
        }).ok
      ).toBe(true);
      const sentView = () => {
        const page = runtime.getInbox("help-proj-2-0", { view: "sent" });
        if (!page.ok) throw new Error(`sent view refused: ${page.code}`);
        return page.value.sent ?? [];
      };
      await waitUntil(() => sentView()[0]?.state === "completed", "the hub's reply on the host");
      expect(sentView()[0]!.replies).toHaveLength(1);
      expect(sentView()[0]!.replies[0]!.untrustedText).toContain("thanks, starting studio-04");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "holds a host lane's message while its Shell is away and delivers it on resume (#13338)",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      enrollOnHost(hostSessionOf(r, null), 0);
      const runtime = requireRemoteService("assistantMessagingRuntime");
      await r.dropLink();

      const sent = runtime.sendMessage("help-proj-2-0", {
        text: "blocked: need a schema decision",
      });
      if (!sent.ok) throw new Error(`send refused: ${sent.code}`);
      const state = () => {
        const page = runtime.getInbox("help-proj-2-0", { view: "sent" });
        return page.ok ? page.value.sent?.[0]?.state : undefined;
      };
      expect(state()).toBe("waiting-for-hub");
      const hubInbox = runtime.getInbox("help-proj-1-0", {});
      expect(hubInbox.ok && hubInbox.value.messages).toEqual([]);

      await r.restoreLink();
      await waitUntil(() => state() === "submitted", "delivery once the Shell is back");
      const delivered = runtime.getInbox("help-proj-1-0", {});
      expect(delivered.ok && delivered.value.messages.map((m) => m.messageId)).toEqual([
        sent.value.messageId,
      ]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "refuses a host lane's message with the host's messaging switched off on this Shell (#13338)",
    async () => {
      db.sqlite = openFile("app.db");
      const r = await harness();
      prepare(r);
      enrollOnHost(hostSessionOf(r, null), 0);
      harnessState.client!.registry.update({ hostId: HOST_ID, assistantMessagingEnabled: false });
      const runtime = requireRemoteService("assistantMessagingRuntime");
      const sent = runtime.sendMessage("help-proj-2-0", { text: "hello" });
      if (!sent.ok) throw new Error(`send refused: ${sent.code}`);
      await waitUntil(() => {
        const page = runtime.getInbox("help-proj-2-0", { view: "sent" });
        return page.ok && page.value.sent?.[0]?.state === "refused";
      }, "the Shell's refusal on the host");
      const page = runtime.getInbox("help-proj-2-0", { view: "sent" });
      expect(page.ok && page.value.sent?.[0]?.refusal).toBe("opted_out");
    },
    TEST_TIMEOUT_MS
  );
});
