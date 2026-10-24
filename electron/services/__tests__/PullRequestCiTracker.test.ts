import { describe, it, expect, vi } from "vitest";

import { PullRequestCiTracker, type PullRequestCiTrackerDeps } from "../PullRequestCiTracker.js";
import type { InternalLinkedPR } from "../pullRequestEntry.js";
import type { BatchLoader } from "../../workspace-host/batchLoader.js";
import type { CIStatus, RepoRef } from "../../../shared/types/forge.js";

const repo: RepoRef = { host: "github.com", owner: "o", repo: "r", rawData: null };

function entry(overrides: Partial<InternalLinkedPR> = {}): InternalLinkedPR {
  return {
    number: 7,
    title: "PR",
    url: "https://github.com/o/r/pull/7",
    state: "open",
    providerId: "daintree.github.github",
    stagnantPollCount: 0,
    ...overrides,
  };
}

function ci(state: CIStatus["state"], headSha?: string): CIStatus {
  return { state, total: 1, passed: 0, failed: 0, pending: 0, headSha };
}

function harness(entries: Array<[string, InternalLinkedPR]>) {
  const detectedPRs = new Map(entries);
  const pending: Array<(value: CIStatus | null) => void> = [];
  const load = vi.fn(() => new Promise<CIStatus | null>((resolve) => pending.push(resolve)));
  const deps = {
    detectedPRs,
    candidates: new Map<string, { issueNumber?: number; branchName?: string }>(),
    getRepo: () => repo,
    getLoader: () => ({ load }) as unknown as BatchLoader<number, CIStatus | null>,
    publish: vi.fn(),
    refreshBoost: vi.fn(() => false),
    scheduleRevalidation: vi.fn(),
  } satisfies PullRequestCiTrackerDeps;
  const tracker = new PullRequestCiTracker(deps);
  const settle = async (value: CIStatus | null) => {
    for (const resolve of pending.splice(0)) resolve(value);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { tracker, deps, load, settle, detectedPRs };
}

describe("PullRequestCiTracker", () => {
  it("enqueues and stamps every load synchronously so the fan-out coalesces", () => {
    const a = entry({ number: 1 });
    const b = entry({ number: 2 });
    const { tracker, load } = harness([
      ["wt-a", a],
      ["wt-b", b],
    ]);

    tracker.enrichPRWithCIStatus(a, repo);
    tracker.enrichPRWithCIStatus(b, repo);

    expect(load.mock.calls).toEqual([[1], [2]]);
    expect(a.lastCiCheckAt).toBeTypeOf("number");
    expect(b.lastCiCheckAt).toBeTypeOf("number");
  });

  it("never lands a result on a distinct entry that moved off the read's commit", async () => {
    const source = entry({ ciStatus: "pending" });
    const pushed = entry({ displacedHeadSha: "old" });
    const { tracker, deps, settle } = harness([
      ["wt-source", source],
      ["wt-pushed", pushed],
    ]);

    tracker.enrichPRWithCIStatus(source, repo);
    await settle(ci("failure", "old"));

    expect(source.ciStatus).toBe("failure");
    expect(pushed.ciStatus).toBeUndefined();
    expect(pushed._ciStatus).toBeUndefined();
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.publish.mock.calls[0][0]).toMatchObject({
      worktreeId: "wt-source",
      prCiStatus: "failure",
    });
  });

  it("disabling sweeps only pending entries and drops a result still in flight", async () => {
    const pending = entry({ number: 1, ciStatus: "pending" });
    const green = entry({ number: 2, ciStatus: "success" });
    const { tracker, deps, settle } = harness([
      ["wt-pending", pending],
      ["wt-green", green],
    ]);

    tracker.enrichPRWithCIStatus(pending, repo);
    tracker.setCIEnrichmentEnabled(false);

    expect(pending.ciStatus).toBeUndefined();
    expect(pending.needsCiBackfill).toBe(true);
    expect(green.ciStatus).toBe("success");
    expect(deps.publish).toHaveBeenCalledTimes(1);
    const swept = deps.publish.mock.calls[0][0];
    expect(swept.worktreeId).toBe("wt-pending");
    expect("prCiStatus" in swept || "ciStatus" in swept || "isCiStatusLoading" in swept).toBe(
      false
    );
    expect(deps.scheduleRevalidation).toHaveBeenCalledTimes(1);

    await settle(ci("success"));
    expect(pending.ciStatus).toBeUndefined();
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it("closes an expired grace window even for a PR revalidation already read", () => {
    const read = entry({ number: 1, ciGraceUntil: Date.now() - 1 });
    const unknown = entry({ number: 2 });
    const { tracker, load } = harness([
      ["wt-read", read],
      ["wt-unknown", unknown],
    ]);

    tracker.enrichDueCiStatuses(new Set([1]), repo);

    expect(read.ciGraceUntil).toBeUndefined();
    // No checks, no backfill debt and no open wait: nothing to re-read.
    expect(load).not.toHaveBeenCalled();
  });
});
