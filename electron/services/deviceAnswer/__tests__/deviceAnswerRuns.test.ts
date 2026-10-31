import { beforeEach, describe, expect, it, vi } from "vitest";

const screens = new Map<string, string | null>();
vi.mock("../../plugin/pluginTerminalScreenRead.js", () => ({
  readPluginTerminalScreen: vi.fn(async (_pty: unknown, runId: string) => {
    const text = screens.get(runId);
    return text == null
      ? { status: "not-found" }
      : { status: "ok", text, lineCount: 1, truncated: false };
  }),
}));

import type { FleetRunRow, FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import { readPluginTerminalScreen } from "../../plugin/pluginTerminalScreenRead.js";
import {
  MAX_LISTED_RUNS,
  MAX_OMITTED_RUNS,
  isRunStillWaiting,
  listWaitingRuns,
} from "../deviceAnswerRuns.js";
import type { AnswerPtyClient } from "../../terminalAnswer.js";

/** A PTY whose terminals were all spawned at `spawnedAt`. */
function ptyAt(spawnedAt: number): AnswerPtyClient {
  return { getTerminalAsync: async () => ({ spawnedAt }) } as unknown as AnswerPtyClient;
}

function row(overrides: Partial<FleetRunRow>): FleetRunRow {
  return {
    runId: "run",
    workspaceId: "ws-1",
    spawnedAt: 100,
    cwd: "/repo",
    ...overrides,
  } as FleetRunRow;
}

function snapshot(runs: FleetRunRow[]): FleetSnapshot {
  return { runs, changedAt: 0 } as unknown as FleetSnapshot;
}

beforeEach(() => {
  screens.clear();
  vi.mocked(readPluginTerminalScreen).mockClear();
});

describe("listWaitingRuns", () => {
  it("lists every project's waiting runs, what asks something first, with what was observed", async () => {
    screens.set("a", "❯ 1. Yes\n  2. No\n\n Esc to cancel");
    screens.set("b", null);
    const { runs, omitted, waiting } = await listWaitingRuns({
      fleet: () =>
        snapshot([
          row({
            runId: "a",
            agentState: "waiting",
            waitingReason: "approval",
            since: 20,
            workspaceId: "ws-1",
          }),
          row({ runId: "busy", agentState: "working", since: 1 }),
          row({
            runId: "b",
            agentState: "waiting",
            waitingReason: "error",
            since: 10,
            workspaceId: "ws-2",
            park: {} as never,
          }),
        ]),
      pty: () => ptyAt(100),
      projectName: (id) => (id === "ws-1" ? "daintree" : null),
    });
    // The parked error has waited longer, but parking set it aside.
    expect(runs.map((r) => r.runId)).toEqual(["a", "b"]);
    expect(runs[0]).toMatchObject({
      waitingReason: "approval",
      parked: false,
      project: "daintree",
      choices: ["Yes", "No"],
    });
    expect(runs[1]).toMatchObject({
      waitingReason: "error",
      parked: true,
      project: null,
      screen: null,
      choices: [],
    });
    expect(omitted).toEqual([]);
    expect(waiting).toBe(2);
  });

  it("shows no screen for an id respawned since the fleet row was taken", async () => {
    screens.set("a", "❯ 1. Yes\n  2. No\n\n Esc to cancel");
    const { runs } = await listWaitingRuns({
      fleet: () => snapshot([row({ runId: "a", agentState: "waiting", spawnedAt: 100 })]),
      pty: () => ptyAt(200),
      projectName: () => null,
    });
    expect(runs[0]).toMatchObject({ screen: null, choices: [] });
  });

  it("drops a run that stopped waiting while its screen was read", async () => {
    screens.set("a", "❯ 1. Yes\n  2. No\n\n Esc to cancel");
    let reads = 0;
    const listed = await listWaitingRuns({
      fleet: () =>
        snapshot([row({ runId: "a", agentState: reads++ === 0 ? "waiting" : "working" })]),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(listed).toEqual({ runs: [], omitted: [], waiting: 0 });
  });

  it("redacts secrets from the screen, the title and each option before they leave", async () => {
    screens.set(
      "a",
      [
        "export OPENAI_API_KEY=abcdefgh12345",
        "❯ 1. Yes",
        "  2. Use token=abcdef123456",
        "  3. No",
        "",
        " Esc to cancel",
      ].join("\n")
    );
    const { runs } = await listWaitingRuns({
      fleet: () =>
        snapshot([row({ runId: "a", agentState: "waiting", title: "deploy password=hunter22" })]),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs[0]).toMatchObject({
      title: "deploy password=[redacted]",
      choices: ["Yes", "Use token=[redacted]", "No"],
    });
    expect(runs[0]!.screen).toContain("OPENAI_API_KEY=[redacted]");
    expect(JSON.stringify(runs)).not.toMatch(/abcdefgh12345|abcdef123456|hunter22/);
  });

  it("keeps the options of a dialog drawn under an unterminated key block", async () => {
    screens.set(
      "a",
      [
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
        "❯ 1. Yes",
        "  2. No",
        "",
        " Esc to cancel",
      ].join("\n")
    );
    const { runs } = await listWaitingRuns({
      fleet: () => snapshot([row({ runId: "a", agentState: "waiting" })]),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs[0]!.choices).toEqual(["Yes", "No"]);
    expect(runs[0]!.screen).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
  });

  it("offers no options when redacting lengthens one past what an answer may carry", async () => {
    const long = `${"x".repeat(181)} password=abc`;
    screens.set("a", ["❯ 1. Yes", `  2. ${long}`, "", " Esc to cancel"].join("\n"));
    const { runs } = await listWaitingRuns({
      fleet: () => snapshot([row({ runId: "a", agentState: "waiting" })]),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs[0]!.choices).toEqual([]);
    expect(runs[0]!.questionId).toBeNull();
    expect(runs[0]!.screen).toContain("password=[redacted]");
  });

  it("names the question each list asks, the same wherever its highlight is, and none without options", async () => {
    const ask = (command: string, highlighted: "Yes" | "No") =>
      [
        ` Run ${command}?`,
        highlighted === "Yes" ? "❯ 1. Yes" : "  1. Yes",
        highlighted === "No" ? "❯ 2. No" : "  2. No",
        "",
        " Esc to cancel",
      ].join("\n");
    const questionIdFor = async (screen: string | null) => {
      screens.set("a", screen);
      const {
        runs: [run],
      } = await listWaitingRuns({
        fleet: () => snapshot([row({ runId: "a", agentState: "waiting" })]),
        pty: () => ptyAt(100),
        projectName: () => null,
      });
      return run!.questionId;
    };
    const asked = await questionIdFor(ask("rm -rf build", "Yes"));
    expect(asked).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(await questionIdFor(ask("rm -rf build", "No"))).toBe(asked);
    expect(await questionIdFor(ask("git push --force", "Yes"))).not.toBe(asked);
    expect(await questionIdFor("Working…")).toBeNull();
    expect(await questionIdFor(null)).toBeNull();
  });

  it("lists nothing when the fleet has no snapshot yet", async () => {
    expect(
      await listWaitingRuns({ fleet: () => null, pty: () => null, projectName: () => null })
    ).toEqual({ runs: [], omitted: [], waiting: 0 });
  });
});

const DIALOG = "❯ 1. Yes\n  2. No\n\n Esc to cancel";

/** `count` runs waiting at their prompt, `idle-0` the longest; every screen draws a dialog. */
function idleRuns(count: number, overrides: Partial<FleetRunRow> = {}): FleetRunRow[] {
  return Array.from({ length: count }, (_, i) => {
    screens.set(`idle-${i}`, DIALOG);
    return row({
      runId: `idle-${i}`,
      agentState: "waiting",
      waitingReason: "prompt",
      since: i + 1,
      ...overrides,
    });
  });
}

const readCount = () => vi.mocked(readPluginTerminalScreen).mock.calls.length;

describe("listWaitingRuns past the screens it reads", () => {
  it("names a run the cap left unread and counts it, and reads it when the device picks it", async () => {
    const rows = idleRuns(MAX_LISTED_RUNS + 1);
    const deps = { fleet: () => snapshot(rows), pty: () => ptyAt(100), projectName: () => "web" };

    const first = await listWaitingRuns(deps);
    expect(readCount()).toBe(MAX_LISTED_RUNS);
    expect(first.runs).toHaveLength(MAX_LISTED_RUNS);
    expect(first.waiting).toBe(MAX_LISTED_RUNS + 1);
    expect(first.omitted).toEqual([
      {
        runId: "idle-20",
        spawnedAt: 100,
        project: "web",
        title: null,
        agentId: null,
        agentState: "waiting",
        waitingReason: "prompt",
        since: 21,
        parked: false,
        snoozed: false,
      },
    ]);

    vi.mocked(readPluginTerminalScreen).mockClear();
    const picked = await listWaitingRuns(deps, { read: { runId: "idle-20", spawnedAt: 100 } });
    expect(readCount()).toBe(MAX_LISTED_RUNS);
    const reached = picked.runs.find((run) => run.runId === "idle-20");
    expect(reached).toMatchObject({ choices: ["Yes", "No"], spawnedAt: 100 });
    expect(reached!.questionId).not.toBeNull();
    // The slot it took is the least pressing run's, which is named instead.
    expect(picked.omitted.map((run) => run.runId)).toEqual(["idle-19"]);
    expect(picked.waiting).toBe(MAX_LISTED_RUNS + 1);
  });

  it("reads a newer approval ahead of twenty agents idle at their prompt", async () => {
    screens.set("approval", DIALOG);
    const rows = [
      ...idleRuns(MAX_LISTED_RUNS),
      row({ runId: "approval", agentState: "waiting", waitingReason: "approval", since: 1_000 }),
    ];
    const { runs, omitted } = await listWaitingRuns({
      fleet: () => snapshot(rows),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs[0]).toMatchObject({ runId: "approval", choices: ["Yes", "No"] });
    expect(omitted.map((run) => run.runId)).toEqual([`idle-${MAX_LISTED_RUNS - 1}`]);
  });

  it("reads what asks something before what's set aside, and both before hand-backs", async () => {
    const asks = (runId: string, extra: Partial<FleetRunRow>) =>
      row({ runId, agentState: "waiting", since: 50, ...extra });
    const rows = [
      ...idleRuns(MAX_LISTED_RUNS - 3),
      asks("question-snoozed", { waitingReason: "question", snooze: {} as never }),
      asks("error", { waitingReason: "error", since: 90 }),
      asks("approval-parked", { waitingReason: "approval", park: {} as never }),
      asks("no-reason", { since: 0 }),
      asks("idle-parked", { waitingReason: "prompt", since: 0, park: {} as never }),
    ];
    const { runs, omitted } = await listWaitingRuns({
      fleet: () => snapshot(rows),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs.slice(0, 4).map((run) => run.runId)).toEqual([
      "error",
      "approval-parked",
      "question-snoozed",
      // No reason given is a hand-back, the longest waiting of them first.
      "no-reason",
    ]);
    // A hand-back parked comes after every hand-back left in front.
    expect(omitted.map((run) => run.runId)).toEqual([`idle-${MAX_LISTED_RUNS - 4}`, "idle-parked"]);
  });

  it("counts no unread run that stopped waiting, and no run that started while screens were read", async () => {
    const rows = idleRuns(MAX_LISTED_RUNS + 2);
    let reads = 0;
    const { runs, omitted, waiting } = await listWaitingRuns({
      fleet: () =>
        snapshot(
          reads++ === 0
            ? rows
            : [
                ...rows.filter((r) => r.runId !== "idle-21"),
                row({ runId: "idle-21", agentState: "working" }),
                row({ runId: "new", agentState: "waiting", waitingReason: "approval" }),
              ]
        ),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(runs).toHaveLength(MAX_LISTED_RUNS);
    expect(omitted.map((run) => run.runId)).toEqual(["idle-20"]);
    expect(waiting).toBe(MAX_LISTED_RUNS + 1);
  });

  it("reads nothing ahead for a pick whose id was respawned or that isn't waiting", async () => {
    screens.set("busy", DIALOG);
    const rows = [...idleRuns(MAX_LISTED_RUNS + 1), row({ runId: "busy", agentState: "working" })];
    const deps = { fleet: () => snapshot(rows), pty: () => ptyAt(100), projectName: () => null };
    for (const read of [
      { runId: "idle-20", spawnedAt: 99 },
      { runId: "busy", spawnedAt: 100 },
      { runId: "elsewhere", spawnedAt: 100 },
    ]) {
      vi.mocked(readPluginTerminalScreen).mockClear();
      const { runs, omitted } = await listWaitingRuns(deps, { read });
      expect(omitted.map((run) => run.runId)).toEqual(["idle-20"]);
      expect(runs.map((run) => run.runId)).not.toContain(read.runId);
      const readIds = vi.mocked(readPluginTerminalScreen).mock.calls.map(([, runId]) => runId);
      expect(readIds).toHaveLength(MAX_LISTED_RUNS);
      expect(readIds).not.toContain("busy");
      expect(readIds).not.toContain("idle-20");
    }
  });

  it("neither lists nor counts a read or unread run whose id was respawned while screens were read", async () => {
    const rows = idleRuns(MAX_LISTED_RUNS + 2);
    let reads = 0;
    const respawned = (runId: string) => row({ runId, agentState: "waiting", spawnedAt: 200 });
    const { runs, omitted, waiting } = await listWaitingRuns(
      {
        fleet: () =>
          snapshot(
            reads++ === 0
              ? rows
              : [
                  ...rows.filter((r) => r.runId !== "idle-21" && r.runId !== "idle-0"),
                  respawned("idle-21"),
                  respawned("idle-0"),
                ]
          ),
        pty: () => ptyAt(100),
        projectName: () => null,
      },
      // Picked, and then respawned too.
      { read: { runId: "idle-0", spawnedAt: 100 } }
    );
    expect(runs.map((run) => run.runId)).not.toContain("idle-0");
    expect(runs).toHaveLength(MAX_LISTED_RUNS - 1);
    expect(omitted.map((run) => run.runId)).toEqual(["idle-20"]);
    expect(waiting).toBe(MAX_LISTED_RUNS);
  });

  it("names unread runs with secrets redacted and no screen, and counts past the ones it names", async () => {
    const rows = idleRuns(MAX_LISTED_RUNS + MAX_OMITTED_RUNS + 5, {
      title: "deploy password=hunter22",
    });
    const { omitted, waiting } = await listWaitingRuns({
      fleet: () => snapshot(rows),
      pty: () => ptyAt(100),
      projectName: () => null,
    });
    expect(readCount()).toBe(MAX_LISTED_RUNS);
    expect(omitted).toHaveLength(MAX_OMITTED_RUNS);
    expect(waiting).toBe(MAX_LISTED_RUNS + MAX_OMITTED_RUNS + 5);
    expect(omitted[0]!.title).toBe("deploy password=[redacted]");
    expect(JSON.stringify(omitted)).not.toMatch(/hunter22|questionId|choices|screen/);
  });
});

describe("isRunStillWaiting", () => {
  it("holds only for the same run, the same spawn, still waiting", () => {
    const fleet = snapshot([row({ runId: "a", spawnedAt: 100, agentState: "waiting" })]);
    expect(isRunStillWaiting(fleet, "a", 100)).toBe(true);
    expect(isRunStillWaiting(fleet, "a", 99)).toBe(false);
    expect(
      isRunStillWaiting(snapshot([row({ runId: "a", agentState: "working" })]), "a", 100)
    ).toBe(false);
    expect(isRunStillWaiting(null, "a", 100)).toBe(false);
  });
});
