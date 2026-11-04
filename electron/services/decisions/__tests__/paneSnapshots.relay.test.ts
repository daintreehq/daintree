import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKeyStore,
  MemoryLocalStore,
  loadIdentity,
  type QuestionOrigin,
  type StoredIdentity,
  type WebSocketLike,
} from "@daintreehq/decisions-client";
import {
  decryptEnvelope,
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import {
  bytesToBase64Url,
  type PaneSnapshotBody,
  type PaneSnapshotContentV1,
} from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
  safeStorage: {},
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));
vi.mock("../../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));

import { defaultDecisionsSettings } from "../decisionsSettings.js";
import type { PaneSnapshotPtyClient } from "../paneSnapshots.js";
import { QuestionBridge } from "../questionBridge.js";
import { RelayConnection, type QuestionSource, type RelayBinding } from "../relayConnection.js";
import { createTrustedPolicy } from "../workflowGates.js";

/**
 * Terminal snapshots (#16230) end to end on this side of the relay: the
 * real connection, 0.4.0 bridge, crypto and coalescing, with only the relay
 * and the pane faked. What the relay is sent is opened with the epoch key, as
 * a phone would open it.
 */

const RELAY: RelayBinding = {
  relayOrigin: "https://decisions.example.workers.dev",
  installationId: "inst_12345678",
  deviceId: "dev_12345678",
};

const ORIGIN: QuestionOrigin = {
  host_id: "host_a",
  pane_id: "pane-1",
  terminal_generation: 1,
  ownership_principal: "principal-1",
  agent_incarnation: "0",
  agent_kind: "claude",
  agent_session_id: null,
  project_id: "p1",
  worktree_id: "wt-1",
  worktree_root: "/repo",
  workflow_gate_id: null,
};

type Frame = Record<string, unknown>;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;

  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
      this.frame({
        t: "hello",
        protocol_version: 1,
        device_id: RELAY.deviceId,
        role: "owner-desktop",
        key_epoch: 1,
        high_water: 0,
        server_time: new Date().toISOString(),
      });
    });
  }

  send(data: string): void {
    if (this.readyState !== 1 || data === "ping") return;
    const frame = JSON.parse(data) as Frame;
    if (frame.t === "sync") this.frame({ t: "caught_up", high_water: 0, has_more: false });
  }

  close(): void {
    this.readyState = 3;
  }

  private frame(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A relay that implements pane snapshots, keeping every snapshot it is sent. */
function fakeRelay() {
  const tickets: unknown[] = [];
  const questions: string[] = [];
  const snapshots: Array<{ questionId: string; body: PaneSnapshotBody }> = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    if (method === "POST" && pathname === "/api/v1/socket-ticket") {
      tickets.push(body);
      return json(200, {
        ticket: `ticket-${tickets.length}`,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        ws_path: "/api/v1/socket",
      });
    }
    if (method === "POST" && pathname === "/api/v1/questions") {
      questions.push((body as { idempotency_key: string }).idempotency_key);
      return json(200, { event_seq: questions.length });
    }
    if (method === "GET" && pathname === "/api/v1/info") {
      return json(200, {
        name: "daintree-decisions",
        protocol_min: 1,
        protocol_max: 1,
        worker_version: "0.4.0",
        claimed: true,
        claim_configured: true,
        voice: { xai: false, anthropic: false, openai: false },
        features: ["pane-snapshots-v1"],
      });
    }
    const snapshot = /^\/api\/v1\/questions\/([^/]+)\/snapshot$/.exec(pathname);
    if (method === "PUT" && snapshot) {
      snapshots.push({ questionId: snapshot[1]!, body: body as PaneSnapshotBody });
      return json(200, { ok: true });
    }
    return json(404, { code: "not_found", message: "no route" });
  };
  return {
    tickets,
    questions,
    snapshots,
    fetchImpl,
    webSocket: (url: string): WebSocketLike => new FakeSocket(url),
  };
}

/** The asking pane: an agent waiting at its prompt, and main's word on its run. */
function fakePane() {
  const pane = {
    record: {
      id: ORIGIN.pane_id,
      cwd: "/repo",
      spawnedAt: 1_000,
      projectId: "p1",
      kind: "terminal",
      hasPty: true,
      launchGeneration: 1,
      agentIncarnation: 0,
      worktreeId: "wt-1",
      detectedAgentId: "claude",
      title: "Claude",
      titleMode: "default",
      agentState: "waiting",
      waitingReason: "question",
    } as Record<string, unknown>,
    screen: "Which option?\n1. Keep\n2. Drop",
    generation: 1,
  };
  const client: PaneSnapshotPtyClient = {
    getTerminalProjectId: () => "p1",
    getTerminalAsync: (async () => ({ ...pane.record })) as never,
    getSerializedStateAsync: (async () => ({ data: pane.screen, cols: 80, rows: 24 })) as never,
    getLiveGeneration: () => pane.generation,
    isLiveGeneration: (_id: string, generation: number) => generation === pane.generation,
  };
  return { pane, client };
}

async function storedIdentity(): Promise<StoredIdentity> {
  return {
    v: 1,
    config: {
      relayOrigin: RELAY.relayOrigin,
      installationId: RELAY.installationId,
      deviceId: RELAY.deviceId,
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
}

async function harness() {
  const relay = fakeRelay();
  const store = new MemoryLocalStore();
  const keys = new MemoryKeyStore();
  await keys.save(await storedIdentity());
  const epochs = (await loadIdentity(keys)).epochs;
  const { pane, client } = fakePane();
  let allowed = true;
  let onPane: ((id: string) => void) | null = null;
  let source: QuestionSource | null = null;
  const connection = new RelayConnection({
    relay: RELAY,
    store,
    keys,
    policy: createTrustedPolicy({ ...defaultDecisionsSettings(), proxyAllowlisted: false }),
    onStatus: () => {},
    onRevoked: () => {},
    onQuestionsReady: (ready) => {
      source = ready;
    },
    webSocket: relay.webSocket,
    fetchImpl: relay.fetchImpl,
    watchResume: () => () => {},
    watchNetwork: () => () => {},
    pumpIntervalMs: 0,
    snapshots: {
      allowed: () => allowed,
      hostId: () => ORIGIN.host_id,
      principalFor: () => ORIGIN.ownership_principal,
      getPtyClient: () => client,
      watchPanes: (listener) => {
        onPane = listener;
        return () => {
          onPane = null;
        };
      },
    },
  });
  connection.start();
  await vi.waitFor(() => expect(source?.live()).toBeTruthy());

  /** An agent in the pane asks, the relay takes it, and the store's rows reach the snapshots as the service feeds them. */
  const ask = async (): Promise<string> => {
    const asked = await new QuestionBridge({
      source: source!,
      isCurrent: () => true,
    }).registerQuestion({ origin: ORIGIN, input: { question: "Keep the cache?" } });
    await vi.waitFor(async () =>
      expect((await store.getQuestion(asked.questionId))?.local_status).toBe("open")
    );
    connection.observeQuestions(await store.listQuestions());
    return asked.questionId;
  };

  const opened = (index: number): Promise<PaneSnapshotContentV1> =>
    decryptEnvelope<PaneSnapshotContentV1>(relay.snapshots[index]!.body.snapshot.envelope!, epochs);

  return {
    relay,
    store,
    pane,
    connection,
    ask,
    opened,
    paneEvent: () => onPane?.(ORIGIN.pane_id),
    setAllowed: (next: boolean) => {
      allowed = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("terminal snapshots through the 0.4.0 bridge (#16230)", () => {
  // Phone images are declared beside snapshots now that Daintree stores them (#16233).
  it("declares pane snapshots to the relay, beside follow-ups and phone images", async () => {
    const h = await harness();

    const features = (h.relay.tickets[0] as { features?: string[] }).features;
    expect(features).toEqual(["pane-snapshots-v1", "phone-images-v1", "thread-messages-v1"]);
    h.connection.stop();
  });

  it("sends one encrypted snapshot per change, and only the newest of a burst", async () => {
    const h = await harness();
    const questionId = await h.ask();

    await vi.waitFor(() => expect(h.relay.snapshots).toHaveLength(1));
    const first = h.relay.snapshots[0]!;
    expect(first.questionId).toBe(questionId);
    expect(first.body.snapshot.record.sharing).toBe("on");
    expect(first.body.snapshot.envelope?.purpose).toBe("snapshot-content");
    // The relay sees ciphertext only: neither the screen nor the title goes in the clear.
    expect(JSON.stringify(first.body)).not.toContain("Which option?");
    expect(JSON.stringify(first.body)).not.toContain("Claude");
    await expect(h.opened(0)).resolves.toMatchObject({
      agent_state: "waiting",
      waiting_reason: "question",
      pane_title: "Claude",
      terminal_lines: ["Which option?", "1. Keep", "2. Drop"],
    });

    // Three changes inside the library's interval: each read replaces the one waiting.
    for (const step of ["one", "two", "three"]) {
      h.pane.screen = `Which option?\nreading ${step}`;
      h.pane.record.lastObservedTitle = `Step ${step}`;
      h.paneEvent();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(h.relay.snapshots).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(h.relay.snapshots).toHaveLength(2));
    await expect(h.opened(1)).resolves.toMatchObject({
      pane_title: "Claude: Step three",
      terminal_lines: ["Which option?", "reading three"],
    });

    // Nothing more while nothing changes.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.relay.snapshots).toHaveLength(2);
    h.connection.stop();
  });

  it("sends exited for a relaunched pane, never the new run's screen", async () => {
    const h = await harness();
    await h.ask();
    await vi.waitFor(() => expect(h.relay.snapshots).toHaveLength(1));

    h.pane.generation = 2;
    h.pane.record.launchGeneration = 2;
    h.pane.screen = "someone else's session";
    h.paneEvent();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(h.relay.snapshots).toHaveLength(2));

    const exited = await h.opened(1);
    expect(exited).toMatchObject({
      agent_state: "exited",
      terminal_lines: [],
      pane_title: "Claude",
    });
    h.connection.stop();
  });

  it("replaces what was shared with sharing off once the switch turns off", async () => {
    const h = await harness();
    await h.ask();
    await vi.waitFor(() => expect(h.relay.snapshots).toHaveLength(1));

    h.setAllowed(false);
    h.connection.snapshotsChanged();
    await vi.waitFor(() => expect(h.relay.snapshots).toHaveLength(2));

    const off = h.relay.snapshots[1]!.body.snapshot;
    expect(off.record.sharing).toBe("off");
    expect(off.envelope).toBeNull();

    h.pane.screen = "after the switch went off";
    h.paneEvent();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.relay.snapshots).toHaveLength(2);
    h.connection.stop();
  });
});
