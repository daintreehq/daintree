// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPushConfirmDialog } from "../GitPushConfirmDialog";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";

/**
 * The #9575 invariant: rendering a preview does NOT gate approval — the
 * `confirmDisabled` wiring is a manual, per-dialog responsibility that has
 * silently broken before. These cover the load-state gate directly, and the
 * fact that the dialog reads through the shared `buildGitRemoteOperationPreview`
 * so it can't drift from the MCP confirm surface (#11538).
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

function pushButton(): HTMLElement {
  return screen.getByRole("button", { name: "Push commits" });
}

/** A promise plus its resolvers, so a test can hold the fetch mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("GitPushConfirmDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    if (useGitPushConfirmStore.getState().pendingConfirm) {
      useGitPushConfirmStore.getState().resolveConfirmation(false);
    }
    cleanup();
    vi.restoreAllMocks();
  });

  it("reads the preview through the shared builder, scoped to the requested cwd", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "feature/x",
      destination: { remote: "origin", branch: "feature/x" },
      pullSource: { remote: "origin", branch: "feature/x" },
      commits: [],
      pushRange: { total: 0, rangeBasis: "tracked" as const },
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(mocks.buildPreview).toHaveBeenCalledWith("/repo", "push");
  });

  it("blocks approval while the preview is still loading", async () => {
    const gate = deferred<{
      branch: string;
      destination: { remote: string; branch: string };
      pullSource: { remote: string; branch: string };
      commits: never[];
      pushRange: { total: number; rangeBasis: "tracked" | "creates" | "unverified" } | null;
    }>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      gate.resolve({
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [],
        pushRange: { total: 0, rangeBasis: "tracked" as const },
      });
      await gate.promise;
    });

    expect(pushButton().hasAttribute("aria-disabled")).toBe(false);
  });

  // `commits.length === 0` is a VALID loaded state — it means "nothing ahead",
  // not "still loading". Blocking on it was the #9575 failure mode.
  it("allows approval once loaded even with no commits to show", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
      pushRange: { total: 0, rangeBasis: "tracked" as const },
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().hasAttribute("aria-disabled")).toBe(false);
    expect(screen.getByTestId("git-push-in-sync").textContent).toContain("Nothing to publish");
  });

  it("keeps approval blocked when the preview fetch fails, and offers a retry", async () => {
    mocks.buildPreview.mockRejectedValue(new Error("git exploded"));
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().getAttribute("aria-disabled")).toBe("true");
    const retry = screen.getByTestId("git-push-commits-retry");

    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [{ hash: "abcdef1234", message: "Fix it", author: "Ada" }],
      pushRange: { total: 1, rangeBasis: "tracked" as const },
    });
    await act(async () => {
      retry.click();
    });

    expect(mocks.buildPreview).toHaveBeenCalledTimes(2);
    expect(pushButton().hasAttribute("aria-disabled")).toBe(false);
    expect(screen.getByText("Fix it")).toBeTruthy();
  });

  // The preview handler fails as a `GitOperationError`, whose discriminant the
  // preload encodes into `.message` because contextBridge strips own Error
  // properties. Rendered raw, that encoding is what the approver reads.
  it("shows the git message without the encoded error prefix", async () => {
    mocks.buildPreview.mockRejectedValue(
      new Error("[GitError|not-a-repo||feature%2Fx] fatal: not a git repository")
    );
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    const alert = screen.getByTestId("git-push-commits-retry").closest("[role='alert']");
    expect(alert?.textContent).toContain("fatal: not a git repository");
    expect(alert?.textContent).not.toContain("GitError");
    expect(alert?.textContent).not.toContain("feature%2Fx");
  });

  // A preview fetch is not the action running. Wiring it to `isConfirmLoading`
  // disabled Cancel, leaving the dialog without a usable exit for the whole fetch.
  it("keeps Cancel usable while the preview is still loading", async () => {
    const gate = deferred<never>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.hasAttribute("aria-disabled")).toBe(false);
    expect(pushButton().getAttribute("aria-disabled")).toBe("true");
  });

  // The rows and the count have to describe the same range, or the tail states
  // a number that was measured over a different set of commits.
  it("counts and tails from the measured range, not from the rows on screen", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [
        { hash: "aaaaaaa1", message: "One", author: "Ada" },
        { hash: "bbbbbbb2", message: "Two", author: "Bob" },
      ],
      pushRange: { total: 7, rangeBasis: "tracked" as const },
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(screen.getAllByTestId("git-push-commit-row")).toHaveLength(2);
    const region = screen.getByTestId("git-push-destination-summary").parentElement!;
    expect(region.textContent).toContain("7");
    expect(region.textContent).toContain("and 5 more");
  });

  it("names the resolved destination rather than leaving it to the title", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "topic",
      destination: { remote: "fork", branch: "release/topic" },
      pullSource: null,
      commits: [],
      pushRange: { total: 0, rangeBasis: "tracked" as const },
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    const summary = screen.getByTestId("git-push-destination-summary");
    expect(summary.textContent).toContain("fork/release/topic");
    expect(summary.textContent).toContain("topic");
  });

  // The title used to interpolate whatever had loaded, so the quoted string
  // silently changed from naming the local branch to naming the remote ref.
  it("keeps one title across loading, blocked and loaded states", async () => {
    const gate = deferred<never>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    const { rerender } = render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });
    const whileLoading = screen.getByRole("heading", { level: 2 }).textContent;

    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: null,
      commits: [{ hash: "abcdef12", message: "One", author: "Ada" }],
      pushRange: { total: 1, rangeBasis: "tracked" as const },
    });
    await act(async () => {
      useGitPushConfirmStore.getState().resolveConfirmation(false);
      rerender(<GitPushConfirmDialog />);
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(whileLoading);
  });

  it("blocks approval and says so when no destination resolves", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "spike",
      destination: null,
      pullSource: null,
      commits: [],
      pushRange: null,
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("git-push-no-destination")).toBeTruthy();
  });

  // A detached HEAD also resolves no destination. Diagnosing it as a missing
  // push remote gives the wrong reason and a fix that cannot be followed.
  it("names a detached HEAD rather than blaming a missing push remote", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: null,
      destination: null,
      pullSource: null,
      commits: [],
      pushRange: null,
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(screen.getByTestId("git-push-detached-head")).toBeTruthy();
    expect(screen.queryByTestId("git-push-no-destination")).toBeNull();
    expect(pushButton().getAttribute("aria-disabled")).toBe("true");
  });

  // An untracked range can only over-report, so the surface must say the list is
  // an upper bound rather than assert a branch creation it cannot verify.
  it("labels an unreachable remote as unverified, never as a branch creation", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "spike",
      destination: { remote: "origin", branch: "spike" },
      pullSource: null,
      commits: [{ hash: "abcdef12", message: "One", author: "Ada" }],
      pushRange: { total: 1, rangeBasis: "unverified" as const },
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    const region = screen.getByTestId("git-push-destination-summary").parentElement!;
    expect(region.textContent).toContain("unverified");
    expect(region.textContent).not.toContain("creates this branch");
  });

  // An untracked range was never compared against the destination, so an empty
  // one means "nothing found locally" — not "the destination is up to date".
  it("never claims a destination is in sync from an unverified range", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "spike",
      destination: { remote: "origin", branch: "spike" },
      pullSource: null,
      commits: [],
      pushRange: { total: 0, rangeBasis: "unverified" as const },
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    // The rule, not the wording: an unverified empty range gets its own state and
    // must never produce the categorical "already has everything" claim.
    expect(screen.queryByTestId("git-push-in-sync")).toBeNull();
    const unverified = screen.getByTestId("git-push-empty-unverified");
    expect(unverified.textContent).not.toContain("already has everything");
    expect(unverified.textContent).toMatch(/n't confirmed|unverified/);
  });

  // The host stays mounted across close/open, so preview state survives a
  // request. A superseded request's response must not land and re-enable
  // approval against the worktree the user has already moved away from.
  it("drops a superseded response instead of approving against it", async () => {
    const first = deferred<{
      branch: string;
      destination: { remote: string; branch: string };
      pullSource: null;
      commits: Array<{ hash: string; message: string; author: string }>;
      pushRange: { total: number; rangeBasis: "tracked" };
    }>();
    mocks.buildPreview.mockReturnValue(first.promise);
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo-a");
    });

    // A second request for a DIFFERENT worktree supersedes the first.
    const second = deferred<never>();
    mocks.buildPreview.mockReturnValue(second.promise);
    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo-b");
    });

    // The FIRST worktree's answer arrives late.
    await act(async () => {
      first.resolve({
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: null,
        commits: [{ hash: "abcdef12", message: "One", author: "Ada" }],
        pushRange: { total: 1, rangeBasis: "tracked" },
      });
      await first.promise;
    });

    // It must neither render nor enable approval: it describes /repo-a, and the
    // dialog on screen is asking about /repo-b.
    expect(pushButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryAllByTestId("git-push-commit-row")).toHaveLength(0);
  });

  // The creation marker is the one claim that requires the remote to have spoken.
  it("marks a branch creation only from a remote-confirmed range", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "spike",
      destination: { remote: "origin", branch: "spike" },
      pullSource: null,
      commits: [{ hash: "abcdef12", message: "One", author: "Ada" }],
      pushRange: { total: 1, rangeBasis: "creates" as const },
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    const region = screen.getByTestId("git-push-destination-summary").parentElement!;
    expect(region.textContent).toContain("creates this branch");
    expect(region.textContent).not.toContain("unverified");
  });

  it("resolves the awaited confirm promise with the user's decision", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
      pushRange: { total: 0, rangeBasis: "tracked" as const },
    });
    render(<GitPushConfirmDialog />);

    let decision: boolean | undefined;
    await act(async () => {
      void useGitPushConfirmStore
        .getState()
        .requestConfirmation("/repo")
        .then((ok) => {
          decision = ok;
        });
    });

    await act(async () => {
      pushButton().click();
    });

    expect(decision).toBe(true);
  });
});
