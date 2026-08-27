// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRemoteCommitPreview } from "@shared/types/git";
import { ForcePushConfirmDialog } from "../ForcePushConfirmDialog";

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

function renderDialog() {
  return render(
    <ForcePushConfirmDialog
      isOpen
      cwd={CWD}
      branchName={BRANCH}
      leaseSha="deadbeef"
      onClose={vi.fn()}
      onSuccess={vi.fn()}
      onError={vi.fn()}
    />
  );
}

/** Settle the preview fetch's promise chain. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ForcePushConfirmDialog preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRemoteCommits.mockResolvedValue(preview(3));
    Object.assign(window, {
      electron: { git: { listRemoteCommits, forcePushWithLease } },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("asks for the handler's full ceiling so the preview isn't pre-truncated (#12001)", async () => {
    renderDialog();
    await flush();

    const [, , limit] = listRemoteCommits.mock.calls[0]!;
    // The main handler clamps to 100; anything below it caps the D2 preview
    // client-side for no reason.
    expect(limit).toBe(100);
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

  it("never reports a total below the commits it is already listing", async () => {
    // `git log` and the range count are separate reads in the handler, so a
    // fetch between them can return a stale, smaller total. The rows in hand
    // prove the range holds at least that many.
    listRemoteCommits.mockResolvedValue(preview(12, 3));
    renderDialog();
    await flush();

    expect(screen.getAllByTestId("force-push-commit-row")).toHaveLength(12);
    expect(screen.queryByTestId("force-push-commit-cap")).toBeNull();
    expect(screen.queryByText("3")).toBeNull();
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
    const confirm = screen.getByRole("button", { name: /force push/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await act(async () => {
      resolvePreview(preview(2));
      await Promise.resolve();
    });
    expect(
      (screen.getByRole("button", { name: /force push/i }) as HTMLButtonElement).disabled
    ).toBe(false);
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
    expect(
      (screen.getByRole("button", { name: /force push/i }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
