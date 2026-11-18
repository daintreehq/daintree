import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { OutboxItem, QuestionOrigin, QuestionRow } from "@daintreehq/decisions-client";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));
vi.mock("../../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));

import { openDb } from "../../persistence/db.js";
import { DaintreeLocalStore } from "../daintreeLocalStore.js";
import {
  PaneSnapshots,
  SNAPSHOTS_SHARED_META_KEY,
  type PaneSnapshotPtyClient,
  type SnapshotBridge,
} from "../paneSnapshots.js";

/** Terminal snapshots (#16230) over the real Decisions store, as main runs them. */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const HOST = "host_1234";
const PANE = "pane-1";
const PRINCIPAL = "principal-1";

const origin: QuestionOrigin = {
  host_id: HOST,
  pane_id: PANE,
  terminal_generation: 3,
  ownership_principal: PRINCIPAL,
  agent_incarnation: "1",
  agent_kind: "claude",
  agent_session_id: null,
  project_id: "project-1",
  worktree_id: "wt-1",
  worktree_root: "/repo",
  workflow_gate_id: null,
};

const row = (id: string, alias: number, over: Partial<QuestionRow> = {}): QuestionRow => ({
  question_id: id,
  alias,
  origin,
  requirement: "human-required",
  question_revision: 0,
  remote_event_seq: null,
  origin_created_at: "2026-11-01T00:00:00.000Z",
  expires_at: null,
  local_status: "open",
  delivery_status: "not-sent",
  last_injection_id: null,
  last_attempt_at: null,
  agent_resume_strategy: null,
  error_code: null,
  content_sealed: '{"sealed":1}',
  answers_json: "[]",
  messages_json: "[]",
  history_only: false,
  delivered_revision: 0,
  attachment_digests: [],
  ...over,
});

const item = (questionId: string): OutboxItem => ({
  id: `o-${questionId}`,
  kind: "create",
  question_id: questionId,
  payload: { n: 1 },
  attempts: 0,
  next_attempt_at: 1,
  created_at: 1,
  last_error: null,
});

/** One pane at its prompt, holding the run every question here asked from. */
const client: PaneSnapshotPtyClient = {
  getTerminalProjectId: () => "project-1",
  getTerminalAsync: (async () => ({
    id: PANE,
    cwd: "/repo",
    spawnedAt: 1_000,
    projectId: "project-1",
    kind: "terminal",
    hasPty: true,
    launchGeneration: 3,
    agentIncarnation: 1,
    worktreeId: "wt-1",
    detectedAgentId: "claude",
    launchAgentId: "claude",
    title: "Claude",
    titleMode: "default",
    agentState: "waiting",
    waitingReason: "question",
  })) as never,
  getSerializedStateAsync: (async () => ({
    data: "Which option?\n1. Keep\n2. Drop",
    cols: 80,
    rows: 24,
  })) as never,
  getLiveGeneration: () => 3,
  isLiveGeneration: (_id: string, generation: number) => generation === 3,
};

function fakeBridge() {
  return {
    publishSnapshot: vi.fn(
      async (_id: string, _input: unknown, _pane?: unknown): Promise<"queued"> => "queued"
    ),
    snapshots: { clear: vi.fn(async (_row?: QuestionRow): Promise<void> => {}) },
  } satisfies SnapshotBridge;
}

let dir: string;
let sqlite: Database.Database | undefined;
let snapshots: PaneSnapshots | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-pane-snapshots-"));
  sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
});

afterEach(() => {
  snapshots?.stop();
  snapshots = null;
  vi.restoreAllMocks();
  try {
    if (sqlite?.open) sqlite.close();
  } finally {
    sqlite = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SETTLED = [
  "human-answered",
  "proxy-answered",
  "expired",
  "cancelled",
  "publish-failed",
] as const;
const HISTORY = 250;

/**
 * A long settled history, aliases 1 to `HISTORY`, none of which decodes any
 * more: a read that mapped one of its rows would fail.
 */
async function seedHistory(store: DaintreeLocalStore): Promise<number> {
  await Promise.all(
    Array.from({ length: HISTORY }, (_, i) =>
      store.commitNewQuestion(
        row(`settled-${i}`, i + 1, { local_status: SETTLED[i % SETTLED.length] }),
        item(`settled-${i}`)
      )
    )
  );
  sqlite!
    .prepare(
      "UPDATE decisions_questions SET attachment_digests = 'not json' WHERE question_id LIKE 'settled-%'"
    )
    .run();
  return HISTORY;
}

function snapshotsOver(store: DaintreeLocalStore): PaneSnapshots {
  snapshots = new PaneSnapshots({
    allowed: () => true,
    hostId: () => HOST,
    principalFor: () => PRINCIPAL,
    getPtyClient: () => client,
    watchPanes: () => () => {},
    store,
    settleMs: 0,
  });
  return snapshots;
}

const publishedIds = (bridge: ReturnType<typeof fakeBridge>) =>
  bridge.publishSnapshot.mock.calls.map(([id]) => id);
const clearedIds = (bridge: ReturnType<typeof fakeBridge>) =>
  bridge.snapshots.clear.mock.calls.map(([cleared]) => cleared!.question_id);

describe("PaneSnapshots over the Decisions store", () => {
  it("reads only open questions when a bridge attaches, and takes back what an earlier run shared", async () => {
    const store = new DaintreeLocalStore(sqlite!);
    let alias = await seedHistory(store);
    // Shared by the run before a restart, then answered on the phone while no relay was up.
    await store.commitNewQuestion(
      row("q-shared", ++alias, { local_status: "human-answered" }),
      item("q-shared")
    );
    await store.commitNewQuestion(row("q-open", ++alias), item("q-open"));
    await store.setMeta(SNAPSHOTS_SHARED_META_KEY, JSON.stringify({ "q-shared": Date.now() }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listQuestions = vi.spyOn(store, "listQuestions");

    const bridge = fakeBridge();
    snapshotsOver(store).attach(bridge);

    await vi.waitFor(() => {
      expect(bridge.publishSnapshot).toHaveBeenCalled();
      expect(bridge.snapshots.clear).toHaveBeenCalled();
    });
    expect(listQuestions.mock.calls).toEqual([[{ status: ["queued", "open"] }]]);
    expect(publishedIds(bridge)).toEqual(["q-open"]);
    expect(bridge.publishSnapshot.mock.calls[0]![1]).toMatchObject({
      agentState: "waiting",
      terminal: ["Which option?", "1. Keep", "2. Drop"],
    });
    expect(clearedIds(bridge)).toEqual(["q-shared"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("takes back, through the next bridge, a question it shared that closed while the relay was away", async () => {
    const store = new DaintreeLocalStore(sqlite!);
    let alias = await seedHistory(store);
    await store.commitNewQuestion(row("q-shared", ++alias), item("q-shared"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paneSnapshots = snapshotsOver(store);
    const first = fakeBridge();
    paneSnapshots.attach(first);
    await vi.waitFor(() => expect(first.publishSnapshot).toHaveBeenCalled());
    paneSnapshots.detach(first);

    await store.updateQuestion("q-shared", { local_status: "human-answered" });
    await store.commitNewQuestion(row("q-open", ++alias), item("q-open"));
    const listQuestions = vi.spyOn(store, "listQuestions");
    const next = fakeBridge();
    paneSnapshots.attach(next);

    await vi.waitFor(() => {
      expect(next.publishSnapshot).toHaveBeenCalled();
      expect(next.snapshots.clear).toHaveBeenCalled();
    });
    expect(listQuestions.mock.calls).toEqual([[{ status: ["queued", "open"] }]]);
    expect(publishedIds(first)).toEqual(["q-shared"]);
    expect(clearedIds(first)).toEqual([]);
    expect(publishedIds(next)).toEqual(["q-open"]);
    expect(clearedIds(next)).toEqual(["q-shared"]);
    expect(warn).not.toHaveBeenCalled();
  });
});
