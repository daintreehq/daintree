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
  viewCompletionWatermark,
  type WorktreeAgentBuckets,
} from "../worktreeAgentBuckets";

const NOW = 1_700_000_000_000;

function run(runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return { runId, workspaceId: "p1", spawnedAt: NOW - 3_600_000, cwd: "/repo", ...overrides };
}

function buckets(
  runs: FleetRunRow[],
  { merged = false, acknowledgedAt }: { merged?: boolean; acknowledgedAt?: number } = {}
): WorktreeAgentBuckets {
  return deriveWorktreeAgentBuckets(
    runs.map((r) => r.runId),
    indexFleetRuns(runs),
    acknowledgedAt,
    merged
  );
}

const working = (id: string) => run(id, { agentState: "working" });
const atPrompt = (id: string, extra: Partial<FleetRunRow> = {}) =>
  run(id, { agentState: "waiting", waitingReason: "prompt", ...extra });
const asking = (id: string) => run(id, { agentState: "waiting", waitingReason: "approval" });

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

  it("puts an agent at its prompt with no hand-back record in Finished, never unseen", () => {
    // Main saw no work stop, and nothing could ever mark it seen.
    expect(buckets([atPrompt("a")])).toMatchObject({ finished: true, finishedUnseen: false });
  });

  it("lets Working and Attention overlap", () => {
    expect(buckets([working("a"), asking("b")])).toMatchObject({
      working: true,
      attention: true,
      finished: false,
    });
  });

  it("keeps an approval, question or error wait in Attention after it has been seen", () => {
    for (const waitingReason of ["approval", "question", "error"] as const) {
      const r = run("a", {
        agentState: "waiting",
        waitingReason,
        handBack: { stoppedAt: NOW - 1000, seenAt: NOW },
      });
      expect(buckets([r], { acknowledgedAt: NOW + 1 }).attention).toBe(true);
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
    expect(deriveWorktreeAgentBuckets(["missing"], indexFleetRuns(null), undefined, false)).toEqual(
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

  it("dates an unrecorded completion against the watermark", () => {
    const stop = run("a", { agentState: "completed", since: NOW - 60_000 });
    expect(buckets([stop], { acknowledgedAt: NOW }).finishedUnseen).toBe(false);
    expect(buckets([stop], { acknowledgedAt: NOW - 120_000 }).finishedUnseen).toBe(true);
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

describe("viewCompletionWatermark", () => {
  it("reads the view's own project, then its scratch", () => {
    const projects = [
      { id: "p1", lastCompletionSeenAt: 5 },
      { id: "p2", lastCompletionSeenAt: 9 },
    ];
    const scratches = [{ id: "s1", lastCompletionSeenAt: 7 }];
    expect(viewCompletionWatermark("p2", projects, scratches)).toBe(9);
    expect(viewCompletionWatermark("s1", projects, scratches)).toBe(7);
    expect(viewCompletionWatermark("other", projects, scratches)).toBeUndefined();
    expect(viewCompletionWatermark(null, projects, scratches)).toBeUndefined();
  });
});
