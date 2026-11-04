import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionOrigin, QuestionRow } from "@daintreehq/decisions-client";

vi.mock("../../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));

import {
  PaneSnapshots,
  SNAPSHOT_LINES,
  SNAPSHOTS_SHARED_META_KEY,
  WORKING_TICK_MS,
  snapshotOf,
  type PaneSnapshotPtyClient,
  type SnapshotBridge,
} from "../paneSnapshots.js";

const HOST = "host_1234";
const PANE = "pane-1";
const PRINCIPAL = "principal-1";

function origin(overrides: Partial<QuestionOrigin> = {}): QuestionOrigin {
  return {
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
    ...overrides,
  } as QuestionOrigin;
}

function row(id: string, overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    question_id: id,
    alias: 1,
    origin: origin(),
    question_revision: 0,
    local_status: "open",
    history_only: false,
    ...overrides,
  } as QuestionRow;
}

interface PaneRecordShape {
  id: string;
  cwd: string;
  spawnedAt: number;
  projectId: string;
  kind: string;
  hasPty: boolean;
  isExited?: boolean;
  launchGeneration: number;
  agentIncarnation: number;
  agentSessionId?: string;
  worktreeId: string;
  detectedAgentId?: string;
  launchAgentId?: string;
  title?: string;
  titleMode?: "default" | "user" | "custom";
  lastObservedTitle?: string;
  agentState?: string;
  waitingReason?: string;
}

/** One pane at its prompt, the screen it shows, and the run main says holds it. */
class FakePane {
  record: PaneRecordShape = {
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
  };
  screen = "Which option?\n1. Keep\n2. Drop";
  generation: number | null = 3;
  /** Runs between the screen read and the record read after it, as a relaunch would. */
  duringRead: (() => void) | null = null;
  reads = 0;

  readonly client: PaneSnapshotPtyClient = {
    getTerminalProjectId: () => this.record.projectId,
    getTerminalAsync: (async () => ({ ...this.record })) as never,
    getSerializedStateAsync: (async () => {
      this.reads++;
      const data = this.screen;
      this.duringRead?.();
      return { data, cols: 80, rows: 24 };
    }) as never,
    getLiveGeneration: () => this.generation,
    isLiveGeneration: (_id: string, generation: number) => generation === this.generation,
  };
}

function fakeBridge() {
  return {
    publishSnapshot: vi.fn(async () => "queued" as const),
    clearSnapshots: vi.fn(async () => {}),
  } satisfies SnapshotBridge;
}

function setup(options: { allowed?: boolean; rows?: QuestionRow[]; meta?: string | null } = {}) {
  const pane = new FakePane();
  let allowed = options.allowed ?? true;
  let rows = options.rows ?? [row("q1")];
  const meta = new Map<string, string>();
  if (options.meta != null) meta.set(SNAPSHOTS_SHARED_META_KEY, options.meta);
  let onPane: ((id: string) => void) | null = null;
  const watchPanes = vi.fn((listener: (id: string) => void) => {
    onPane = listener;
    return () => {
      onPane = null;
    };
  });
  const snapshots = new PaneSnapshots({
    allowed: () => allowed,
    hostId: () => HOST,
    principalFor: () => PRINCIPAL,
    getPtyClient: () => pane.client,
    watchPanes,
    store: {
      listQuestions: vi.fn(async () => rows),
      getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
      setMeta: vi.fn(async (key: string, value: string) => {
        meta.set(key, value);
      }),
    },
  });
  return {
    pane,
    snapshots,
    meta,
    watchPanes,
    setAllowed: (next: boolean) => {
      allowed = next;
    },
    setRows: (next: QuestionRow[]) => {
      rows = next;
    },
    paneEvent: (id: string) => onPane?.(id),
    listening: () => onPane !== null,
  };
}

/** What was published for each call, by question. */
function published(bridge: ReturnType<typeof fakeBridge>) {
  return bridge.publishSnapshot.mock.calls.map((call) => {
    const [questionId, input] = call as unknown as [
      string,
      { agentState: string; waitingReason: string | null; paneTitle: string; terminal: string[] },
    ];
    return { questionId, ...input };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("snapshotOf", () => {
  const base = new FakePane().record;

  it("titles the pane as its header does: a user's title, then the agent's task, then the default", () => {
    const user = snapshotOf(
      { ...base, title: "My run", titleMode: "user", lastObservedTitle: "Fix the auth tests" } as never,
      "",
      0
    );
    const task = snapshotOf(
      { ...base, title: "Claude", lastObservedTitle: "Fix the auth tests" } as never,
      "",
      0
    );
    const fallback = snapshotOf({ ...base, title: "Claude" } as never, "", 0);

    expect(user.paneTitle).toBe("My run");
    expect(task.paneTitle).toBe("Claude: Fix the auth tests");
    expect(fallback.paneTitle).toBe("Claude");
  });

  it("keeps a pane's last known title when it reports none newer", () => {
    // A pane that isn't mounted sends no observed title; the record keeps the last.
    const unmounted = snapshotOf(
      { ...base, title: "Claude", lastObservedTitle: "Write the migration" } as never,
      "",
      0
    );
    expect(unmounted.paneTitle).toBe("Claude: Write the migration");
  });

  it("redacts the whole screen before keeping its last lines, so no cut leaves part of a key", () => {
    const key = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu",
      "-----END PRIVATE KEY-----",
    ];
    // The 40-line cut lands inside the key: line 3 of the screen, its second body line.
    const filler = Array.from({ length: SNAPSHOT_LINES - 2 }, (_, i) => `line ${i}`);
    const screen = ["top", ...key, ...filler].join("\n");

    const { terminal } = snapshotOf(base as never, screen, 0);
    const text = (terminal as string[]).join("\n");

    expect(terminal.length).toBeLessThanOrEqual(SNAPSHOT_LINES);
    expect(text).not.toContain("VJTUt9Us8cKjMzEfYyjiWA4R4");
    expect(text).not.toContain("END PRIVATE KEY");
    expect(text).toContain(`line ${SNAPSHOT_LINES - 3}`);
  });

  it("redacts a secret in the title", () => {
    const leaked = snapshotOf(
      {
        ...base,
        title: "Claude",
        lastObservedTitle: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      } as never,
      "",
      0
    );
    expect(leaked.paneTitle).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("names a waiting agent's reason, and no reason for any other state", () => {
    expect(snapshotOf(base as never, "", 0)).toMatchObject({
      agentState: "waiting",
      waitingReason: "question",
    });
    expect(
      snapshotOf({ ...base, agentState: "working", waitingReason: "question" } as never, "", 0)
    ).toMatchObject({ agentState: "working", waitingReason: null });
  });
});

describe("PaneSnapshots", () => {
  async function attached(options: Parameters<typeof setup>[0] = {}) {
    const env = setup(options);
    const bridge = fakeBridge();
    env.snapshots.attach(bridge);
    await vi.advanceTimersByTimeAsync(250);
    return { ...env, bridge };
  }

  it("publishes an asking pane's state, title and screen once its bridge is up", async () => {
    const { bridge } = await attached();

    expect(published(bridge)).toEqual([
      {
        questionId: "q1",
        agentState: "waiting",
        waitingReason: "question",
        paneTitle: "Claude",
        terminal: ["Which option?", "1. Keep", "2. Drop"],
        observedAt: expect.any(Number),
      },
    ]);
    // The asker's identity goes with it, so the library checks the row is still that run's.
    expect(bridge.publishSnapshot.mock.calls[0]).toContainEqual(
      expect.objectContaining({ pane_id: PANE, terminal_generation: 3 })
    );
  });

  it("shows only the alternate screen while a TUI holds it", async () => {
    const env = setup();
    env.pane.screen = "shell history\n\x1b[?1049h\x1b[H\x1b[31mtui frame\x1b[0m\nsecond row";
    const bridge = fakeBridge();
    env.snapshots.attach(bridge);
    await vi.advanceTimersByTimeAsync(250);

    expect(published(bridge)[0]?.terminal).toEqual(["tui frame", "second row"]);
  });

  it("drops the suggestion an agent draws in its empty input box", async () => {
    const env = setup();
    env.pane.screen = "⏺ Done.\n› \x1b[2mExplain this codebase\x1b[22m";
    const bridge = fakeBridge();
    env.snapshots.attach(bridge);
    await vi.advanceTimersByTimeAsync(250);

    const text = published(bridge)[0]?.terminal.join("\n");
    expect(text).toContain("Done.");
    expect(text).not.toContain("Explain this codebase");
  });

  describe("a pane that no longer holds the run that asked", () => {
    it("publishes exited, without the screen, for a pane relaunched before it is read", async () => {
      const env = setup();
      env.pane.generation = 4;
      env.pane.record.launchGeneration = 4;
      env.pane.screen = "the new run's screen";
      const bridge = fakeBridge();
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);

      expect(published(bridge)).toEqual([
        expect.objectContaining({ agentState: "exited", terminal: [], waitingReason: null }),
      ]);
      expect(env.pane.reads).toBe(0);
    });

    it("publishes exited, never the screen it read, for a pane relaunched while being read", async () => {
      const env = setup();
      env.pane.screen = "maybe the new run's screen";
      env.pane.duringRead = () => {
        env.pane.generation = 4;
      };
      const bridge = fakeBridge();
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);

      expect(published(bridge)).toEqual([
        expect.objectContaining({ agentState: "exited", terminal: [] }),
      ]);
    });

    it("keeps the title it last read for the run that asked", async () => {
      const { pane, bridge, paneEvent } = await attached();
      pane.record.lastObservedTitle = "Pick a database";
      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);
      expect(published(bridge).at(-1)?.paneTitle).toBe("Claude: Pick a database");

      // Relaunched under a new principal: someone else's title from here on.
      pane.record.lastObservedTitle = "Another task";
      pane.generation = 4;
      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);

      expect(published(bridge).at(-1)).toMatchObject({
        agentState: "exited",
        paneTitle: "Claude: Pick a database",
        terminal: [],
      });
    });

    it("publishes exited for a pane whose process exited", async () => {
      const env = setup();
      env.pane.record.isExited = true;
      const bridge = fakeBridge();
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);

      expect(published(bridge)).toEqual([expect.objectContaining({ agentState: "exited" })]);
    });

    it("publishes nothing while the pty host can't be read, rather than invent an exit", async () => {
      const env = setup();
      env.pane.client.getTerminalAsync = (async () => null) as never;
      const bridge = fakeBridge();
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);

      expect(bridge.publishSnapshot).not.toHaveBeenCalled();
    });
  });

  describe("triggers", () => {
    it("publishes when a question is asked", async () => {
      const { snapshots, bridge } = await attached({ rows: [] });
      expect(bridge.publishSnapshot).not.toHaveBeenCalled();

      snapshots.observe([row("q2")]);
      await vi.advanceTimersByTimeAsync(250);

      expect(published(bridge).map((p) => p.questionId)).toEqual(["q2"]);
    });

    it("publishes on an agent state change, and on a waiting reason alone", async () => {
      const { pane, bridge, paneEvent } = await attached();

      pane.record.agentState = "working";
      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);
      pane.record.agentState = "waiting";
      pane.record.waitingReason = "approval";
      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);

      expect(published(bridge).map((p) => [p.agentState, p.waitingReason])).toEqual([
        ["waiting", "question"],
        ["working", null],
        ["waiting", "approval"],
      ]);
    });

    it("publishes on a retitle", async () => {
      const { pane, bridge, paneEvent } = await attached();

      pane.record.title = "Renamed";
      pane.record.titleMode = "user";
      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);

      expect(published(bridge).map((p) => p.paneTitle)).toEqual(["Claude", "Renamed"]);
    });

    it("reads events that come together once, and sends nothing for one that changed nothing", async () => {
      const { pane, bridge, paneEvent } = await attached();

      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(1);

      const before = pane.reads;
      pane.record.agentState = "working";
      paneEvent(PANE);
      paneEvent(PANE);
      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);
      expect(pane.reads).toBe(before + 1);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(2);
    });

    it("ignores events from panes nobody asked from", async () => {
      const { pane, bridge, paneEvent } = await attached();
      const before = pane.reads;

      paneEvent("pane-elsewhere");
      await vi.advanceTimersByTimeAsync(250);

      expect(pane.reads).toBe(before);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(1);
    });

    it("answers a phone's refresh with a fresh snapshot, even of a screen that hasn't changed", async () => {
      const { snapshots, bridge } = await attached();

      snapshots.refreshRequested(bridge, { questionId: "q1" } as never);
      await vi.advanceTimersByTimeAsync(250);

      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(2);
      expect(bridge.clearSnapshots).not.toHaveBeenCalled();
    });

    it("reads a working agent's pane again on each tick, and a waiting one's never", async () => {
      const { pane, bridge, paneEvent } = await attached();

      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS * 2);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(1);

      pane.record.agentState = "working";
      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS + 250);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(3);

      pane.record.agentState = "waiting";
      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS + 250);
      const settled = bridge.publishSnapshot.mock.calls.length;
      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS * 3);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(settled);
    });
  });

  describe("with snapshots off", () => {
    it("reads no pane, publishes nothing and listens to nothing", async () => {
      const { pane, bridge, watchPanes, snapshots } = await attached({ allowed: false });
      snapshots.observe([row("q1"), row("q2")]);
      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS * 2);

      expect(pane.reads).toBe(0);
      expect(bridge.publishSnapshot).not.toHaveBeenCalled();
      expect(watchPanes).not.toHaveBeenCalled();
      // Nothing was ever shared from this store, so there is nothing to take back.
      expect(bridge.clearSnapshots).not.toHaveBeenCalled();
    });

    it("answers a phone's refresh as not shared, without reading the pane", async () => {
      const { pane, bridge, snapshots } = await attached({ allowed: false });

      snapshots.refreshRequested(bridge, { questionId: "q1" } as never);
      await vi.advanceTimersByTimeAsync(250);

      expect(bridge.clearSnapshots).toHaveBeenCalledWith("q1");
      expect(pane.reads).toBe(0);
    });

    it("sends nothing a read began before the switch turned off", async () => {
      const env = setup();
      env.pane.duringRead = () => env.setAllowed(false);
      const bridge = fakeBridge();
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);

      expect(bridge.publishSnapshot).not.toHaveBeenCalled();
    });
  });

  describe("clearing", () => {
    it("takes back every question's snapshot when the switch turns off, and stops listening", async () => {
      const env = await attached();
      expect(env.listening()).toBe(true);

      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);

      expect(env.bridge.clearSnapshots).toHaveBeenCalledWith();
      expect(env.listening()).toBe(false);
      expect(env.meta.get(SNAPSHOTS_SHARED_META_KEY)).toBe("0");

      env.pane.record.agentState = "working";
      env.paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS * 2);
      expect(env.bridge.publishSnapshot).toHaveBeenCalledTimes(1);
    });

    it("takes back a question's snapshot once it is answered", async () => {
      const { snapshots, bridge } = await attached();

      snapshots.observe([row("q1", { local_status: "human-answered" })]);
      await vi.advanceTimersByTimeAsync(0);

      expect(bridge.clearSnapshots).toHaveBeenCalledWith("q1");
    });

    it("takes back a closed question's snapshot through the next bridge when none was up", async () => {
      const env = await attached();
      env.snapshots.detach(env.bridge);

      env.snapshots.observe([row("q1", { local_status: "proxy-answered" })]);
      env.setRows([row("q1", { local_status: "proxy-answered" })]);
      const next = fakeBridge();
      env.snapshots.attach(next);
      await vi.advanceTimersByTimeAsync(250);

      expect(env.bridge.clearSnapshots).not.toHaveBeenCalled();
      expect(next.clearSnapshots).toHaveBeenCalledWith("q1");
      expect(next.publishSnapshot).not.toHaveBeenCalled();
    });

    it("takes back what a run before a restart shared, when it starts with snapshots off", async () => {
      const { bridge, meta } = await attached({ allowed: false, meta: "1" });

      expect(bridge.clearSnapshots).toHaveBeenCalledWith();
      expect(meta.get(SNAPSHOTS_SHARED_META_KEY)).toBe("0");
    });

    it("records a share before it goes, so a restart knows to take it back", async () => {
      const { meta } = await attached();
      expect(meta.get(SNAPSHOTS_SHARED_META_KEY)).toBe("1");
    });

    it("lets a clear queued after a publish land after it", async () => {
      const env = await attached();
      env.pane.record.agentState = "working";
      env.paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);
      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);

      const order = [
        ...env.bridge.publishSnapshot.mock.invocationCallOrder.map((n) => [n, "publish"] as const),
        ...env.bridge.clearSnapshots.mock.invocationCallOrder.map((n) => [n, "clear"] as const),
      ]
        .sort((a, b) => a[0] - b[0])
        .map(([, kind]) => kind);
      expect(order).toEqual(["publish", "publish", "clear"]);
    });
  });

  describe("bridges", () => {
    it("sends nothing through a retired attempt's bridge", async () => {
      const env = setup();
      const old = fakeBridge();
      env.pane.duringRead = () => env.snapshots.detach(old);
      env.snapshots.attach(old);
      await vi.advanceTimersByTimeAsync(250);

      expect(old.publishSnapshot).not.toHaveBeenCalled();
    });

    it("ignores a refresh that came through a retired bridge", async () => {
      const env = await attached();
      const next = fakeBridge();
      env.snapshots.attach(next);
      await vi.advanceTimersByTimeAsync(250);
      const before = env.pane.reads;

      env.snapshots.refreshRequested(env.bridge, { questionId: "q1" } as never);
      await vi.advanceTimersByTimeAsync(250);

      expect(env.pane.reads).toBe(before);
      expect(env.bridge.clearSnapshots).not.toHaveBeenCalled();
    });

    it("publishes every asking pane again through a new bridge", async () => {
      const env = await attached();
      const next = fakeBridge();

      env.snapshots.attach(next);
      await vi.advanceTimersByTimeAsync(250);

      expect(published(next).map((p) => p.questionId)).toEqual(["q1"]);
    });

    it("stops listening and ticking when stopped", async () => {
      const env = await attached();
      env.pane.record.agentState = "working";
      env.paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);

      env.snapshots.stop();
      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS * 2);

      expect(env.listening()).toBe(false);
      expect(env.bridge.publishSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("follows only open questions this machine's panes asked", async () => {
    const { bridge } = await attached({
      rows: [
        row("q-open"),
        row("q-queued", { local_status: "queued" }),
        row("q-answered", { local_status: "human-answered" }),
        row("q-history", { history_only: true }),
        row("q-elsewhere", { origin: origin({ host_id: "host_other" }) }),
      ],
    });

    expect(published(bridge).map((p) => p.questionId)).toEqual(["q-open", "q-queued"]);
  });
});
