import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logCalls } = vi.hoisted(() => ({ logCalls: [] as unknown[][] }));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => {
    const record =
      (level: string) =>
      (...args: unknown[]) =>
        logCalls.push([level, ...args]);
    return { debug: record("debug"), info: record("info"), warn: record("warn"), error: vi.fn() };
  },
}));

vi.mock("../../ProjectStore.js", () => ({
  projectStore: { getProjectState: vi.fn(async () => null) },
}));

const sessionIdentityRevision = vi.hoisted(() => vi.fn((_terminalId: string) => 0));
vi.mock("../../pty/agentSessionCapturePersistence.js", () => ({
  acceptLiveSessionAttribution: vi.fn(),
  sessionIdentityRevision,
}));

import { events } from "../../events.js";
import type { ProjectState, TerminalSnapshot } from "../../../../shared/types/project.js";
import type { PaneWritebackOutcome } from "../../pty/agentSessionCapturePersistence.js";
import type { CodexCreatedThread } from "../CodexSubagentService.js";
import {
  CodexLiveSessionAttribution,
  matchLiveCodexThreads,
  type CodexLiveSessionAttributionDeps,
  type LiveAttributionPane,
} from "../CodexLiveSessionAttribution.js";

const SPAWN_MS = 1_800_000_000_000;
const SPAWN_S = SPAWN_MS / 1000;
const HANDBACK = "\n\nWhen you are done, print DAINTREE-DONE-abc then END-abc.";

function pane(terminalId: string, promptText: string, spawnedAtMs = SPAWN_MS): LiveAttributionPane {
  return { terminalId, spawnedAtMs, promptText };
}

function thread(sessionId: string, preview: string, createdAt = SPAWN_S + 5): CodexCreatedThread {
  return { sessionId, preview, createdAt };
}

describe("matchLiveCodexThreads", () => {
  it("separates a fleet launched into one folder seconds apart by its prompts", () => {
    const panes = Array.from({ length: 18 }, (_, i) =>
      pane(`pane-${i}`, `Triage issue #${100 + i} and report back.`, SPAWN_MS + i * 1_000)
    );
    // Threads start in a different order from their panes, and close together.
    const threads = panes
      .map((p, i) => thread(`session-${i}`, `${p.promptText}${HANDBACK}`, SPAWN_S + 20 - (i % 3)))
      .reverse();

    const matches = matchLiveCodexThreads(panes, threads, new Set());

    expect(matches.size).toBe(18);
    for (let i = 0; i < 18; i++) expect(matches.get(`pane-${i}`)).toBe(`session-${i}`);
  });

  it("leaves both panes unattributed when they were sent the same prompt", () => {
    const matches = matchLiveCodexThreads(
      [pane("a", "Fix the tests"), pane("b", "Fix the tests")],
      [thread("s1", "Fix the tests"), thread("s2", "Fix the tests")],
      new Set()
    );

    expect(matches.size).toBe(0);
  });

  it("refuses a pane two threads fit, even with only one pane in the running", () => {
    // A conversation started outside Daintree with the same words.
    const matches = matchLiveCodexThreads(
      [pane("a", "Fix the tests")],
      [thread("mine", "Fix the tests"), thread("by-hand", "Fix the tests please")],
      new Set()
    );

    expect(matches.size).toBe(0);
  });

  it("doesn't read one prompt as the start of a longer sibling's", () => {
    const matches = matchLiveCodexThreads(
      [pane("a", "Triage #1"), pane("b", "Triage #12")],
      [thread("s1", `Triage #1${HANDBACK}`), thread("s12", "Triage #12")],
      new Set()
    );

    expect(matches).toEqual(
      new Map([
        ["a", "s1"],
        ["b", "s12"],
      ])
    );
  });

  it("lets a prompt cut at its cap run on mid-word", () => {
    const cut: LiveAttributionPane = {
      ...pane("a", "Rewrite the parser so it han"),
      promptTruncated: true,
    };

    expect(
      matchLiveCodexThreads(
        [cut],
        [thread("s", "Rewrite the parser so it handles BOMs")],
        new Set()
      )
    ).toEqual(new Map([["a", "s"]]));
    expect(
      matchLiveCodexThreads(
        [pane("a", "Rewrite the parser so it han")],
        [thread("s", "Rewrite the parser so it handles BOMs")],
        new Set()
      ).size
    ).toBe(0);
  });

  it("compares the words, not the line breaks the launch command flattened", () => {
    const matches = matchLiveCodexThreads(
      [pane("a", "  Fix the build.\r\nThen run\n\nthe tests.  ")],
      [thread("s", `Fix the build. Then run the tests.${HANDBACK}`.replace(/\n/g, " "))],
      new Set()
    );

    expect(matches.get("a")).toBe("s");
  });

  it("ignores threads from before the pane's process existed", () => {
    // A previous run of the same prompt in the same folder.
    const matches = matchLiveCodexThreads(
      [pane("a", "Fix the tests", SPAWN_MS + 900)],
      [thread("earlier", "Fix the tests", SPAWN_S - 60), thread("now", "Fix the tests", SPAWN_S)],
      new Set()
    );

    // Same second as the spawn counts: the protocol has no finer precision.
    expect(matches.get("a")).toBe("now");
  });

  it("leaves out a thread another pane already holds", () => {
    const matches = matchLiveCodexThreads(
      [pane("a", "Fix the tests")],
      [thread("held", "Fix the tests"), thread("mine", "Fix the tests")],
      new Set(["held"])
    );

    expect(matches.get("a")).toBe("mine");
  });

  it("fits nothing to a preview shorter than the prompt", () => {
    const matches = matchLiveCodexThreads(
      [pane("a", "Fix the tests and the lint")],
      [thread("s", "Fix the tests")],
      new Set()
    );

    expect(matches.size).toBe(0);
  });
});

type TerminalRecord = Awaited<
  ReturnType<CodexLiveSessionAttributionDeps["ptyClient"]["getAllTerminalsWithCompletenessAsync"]>
>["terminals"][number];

const PROJECT_ID = "project-1";
const DELAYS = [10, 20, 40];

function terminal(id: string, overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id,
    projectId: PROJECT_ID,
    launchAgentId: "codex",
    detectedAgentId: "codex",
    agentIncarnation: 0,
    cwd: "/repo",
    spawnedAt: SPAWN_MS,
    hasPty: true,
    ...overrides,
  } as TerminalRecord;
}

function saved(
  id: string,
  prompt?: string,
  overrides: Partial<TerminalSnapshot> = {}
): TerminalSnapshot {
  return {
    id,
    kind: "terminal",
    launchAgentId: "codex",
    title: "Codex",
    location: "grid",
    ...(prompt !== undefined && { firstPrompt: { text: prompt, via: "launch", at: SPAWN_MS } }),
    ...overrides,
  } as TerminalSnapshot;
}

function harness(
  options: {
    terminals?: TerminalRecord[];
    panes?: TerminalSnapshot[];
    threads?: CodexCreatedThread[] | null;
    degraded?: boolean;
    quitting?: boolean;
  } = {}
) {
  const world = {
    terminals: options.terminals ?? [terminal("pane-1")],
    panes: options.panes ?? [saved("pane-1", "Triage issue #1")],
    threads:
      options.threads === undefined ? [thread("session-1", "Triage issue #1")] : options.threads,
    degraded: options.degraded ?? false,
    quitting: options.quitting ?? false,
    generations: new Map<string, number>(),
  };
  const ptyClient = {
    getAllTerminalsWithCompletenessAsync: vi.fn(async () => ({
      terminals: world.terminals,
      degraded: world.degraded,
      shardsTotal: 1,
      shardsFailed: world.degraded ? 1 : 0,
    })),
    getLiveGeneration: vi.fn((id: string) => world.generations.get(id) ?? 1),
    noteLiveAgentSessionId: vi.fn(),
  };
  const getProjectState = vi.fn(async (projectId: string): Promise<ProjectState> => ({
    projectId,
    sidebarWidth: 350,
    terminals: world.panes,
  }));
  const listThreads = vi.fn(async (_cwd: string, _since: number, _home?: string) => world.threads);
  const persist = vi.fn(async (): Promise<PaneWritebackOutcome> => "filled");
  const service = new CodexLiveSessionAttribution({
    ptyClient,
    isQuitting: () => world.quitting,
    getProjectState,
    listThreads,
    persist,
    attemptDelaysMs: DELAYS,
  });
  return { world, ptyClient, getProjectState, listThreads, persist, service };
}

function working(terminalId: string, agentId = "codex"): void {
  events.emit("agent:state-changed", {
    terminalId,
    agentId,
    state: "working",
    previousState: "idle",
    timestamp: Date.now(),
    trigger: "output",
    confidence: 1,
  } as never);
}

describe("CodexLiveSessionAttribution", () => {
  let services: CodexLiveSessionAttribution[] = [];
  const track = <T extends { service: CodexLiveSessionAttribution }>(h: T): T => {
    services.push(h.service);
    return h;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    logCalls.length = 0;
    sessionIdentityRevision.mockReset();
    sessionIdentityRevision.mockReturnValue(0);
  });

  afterEach(() => {
    for (const service of services) service.dispose();
    services = [];
    vi.useRealTimers();
  });

  it("writes the id once the run's first turn has a thread, and tells the host", async () => {
    const h = track(harness());
    sessionIdentityRevision.mockReturnValue(3);

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(h.listThreads).toHaveBeenCalledWith("/repo", SPAWN_S, undefined);
    expect(h.persist).toHaveBeenCalledWith({
      terminalId: "pane-1",
      generation: 1,
      projectId: PROJECT_ID,
      agentId: "codex",
      sessionId: "session-1",
      identityRevision: 3,
    });
    expect(h.ptyClient.noteLiveAgentSessionId).toHaveBeenCalledWith("pane-1", "session-1", 1);

    // Done for this run: later turns don't query again.
    working("pane-1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.listThreads).toHaveBeenCalledTimes(1);
  });

  it("answers a fleet starting together with one query per attempt", async () => {
    const ids = ["pane-1", "pane-2", "pane-3"];
    const h = track(
      harness({
        terminals: ids.map((id, i) => terminal(id, { spawnedAt: SPAWN_MS + i * 1_000 })),
        panes: ids.map((id) => saved(id, `Triage ${id}`)),
        threads: ids.map((id, i) => thread(`session-${i}`, `Triage ${id}${HANDBACK}`)),
      })
    );

    for (const id of ids) working(id);
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(h.listThreads).toHaveBeenCalledTimes(1);
    expect(h.persist.mock.calls.map(([call]) => (call as { sessionId: string }).sessionId)).toEqual(
      ["session-0", "session-1", "session-2"]
    );
  });

  it("retries while the prompt isn't saved yet, then stops for good", async () => {
    const h = track(harness({ panes: [saved("pane-1")] }));

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS.reduce((a, b) => a + b, 0) + 100);

    // No prompt is nothing to match: the app-server is never asked.
    expect(h.ptyClient.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(DELAYS.length);
    expect(h.listThreads).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();

    // The same run's next turn doesn't hand it a fresh budget.
    working("pane-1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.ptyClient.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(DELAYS.length);
  });

  it("picks the match up on a later attempt once the thread is indexed", async () => {
    const h = track(harness({ threads: [] }));

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);
    expect(h.persist).not.toHaveBeenCalled();

    h.world.threads = [thread("session-1", "Triage issue #1")];
    await vi.advanceTimersByTimeAsync(DELAYS[1]);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("finishes nothing on a partial inventory or a failed query", async () => {
    const h = track(harness({ degraded: true }));

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);
    expect(h.listThreads).not.toHaveBeenCalled();

    h.world.degraded = false;
    h.world.threads = null;
    await vi.advanceTimersByTimeAsync(DELAYS[1]);
    expect(h.listThreads).toHaveBeenCalledTimes(1);
    expect(h.persist).not.toHaveBeenCalled();

    h.world.threads = [thread("session-1", "Triage issue #1")];
    await vi.advanceTimersByTimeAsync(DELAYS[2]);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("counts a sibling that hasn't reported working yet as a rival", async () => {
    const h = track(
      harness({
        terminals: [terminal("pane-1"), terminal("pane-2")],
        panes: [saved("pane-1", "Fix the tests"), saved("pane-2", "Fix the tests")],
        threads: [thread("session-1", "Fix the tests")],
      })
    );

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(h.listThreads).toHaveBeenCalledTimes(1);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("reads back only as far as the due panes, and accepts no older pane from that", async () => {
    const h = track(
      harness({
        terminals: [terminal("pane-old", { spawnedAt: SPAWN_MS - 600_000 }), terminal("pane-new")],
        panes: [saved("pane-old", "Old task"), saved("pane-new", "New task")],
        // The old pane's own thread is from before the window, so this later
        // one is all the list can show it.
        threads: [thread("new-s", "New task"), thread("later-s", "Old task")],
      })
    );

    working("pane-new");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(h.listThreads).toHaveBeenCalledWith("/repo", SPAWN_S, undefined);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({ terminalId: "pane-new" }));
  });

  it("treats an id held anywhere as taken", async () => {
    const h = track(
      harness({
        terminals: [terminal("pane-1"), terminal("pane-2", { agentSessionId: "session-held" })],
        panes: [
          saved("pane-1", "Fix the tests"),
          saved("pane-3", undefined, { agentSessionId: "session-saved" }),
        ],
        threads: [
          thread("session-held", "Fix the tests"),
          thread("session-saved", "Fix the tests"),
          thread("session-1", "Fix the tests"),
        ],
      })
    );

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
  });

  it.each([
    ["already holds an id on the host", terminal("pane-1", { agentSessionId: "known" })],
    ["is running another agent now", terminal("pane-1", { detectedAgentId: "claude" })],
    ["hosts a later agent session", terminal("pane-1", { agentIncarnation: 1 })],
    ["is the assistant", terminal("pane-1", { isAssistantTerminal: true })],
    ["has exited", terminal("pane-1", { isExited: true })],
  ])("leaves a pane alone that %s", async (_label, record) => {
    const h = track(harness({ terminals: [record] }));

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS.reduce((a, b) => a + b, 0) + 100);

    expect(h.listThreads).not.toHaveBeenCalled();
    // Finished on the first look rather than retried.
    expect(h.ptyClient.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(1);
  });

  it("stops once the saved pane has an id", async () => {
    const h = track(
      harness({ panes: [saved("pane-1", "Triage issue #1", { agentSessionId: "x" })] })
    );

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS.reduce((a, b) => a + b, 0) + 100);

    expect(h.listThreads).not.toHaveBeenCalled();
    expect(h.ptyClient.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(1);
  });

  it("ignores other agents' turns", async () => {
    const h = track(harness());

    working("pane-1", "claude");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.ptyClient.getAllTerminalsWithCompletenessAsync).not.toHaveBeenCalled();
  });

  it("starts over for a relaunch, and drops the old run's attempt", async () => {
    const h = track(harness({ threads: [] }));

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);
    h.world.generations.set("pane-1", 2);
    h.world.threads = [thread("session-2", "Triage issue #1")];

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }));
  });

  it("does nothing while quitting", async () => {
    const h = track(harness({ quitting: true }));

    working("pane-1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.ptyClient.getAllTerminalsWithCompletenessAsync).not.toHaveBeenCalled();
  });

  it("clears its timers and its subscription on dispose", async () => {
    const h = harness();

    working("pane-1");
    h.service.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    working("pane-1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.ptyClient.getAllTerminalsWithCompletenessAsync).not.toHaveBeenCalled();
  });

  it("queries a pane's own Codex profile", async () => {
    const h = track(
      harness({
        panes: [saved("pane-1", "Triage issue #1", { env: { codex_home: "/profiles/work" } })],
      })
    );

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(h.listThreads).toHaveBeenCalledWith("/repo", SPAWN_S, "/profiles/work");
  });

  it("doesn't tell the host about an id the saved pane refused", async () => {
    const h = track(harness());
    h.persist.mockResolvedValue("conflict");

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    expect(h.ptyClient.noteLiveAgentSessionId).not.toHaveBeenCalled();
  });

  it("never logs the prompt or the session id", async () => {
    track(harness());

    working("pane-1");
    await vi.advanceTimersByTimeAsync(DELAYS[0]);

    const logged = JSON.stringify(logCalls);
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logged).not.toContain("Triage issue");
    expect(logged).not.toContain("session-1");
  });
});
