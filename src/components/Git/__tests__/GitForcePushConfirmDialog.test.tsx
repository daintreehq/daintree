// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_REMOTE_COMMIT_PREVIEW_MAX, type GitRemoteCommitPreview } from "@shared/types/git";
import { GitForcePushConfirmDialog } from "../GitForcePushConfirmDialog";
import { useGitForcePushStore } from "@/store/gitForcePushStore";

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

const listRemoteCommits =
  vi.fn<(cwd: string, branch: string, limit?: number) => Promise<GitRemoteCommitPreview>>();
const forcePushWithLease = vi.fn().mockResolvedValue(undefined);

const LEASE = "deadbeef";
const CWD = "/repo/wt";
const BRANCH = "feature/x";

function commits(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    hash: `${i}`.padStart(40, "a"),
    date: "2026-01-01",
    message: `remote commit ${i}`,
    author: "Ada",
  }));
}

function preview(shown: number, total = shown): GitRemoteCommitPreview {
  return {
    destination: { remote: "origin", branch: BRANCH },
    total,
    commits: commits(shown),
  };
}

/**
 * Opens the dialog the only way it can be opened: a lease captured from a real
 * push rejection, then an action awaiting the confirm. The returned promise is
 * the deferred one `git.forcePushWithLease` awaits.
 */
function openConfirm(cwd = CWD, branch = BRANCH, lease = LEASE) {
  const store = useGitForcePushStore.getState();
  const record = store.recordRejection({ cwd, branchName: branch, leaseSha: lease });
  if (!record) throw new Error("test setup: rejection produced no recovery record");
  return store.requestConfirmation(record);
}

function renderDialog() {
  const confirmed = openConfirm();
  // Nothing awaits this in the preview tests; the afterEach resolves it.
  void confirmed;
  return render(<GitForcePushConfirmDialog />);
}

function confirmButton(): HTMLElement {
  return screen.getByRole("button", { name: /force push/i });
}

/** Settle the preview fetch's promise chain. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("GitForcePushConfirmDialog preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRemoteCommits.mockResolvedValue(preview(3));
    Object.assign(window, {
      electron: { git: { listRemoteCommits, forcePushWithLease } },
    });
  });

  afterEach(() => {
    // Settle any deferred confirm before unmount so an awaited promise cannot
    // leak into the next test, then reset the store's recovery map.
    act(() => {
      useGitForcePushStore.getState().resolveConfirmation(false);
    });
    useGitForcePushStore.setState({ recovery: {}, pendingConfirm: null });
    cleanup();
  });

  it("asks for the handler's full ceiling so the preview isn't pre-truncated (#12001)", async () => {
    renderDialog();
    await flush();

    const [, , limit] = listRemoteCommits.mock.calls[0]!;
    // Against the shared contract both sides read, not a copied number — the
    // point is that the dialog never narrows the preview below what the main
    // process would serve, whatever that ceiling becomes.
    expect(limit).toBe(GIT_REMOTE_COMMIT_PREVIEW_MAX);
  });

  it("renders each fetched commit once, in the order the range returned them", async () => {
    listRemoteCommits.mockResolvedValue(preview(12));
    renderDialog();
    await waitFor(() => expect(screen.getAllByTestId("force-push-commit-row")).toHaveLength(12));

    const rows = screen.getAllByTestId("force-push-commit-row");
    const messages = rows.map((r) => r.textContent ?? "");
    expect(messages[0]).toContain("remote commit 0");
    expect(messages.at(-1)).toContain("remote commit 11");
    expect(new Set(messages).size).toBe(rows.length);
  });

  it("shows each row's own short hash and author, not just its subject", async () => {
    // A D2 preview is judged on whether the content identifies the commits, so
    // a row that renders only a message is not a preview.
    listRemoteCommits.mockResolvedValue(preview(2));
    renderDialog();
    await flush();

    const first = screen.getAllByTestId("force-push-commit-row")[0]!;
    expect(first.textContent).toContain("aaaaaaa");
    expect(first.textContent).toContain("Ada");
  });

  it("refuses a self-contradictory preview instead of picking a number", async () => {
    // `git log` and the range count are separate reads over a symbolic range,
    // so a concurrent fetch or branch move can leave them disagreeing. Neither
    // side is then trustworthy, and guessing which to believe would be guessing
    // about what a force push discards.
    listRemoteCommits.mockResolvedValue(preview(12, 3));
    renderDialog();
    await flush();

    expect(screen.queryAllByTestId("force-push-commit-row")).toHaveLength(0);
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    // And it recovers the same way a failed load does.
    expect(screen.getByTestId("force-push-commits-retry")).toBeTruthy();
  });

  it("proceeds normally when the total merely exceeds the fetched rows", async () => {
    listRemoteCommits.mockResolvedValue(preview(100, 237));
    renderDialog();
    await flush();

    expect(screen.getAllByTestId("force-push-commit-row")).toHaveLength(100);
    expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
  });

  it("adds no cap notice while every diverged commit is listed", async () => {
    listRemoteCommits.mockResolvedValue(preview(12));
    renderDialog();
    await flush();

    expect(screen.queryByTestId("force-push-commit-cap")).toBeNull();
  });

  it("states the cap as a fact when the range runs past what was fetched", async () => {
    listRemoteCommits.mockResolvedValue(preview(100, 237));
    renderDialog();
    await flush();

    const cap = await screen.findByTestId("force-push-commit-cap");
    // Both halves matter: how many are on screen, and how many exist. Neither
    // is phrased as content waiting behind a control.
    expect(cap.textContent).toContain("100");
    expect(cap.textContent).toContain("237");
    expect(cap.textContent?.toLowerCase()).not.toContain("more");
  });

  it("puts the commit list in a keyboard-reachable region", async () => {
    listRemoteCommits.mockResolvedValue(preview(30));
    renderDialog();
    await flush();

    // A scrollable region with no focusable children of its own has to be
    // reachable in its own right (WCAG 2.1.1).
    const region = screen.getByRole("region", { name: /remote commits to discard/i });
    expect(region.getAttribute("tabindex")).toBe("0");
  });

  it("names the resolved destination in the region label, not just the branch", async () => {
    renderDialog();
    await flush();

    const region = screen.getByRole("region", { name: /remote commits to discard/i });
    expect(region.getAttribute("aria-label")).toContain("origin");
  });

  it("says so plainly when the remote has nothing to discard", async () => {
    listRemoteCommits.mockResolvedValue(preview(0));
    renderDialog();
    await flush();

    expect(screen.getByText(/no remote commits to discard/i)).toBeTruthy();
    expect(screen.queryByRole("region", { name: /remote commits to discard/i })).toBeNull();
  });

  it("blocks confirm while the preview has not resolved", async () => {
    let resolvePreview: (p: GitRemoteCommitPreview) => void = () => {};
    listRemoteCommits.mockReturnValue(
      new Promise<GitRemoteCommitPreview>((resolve) => {
        resolvePreview = resolve;
      })
    );
    renderDialog();
    await flush();

    // Without the preview the user has no visibility into what would be
    // discarded, so the destructive action stays closed.
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      resolvePreview(preview(2));
      await Promise.resolve();
    });
    expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
  });

  it("offers a retry that refetches at the same ceiling after a failed load", async () => {
    listRemoteCommits.mockRejectedValueOnce(new Error("no remote"));
    renderDialog();
    await flush();

    const retry = await screen.findByTestId("force-push-commits-retry");
    listRemoteCommits.mockResolvedValue(preview(2));
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    // Same request as the first attempt — a retry that quietly narrowed the
    // range would hand back a different preview than the one that failed.
    expect(listRemoteCommits.mock.calls[1]).toEqual(listRemoteCommits.mock.calls[0]);
    // And it recovers: the error clears, rows appear, and confirm arms.
    expect(screen.queryByTestId("force-push-commits-retry")).toBeNull();
    expect(screen.getAllByTestId("force-push-commit-row")).toHaveLength(2);
    expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
  });

  it("names the pinned lease in full so it can be checked against anything", async () => {
    renderDialog();
    await flush();

    // Abbreviated, this is the one value in the dialog a user cannot verify:
    // everything else is a preview of the discard, but the lease is what
    // decides whether the discard is permitted at all.
    expect(screen.getByTestId("force-push-lease").textContent).toBe(LEASE);
  });

  it("resolves the action's deferred confirm rather than pushing itself", async () => {
    const confirmed = openConfirm();
    render(<GitForcePushConfirmDialog />);
    await flush();

    await act(async () => {
      confirmButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(await confirmed).toBe(true);
    // The IPC belongs to `git.forcePushWithLease`'s run(), so its dispatch
    // result reports the real outcome instead of a dialog swallowing it.
    expect(forcePushWithLease).not.toHaveBeenCalled();
  });

  it("resolves false when the confirm is dismissed", async () => {
    const confirmed = openConfirm();
    render(<GitForcePushConfirmDialog />);
    await flush();

    await act(async () => {
      screen
        .getByRole("button", { name: /cancel/i })
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(await confirmed).toBe(false);
    expect(forcePushWithLease).not.toHaveBeenCalled();
  });

  it("blocks confirm until the superseding request's own preview arrives", async () => {
    renderDialog();
    await flush();
    expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);

    // A second worktree's confirm supersedes the first. The host stays mounted
    // across the swap, so for the frames before the new fetch lands the commit
    // list on screen still belongs to the PREVIOUS worktree — confirming there
    // would force push against a preview of somewhere else entirely.
    let resolvePreview: (p: GitRemoteCommitPreview) => void = () => {};
    listRemoteCommits.mockReturnValue(
      new Promise<GitRemoteCommitPreview>((resolve) => {
        resolvePreview = resolve;
      })
    );
    await act(async () => {
      void openConfirm("/repo/other", "feature/other", "beefcafe");
      await Promise.resolve();
    });

    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      resolvePreview(preview(1));
      await Promise.resolve();
    });
    expect(confirmButton().hasAttribute("aria-disabled")).toBe(false);
  });
});
