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

vi.mock("../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    addSessionEndedListener: () => () => {},
    addSessionReattachedListener: () => () => {},
    getRunningLaneSession: () => null,
    listRunningLanes: () => [],
    getSessionLane: () => null,
    getWebContentsIdForSessionId: () => null,
    getAssistantBackends: () => [],
    helpSessionRefsForWebContentsId: () => [],
    revokeByWebContentsId: async () => undefined,
    revokeSession: async () => undefined,
    setRunbooksHostState: () => {},
  },
}));

/**
 * The app database the host's retired records live in, a file on disk so the
 * host reads what a v0.44 build of it left there.
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
import { openDb } from "../../services/persistence/db.js";
import { senderIdForCredential } from "../assistant/hostSenders.js";
import {
  AssistantLinkMethod,
  ExchangeChangesSchema,
  ExchangeRecordSchema,
  RetiredExchangeMethod,
  SendResultSchema,
} from "../assistant/linkMethods.js";
import { RETIRED_OUTCOME } from "../exchange/RetiredExchangeStore.js";
import type { LinkSession } from "../link/session.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../services/persistence/migrations");
const TEST_TIMEOUT_MS = 60_000;
/** A v0.44 Shell's sender credential for this host, and the sender it proves. */
const CREDENTIAL = "S".repeat(43);
const SENDER = senderIdForCredential(CREDENTIAL);

let h: RemoteHarness | null = null;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-retired-"));
});

afterEach(async () => {
  await h?.dispose();
  h = null;
  if (db.sqlite?.open) db.sqlite.close();
  db.sqlite = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A record as a v0.44 host wrote it, by the columns its store kept. */
function seedExchange(
  sqlite: Database.Database,
  row: { messageId: string; state: string; revision: number; senderId?: string }
): void {
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO assistant_exchanges (task_id, sender_id, message_id, context_id, reference_task_ids,
         receiver_host_id, receiver_lane_id, enrollment_generation, state, outcome, payload_digest,
         body_digest, body_bytes, created_at, updated_at, expires_at, revision, accepted_at)
       VALUES (?, ?, ?, ?, '[]', 'local', 'proj-2:0', 'open', ?, NULL, 'p', 'b', 12, ?, ?, ?, ?, ?)`
    )
    .run(
      `task-${row.messageId}`,
      row.senderId ?? SENDER,
      row.messageId,
      `ctx-${row.messageId}`,
      row.state,
      now,
      now,
      now + 24 * 60 * 60_000,
      row.revision,
      now
    );
  sqlite
    .prepare(
      "INSERT INTO assistant_exchange_clock (id, revision, min_cursor) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET revision = max(revision, excluded.revision)"
    )
    .run(row.revision);
}

function shellSession(): LinkSession {
  const session = harnessState.client!.sessionFor(HOST_ID);
  if (!session) throw new Error("no session to the host");
  return session;
}

describe("a v0.44 Shell's exchanges on an updated host (#13496)", () => {
  it(
    "reads the work the host accepted as ended, never as silently gone",
    async () => {
      db.sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
      seedExchange(db.sqlite, { messageId: "open-1", state: "working", revision: 1 });
      seedExchange(db.sqlite, { messageId: "done-1", state: "completed", revision: 2 });
      seedExchange(db.sqlite, {
        messageId: "theirs",
        state: "submitted",
        revision: 3,
        senderId: "another-shell",
      });

      h = await startRemoteHarness();
      await h.connect();
      await waitUntil(() => harnessState.client?.sessionFor(HOST_ID)?.isOpen === true, "session");
      const session = shellSession();
      await session.call(AssistantLinkMethod.AUTHENTICATE, { credential: CREDENTIAL });

      // What that Shell reads by cursor on its next session.
      const changes = ExchangeChangesSchema.parse(
        await session.call(RetiredExchangeMethod.LIST_EXCHANGES, { cursor: 0 })
      );
      const byId = new Map(changes.records.map((record) => [record.messageId, record]));
      expect([...byId.keys()].sort()).toEqual(["done-1", "open-1"]);
      expect(byId.get("open-1")).toMatchObject({ state: "failed", outcome: RETIRED_OUTCOME });
      expect(byId.get("done-1")).toMatchObject({ state: "completed", outcome: null });
      // Ended with a new revision, so a Shell already past the old one sees it end too.
      expect(byId.get("open-1")!.revision).toBeGreaterThan(3);

      const looked = ExchangeRecordSchema.parse(
        await session.call(RetiredExchangeMethod.GET_EXCHANGE, { messageId: "open-1" })
      );
      expect(looked).toMatchObject({ state: "failed", terminalAt: expect.any(Number) });
      await expect(
        session.call(RetiredExchangeMethod.GET_EXCHANGE, { messageId: "theirs" })
      ).resolves.toBeNull();
      await expect(
        session.call(RetiredExchangeMethod.GET_RESPONSES, { messageId: "open-1" })
      ).resolves.toEqual({ responses: [] });

      // A resend of what it took answers from that record; anything new is unsupported.
      const send = {
        messageId: "open-1",
        contextId: "ctx-open-1",
        referenceTaskIds: [],
        projectId: "proj-2",
        slot: 0,
        generation: "open",
        body: "please rebase the release branch",
      };
      expect(
        SendResultSchema.parse(await session.call(RetiredExchangeMethod.SEND, send))
      ).toMatchObject({ disposition: "existing", record: { state: "failed" } });
      await expect(
        session.call(RetiredExchangeMethod.SEND, { ...send, messageId: "new-1" })
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      // What the inbox's lanes and starts were is gone too.
      await expect(session.call("assistant.list-lanes", {})).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "refuses every exchange read before a sender is proven",
    async () => {
      db.sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
      seedExchange(db.sqlite, { messageId: "open-1", state: "working", revision: 1 });
      h = await startRemoteHarness();
      await h.connect();
      await waitUntil(() => harnessState.client?.sessionFor(HOST_ID)?.isOpen === true, "session");
      await expect(
        shellSession().call(RetiredExchangeMethod.GET_EXCHANGE, { messageId: "open-1" })
      ).rejects.toMatchObject({ code: "PERMISSION" });
    },
    TEST_TIMEOUT_MS
  );
});
