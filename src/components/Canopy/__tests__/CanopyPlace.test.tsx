// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { buildPilotGroups } from "@/components/Pilot/pilotRows";
import { buildCanopyInbox, type CanopyItem } from "../canopyModel";
import { CanopyPlace, __resetCanopyPlaceForTests } from "../CanopyPlace";

const NOW = 1_700_000_000_000;
const SPAWNED_AT = NOW - 3_600_000;
const REREAD_MS = 15_000;

function itemFor(run: Partial<FleetRunRow> = {}): CanopyItem {
  const fleetRun: FleetRunRow = {
    runId: "run-1",
    workspaceId: "p1",
    spawnedAt: SPAWNED_AT,
    cwd: "/worktrees/login-fix",
    agentId: "claude",
    agentState: "working",
    title: "Fix login",
    since: NOW - 60_000,
    ...run,
  };
  const groups = buildPilotGroups([fleetRun], {
    workspaces: new Map([["p1", { kind: "project", name: "app", emoji: "🦊" }]]),
    currentWorkspaceId: null,
    nowMs: NOW,
  });
  return buildCanopyInbox(groups, new Map())[0]!;
}

/** Branch reads that settle only when the test says, in whatever order it says. */
function heldReads() {
  const reads: Array<{
    resolve: (branch: string | null) => void;
    reject: (error: Error) => void;
  }> = [];
  const runBranch = vi.fn(
    (_runId: string, _target: { spawnedAt: number }) =>
      new Promise<string | null>((resolve, reject) => {
        reads.push({ resolve, reject });
      })
  );
  return { reads, runBranch };
}

function shownBranch(): string | null {
  const place = document.querySelector<HTMLElement>("[data-canopy-place]");
  const label = place?.querySelector(".font-mono");
  return label?.textContent ?? null;
}

/** What the place says after the project: a branch, or the folder in its stead. */
function shownPlace(): { kind: string; text: string } | null {
  const place = document.querySelector<HTMLElement>("[data-canopy-place]");
  const kind = place?.querySelector(".sr-only")?.textContent;
  const text = place?.querySelector(".font-mono")?.textContent;
  return kind && text ? { kind, text } : null;
}

async function settle(fn: () => void) {
  await act(async () => {
    fn();
  });
}

beforeEach(() => {
  __resetCanopyPlaceForTests();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CanopyPlace branch reads", () => {
  it("keeps the newer branch when an earlier, slower read lands last", async () => {
    const item = itemFor();
    const { reads, runBranch } = heldReads();
    render(<CanopyPlace item={item} id="place" hostId="remote" runBranch={runBranch} />);
    expect(reads).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(REREAD_MS);
    });
    expect(reads).toHaveLength(2);

    await settle(() => reads[1]!.resolve("feature/after-checkout"));
    expect(shownBranch()).toBe("feature/after-checkout");

    await settle(() => reads[0]!.resolve("feature/before-checkout"));
    expect(shownBranch()).toBe("feature/after-checkout");

    // The cache the next visit starts from holds the newer branch too.
    cleanup();
    const next = heldReads();
    render(<CanopyPlace item={item} id="place" hostId="remote" runBranch={next.runBranch} />);
    expect(shownBranch()).toBe("feature/after-checkout");
  });

  it("lets a failed earlier read that lands last leave the newer branch shown", async () => {
    const { reads, runBranch } = heldReads();
    render(<CanopyPlace item={itemFor()} id="place" hostId="remote" runBranch={runBranch} />);
    act(() => {
      vi.advanceTimersByTime(REREAD_MS);
    });

    await settle(() => reads[1]!.resolve("feature/after-checkout"));
    // Even once the cache has let the branch go, the read on screen stands.
    __resetCanopyPlaceForTests();
    await settle(() => reads[0]!.reject(new Error("Too many requests")));
    expect(shownBranch()).toBe("feature/after-checkout");
  });

  it("takes an earlier read's branch when the newer read fails", async () => {
    const { reads, runBranch } = heldReads();
    render(<CanopyPlace item={itemFor()} id="place" hostId="remote" runBranch={runBranch} />);
    act(() => {
      vi.advanceTimersByTime(REREAD_MS);
    });

    await settle(() => reads[1]!.reject(new Error("Too many requests")));
    await settle(() => reads[0]!.resolve("feature/before-checkout"));
    expect(shownBranch()).toBe("feature/before-checkout");
  });

  it("drops a read from before the agent moved on when it lands after the next one", async () => {
    const { reads, runBranch } = heldReads();
    const { rerender } = render(
      <CanopyPlace item={itemFor()} id="place" hostId="remote" runBranch={runBranch} />
    );
    rerender(
      <CanopyPlace
        item={itemFor({ agentState: "waiting", waitingReason: "approval" })}
        id="place"
        hostId="remote"
        runBranch={runBranch}
      />
    );
    expect(reads).toHaveLength(2);

    await settle(() => reads[1]!.resolve("feature/after-checkout"));
    await settle(() => reads[0]!.resolve("feature/before-checkout"));
    expect(shownBranch()).toBe("feature/after-checkout");
  });

  it("keeps the branch through a failed read and takes the next good one", async () => {
    const item = itemFor();
    const { reads, runBranch } = heldReads();
    render(<CanopyPlace item={item} id="place" hostId="remote" runBranch={runBranch} />);
    await settle(() => reads[0]!.resolve("feature/login"));
    expect(shownPlace()).toEqual({ kind: "on branch", text: "feature/login" });

    act(() => {
      vi.advanceTimersByTime(REREAD_MS);
    });
    await settle(() => reads[1]!.reject(new Error("Couldn't read the branch")));
    expect(shownPlace()).toEqual({ kind: "on branch", text: "feature/login" });

    // Coming back to the run starts from the branch, not from the failure.
    cleanup();
    const next = heldReads();
    render(<CanopyPlace item={item} id="place" hostId="remote" runBranch={next.runBranch} />);
    expect(shownPlace()).toEqual({ kind: "on branch", text: "feature/login" });

    await settle(() => next.reads[0]!.resolve("feature/after-checkout"));
    expect(shownPlace()).toEqual({ kind: "on branch", text: "feature/after-checkout" });
  });

  it("names the folder once a read says the branch is gone", async () => {
    const item = itemFor();
    const { reads, runBranch } = heldReads();
    render(<CanopyPlace item={item} id="place" hostId="remote" runBranch={runBranch} />);
    await settle(() => reads[0]!.resolve("feature/login"));

    act(() => {
      vi.advanceTimersByTime(REREAD_MS);
    });
    await settle(() => reads[1]!.resolve(null));
    expect(shownPlace()).toEqual({ kind: "in folder", text: "login-fix" });

    cleanup();
    render(
      <CanopyPlace item={item} id="place" hostId="remote" runBranch={heldReads().runBranch} />
    );
    expect(shownPlace()).toEqual({ kind: "in folder", text: "login-fix" });
  });

  it("still takes each read in turn when they land in the order they went out", async () => {
    const { reads, runBranch } = heldReads();
    render(<CanopyPlace item={itemFor()} id="place" hostId="remote" runBranch={runBranch} />);
    await settle(() => reads[0]!.resolve("main"));
    expect(shownBranch()).toBe("main");

    act(() => {
      vi.advanceTimersByTime(REREAD_MS);
    });
    await settle(() => reads[1]!.resolve("feature/next"));
    expect(shownBranch()).toBe("feature/next");
  });
});
