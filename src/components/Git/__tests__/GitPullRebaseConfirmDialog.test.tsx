// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPullRebaseConfirmDialog } from "../GitPullRebaseConfirmDialog";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";

/**
 * Mirror of `GitPushConfirmDialog.test.tsx` for the rebase dialog. Both were
 * refactored onto the shared `buildGitRemoteOperationPreview` (#11538), and the
 * #9575 `confirmDisabled` load-state gate is per-dialog wiring — covering only
 * push would let a pull-only regression through.
 */

const mocks = vi.hoisted(() => ({ buildPreview: vi.fn() }));

vi.mock("@/components/Git/gitRemoteOperationPreview", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/Git/gitRemoteOperationPreview")>();
  return { ...actual, buildGitRemoteOperationPreview: mocks.buildPreview };
});

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function rebaseButton(): HTMLElement {
  return screen.getByRole("button", { name: "Pull and rebase" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("GitPullRebaseConfirmDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    if (useGitPullRebaseConfirmStore.getState().pendingConfirm) {
      useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
    }
    cleanup();
    vi.restoreAllMocks();
  });

  it("reads the preview through the shared builder, scoped to the requested cwd", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "feature/y",
      destination: { remote: "origin", branch: "feature/y" },
      pullSource: { remote: "origin", branch: "feature/y" },
      commits: [],
      pushRange: null,
      rebaseRange: { total: 0, rangeBasis: "tracked", behind: 0 },
    });
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(mocks.buildPreview).toHaveBeenCalledWith("/repo", "pull-rebase");
  });

  it("blocks approval while the preview is still loading", async () => {
    const gate = deferred<{
      branch: string;
      destination: { remote: string; branch: string };
      pullSource: { remote: string; branch: string };
      commits: never[];
      pushRange: null;
      rebaseRange: { total: number; rangeBasis: "tracked"; behind: number };
    }>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(rebaseButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve({
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [],
        pushRange: null,
        rebaseRange: { total: 0, rangeBasis: "tracked", behind: 0 },
      });
      await gate.promise;
    });

    expect(rebaseButton().hasAttribute("disabled")).toBe(false);
  });

  it("keeps approval blocked when the preview fetch fails", async () => {
    mocks.buildPreview.mockRejectedValue(new Error("git exploded"));
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(rebaseButton().hasAttribute("disabled")).toBe(true);
  });

  it("resolves the awaited confirm promise with the user's decision", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
      pushRange: null,
      rebaseRange: { total: 0, rangeBasis: "tracked", behind: 0 },
    });
    render(<GitPullRebaseConfirmDialog />);

    let decision: boolean | undefined;
    await act(async () => {
      void useGitPullRebaseConfirmStore
        .getState()
        .requestConfirmation("/repo")
        .then((ok) => {
          decision = ok;
        });
    });

    await act(async () => {
      rebaseButton().click();
    });

    expect(decision).toBe(true);
  });

  function cancelButton(): HTMLElement {
    return screen.getByRole("button", { name: "Cancel" });
  }

  function loaded(overrides: Record<string, unknown> = {}) {
    return {
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [{ hash: "abcdef1234567", message: "Fix the thing", author: "Ada" }],
      pushRange: null,
      rebaseRange: { total: 1, rangeBasis: "tracked" as const, behind: 0 },
      ...overrides,
    };
  }

  // The accessible name is what a screen reader announces when the dialog opens.
  // Interpolating a ref into it meant the name changed once the read landed —
  // silently, because nothing re-announces a renamed dialog — and on a failed read
  // it stayed on the placeholder for good. Asserted as a RULE (name before ===
  // name after), not against the literal string, so rewording the title is free.
  it("keeps one stable accessible name across the whole preview lifecycle", async () => {
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });
    const whileLoading = screen.getByRole("heading", { level: 2 }).textContent;

    await act(async () => {
      gate.resolve(loaded());
      await gate.promise;
    });
    const whenLoaded = screen.getByRole("heading", { level: 2 }).textContent;

    expect(whileLoading).toBe(whenLoaded);
    expect(whileLoading).not.toContain("main");
  });

  // The preview read must never disable the dialog's safe exit. AppDialog's
  // initial-focus pass finds Cancel by selector and calls `.focus()` without
  // checking it is enabled, so a disabled Cancel leaves focus outside the dialog
  // for the whole read — and takes the keyboard exit with it.
  it("leaves Cancel usable while the preview is still in flight", async () => {
    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(cancelButton().hasAttribute("disabled")).toBe(false);
    expect(rebaseButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve(loaded());
      await gate.promise;
    });
    expect(cancelButton().hasAttribute("disabled")).toBe(false);
  });

  // Scoped to what a component test can actually prove. The host stays mounted
  // across close/open, so the rows from the previous request must not survive into
  // the next one, and approval must go back to blocked until the new read lands.
  //
  // The `loadedFor` identity gate in the component defends a narrower window than
  // this — the frames between render and effect on a back-to-back supersede, where
  // `isLoading` has not been set yet and stale state would still read as settled.
  // That window is not reachable from here: `act` flushes the effect before any
  // assertion can run, so removing the gate does not change what this test sees.
  // Deliberately not asserted rather than asserted by a test that would pass
  // either way; the superseded-response half of the same hazard IS covered, by
  // `requestIdRef`.
  it("drops the old rows and re-blocks approval when a second worktree asks", async () => {
    mocks.buildPreview.mockResolvedValue(
      loaded({ commits: [{ hash: "aaaaaaa1111", message: "From repo A", author: "Ada" }] })
    );
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo-a");
    });
    expect(screen.getByText("From repo A")).toBeTruthy();

    const gate = deferred<ReturnType<typeof loaded>>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo-b");
    });

    expect(screen.queryByText("From repo A")).toBeNull();
    expect(rebaseButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve(
        loaded({ commits: [{ hash: "bbbbbbb2222", message: "From repo B", author: "Ada" }] })
      );
      await gate.promise;
    });
    expect(screen.getByText("From repo B")).toBeTruthy();
    expect(rebaseButton().hasAttribute("disabled")).toBe(false);
  });

  // A measured-empty range is a real answer and a different one from "not measured".
  // It must not render as a commit list, and it must not read as a warning either:
  // there is nothing to be careful about.
  it("says nothing would be replayed instead of listing rows for a measured-empty range", async () => {
    mocks.buildPreview.mockResolvedValue(
      loaded({ commits: [], rebaseRange: { total: 0, rangeBasis: "tracked" as const, behind: 0 } })
    );
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(screen.queryAllByTestId("git-pull-rebase-commit-row")).toHaveLength(0);
    expect(screen.getByTestId("git-pull-rebase-in-sync")).toBeTruthy();
    // Approvable: a branch level with its upstream rebases to a no-op, which is
    // a different thing from a rebase we could not describe.
    expect(rebaseButton().hasAttribute("disabled")).toBe(false);
  });

  // An unfetched upstream measured nothing, so it may not borrow the empty note —
  // and, more importantly, it may not be approved. This is the one state where the
  // surface cannot answer the question it exists to answer, and a destructive
  // confirm that hands out an approval there is failing open.
  it("blocks approval rather than claiming an empty replay set when the upstream was never fetched", async () => {
    mocks.buildPreview.mockResolvedValue(
      loaded({
        commits: [],
        rebaseRange: { total: 0, rangeBasis: "unfetched" as const, behind: 0 },
      })
    );
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(screen.queryByTestId("git-pull-rebase-in-sync")).toBeNull();
    expect(screen.getByTestId("git-pull-rebase-empty-unfetched")).toBeTruthy();
    expect(rebaseButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(screen.getByTestId("app-dialog-hint").textContent?.trim()).toBeTruthy();
  });

  // A branch level with its upstream and a branch behind it both measure an empty
  // replay set, and only the first "already matches". Saying so of the second is a
  // plain factual error about what the operation is going to do.
  it("separates a branch that is level from one that is behind with nothing to replay", async () => {
    mocks.buildPreview.mockResolvedValue(
      loaded({ commits: [], rebaseRange: { total: 0, rangeBasis: "tracked" as const, behind: 6 } })
    );
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(screen.queryByTestId("git-pull-rebase-in-sync")).toBeNull();
    expect(screen.getByTestId("git-pull-rebase-behind-nothing-to-replay")).toBeTruthy();
    // Still approvable: pulling in what the upstream has is a real, wanted outcome
    // — it just replays nothing, which is the part the copy has to get right. What
    // it must NOT do is promise a fast-forward, which `behind` alone can't establish.
    expect(screen.queryByText(/fast-forward/i)).toBeNull();
    expect(rebaseButton().hasAttribute("disabled")).toBe(false);
  });

  // The conflict caution describes what happens DURING a replay. Rendering it in a
  // state with nothing to replay contradicts the panel directly above it, and it
  // made the empty state taller than the one-commit state.
  it("only cautions about replay conflicts when there is a replay", async () => {
    mocks.buildPreview.mockResolvedValue(
      loaded({ commits: [], rebaseRange: { total: 0, rangeBasis: "tracked" as const, behind: 0 } })
    );
    const { unmount } = render(<GitPullRebaseConfirmDialog />);
    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });
    expect(screen.queryByText(/stops mid-rebase/i)).toBeNull();

    useGitPullRebaseConfirmStore.getState().resolveConfirmation(false);
    unmount();

    mocks.buildPreview.mockResolvedValue(loaded());
    render(<GitPullRebaseConfirmDialog />);
    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });
    expect(screen.getByText(/stops mid-rebase/i)).toBeTruthy();
  });

  // Every state that kills the primary has to say so where a screen reader will
  // hear it, and name the unmet prerequisite next to the dead button. Driven off
  // the disabled state rather than a list of strings, so a new blocking state
  // cannot be added without answering the same question.
  it.each([
    ["a failed preview", () => mocks.buildPreview.mockRejectedValue(new Error("git exploded"))],
    [
      "no upstream",
      () =>
        mocks.buildPreview.mockResolvedValue(
          loaded({ pullSource: null, commits: [], rebaseRange: null })
        ),
    ],
    [
      "a detached HEAD",
      () =>
        mocks.buildPreview.mockResolvedValue(
          loaded({ branch: null, pullSource: null, commits: [], rebaseRange: null })
        ),
    ],
  ])("explains the block to everyone when approval is refused for %s", async (_label, arrange) => {
    arrange();
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(rebaseButton().hasAttribute("disabled")).toBe(true);
    // Announced: assistive tech learns why without having to hunt for it.
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    // And stated beside the control it disables, so a sighted user does not have
    // to infer the reason from a greyed-out button. Asserted as "the footer hint
    // says something", not against the wording: keying off the copy would make
    // this a test of the string rather than of the rule, and rewording a hint is
    // exactly the kind of change that should stay free.
    expect(screen.getByTestId("app-dialog-hint").textContent?.trim()).toBeTruthy();
  });

  // A detached HEAD also resolves no upstream, so the order of the two checks is
  // load-bearing: diagnosing it as "set an upstream" prescribes a fix that cannot
  // be carried out, for a branch that does not exist.
  it("diagnoses a detached HEAD as a missing branch, not a missing upstream", async () => {
    mocks.buildPreview.mockResolvedValue(
      loaded({ branch: null, pullSource: null, commits: [], rebaseRange: null })
    );
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(screen.getByTestId("git-pull-rebase-detached-head")).toBeTruthy();
    expect(screen.queryByTestId("git-pull-rebase-no-destination")).toBeNull();
  });

  // The scrollable list has no focusable children of its own, so it needs to be
  // reachable in its own right or a keyboard-only user cannot read past the fold
  // of the one thing this dialog exists to show them (WCAG 2.1.1).
  it("exposes the commit list as a keyboard-reachable labelled region", async () => {
    mocks.buildPreview.mockResolvedValue(loaded());
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    const region = screen.getByRole("region", { name: /commits to replay/i });
    expect(region.getAttribute("tabindex")).toBe("0");
  });

  // The rows shown are capped by the IPC limit while the total is measured over
  // the whole range, so a preview that showed only the rows would understate the
  // rewrite. Asserted as "the measured total is surfaced", not against a literal.
  it("surfaces the measured total rather than the number of rows it could fit", async () => {
    mocks.buildPreview.mockResolvedValue(
      loaded({
        commits: [
          { hash: "aaaaaaa1111", message: "One", author: "Ada" },
          { hash: "bbbbbbb2222", message: "Two", author: "Ada" },
        ],
        rebaseRange: { total: 30, rangeBasis: "tracked" as const, behind: 0 },
      })
    );
    render(<GitPullRebaseConfirmDialog />);

    await act(async () => {
      void useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText(/and 28 more/)).toBeTruthy();
  });
});
