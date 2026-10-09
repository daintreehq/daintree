import { describe, expect, it } from "vitest";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { CanopyCard, CanopyReadMark, CanopySeen } from "@shared/types/ipc/canopy";
import { buildPilotGroups, type PilotRowContext } from "@/components/Pilot/pilotRows";
import {
  buildCanopyInbox,
  CHECK_IN_CEILING,
  CHECK_IN_FLOOR,
  itemContextWarning,
  itemFacts,
  itemLooksDone,
  itemNeedsAttention,
  itemProgress,
  itemSubject,
  itemPriority,
  observedKind,
  PERMISSION_FLOOR,
  QUIET_PRIORITY,
  shownPriority,
  splitInbox,
  unseenLabelMs,
  type CanopyReadState,
} from "../canopyModel";

const NOW = 1_700_000_000_000;

function run(runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId,
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/Users/dev/app",
    agentId: "claude",
    ...overrides,
  };
}

const ctx: PilotRowContext = {
  workspaces: new Map([["p1", { kind: "project", name: "app", emoji: "🌳" }]]),
  currentWorkspaceId: null,
  nowMs: NOW,
};

function card(runId: string, overrides: Partial<CanopyCard> = {}): CanopyCard {
  return {
    runId,
    spawnedAt: NOW - 3_600_000,
    revision: 1,
    category: "working",
    confidence: 0.9,
    attentionProbability: 0.9,
    attentionScore: null,
    priority: 90,
    task: null,
    risk: "unknown",
    riskReason: null,
    action: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    handledAt: null,
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    stage: "described",
    wordsCategory: null,
    describing: false,
    headline: null,
    summary: null,
    question: null,
    options: [],
    secretPrompt: false,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
    observedAt: NOW,
    ...overrides,
  };
}

function inbox(
  runs: FleetRunRow[],
  cards: CanopyCard[] = [],
  read?: CanopyReadState,
  seen: CanopySeen[] = []
) {
  return buildCanopyInbox(
    buildPilotGroups(runs, ctx),
    new Map(cards.map((c) => [c.runId, c])),
    read,
    new Map(),
    new Map(seen.map((entry) => [entry.runId, entry])),
    NOW
  );
}

const SPAWNED = NOW - 3_600_000;
const seenAt = (runId: string, ago: number): CanopySeen => ({
  runId,
  spawnedAt: SPAWNED,
  at: NOW - ago,
});

describe("observedKind", () => {
  it("reads Daintree's waiting reason before any screen has been classified", () => {
    expect(observedKind(run("a", { agentState: "waiting", waitingReason: "approval" }))).toBe(
      "approval"
    );
    expect(observedKind(run("a", { agentState: "waiting", waitingReason: "error" }))).toBe("error");
    expect(observedKind(run("a", { agentState: "waiting", waitingReason: "prompt" }))).toBe(
      "question"
    );
    expect(observedKind(run("a", { agentState: "completed" }))).toBe("finished");
    expect(observedKind(run("a", { agentState: "directing" }))).toBe("working");
    expect(observedKind(run("a", { agentState: "exited" }))).toBe("idle");
  });
});

describe("buildCanopyInbox", () => {
  it("is one list, most blocked first, before anything is read — a long-unseen working agent included", () => {
    const result = inbox([
      run("finished", { agentState: "completed", since: NOW - 900_000 }),
      run("approval-new", {
        agentState: "waiting",
        waitingReason: "approval",
        since: NOW - 10_000,
      }),
      run("working", { agentState: "working", since: NOW - 60_000 }),
      run("approval-old", {
        agentState: "waiting",
        waitingReason: "approval",
        since: NOW - 600_000,
      }),
      run("idle", { agentState: "idle" }),
    ]);
    // The working agent has not been looked at since it spawned an hour ago,
    // which ranks it above finished work but under anything blocked.
    expect(result.map((i) => i.runId)).toEqual([
      "approval-old",
      "approval-new",
      "working",
      "finished",
      "idle",
    ]);
  });

  it("files a run by the classifier's reading once it has one", () => {
    const [item] = inbox(
      [run("a", { agentState: "working", since: NOW - 5_000 })],
      [card("a", { category: "approval", observedAt: NOW })]
    );
    expect(item!.kind).toBe("approval");
    expect(itemNeedsAttention(item!)).toBe(true);
  });

  it("keeps an older card's words when the kinds disagree, placed by the observed state", () => {
    const result = inbox(
      [run("a", { agentState: "working", since: NOW })],
      [card("a", { category: "approval", observedAt: NOW - 60_000, headline: "Approve it" })]
    );
    const item = result[0]!;
    expect(item.kind).toBe("working");
    expect(item.card?.headline).toBe("Approve it");
    expect(item.card?.question).toBeNull();
    expect(item.pending).toBe(true);
    expect(itemNeedsAttention(item)).toBe(false);
  });

  it("files an archived run under Archived, and keeps a replied one in the list", () => {
    const runs = [run("a"), run("b"), run("c")];
    const cards = ["a", "b", "c"].map((id) => card(id, { attentionProbability: 0.9 }));
    const dispositions = new Map([
      ["a", { runId: "a", spawnedAt: runs[0]!.spawnedAt, kind: "archived" as const, at: NOW }],
      ["b", { runId: "b", spawnedAt: runs[1]!.spawnedAt, kind: "replied" as const, at: NOW }],
    ]);
    const split = splitInbox(
      buildCanopyInbox(
        buildPilotGroups(runs, ctx),
        new Map(cards.map((c) => [c.runId, c])),
        undefined,
        dispositions,
        new Map(),
        NOW
      )
    );
    expect(split.archived.map((item) => item.runId)).toEqual(["a"]);
    expect(split.inbox.map((item) => item.runId).sort()).toEqual(["b", "c"]);
    const byId = (id: string) => split.inbox.find((item) => item.runId === id)!;
    expect(itemNeedsAttention(byId("b"))).toBe(false);
    expect(itemNeedsAttention(byId("c"))).toBe(true);
  });

  it("reads a finished, stopped run as looking done, never a working or re-reading one", () => {
    const items = inbox(
      [
        run("done", { agentState: "completed", since: NOW - 60_000 }),
        run("busy", { agentState: "working", since: NOW - 60_000 }),
        run("moved", { agentState: "completed", since: NOW }),
      ],
      [
        card("done", { category: "finished", observedAt: NOW }),
        card("busy", { category: "finished", observedAt: NOW }),
        // Read before its latest state change: stale until read again.
        card("moved", { category: "finished", observedAt: NOW - 60_000 }),
      ]
    );
    const byId = (id: string) => items.find((item) => item.runId === id)!;
    expect(itemLooksDone(byId("done"))).toBe(true);
    expect(itemLooksDone(byId("busy"))).toBe(false);
    expect(itemLooksDone(byId("moved"))).toBe(false);
    // The screen moved since the reading and has not been read again.
    const [moved] = inbox(
      [run("done", { agentState: "completed", since: NOW - 60_000 })],
      [card("done", { category: "finished", observedAt: NOW, priorityFromEarlierRead: true })]
    );
    expect(itemLooksDone(moved!)).toBe(false);
  });

  it("marks a run unread from what the user has read, for its incarnation, never while archived", () => {
    const runs = [run("a"), run("b"), run("c"), run("d")];
    const spawned = runs[0]!.spawnedAt;
    const mark = (runId: string, turn: number, readTurn: number, spawnedAt = spawned) => ({
      runId,
      spawnedAt,
      turn,
      readTurn,
      markedUnreadAt: null,
      version: 0,
    });
    const items = buildCanopyInbox(
      buildPilotGroups(runs, ctx),
      new Map(),
      undefined,
      new Map([["c", { runId: "c", spawnedAt: spawned, kind: "archived" as const, at: NOW }]]),
      new Map(),
      NOW,
      new Map(),
      new Map([
        ["a", mark("a", 2, 1)],
        ["b", mark("b", 2, 2)],
        ["c", mark("c", 3, 1)],
        ["d", mark("d", 4, 0, spawned - 1)],
      ])
    );
    const byId = (id: string) => items.find((item) => item.runId === id)!;
    expect(byId("a").unread).toBe(true);
    expect(byId("b").unread).toBe(false);
    // Put aside: whatever brings it back is what is new.
    expect(byId("c").unread).toBe(false);
    // Read marks of an earlier terminal under the same id say nothing about this one.
    expect(byId("d").readMark).toBeNull();
    expect(byId("d").unread).toBe(false);
  });

  it("never moves a run in the list for being read or unread", () => {
    const runs = [run("a"), run("b")];
    const cards = [card("a", { priority: 60 }), card("b", { priority: 40 })];
    const order = (reads: Map<string, CanopyReadMark>) =>
      buildCanopyInbox(
        buildPilotGroups(runs, ctx),
        new Map(cards.map((c) => [c.runId, c])),
        undefined,
        new Map(),
        new Map(),
        NOW,
        new Map(),
        reads
      ).map((item) => item.runId);
    const unreadB = new Map([
      [
        "b",
        {
          runId: "b",
          spawnedAt: runs[1]!.spawnedAt,
          turn: 1,
          readTurn: 0,
          markedUnreadAt: null,
          version: 1,
        },
      ],
    ]);
    expect(order(unreadB)).toEqual(order(new Map()));
  });

  it("ignores an archive set on an earlier incarnation of the same terminal", () => {
    const runs = [run("a")];
    const items = buildCanopyInbox(
      buildPilotGroups(runs, ctx),
      new Map(),
      undefined,
      new Map([
        [
          "a",
          { runId: "a", spawnedAt: runs[0]!.spawnedAt - 1, kind: "archived" as const, at: NOW },
        ],
      ])
    );
    expect(items[0]!.disposition).toBeNull();
    // Still read like any run in the inbox.
    expect(items[0]!.pending).toBe(true);
  });

  it("keeps an older card's words while it still agrees with the observed state", () => {
    const result = inbox(
      [run("a", { agentState: "working", since: NOW })],
      [card("a", { category: "working", observedAt: NOW - 60_000, activity: "Update(src/app.ts)" })]
    );
    expect(result[0]!.card?.activity).toBe("Update(src/app.ts)");
  });

  it("never carries an older card's prompt into a newer approval", () => {
    const result = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval", since: NOW })],
      [
        card("a", {
          category: "approval",
          observedAt: NOW - 60_000,
          headline: "Run the tests?",
          question: "Run npm test?",
          options: ["Yes", "No"],
        }),
      ]
    );
    const item = result[0]!;
    expect(item.card?.headline).toBe("Run the tests?");
    expect(item.card?.question).toBeNull();
    expect(item.card?.options).toEqual([]);
    expect(item.pending).toBe(true);
  });

  it("marks a run pending while its describer pass is in flight", () => {
    const result = inbox(
      [run("a", { agentState: "waiting", waitingReason: "question" })],
      [card("a", { category: "question", describing: true, stage: "classified" })]
    );
    expect(result[0]!.pending).toBe(true);
  });

  it("drops a card read from an earlier incarnation of the terminal", () => {
    const result = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval", spawnedAt: NOW })],
      [card("a", { category: "approval", spawnedAt: NOW - 3_600_000, options: ["Yes"] })]
    );
    expect(result[0]!.card).toBeNull();
  });

  it("keeps a card current when Daintree's state only catches up with what it read", () => {
    const approval = card("a", {
      category: "approval",
      observedAt: NOW - 8_000,
      question: "Run npm test?",
      options: ["Yes", "No"],
      // Read while Daintree still saw the agent working.
      observedWhenRead: { agentState: "working", waitingReason: null },
    });
    const [caughtUp] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval", since: NOW })],
      [approval]
    );
    expect(caughtUp!.stale).toBe(false);
    expect(caughtUp!.card?.options).toEqual(["Yes", "No"]);
    // Daintree names the stop more loosely than the reading: still the same card.
    const [loosely] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "prompt", since: NOW })],
      [approval]
    );
    expect(loosely!.stale).toBe(false);
    expect(loosely!.card?.category).toBe("approval");
    // Long after the reading: the agent may have worked and stopped again since.
    const [later] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval", since: NOW })],
      [{ ...approval, observedAt: NOW - 60_000 }]
    );
    expect(later!.stale).toBe(true);
    expect(later!.card?.options).toEqual([]);
    // Read while it was already waiting: the same state reached again is a new ask.
    const [again] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval", since: NOW })],
      [{ ...approval, observedWhenRead: { agentState: "waiting", waitingReason: "approval" } }]
    );
    expect(again!.stale).toBe(true);
    expect(again!.card?.options).toEqual([]);
  });

  it("marks a card stale once the run's state moved after it was read", () => {
    const result = inbox(
      [run("a", { agentState: "waiting", waitingReason: "question", since: NOW })],
      [card("a", { category: "question", observedAt: NOW - 60_000, question: "Keep it?" })]
    );
    expect(result[0]!.stale).toBe(true);
  });

  it("promises words only while something is on its way to write them", () => {
    const waiting = [run("a", { agentState: "waiting", waitingReason: "question", since: NOW })];
    const staleCard = [card("a", { category: "question", observedAt: NOW - 60_000 })];
    const pending = (cards: CanopyCard[], read: CanopyReadState) =>
      inbox(waiting, cards, read)[0]!.pending;

    // A first read, or a re-read of a card the run has moved past, is coming.
    expect(pending([], { failed: false })).toBe(true);
    expect(pending(staleCard, { failed: false })).toBe(true);
    // After a failed read nothing is reading now.
    for (const cards of [[], staleCard]) {
      expect(pending(cards, { failed: true })).toBe(false);
    }
  });
});

describe("buildCanopyInbox ordering", () => {
  it("orders by the models' combined priority, not by age or state", () => {
    const runs = [
      run("old", { agentState: "waiting", since: NOW - 600_000 }),
      run("urgent", { agentState: "working", since: NOW - 60_000 }),
      run("unread", { agentState: "waiting", waitingReason: "approval", since: NOW - 900_000 }),
    ];
    const result = inbox(runs, [
      card("old", { category: "finished", priority: 30 }),
      // A working agent the readers think is stuck rises above a finished one.
      card("urgent", { category: "working", priority: 85 }),
    ]);
    // Unread runs rank by what Daintree observed, and a waiting approval is the
    // permission floor: above even an agent the readers think is stuck.
    expect(result.map((item) => item.runId)).toEqual(["unread", "urgent", "old"]);
  });

  it("counts a run only classified so far by the classifier's priority, on the describer's bands", () => {
    // A finished turn the classifier reads sits at its anchor, 50: below the
    // "needs you" floor however sure it is that someone could look.
    const [finished] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "prompt" })],
      [
        card("a", {
          category: "finished",
          stage: "classified",
          attentionProbability: 0.9,
          priority: 50,
        }),
      ]
    );
    expect(itemNeedsAttention(finished!)).toBe(false);
    const [asking] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "prompt" })],
      [
        card("a", {
          category: "question",
          stage: "classified",
          attentionProbability: 0.95,
          priority: 86,
        }),
      ]
    );
    expect(itemNeedsAttention(asking!)).toBe(true);
    const [unread] = inbox([run("b", { agentState: "waiting", waitingReason: "prompt" })]);
    expect(itemNeedsAttention(unread!)).toBe(true);
  });

  it("always counts an approval Daintree observes, whatever a reading doubts", () => {
    const [observed] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "approval" })],
      [card("a", { category: "approval", attentionProbability: 0.3 })]
    );
    expect(itemNeedsAttention(observed!)).toBe(true);
  });
});

describe("the inbox's groups", () => {
  it("keeps an answered run in the list but out of what needs you", () => {
    const runs = [
      run("asked", { agentState: "waiting", waitingReason: "question" }),
      run("answered", { agentState: "waiting", waitingReason: "question" }),
    ];
    const { inbox: list, archived } = splitInbox(
      inbox(runs, [
        card("asked", { category: "question", attentionProbability: 0.9 }),
        card("answered", {
          category: "question",
          attentionProbability: 0.9,
          handledAt: NOW,
          priority: 0,
        }),
      ])
    );
    expect(archived).toEqual([]);
    expect(list.map((item) => item.runId)).toEqual(["asked", "answered"]);
    expect(list.filter(itemNeedsAttention).map((item) => item.runId)).toEqual(["asked"]);
  });
});

describe("checking on working agents", () => {
  const working = (id: string, overrides: Partial<FleetRunRow> = {}) =>
    run(id, { agentState: "working", since: NOW - 120_000, ...overrides });
  const progress = (id: string) =>
    card(id, { category: "working", priority: 4, attentionProbability: 0.05 });

  it("ranks a working agent up the longer it goes unseen, never past waiting work", () => {
    const items = inbox(
      [
        working("looked"),
        working("unseen"),
        run("finished", { agentState: "completed", since: NOW - 60_000 }),
        run("approval", { agentState: "waiting", waitingReason: "approval", since: NOW }),
      ],
      [
        progress("looked"),
        progress("unseen"),
        card("finished", { category: "finished", priority: 40 }),
        card("approval", { category: "approval", priority: 82 }),
      ],
      undefined,
      [seenAt("looked", 60_000), seenAt("unseen", 30 * 60_000)]
    );
    expect(items.map((item) => item.runId)).toEqual(["approval", "unseen", "finished", "looked"]);
    const byId = (id: string) => items.find((item) => item.runId === id)!;
    // A minute unseen is no step yet: the number holds while the user reads.
    expect(itemPriority(byId("looked"), NOW)).toBe(CHECK_IN_FLOOR);
    expect(itemPriority(byId("unseen"), NOW)).toBe(CHECK_IN_CEILING);
    expect(shownPriority(byId("unseen"), NOW)).toBe(CHECK_IN_CEILING);
  });

  it("says how long a working agent went unseen only once it has been a while", () => {
    const items = inbox(
      [working("recent"), working("long")],
      [progress("recent"), progress("long")],
      undefined,
      [seenAt("recent", 2 * 60_000), seenAt("long", 12 * 60_000)]
    );
    const byId = (id: string) => items.find((item) => item.runId === id)!;
    expect(unseenLabelMs(byId("recent"), NOW)).toBeNull();
    expect(unseenLabelMs(byId("long"), NOW)).toBe(12 * 60_000);
  });

  it("ranks a working agent Daintree sees gone quiet above finished work", () => {
    const [quiet] = inbox(
      [working("quiet", { quietSince: NOW - 600_000 })],
      [progress("quiet")],
      undefined,
      [seenAt("quiet", 0)]
    );
    expect(itemPriority(quiet!, NOW)).toBe(QUIET_PRIORITY);
    // The row already says quiet; the unseen time is not why it ranks there.
    expect(unseenLabelMs(quiet!, NOW)).toBeNull();
  });

  it("ignores a look at an earlier incarnation of the terminal", () => {
    const [item] = inbox([working("a")], [progress("a")], undefined, [
      { runId: "a", spawnedAt: SPAWNED - 1, at: NOW },
    ]);
    expect(item!.seenAt).toBeNull();
    expect(itemPriority(item!, NOW)).toBe(CHECK_IN_CEILING);
  });

  it("never raises a waiting run or one just answered", () => {
    const items = inbox(
      [run("finished", { agentState: "completed", since: NOW - 60_000 }), working("answered")],
      [
        card("finished", { category: "finished", priority: 30 }),
        card("answered", { category: "working", priority: 0, handledAt: NOW }),
      ]
    );
    const byId = (id: string) => items.find((item) => item.runId === id)!;
    expect(itemPriority(byId("finished"), NOW)).toBe(30);
    expect(itemPriority(byId("answered"), NOW)).toBe(0);
  });

  it("shows an answered approval at 0 while Daintree sees its agent set off again", () => {
    // Answered, then the agent works: the approval card is from before, and
    // the number holds at 0 rather than blanking until the next reading.
    const [answered] = inbox(
      [working("a")],
      [
        card("a", {
          category: "approval",
          priority: 0,
          handledAt: NOW - 1_000,
          observedAt: NOW - 5_000,
          observedWhenRead: { agentState: "waiting", waitingReason: "approval" },
        }),
      ]
    );
    expect(shownPriority(answered!, NOW)).toBe(0);
  });
});

describe("a priority from an earlier screen", () => {
  it("is neither shown nor ranked by until the run is scored again", () => {
    const [item] = inbox(
      [run("a", { agentState: "waiting", waitingReason: "question" })],
      [card("a", { category: "question", priority: 99, priorityFromEarlierRead: true })]
    );
    expect(shownPriority(item!, NOW)).toBeNull();
    expect(itemPriority(item!, NOW)).not.toBe(99);
  });
});

describe("the row's name", () => {
  const waiting = { agentState: "waiting" as const, waitingReason: "prompt" as const };

  it("goes by the name the agent gave its pane, whatever the readers titled the task", () => {
    const [item] = inbox(
      [run("a", { ...waiting, lastObservedTitle: "✳ Server routing refactor" })],
      [card("a", { category: "finished", task: "Refactor server routing" })]
    );
    expect(itemSubject(item!)).toBe("Server routing refactor");
  });

  it("goes by a name the user gave the pane", () => {
    const [item] = inbox(
      [run("a", { ...waiting, title: "Billing spike", titleMode: "user" })],
      [card("a", { category: "finished", task: "Refactor server routing" })]
    );
    expect(itemSubject(item!)).toBe("Billing spike");
  });

  it("borrows the readers' title, then the worktree, for a pane named only for its agent", () => {
    const worktree = { ...waiting, cwd: "/Users/dev/app-worktrees/fix-rounding" };
    const [titled] = inbox([run("a", worktree)], [card("a", { task: "Fix unit rounding" })]);
    expect(itemSubject(titled!)).toBe("Fix unit rounding");
    const [untitled] = inbox([run("a", worktree)], [card("a", { task: null })]);
    expect(itemSubject(untitled!)).toBe("fix-rounding");
  });
});

describe("progress and facts", () => {
  const stopped = { agentState: "waiting" as const, waitingReason: "prompt" as const };

  it("shows checklist counts when the agent drew one, else the reading's estimate, marked as one", () => {
    const [counted] = inbox(
      [run("a", stopped)],
      [
        card("a", {
          category: "approval",
          progress: 75,
          steps: { done: 4, total: 6, current: null },
        }),
      ]
    );
    // One unit down the column, counted or estimated; the count is still said.
    expect(itemProgress(counted!)).toMatchObject({
      value: 75,
      label: "75%",
      spoken: "4 of 6 steps done",
    });
    const [estimated] = inbox(
      [run("a", stopped)],
      [card("a", { category: "approval", progress: 30 })]
    );
    expect(itemProgress(estimated!)).toMatchObject({ value: 30, label: "~30%" });
  });

  it("shows no progress for a task finished in full, nor one not yet begun", () => {
    const [done] = inbox([run("a", stopped)], [card("a", { category: "finished", progress: 100 })]);
    expect(itemProgress(done!)).toBeNull();
    const [unstarted] = inbox([run("a", stopped)], [card("a", { category: "error", progress: 0 })]);
    expect(itemProgress(unstarted!)).toBeNull();
  });

  it("says what a stopped run reported, and nothing about a busy one", () => {
    const facts = { tests: "passing", changes: "uncommitted" } as const;
    const [finished] = inbox([run("a", stopped)], [card("a", { category: "finished", ...facts })]);
    expect(itemFacts(finished!)).toEqual(["Tests pass", "Not committed"]);
    const [busy] = inbox(
      [run("a", { agentState: "working" })],
      [card("a", { category: "working", ...facts })]
    );
    expect(itemFacts(busy!)).toEqual([]);
  });

  it("does not call a run done that stopped part way or left tests failing", () => {
    const [interrupted] = inbox(
      [run("a", stopped)],
      [card("a", { category: "finished", progress: 60 })]
    );
    expect(itemLooksDone(interrupted!)).toBe(false);
    const [failing] = inbox(
      [run("a", stopped)],
      [card("a", { category: "finished", tests: "failing" })]
    );
    expect(itemLooksDone(failing!)).toBe(false);
    const [done] = inbox([run("a", stopped)], [card("a", { category: "finished", progress: 100 })]);
    expect(itemLooksDone(done!)).toBe(true);
  });
});

describe("permission prompts", () => {
  const asking = { agentState: "waiting" as const, waitingReason: "approval" as const };

  it("rank above anything a reading says about another run, before and after a read", () => {
    const items = inbox(
      [
        run("question", { agentState: "waiting", waitingReason: "question" }),
        run("permission", asking),
      ],
      [
        card("question", { category: "question", priority: 88 }),
        // A reading that under-scores the dialog does not sink it.
        card("permission", { category: "approval", priority: 60 }),
      ]
    );
    expect(items.map((item) => item.runId)).toEqual(["permission", "question"]);
    expect(shownPriority(items[0]!, NOW)).toBe(PERMISSION_FLOOR);

    const [unread] = inbox([run("permission", asking)]);
    expect(itemPriority(unread!, NOW)).toBeGreaterThanOrEqual(PERMISSION_FLOOR);
  });
});

describe("needs you", () => {
  it("goes by the describer's reading once it has one, not the classifier's lean", () => {
    const waiting = { agentState: "waiting" as const, waitingReason: "prompt" as const };
    const [idle] = inbox(
      [run("a", waiting)],
      [card("a", { category: "idle", attentionProbability: 0.72, priority: 20 })]
    );
    expect(itemNeedsAttention(idle!)).toBe(false);
    const [finished] = inbox(
      [run("a", waiting)],
      [card("a", { category: "finished", attentionProbability: 0.3, priority: 55 })]
    );
    expect(itemNeedsAttention(finished!)).toBe(true);
    // Done, committed, nothing to decide: in the list, not in the count.
    const [clean] = inbox(
      [run("a", waiting)],
      [card("a", { category: "finished", attentionProbability: 0.9, priority: 40 })]
    );
    expect(itemNeedsAttention(clean!)).toBe(false);
    const [stuck] = inbox(
      [run("a", { agentState: "working" })],
      [card("a", { category: "working", attentionProbability: 0.2, priority: 70 })]
    );
    expect(itemNeedsAttention(stuck!)).toBe(true);
  });
});

describe("context left", () => {
  it("says so only when the agent's footer shows it nearly out", () => {
    const waiting = { agentState: "waiting" as const, waitingReason: "prompt" as const };
    const [low] = inbox([run("a", waiting)], [card("a", { category: "finished", contextLeft: 8 })]);
    expect(itemContextWarning(low!)).toBe("8% context left");
    const [plenty] = inbox(
      [run("a", waiting)],
      [card("a", { category: "finished", contextLeft: 60 })]
    );
    expect(itemContextWarning(plenty!)).toBeNull();
  });
});

describe("a stalled agent", () => {
  it("needs a look once Daintree sees it quiet, whatever its reading says", () => {
    const [quiet] = inbox(
      [run("a", { agentState: "working", quietSince: NOW - 11 * 60_000 })],
      [card("a", { category: "working", priority: 5 })]
    );
    expect(itemNeedsAttention(quiet!)).toBe(true);
  });
});

describe("a run stalled behind its spinner", () => {
  it("needs a look and ranks like a quiet one", () => {
    const [stalled] = inbox(
      [run("a", { agentState: "working" })],
      [card("a", { category: "working", priority: 5, stalledSince: NOW - 12 * 60_000 })]
    );
    expect(itemNeedsAttention(stalled!)).toBe(true);
    expect(itemPriority(stalled!, NOW)).toBe(QUIET_PRIORITY);
  });
});
