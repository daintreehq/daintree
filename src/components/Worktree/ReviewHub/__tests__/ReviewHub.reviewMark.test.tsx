/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { StagingStatus, WorktreeState } from "@shared/types";
import type {
  ReviewMarkCaptureOutcome,
  ReviewMarkCompareOutcome,
  ReviewMarkSaveOutcome,
  ReviewMarkSummary,
  ReviewMarksSnapshot,
} from "@shared/types/ipc/reviewMarks";
import type { ReviewComparisonResult } from "@shared/types/reviewComparison";

const { worktreeStoreData, portListeners } = vi.hoisted(() => ({
  worktreeStoreData: { current: new Map<string, Partial<WorktreeState>>() },
  portListeners: new Map<string, (data: unknown) => void>(),
}));

vi.mock("@/utils/debounce", () => ({
  debounce: (fn: (...args: unknown[]) => void) => {
    const immediate = (...args: unknown[]) => fn(...args);
    immediate.cancel = vi.fn();
    immediate.flush = vi.fn();
    return immediate;
  },
}));

vi.mock("@/hooks", () => ({
  useTruncationDetection: vi.fn(() => ({ ref: vi.fn(), isTruncated: false })),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (
    selector: (state: { worktrees: Map<string, Partial<WorktreeState>> }) => unknown
  ) => selector({ worktrees: worktreeStoreData.current }),
}));

vi.mock("@/panels/diff/useWorktreeIdForPath", () => ({
  useWorktreeIdForPath: (path: string | undefined) => path,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ReviewHubContent } from "../ReviewHubContent";
import { resetStagingStatusCacheForTests } from "../stagingStatusCache";
import { _resetReviewMarksStoreForTesting, useReviewMarksStore } from "@/store/reviewMarksStore";
import {
  _resetReviewHubMarkTargetsForTesting,
  findReviewHubMarkTarget,
} from "../reviewHubMarkTargets";

const WT = "/home/user/project-wt";
const SETTLE_MS = 50;
const COMMIT = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const PROJECT = "p".repeat(64);

const status: StagingStatus = {
  staged: [],
  unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: false,
  pushDestination: { remote: "origin", branch: "feature/test" },
  pullSource: { remote: "origin", branch: "feature/test" },
  repoState: "DIRTY",
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
};

function captured(captureId: string): ReviewMarkCaptureOutcome {
  return {
    status: "captured",
    capture: {
      captureId,
      capturedAt: 1,
      head: { kind: "branch", branch: "feature/test", commit: COMMIT },
      complete: true,
      pathCount: 1,
    },
  };
}

function summary(revision: number): ReviewMarkSummary {
  return {
    markedAt: Date.now() - 2 * 3_600_000,
    capturedAt: 1,
    head: { kind: "branch", branch: "feature/test", commit: COMMIT },
    base: { ref: null, tip: null },
    complete: true,
    pathCount: 1,
    revision,
  };
}

function snapshot(marks: Record<string, ReviewMarkSummary>, revision: number): ReviewMarksSnapshot {
  return { projectId: PROJECT, marks, revision };
}

const COMPARED = {
  comparedAt: 1,
  head: { kind: "branch" as const, branch: "feature/test", commit: COMMIT },
  base: {
    reviewed: { ref: null, tip: null, mergeBases: [] },
    current: { ref: null, tip: null, mergeBases: [] },
  },
};

function comparable(paths: string[], commits = 0): ReviewComparisonResult {
  return {
    state: "comparable",
    ...COMPARED,
    files: paths.map((path) => ({
      path,
      status: "modified" as const,
      index: "unchanged" as const,
      worktree: "changed" as const,
      baseUpdate: "none" as const,
      reviewed: { kind: "unlisted" as const, entry: null },
      current: { kind: "unlisted" as const, entry: null },
    })),
    commits: {
      kind: "listed",
      history: "extended",
      commits: Array.from({ length: commits }, (_, i) => ({
        oid: String(i).repeat(40).slice(0, 40),
        parents: [],
        subject: "work",
        authorName: "a",
        authorEmail: "a@example.com",
        authoredAt: 1,
        kind: "new" as const,
      })),
      truncated: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let bridge: {
  capture: ReturnType<typeof vi.fn>;
  markCaptured: ReturnType<typeof vi.fn>;
  compare: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};
let getStagingStatus: ReturnType<typeof vi.fn>;

function fireWorktreeEvent(): void {
  act(() => portListeners.get("worktree-update")?.({ worktree: { path: WT } }));
}

function renderHub() {
  return render(
    <ReviewHubContent isOpen={true} worktreePath={WT} panelId="review-1" onClose={vi.fn()} />
  );
}

beforeEach(() => {
  resetStagingStatusCacheForTests();
  _resetReviewMarksStoreForTesting();
  _resetReviewHubMarkTargetsForTesting();
  portListeners.clear();
  worktreeStoreData.current = new Map([
    [
      WT,
      {
        id: WT,
        path: WT,
        name: "wt",
        branch: "feature/test",
        isCurrent: true,
        worktreeChanges: null,
        lastActivityTimestamp: null,
      },
    ],
  ]);
  getStagingStatus = vi.fn().mockResolvedValue(status);
  bridge = {
    capture: vi.fn().mockResolvedValue(captured("c1")),
    markCaptured: vi.fn(),
    compare: vi.fn().mockResolvedValue({ status: "none" } satisfies ReviewMarkCompareOutcome),
    clear: vi.fn(),
  };
  Object.defineProperty(window, "electron", {
    value: {
      git: {
        getStagingStatus,
        stageFile: vi.fn().mockResolvedValue(undefined),
        unstageFile: vi.fn().mockResolvedValue(undefined),
        stageAll: vi.fn().mockResolvedValue(undefined),
        unstageAll: vi.fn().mockResolvedValue(undefined),
        compareWorktrees: vi.fn().mockResolvedValue({ files: [] }),
      },
      system: { openInEditor: vi.fn() },
      worktreePort: {
        onEvent: (type: string, callback: (data: unknown) => void) => {
          const previous = portListeners.get(type);
          portListeners.set(type, (data) => {
            previous?.(data);
            callback(data);
          });
          return () => {};
        },
      },
      reviewMarks: {
        ...bridge,
        hydrate: vi.fn().mockResolvedValue(snapshot({}, 0)),
        mark: vi.fn(),
        onChanged: vi.fn(() => () => {}),
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function markButtonReady(): Promise<HTMLElement> {
  const button = await screen.findByTestId("review-hub-mark-reviewed");
  await waitFor(() => expect(button.getAttribute("aria-disabled")).toBeNull());
  return button;
}

describe("Review Hub review marks (#14585)", () => {
  it("marks the capture behind the status on screen, with the revision held before it", async () => {
    useReviewMarksStore.setState({ marks: {}, revision: 4, loaded: true });
    bridge.markCaptured.mockResolvedValue({
      status: "saved",
      snapshot: snapshot({ [WT]: summary(5) }, 5),
    } satisfies ReviewMarkSaveOutcome);
    renderHub();

    fireEvent.click(await markButtonReady());

    await waitFor(() => expect(bridge.markCaptured).toHaveBeenCalledWith(WT, "c1", 4));
  });

  it("marks the newer capture once a background refresh that rewrote a file is on screen", async () => {
    bridge.markCaptured.mockResolvedValue({
      status: "saved",
      snapshot: snapshot({ [WT]: summary(1) }, 1),
    } satisfies ReviewMarkSaveOutcome);
    renderHub();
    await markButtonReady();
    const reads = getStagingStatus.mock.calls.length;

    // An agent rewrites src/app.ts: same path, same status, new content.
    bridge.capture.mockResolvedValue(captured("c2"));
    fireWorktreeEvent();
    await waitFor(() => expect(getStagingStatus.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(bridge.capture).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(await markButtonReady());

    await waitFor(() => expect(bridge.markCaptured).toHaveBeenCalledWith(WT, "c2", 0));
  });

  it("never attaches a capture that landed after the status read on screen was sent", async () => {
    bridge.markCaptured.mockResolvedValue({
      status: "saved",
      snapshot: snapshot({ [WT]: summary(1) }, 1),
    } satisfies ReviewMarkSaveOutcome);
    renderHub();
    await markButtonReady();

    // Refresh sends a status read at once, beside a new capture. The capture
    // lands before the read answers: what it holds may have arrived after the
    // read, so the read must still show the capture from before it went out.
    const read = deferred<StagingStatus>();
    const slowCapture = deferred<ReviewMarkCaptureOutcome>();
    getStagingStatus.mockReturnValueOnce(read.promise);
    bridge.capture.mockReturnValueOnce(slowCapture.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(bridge.capture).toHaveBeenCalledTimes(2));
    // The reads that follow the capture stay out, so only the first answers.
    getStagingStatus.mockReturnValue(new Promise(() => {}));
    await act(async () => slowCapture.resolve(captured("c3")));
    await act(async () => read.resolve(status));

    fireEvent.click(await markButtonReady());

    await waitFor(() => expect(bridge.markCaptured).toHaveBeenLastCalledWith(WT, "c1", 0));
  });

  it("marks again from a capture taken after its own mark", async () => {
    bridge.markCaptured.mockResolvedValue({
      status: "saved",
      snapshot: snapshot({ [WT]: summary(1) }, 1),
    } satisfies ReviewMarkSaveOutcome);
    renderHub();
    const button = await markButtonReady();
    bridge.capture.mockResolvedValue(captured("c2"));
    fireEvent.click(button);
    await waitFor(() => expect(bridge.markCaptured).toHaveBeenCalledWith(WT, "c1", 0));
    await waitFor(() => expect(bridge.capture).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(findReviewHubMarkTarget({ focusedPanelId: "review-1" })?.markBlockedReason()).toBe(
        null
      )
    );
    await act(async () => {
      await findReviewHubMarkTarget({ focusedPanelId: "review-1" })?.markReviewed();
    });

    expect(bridge.markCaptured).toHaveBeenLastCalledWith(WT, "c2", 1);
  });

  it("can't mark before the hub has a capture behind what it shows", async () => {
    bridge.capture.mockReturnValue(new Promise(() => {}));
    renderHub();

    const button = await screen.findByTestId("review-hub-mark-reviewed");
    await waitFor(() => screen.getByText("app.ts"));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(bridge.markCaptured).not.toHaveBeenCalled();
  });

  it("says when and at which commit, and counts what's new from a complete comparison", async () => {
    useReviewMarksStore.setState({ marks: { [WT]: summary(2) }, revision: 2, loaded: true });
    bridge.compare.mockResolvedValue({
      status: "compared",
      markRevision: 2,
      result: comparable(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], 3),
    } satisfies ReviewMarkCompareOutcome);
    renderHub();

    const line = await screen.findByTestId("review-hub-review-mark");
    expect(line.textContent).toContain("Reviewed 2h ago at a1b2c3d");
    await waitFor(() =>
      expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe(
        "3 commits, 5 files since"
      )
    );
  });

  it("says nothing is new only when the comparison is complete", async () => {
    useReviewMarksStore.setState({ marks: { [WT]: summary(2) }, revision: 2, loaded: true });
    bridge.compare.mockResolvedValue({
      status: "compared",
      markRevision: 2,
      result: comparable([]),
    } satisfies ReviewMarkCompareOutcome);
    renderHub();

    await waitFor(() =>
      expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe(
        "Nothing new since review"
      )
    );

    // The worktree moves: the old answer no longer stands while the next runs.
    const next = deferred<ReviewMarkCompareOutcome>();
    bridge.compare.mockReturnValueOnce(next.promise);
    fireWorktreeEvent();
    await waitFor(() =>
      expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe("Comparing…")
    );
    await act(async () =>
      next.resolve({
        status: "compared",
        markRevision: 2,
        result: {
          state: "incomplete",
          reasons: ["current-state-incomplete"],
          gaps: [],
          ...COMPARED,
          files: [],
          commits: { kind: "listed", history: "extended", commits: [], truncated: false },
        },
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe(
        "Comparison incomplete: the worktree couldn't be read in full"
      )
    );
  });

  it("says a failed comparison failed and compares again on Retry", async () => {
    useReviewMarksStore.setState({ marks: { [WT]: summary(2) }, revision: 2, loaded: true });
    bridge.compare.mockResolvedValueOnce({
      status: "compared",
      markRevision: 2,
      result: { state: "failed", reason: "deadline", message: "The comparison ran out of time." },
    } satisfies ReviewMarkCompareOutcome);
    renderHub();

    await waitFor(() =>
      expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe(
        "Couldn't compare with the review"
      )
    );
    bridge.compare.mockResolvedValueOnce({
      status: "compared",
      markRevision: 2,
      result: comparable(["a.ts"]),
    } satisfies ReviewMarkCompareOutcome);
    fireEvent.click(screen.getByTestId("review-hub-review-mark-retry"));

    await waitFor(() =>
      expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe("1 file since")
    );
  });

  it("says which files the new mark doesn't cover when the work changed after the hub read it", async () => {
    bridge.markCaptured.mockImplementation(async () => {
      const reply = snapshot({ [WT]: summary(7) }, 7);
      return { status: "saved", snapshot: reply } satisfies ReviewMarkSaveOutcome;
    });
    bridge.compare.mockImplementation(async () => ({
      status: "compared",
      markRevision: 7,
      result: comparable(["src/app.ts"]),
    }));
    renderHub();

    fireEvent.click(await markButtonReady());

    const notice = await screen.findByTestId("review-hub-review-mark-notice");
    expect(notice.textContent).toContain("Not covered: src/app.ts.");
    expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe("1 file since");
  });

  it("clears the mark and drops the line once the host says it's gone", async () => {
    useReviewMarksStore.setState({ marks: { [WT]: summary(2) }, revision: 2, loaded: true });
    bridge.clear.mockResolvedValue({ status: "cleared", snapshot: snapshot({}, 3) });
    renderHub();

    fireEvent.click(await screen.findByTestId("review-hub-review-mark-clear"));

    await waitFor(() => expect(bridge.clear).toHaveBeenCalledWith(WT, 2));
    await waitFor(() => expect(screen.queryByTestId("review-hub-review-mark")).toBeNull());
  });

  it("reads status twice on open: once straight away, once after the capture", async () => {
    renderHub();
    await markButtonReady();
    // Long enough for any read the lane would still send to have gone out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    });

    // Staging status is rate limited on the host; the lane adds one read per capture.
    expect(getStagingStatus).toHaveBeenCalledTimes(2);
    expect(bridge.capture).toHaveBeenCalledTimes(1);
  });

  it("keeps the capture on screen when the opening's first read answers last", async () => {
    bridge.markCaptured.mockResolvedValue({
      status: "saved",
      snapshot: snapshot({ [WT]: summary(1) }, 1),
    } satisfies ReviewMarkSaveOutcome);
    const firstRead = deferred<StagingStatus>();
    getStagingStatus.mockReturnValueOnce(firstRead.promise);
    renderHub();
    const button = await markButtonReady();

    // The read sent before the capture landed answers after the one sent after it.
    await act(async () => firstRead.resolve(status));

    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(bridge.markCaptured).toHaveBeenCalledWith(WT, "c1", 0));
  });

  it("answers whether it can mark while another component renders, as the palette asks", async () => {
    renderHub();
    await markButtonReady();

    function PaletteProbe() {
      const reason = findReviewHubMarkTarget({ focusedPanelId: "review-1" })?.markBlockedReason();
      return <span data-testid="palette-probe">{reason === null ? "ready" : String(reason)}</span>;
    }
    render(<PaletteProbe />);

    expect(screen.getByTestId("palette-probe").textContent).toBe("ready");
  });

  it("still names what isn't covered when the mark's push and its comparison beat the reply", async () => {
    const reply = deferred<ReviewMarkSaveOutcome>();
    bridge.markCaptured.mockReturnValue(reply.promise);
    bridge.compare.mockResolvedValue({
      status: "compared",
      markRevision: 7,
      result: comparable(["src/app.ts"]),
    } satisfies ReviewMarkCompareOutcome);
    renderHub();
    fireEvent.click(await markButtonReady());

    act(() =>
      useReviewMarksStore.setState({ marks: { [WT]: summary(7) }, revision: 7, loaded: true })
    );
    await waitFor(() =>
      expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe("1 file since")
    );
    await act(async () =>
      reply.resolve({ status: "saved", snapshot: snapshot({ [WT]: summary(7) }, 7) })
    );

    const notice = await screen.findByTestId("review-hub-review-mark-notice");
    expect(notice.textContent).toContain("Not covered: src/app.ts.");
  });

  it("can mark the next worktree when it switches while a mark is still out", async () => {
    const other = "/home/user/other-wt";
    worktreeStoreData.current.set(other, {
      id: other,
      path: other,
      name: "other",
      branch: "feature/other",
      isCurrent: false,
      worktreeChanges: null,
      lastActivityTimestamp: null,
    });
    bridge.markCaptured.mockReturnValue(new Promise(() => {}));
    const view = renderHub();
    fireEvent.click(await markButtonReady());
    await waitFor(() => expect(bridge.markCaptured).toHaveBeenCalledTimes(1));

    view.rerender(
      <ReviewHubContent isOpen={true} worktreePath={other} panelId="review-1" onClose={vi.fn()} />
    );

    await markButtonReady();
    expect(bridge.capture).toHaveBeenLastCalledWith(other);
  });

  it("says the comparison failed once other windows' keep replacing it, and offers Retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    useReviewMarksStore.setState({ marks: { [WT]: summary(2) }, revision: 2, loaded: true });
    bridge.compare.mockResolvedValue({
      status: "compared",
      markRevision: 2,
      result: { state: "failed", reason: "superseded", message: "A newer comparison replaced it." },
    } satisfies ReviewMarkCompareOutcome);
    renderHub();

    await waitFor(
      () =>
        expect(screen.getByTestId("review-hub-review-mark-since").textContent).toBe(
          "Couldn't compare with the review"
        ),
      { timeout: 6_000 }
    );
    // The first ask and three more, spaced out.
    expect(bridge.compare).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("review-hub-review-mark-retry")).not.toBeNull();
  }, 10_000);
});
