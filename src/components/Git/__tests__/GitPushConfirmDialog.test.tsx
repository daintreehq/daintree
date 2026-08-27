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
  return screen.getByRole("button", { name: "Push" });
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
      pushRange: { total: 0, createsRemoteBranch: false },
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
      pushRange: { total: number; createsRemoteBranch: boolean } | null;
    }>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve({
        branch: "main",
        destination: { remote: "origin", branch: "main" },
        pullSource: { remote: "origin", branch: "main" },
        commits: [],
        pushRange: { total: 0, createsRemoteBranch: false },
      });
      await gate.promise;
    });

    expect(pushButton().hasAttribute("disabled")).toBe(false);
  });

  // `commits.length === 0` is a VALID loaded state — it means "nothing ahead",
  // not "still loading". Blocking on it was the #9575 failure mode.
  it("allows approval once loaded even with no commits to show", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
      pushRange: { total: 0, createsRemoteBranch: false },
    });
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("git-push-in-sync").textContent).toContain("Nothing to publish");
  });

  it("keeps approval blocked when the preview fetch fails, and offers a retry", async () => {
    mocks.buildPreview.mockRejectedValue(new Error("git exploded"));
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    expect(pushButton().hasAttribute("disabled")).toBe(true);
    const retry = screen.getByTestId("git-push-commits-retry");

    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [{ hash: "abcdef1234", message: "Fix it", author: "Ada" }],
      pushRange: { total: 1, createsRemoteBranch: false },
    });
    await act(async () => {
      retry.click();
    });

    expect(mocks.buildPreview).toHaveBeenCalledTimes(2);
    expect(pushButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Fix it")).toBeTruthy();
  });

  // A preview fetch is not the action running. Wiring it to `isConfirmLoading`
  // disabled Cancel, and AppDialog's initial-focus pass calls `.focus()` on the
  // Cancel button it finds by selector without checking it is enabled — so a
  // disabled Cancel left focus outside the dialog for the whole fetch.
  it("keeps Cancel usable while the preview is still loading", async () => {
    const gate = deferred<never>();
    mocks.buildPreview.mockReturnValue(gate.promise);
    render(<GitPushConfirmDialog />);

    await act(async () => {
      void useGitPushConfirmStore.getState().requestConfirmation("/repo");
    });

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.hasAttribute("disabled")).toBe(false);
    expect(pushButton().hasAttribute("disabled")).toBe(true);
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
      pushRange: { total: 7, createsRemoteBranch: false },
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
      pushRange: { total: 0, createsRemoteBranch: false },
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
      pushRange: { total: 1, createsRemoteBranch: false },
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

    expect(pushButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("git-push-no-destination")).toBeTruthy();
  });

  it("resolves the awaited confirm promise with the user's decision", async () => {
    mocks.buildPreview.mockResolvedValue({
      branch: "main",
      destination: { remote: "origin", branch: "main" },
      pullSource: { remote: "origin", branch: "main" },
      commits: [],
      pushRange: { total: 0, createsRemoteBranch: false },
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
