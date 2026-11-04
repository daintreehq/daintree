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
    publishSnapshot: vi.fn(
      async (_id: string, _input: unknown, _pane?: unknown): Promise<"queued"> => "queued"
    ),
    snapshots: { clear: vi.fn(async (_row?: QuestionRow): Promise<void> => {}) },
  } satisfies SnapshotBridge;
}

/** The questions whose snapshot was handed over to be cleared, in order. */
function cleared(bridge: ReturnType<typeof fakeBridge>): string[] {
  return bridge.snapshots.clear.mock.calls.map(([cleared]) => cleared!.question_id);
}

function setup(options: { allowed?: boolean; rows?: QuestionRow[]; meta?: string | null } = {}) {
  const pane = new FakePane();
  let allowed = options.allowed ?? true;
  let rows = options.rows ?? [row("q1")];
  const meta = new Map<string, string>();
  if (options.meta != null) meta.set(SNAPSHOTS_SHARED_META_KEY, options.meta);
  let writes: Promise<void> | null = null;
  let onPane: ((id: string, state?: string) => void) | null = null;
  const watchPanes = vi.fn((listener: (id: string, state?: string) => void) => {
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
      getQuestion: vi.fn(async (id: string) => rows.find((r) => r.question_id === id) ?? null),
      getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
      setMeta: vi.fn(async (key: string, value: string) => {
        await writes;
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
    paneEvent: (id: string, state?: string) => onPane?.(id, state),
    listening: () => onPane !== null,
    /** What the store records as shared. */
    shared: (): string[] =>
      Object.keys(JSON.parse(meta.get(SNAPSHOTS_SHARED_META_KEY) ?? "{}") as object).sort(),
    /** Holds the store's writes until the returned release is called. */
    holdWrites: (): (() => void) => {
      let release!: () => void;
      writes = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        writes = null;
        release();
      };
    },
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
      {
        ...base,
        title: "My run",
        titleMode: "user",
        lastObservedTitle: "Fix the auth tests",
      } as never,
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

  it("drops the suggestion an agent draws in its empty input box, by the agent's own rule", async () => {
    const env = setup();
    // Claude Code's box: not on the last row, where the generic drop looks, and its cursor cell inverted.
    env.pane.screen =
      "⏺ Done.\n\x1b[38;2;136;136;136m──────\x1b[39m\n❯ \x1b[7mm\x1b[27m\x1b[2merge #2079 when green\x1b[22m\n──────\n  ? for shortcuts";
    const bridge = fakeBridge();
    env.snapshots.attach(bridge);
    await vi.advanceTimersByTimeAsync(250);

    const text = published(bridge)[0]?.terminal.join("\n");
    expect(text).toContain("Done.");
    expect(text).toContain("? for shortcuts");
    expect(text).not.toContain("erge #2079");
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

      pane.record.waitingReason = "approval";
      paneEvent(PANE);
      await vi.advanceTimersByTimeAsync(250);
      pane.record.agentState = "working";
      paneEvent(PANE, "working");
      await vi.advanceTimersByTimeAsync(250);

      expect(published(bridge).map((p) => [p.agentState, p.waitingReason])).toEqual([
        ["waiting", "question"],
        ["waiting", "approval"],
        ["working", null],
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
      expect(cleared(bridge)).toEqual([]);
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

    it("reads again after a read the pty host didn't answer", async () => {
      const env = setup();
      let failing = true;
      env.pane.client.getTerminalAsync = (async () => {
        if (failing) throw new Error("timed out");
        return { ...env.pane.record };
      }) as never;
      const bridge = fakeBridge();
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.publishSnapshot).not.toHaveBeenCalled();

      failing = false;
      await vi.advanceTimersByTimeAsync(5_250);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(1);
    });

    it("ticks for an agent its event says works, even while its pane can't be read", async () => {
      const env = await attached();
      let failing = true;
      env.pane.client.getTerminalAsync = (async () => {
        if (failing) throw new Error("timed out");
        return { ...env.pane.record };
      }) as never;
      env.pane.record.agentState = "working";
      env.paneEvent(PANE, "working");
      // The read and every retry fail.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(env.bridge.publishSnapshot).toHaveBeenCalledTimes(1);

      failing = false;
      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS + 250);
      expect(published(env.bridge).at(-1)?.agentState).toBe("working");
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
      expect(cleared(bridge)).toEqual([]);
    });

    it("answers a phone's refresh as not shared, without reading the pane", async () => {
      const { pane, bridge, snapshots } = await attached({ allowed: false });

      snapshots.refreshRequested(bridge, { questionId: "q1" } as never);
      await vi.advanceTimersByTimeAsync(250);

      expect(cleared(bridge)).toEqual(["q1"]);
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
      expect(env.shared()).toEqual(["q1"]);

      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);

      expect(cleared(env.bridge)).toEqual(["q1"]);
      expect(env.listening()).toBe(false);

      env.pane.record.agentState = "working";
      env.paneEvent(PANE, "working");
      await vi.advanceTimersByTimeAsync(WORKING_TICK_MS * 2);
      expect(env.bridge.publishSnapshot).toHaveBeenCalledTimes(1);
    });

    it("takes back a question's snapshot once it is answered", async () => {
      const env = await attached();
      const answered = [row("q1", { local_status: "human-answered" })];

      env.setRows(answered);
      env.snapshots.observe(answered);
      await vi.advanceTimersByTimeAsync(0);

      expect(cleared(env.bridge)).toEqual(["q1"]);
    });

    it("takes nothing back for a question it never shared", async () => {
      const { snapshots, bridge } = await attached({ allowed: false });

      snapshots.observe([row("q1", { local_status: "human-answered" })]);
      await vi.advanceTimersByTimeAsync(0);

      expect(cleared(bridge)).toEqual([]);
    });

    it("takes back a closed question's snapshot through the next bridge when none was up", async () => {
      const env = await attached();
      env.snapshots.detach(env.bridge);

      env.setRows([row("q1", { local_status: "proxy-answered" })]);
      env.snapshots.observe([row("q1", { local_status: "proxy-answered" })]);
      const next = fakeBridge();
      env.snapshots.attach(next);
      await vi.advanceTimersByTimeAsync(250);

      expect(cleared(env.bridge)).toEqual([]);
      expect(cleared(next)).toEqual(["q1"]);
      expect(next.publishSnapshot).not.toHaveBeenCalled();
    });

    it("takes back what a run before a restart shared, when it starts with snapshots off", async () => {
      const env = await attached({ allowed: false, meta: JSON.stringify({ q1: Date.now() }) });

      expect(cleared(env.bridge)).toEqual(["q1"]);
    });

    it("takes back an answered question's snapshot an earlier run shared, when it starts sharing", async () => {
      const env = await attached({
        meta: JSON.stringify({ "q-answered": Date.now() }),
        rows: [row("q1"), row("q-answered", { local_status: "human-answered" })],
      });

      expect(cleared(env.bridge)).toEqual(["q-answered"]);
      expect(published(env.bridge).map((p) => p.questionId)).toEqual(["q1"]);
      expect(env.shared()).toEqual(["q-answered", "q1"]);
    });

    it("keeps a question recorded after its clear settles, since a refused clear settles too", async () => {
      const env = await attached();
      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared(env.bridge)).toEqual(["q1"]);
      expect(env.shared()).toEqual(["q1"]);

      // A restart takes it back again.
      const restarted = await attached({
        allowed: false,
        meta: env.meta.get(SNAPSHOTS_SHARED_META_KEY)!,
      });
      expect(cleared(restarted.bridge)).toEqual(["q1"]);
    });

    it("sends a clear again on its bridge once its question shared after the last one", async () => {
      const env = await attached();
      let settle!: () => void;
      env.bridge.snapshots.clear.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          })
      );
      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);

      // Shared again before that clear settled; it then settles, superseded.
      env.setAllowed(true);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(250);
      expect(env.bridge.publishSnapshot).toHaveBeenCalledTimes(2);
      settle();
      await vi.advanceTimersByTimeAsync(0);

      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared(env.bridge)).toEqual(["q1", "q1"]);
      // Settled, and kept: a refusal settles too.
      expect(env.shared()).toEqual(["q1"]);

      // That one settled with nothing shared since: answering sends nothing more on this bridge.
      const answered = [row("q1", { local_status: "human-answered" })];
      env.setRows(answered);
      env.snapshots.observe(answered);
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared(env.bridge)).toEqual(["q1", "q1"]);
    });

    it("sends a settled clear again through a new bridge, since a refusal settles too", async () => {
      const env = await attached();
      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared(env.bridge)).toEqual(["q1"]);

      const next = fakeBridge();
      env.snapshots.detach(env.bridge);
      env.snapshots.attach(next);
      await vi.advanceTimersByTimeAsync(250);

      expect(cleared(next)).toEqual(["q1"]);
    });

    it("clears a share of this run however old, since its snapshot may still wait to send", async () => {
      const env = await attached();

      await vi.advanceTimersByTimeAsync(49 * 60 * 60_000);
      const answered = [row("q1", { local_status: "human-answered" })];
      env.setRows(answered);
      env.snapshots.observe(answered);
      await vi.advanceTimersByTimeAsync(0);

      expect(cleared(env.bridge)).toEqual(["q1"]);
    });

    it("keeps the record bounded while one bridge lives", async () => {
      const env = await attached();
      const answered = [row("q1", { local_status: "human-answered" })];
      env.setRows(answered);
      env.snapshots.observe(answered);
      await vi.advanceTimersByTimeAsync(0);
      expect(env.shared()).toEqual(["q1"]);

      await vi.advanceTimersByTimeAsync(49 * 60 * 60_000);
      const asked = [...answered, row("q2")];
      env.setRows(asked);
      env.snapshots.observe(asked);
      await vi.advanceTimersByTimeAsync(250);

      expect(env.shared()).toEqual(["q2"]);
    });

    it("lets no clear settling after its entry was forgotten stand for a later share", async () => {
      const env = await attached();
      const answered = row("q1", { local_status: "human-answered" });
      env.setRows([answered]);
      env.snapshots.observe([answered]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(49 * 60 * 60_000);

      // A new bridge owes it a clear, which stays out while the entry ages out.
      const next = fakeBridge();
      let settle!: () => void;
      next.snapshots.clear.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          })
      );
      env.snapshots.detach(env.bridge);
      env.snapshots.attach(next);
      await vi.advanceTimersByTimeAsync(250);
      expect(cleared(next)).toEqual(["q1"]);
      const asked = [answered, row("q2", { origin: origin({ pane_id: "pane-2" }) })];
      env.setRows(asked);
      env.snapshots.observe(asked);
      await vi.advanceTimersByTimeAsync(250);
      expect(env.shared()).toEqual(["q2"]);

      // Reopened and shared again before the old clear settles; then turned off: its clear goes.
      const reopened = [row("q1"), asked[1]!];
      env.setRows(reopened);
      env.snapshots.observe(reopened);
      await vi.advanceTimersByTimeAsync(250);
      expect(env.shared()).toEqual(["q1", "q2"]);
      settle();
      await vi.advanceTimersByTimeAsync(0);
      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);

      expect(cleared(next).filter((id) => id === "q1")).toHaveLength(2);
    });

    it("keeps a share's time fresh while a snapshot of it may still wait to send", async () => {
      const env = await attached();
      const recordedAt = () =>
        (JSON.parse(env.meta.get(SNAPSHOTS_SHARED_META_KEY)!) as Record<string, number>).q1!;
      const first = recordedAt();

      await vi.advanceTimersByTimeAsync(61 * 60_000);

      expect(recordedAt()).toBeGreaterThanOrEqual(first + 60 * 60_000);
    });

    it("sends what a new bridge owes a few at a time, so other steps go between", async () => {
      const owed = Array.from({ length: 10 }, (_, i) => `q-old-${i}`);
      const env = setup({
        meta: JSON.stringify(Object.fromEntries(owed.map((id) => [id, Date.now()]))),
        rows: [row("q1"), ...owed.map((id) => row(id, { local_status: "human-answered" }))],
      });
      const bridge = fakeBridge();
      // The relay keeps them waiting: each batch has its own time to settle.
      bridge.snapshots.clear.mockImplementation(() => new Promise(() => {}));
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);
      expect(cleared(bridge)).toHaveLength(4);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(1);

      env.snapshots.refreshRequested(bridge, { questionId: "q1" } as never);
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(2);
      expect(cleared(bridge)).toHaveLength(4);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(cleared(bridge)).toHaveLength(10);
    });

    it("forgets a question the relay keeps nothing of, without a clear", async () => {
      const day = 48 * 60 * 60_000;
      const env = await attached({
        allowed: false,
        meta: JSON.stringify({ "q-expired": Date.now(), "q-old": Date.now() - day - 60_000 }),
        rows: [
          row("q-expired", { local_status: "expired" }),
          row("q-old", { local_status: "human-answered" }),
        ],
      });

      expect(cleared(env.bridge)).toEqual([]);
      expect(env.shared()).toEqual([]);
    });

    it("records a share before it goes, so a restart knows to take it back", async () => {
      const env = setup();
      const bridge = fakeBridge();
      const recorded: string[][] = [];
      bridge.publishSnapshot.mockImplementation(async () => {
        recorded.push(env.shared());
        return "queued";
      });
      const release = env.holdWrites();
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.publishSnapshot).not.toHaveBeenCalled();

      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(recorded).toEqual([["q1"]]);
    });

    it("hands over a clear asked for while a publish is being queued only once it is", async () => {
      const env = setup();
      const bridge = fakeBridge();
      let queued!: () => void;
      bridge.publishSnapshot.mockImplementation(
        () =>
          new Promise((resolve) => {
            queued = () => resolve("queued");
          })
      );
      env.snapshots.attach(bridge);
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.publishSnapshot).toHaveBeenCalledTimes(1);

      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared(bridge)).toEqual([]);

      queued();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared(bridge)).toEqual(["q1"]);
    });

    it("holds nothing up behind a clear the relay keeps refusing", async () => {
      const env = await attached({
        rows: [row("q1"), row("q2", { origin: origin({ pane_id: "pane-2" }) })],
      });
      expect(env.bridge.publishSnapshot).toHaveBeenCalledTimes(2);
      // The library retries it for as long as the relay refuses: it never settles.
      env.bridge.snapshots.clear.mockImplementation(() => new Promise(() => {}));

      const answered = [
        row("q1", { local_status: "human-answered" }),
        row("q2", { origin: origin({ pane_id: "pane-2" }) }),
      ];
      env.setRows(answered);
      env.snapshots.observe(answered);
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared(env.bridge)).toEqual(["q1"]);

      // Turned off: the open question's snapshot is handed over at once all the same.
      env.setAllowed(false);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(cleared(env.bridge)).toContain("q2");

      // And on again: publishing carries on.
      env.setAllowed(true);
      env.snapshots.sharingChanged();
      await vi.advanceTimersByTimeAsync(250);
      expect(env.bridge.publishSnapshot).toHaveBeenCalledTimes(3);
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
      expect(cleared(env.bridge)).toEqual([]);
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
      expect(vi.getTimerCount()).toBe(0);
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
