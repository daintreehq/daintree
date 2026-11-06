import { describe, expect, it } from "vitest";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { WorktreeState } from "@shared/types/worktree";
import type { NormalizedPRState } from "@shared/types/forge";
import {
  decodeWorktreeAgentBuckets,
  deriveWorktreeAgentBuckets,
  encodeWorktreeAgentBuckets,
  indexFleetRuns,
  isWorktreeMergedForCleanup,
  type WorktreeAgentBuckets,
} from "../worktreeAgentBuckets";
import type { PluginWorktreeAttention } from "../pluginPanelAttention";

const NOW = 1_700_000_000_000;

function run(runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return { runId, workspaceId: "p1", spawnedAt: NOW - 3_600_000, cwd: "/repo", ...overrides };
}

function buckets(
  runs: FleetRunRow[],
  { merged = false }: { merged?: boolean } = {}
): WorktreeAgentBuckets {
  return deriveWorktreeAgentBuckets(
    runs.map((r) => r.runId),
    indexFleetRuns(runs),
    merged
  );
}

const working = (id: string) => run(id, { agentState: "working" });
const atPrompt = (id: string, extra: Partial<FleetRunRow> = {}) =>
  run(id, { agentState: "waiting", waitingReason: "prompt", ...extra });
const ASK = { kind: "asked", quote: "Run the migration?", readAt: NOW, seen: false } as const;
const asking = (id: string) =>
  run(id, { agentState: "waiting", waitingReason: "approval", canopy: ASK });

describe("deriveWorktreeAgentBuckets", () => {
  it("counts a worktree with one working and one idle-at-prompt agent as Working only", () => {
    // The issue's own example: the idle agent has already been looked at.
    const seen = atPrompt("b", { handBack: { stoppedAt: NOW - 1000, seenAt: NOW } });
    expect(buckets([working("a"), seen])).toEqual({
      working: true,
      attention: false,
      finished: false,
      finishedUnseen: false,
      cleanup: false,
    });
  });

  it("puts a single agent idle at its prompt in Finished, unseen until looked at", () => {
    const unseen = atPrompt("a", { handBack: { stoppedAt: NOW - 1000 } });
    expect(buckets([unseen])).toMatchObject({
      finished: true,
      finishedUnseen: true,
      attention: false,
    });
    const seen = atPrompt("a", { handBack: { stoppedAt: NOW - 1000, seenAt: NOW } });
    expect(buckets([seen])).toMatchObject({ finished: true, finishedUnseen: false });
  });

  it("leaves a stop with no hand-back record out of every bucket", () => {
    // Main saw no work stop, so nothing was handed back: the agent is idle, and
    // a prompt is not a question either.
    expect(buckets([atPrompt("a")])).toEqual(decodeWorktreeAgentBuckets(0));
    expect(buckets([run("a", { agentState: "completed", since: NOW })])).toEqual(
      decodeWorktreeAgentBuckets(0)
    );
  });

  it("lets Working and Attention overlap", () => {
    expect(buckets([working("a"), asking("b")])).toMatchObject({
      working: true,
      attention: true,
      finished: false,
    });
  });

  it("keeps an error wait, or an ask Canopy read and nobody has, in Attention whatever the hand-back says", () => {
    const handBack = { stoppedAt: NOW - 1000, seenAt: NOW };
    const error = run("a", { agentState: "waiting", waitingReason: "error", handBack });
    expect(buckets([error]).attention).toBe(true);
    for (const waitingReason of ["approval", "question"] as const) {
      const r = run("a", { agentState: "waiting", waitingReason, handBack, canopy: ASK });
      expect(buckets([r]).attention).toBe(true);
    }
  });

  it("reads an approval or question wait no reading placed as unread until looked at, never Attention", () => {
    for (const waitingReason of ["approval", "question"] as const) {
      const unseen = run("a", { agentState: "waiting", waitingReason, wait: { stoppedAt: NOW } });
      expect(buckets([unseen])).toMatchObject({
        attention: false,
        finished: true,
        finishedUnseen: true,
      });
      const looked = run("a", {
        agentState: "waiting",
        waitingReason,
        wait: { stoppedAt: NOW - 1000, seenAt: NOW },
      });
      expect(buckets([looked])).toEqual(decodeWorktreeAgentBuckets(0));
    }
  });

  it("drops parked and snoozed asks out of Attention", () => {
    const parked = run("a", { ...asking("a"), park: { parkedAt: NOW } });
    const snoozed = run("b", {
      ...asking("b"),
      snooze: { snoozedAt: NOW, until: NOW + 60_000 },
    } as Partial<FleetRunRow>);
    expect(buckets([parked, snoozed])).toEqual(decodeWorktreeAgentBuckets(0));
  });

  it("keeps a parked or snoozed agent that is still working in Working", () => {
    // A park shelves demands, not work: a merged worktree must not read as
    // ready for cleanup while an agent in it is running.
    const snoozed = run("a", {
      agentState: "working",
      snooze: { snoozedAt: NOW, until: NOW + 60_000 },
    } as Partial<FleetRunRow>);
    const parked = run("b", { agentState: "directing", park: { parkedAt: NOW } });
    for (const r of [snoozed, parked]) {
      expect(buckets([r], { merged: true })).toMatchObject({
        working: true,
        finished: false,
        cleanup: false,
      });
    }
  });

  it("counts a quiet agent as Working", () => {
    expect(buckets([run("a", { agentState: "working", quietSince: NOW })]).working).toBe(true);
  });

  it("leaves idle- or exited-only worktrees in All only", () => {
    expect(buckets([run("a", { agentState: "idle" }), run("b", { agentState: "exited" })])).toEqual(
      decodeWorktreeAgentBuckets(0)
    );
  });

  it("ignores agent panels the fleet has not reported", () => {
    expect(deriveWorktreeAgentBuckets(["missing"], indexFleetRuns(null), false)).toEqual(
      decodeWorktreeAgentBuckets(0)
    );
  });

  it("routes a merged worktree with no agents to Finished and cleanup", () => {
    expect(buckets([], { merged: true })).toMatchObject({
      finished: true,
      cleanup: true,
      finishedUnseen: false,
    });
  });

  it("keeps a merged worktree out of Finished while an agent is asking or working", () => {
    expect(buckets([asking("a")], { merged: true })).toMatchObject({
      attention: true,
      finished: false,
      cleanup: false,
    });
    expect(buckets([working("a")], { merged: true })).toMatchObject({
      finished: false,
      cleanup: false,
    });
  });
});

describe("encodeWorktreeAgentBuckets", () => {
  it("round-trips every combination", () => {
    for (let bits = 0; bits < 32; bits++) {
      expect(encodeWorktreeAgentBuckets(decodeWorktreeAgentBuckets(bits))).toBe(bits);
    }
  });
});

describe("isWorktreeMergedForCleanup", () => {
  type MergeFacts = Pick<WorktreeState, "isMainWorktree" | "worktreeChanges" | "linked">;

  function facts(prState: NormalizedPRState, overrides: Partial<MergeFacts> = {}): MergeFacts {
    return {
      isMainWorktree: false,
      worktreeChanges: { worktreeId: "/wt", rootPath: "/wt", changes: [], changedFileCount: 0 },
      linked: {
        providerId: "github",
        pr: {
          ref: { providerId: "github", owner: "o", repo: "r", number: 7, rawData: {} },
          url: "https://example.test/pull/7",
          state: prState,
        },
      },
      ...overrides,
    };
  }

  it("is true for a merged non-main worktree with loaded git status", () => {
    expect(isWorktreeMergedForCleanup(facts("merged"))).toBe(true);
  });

  it("is false for the main worktree, unloaded status, or an unmerged PR", () => {
    expect(isWorktreeMergedForCleanup(facts("merged", { isMainWorktree: true }))).toBe(false);
    expect(isWorktreeMergedForCleanup(facts("merged", { worktreeChanges: null }))).toBe(false);
    expect(isWorktreeMergedForCleanup(facts("merged", { linked: null }))).toBe(false);
    for (const state of ["open", "closed", "declined"] as const) {
      expect(isWorktreeMergedForCleanup(facts(state))).toBe(false);
    }
  });
});

describe("deriveWorktreeAgentBuckets with Canopy's readings", () => {
  const ASKED = {
    kind: "asked",
    quote: "Want me to update the tests too?",
    readAt: NOW,
    seen: false,
  } as const;

  it("moves a seen hand-back that asks something out of Finished and into Attention", () => {
    const seen = { handBack: { stoppedAt: NOW - 1000, seenAt: NOW } };
    expect(buckets([atPrompt("a", seen)]).finished).toBe(true);
    const asked = buckets([atPrompt("a", { ...seen, canopy: ASKED })]);
    expect(asked).toMatchObject({ attention: true, finished: false });
    // Once the user has read the ask it is neither: the run hasn't finished.
    const read = buckets([atPrompt("a", { ...seen, canopy: { ...ASKED, seen: true } })]);
    expect(read).toEqual(decodeWorktreeAgentBuckets(0));
  });

  it("files a question wait the reading shows asks nothing as Finished, by the reading's read mark", () => {
    // The record is the stop before, already seen: a question wait never makes one.
    const wait = run("a", {
      agentState: "waiting",
      waitingReason: "question",
      handBack: { stoppedAt: NOW - 60_000, seenAt: NOW - 50_000 },
    });
    expect(buckets([wait]).attention).toBe(false);
    const NOT_ASKING = { kind: "not-asking", quote: "All tests pass.", readAt: NOW } as const;
    const cleared = buckets([{ ...wait, canopy: { ...NOT_ASKING, seen: false } }]);
    expect(cleared).toMatchObject({ attention: false, finished: true, finishedUnseen: true });
    const read = buckets([{ ...wait, canopy: { ...NOT_ASKING, seen: true } }]);
    expect(read).toMatchObject({ attention: false, finished: true, finishedUnseen: false });
  });

  it("keeps a stalled agent in Working: the sidebar has no Quiet bucket", () => {
    const stalled = run("a", {
      agentState: "working",
      canopy: { kind: "stalled", quote: "Running", readAt: NOW, stalledSince: NOW - 900_000 },
    });
    expect(buckets([stalled])).toMatchObject({ working: true, attention: false });
  });
});

describe("deriveWorktreeAgentBuckets with plugin panel rows (#13821)", () => {
  const plugin = (facts: Partial<PluginWorktreeAttention>): PluginWorktreeAttention => ({
    working: false,
    attention: false,
    finished: false,
    unseen: false,
    ...facts,
  });

  it("puts a worktree with only a waiting plugin panel in Attention", () => {
    expect(deriveWorktreeAgentBuckets([], new Map(), false, plugin({ attention: true }))).toEqual({
      working: false,
      attention: true,
      finished: false,
      finishedUnseen: false,
      cleanup: false,
    });
  });

  it("keeps a finished agent's worktree out of Finished while a plugin panel is waiting", () => {
    const handedBack = atPrompt("a", { handBack: { stoppedAt: NOW - 1000 } });
    expect(buckets([handedBack]).finished).toBe(true);
    const withPlugin = deriveWorktreeAgentBuckets(
      ["a"],
      indexFleetRuns([handedBack]),
      false,
      plugin({ attention: true })
    );
    expect(withPlugin).toMatchObject({ attention: true, finished: false, finishedUnseen: false });
  });

  it("reads an unread plugin report as Finished, unseen, and a working one as Working", () => {
    expect(
      deriveWorktreeAgentBuckets([], new Map(), false, plugin({ finished: true, unseen: true }))
    ).toMatchObject({ finished: true, finishedUnseen: true });
    expect(
      deriveWorktreeAgentBuckets([], new Map(), true, plugin({ working: true }))
    ).toMatchObject({ working: true, finished: false, cleanup: false });
  });
});

describe("indexFleetRuns", () => {
  it("builds one index per runs array, so every surface in a view shares it", () => {
    const runs = [working("a"), atPrompt("b")];
    const index = indexFleetRuns(runs);
    expect(indexFleetRuns(runs)).toBe(index);
    expect(index.get("b")).toBe(runs[1]);
  });

  it("keeps each array's index while callers interleave older and newer snapshots", () => {
    const first = [working("a")];
    const next = [asking("a")];
    const firstIndex = indexFleetRuns(first);
    const nextIndex = indexFleetRuns(next);
    expect(nextIndex).not.toBe(firstIndex);
    expect(indexFleetRuns(first)).toBe(firstIndex);
    expect(indexFleetRuns(next)).toBe(nextIndex);
    expect(indexFleetRuns(first).get("a")).toBe(first[0]);
    expect(indexFleetRuns(next).get("a")).toBe(next[0]);
  });

  it("reads an absent or empty fleet as one shared empty index", () => {
    const empty = indexFleetRuns(null);
    expect(empty.size).toBe(0);
    expect(indexFleetRuns(undefined)).toBe(empty);
    expect(indexFleetRuns([])).toBe(empty);
  });
});
