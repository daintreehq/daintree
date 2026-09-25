/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { CommitList } from "../components/CommitList";
import type { GitCommit, GitCommitListResponse } from "@shared/types/git";

const dispatchMock = vi.fn();
const listCommitsMock = vi.fn();
const listPushCommitsMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (date: string) => `time:${date}`,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useDebounce", () => ({
  useDebounce: <T,>(value: T) => value,
}));

const commitWithBody: GitCommit = {
  hash: "aaaaaaa1bbbbbbb2",
  shortHash: "aaaaaaa",
  message: "feat(auth): add login flow",
  body: "Detailed body line 1.\n\nDetailed body line 2.",
  author: { name: "Alice", email: "alice@example.com" },
  date: "2026-01-01T00:00:00Z",
};

const commitNoBody: GitCommit = {
  hash: "ccccccc3ddddddd4",
  shortHash: "ccccccc",
  message: "fix: tiny patch",
  author: { name: "Bob", email: "bob@example.com" },
  date: "2026-01-02T00:00:00Z",
};

const page = (items: GitCommit[], hasMore = false): GitCommitListResponse => ({
  items,
  hasMore,
  total: items.length,
});

const rowOf = (commit: GitCommit) => document.getElementById(`local-commit-row-${commit.hash}`);

beforeEach(() => {
  dispatchMock.mockReset();
  listCommitsMock.mockReset();
  listPushCommitsMock.mockReset();
  listPushCommitsMock.mockRejectedValue(new Error("no remote"));
  (window as unknown as { electron: unknown }).electron = {
    git: { listCommits: listCommitsMock, listPushCommits: listPushCommitsMock },
  };
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { electron?: unknown }).electron;
});

async function renderList(items: GitCommit[], hasMore = false) {
  listCommitsMock.mockResolvedValueOnce(page(items, hasMore));
  const onClose = vi.fn();
  const utils = render(
    <CommitList projectPath="/tmp/repo" branch="main" onClose={onClose} initialCount={2} />
  );
  await waitFor(() => expect(rowOf(items[0]!)).not.toBeNull());
  const input = utils.getByRole("combobox");
  return { ...utils, input, onClose };
}

describe("CommitList", () => {
  it("lists the worktree's history through the host's commits list", async () => {
    await renderList([commitWithBody, commitNoBody]);

    expect(listCommitsMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/repo", branch: "main", skip: 0 })
    );
    expect(listPushCommitsMock).toHaveBeenCalledWith("/tmp/repo", "main", 100);
  });

  it("opens the branch's commits on GitHub and closes", async () => {
    const { getByRole, onClose } = await renderList([commitNoBody]);

    fireEvent.click(getByRole("button", { name: /view on github/i }));

    expect(dispatchMock).toHaveBeenCalledWith(
      "forge.openCommits",
      { projectPath: "/tmp/repo", branch: "main" },
      { source: "user" }
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Enter on a commit with a body toggles it, and a second Enter collapses it", async () => {
    const { input } = await renderList([commitWithBody, commitNoBody]);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(rowOf(commitWithBody)?.getAttribute("aria-expanded")).toBe("true");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(rowOf(commitWithBody)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("Enter on a commit without a body copies its hash", async () => {
    const { input } = await renderList([commitNoBody]);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(commitNoBody.hash);
    expect(rowOf(commitNoBody)?.hasAttribute("aria-expanded")).toBe(false);
  });

  it("keeps an expansion when Load more appends a page", async () => {
    const { input, getByRole } = await renderList([commitWithBody], true);
    listCommitsMock.mockResolvedValueOnce(page([commitNoBody]));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    fireEvent.click(getByRole("button", { name: /load more/i }));

    await waitFor(() => expect(rowOf(commitNoBody)).not.toBeNull());
    expect(rowOf(commitWithBody)?.getAttribute("aria-expanded")).toBe("true");
  });

  it("survives Enter with no clipboard available", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const { input, findAllByText } = await renderList([commitNoBody]);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect((await findAllByText("Couldn't copy hash")).length).toBeGreaterThan(0);
  });
});
