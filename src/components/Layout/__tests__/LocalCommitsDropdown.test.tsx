/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { LocalCommitsDropdown, reflowCommitBody } from "../LocalCommitsDropdown";
import type { GitCommit, GitCommitListResponse } from "@shared/types/git";

const listCommitsMock = vi.fn();

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

const makeCommit = (n: number, body = ""): GitCommit => ({
  hash: `hash-${n}`,
  shortHash: `sh${n}`,
  message: `commit message ${n}`,
  body,
  author: { name: `Author ${n}`, email: `author${n}@example.com` },
  date: "2026-01-01T00:00:00Z",
});

const makeResponse = (
  items: GitCommit[],
  overrides: Partial<GitCommitListResponse> = {}
): GitCommitListResponse => ({
  items,
  hasMore: false,
  total: items.length,
  ...overrides,
});

beforeEach(() => {
  listCommitsMock.mockReset();
  (window as unknown as { electron: unknown }).electron = {
    git: { listCommits: listCommitsMock },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("LocalCommitsDropdown", () => {
  it("fetches local commits with the expected bridge arguments when open", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));

    render(<LocalCommitsDropdown cwd="/repo" branch="main" open initialCount={1} />);

    await waitFor(() => expect(listCommitsMock).toHaveBeenCalledTimes(1));
    expect(listCommitsMock).toHaveBeenCalledWith({
      cwd: "/repo",
      branch: "main",
      search: undefined,
      skip: 0,
      limit: 30,
    });
  });

  it("does not fetch while closed", () => {
    listCommitsMock.mockResolvedValue(makeResponse([]));

    render(<LocalCommitsDropdown cwd="/repo" open={false} />);

    expect(listCommitsMock).not.toHaveBeenCalled();
  });

  it("renders commit rows with message, author, and short hash", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1), makeCommit(2)]));

    const { findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={2} />
    );

    expect((await findAllByText("commit message 1")).length).toBeGreaterThan(0);
    expect((await findAllByText("commit message 2")).length).toBeGreaterThan(0);
    expect(await findByText("Author 1")).toBeTruthy();
    expect(await findByText("sh1")).toBeTruthy();
  });

  it("shows the no-commits empty state for an empty repo", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([]));

    const { findByText } = render(<LocalCommitsDropdown cwd="/repo" open initialCount={0} />);

    expect(await findByText("No commits yet")).toBeTruthy();
  });

  it("shows the search-specific empty state when a query matches nothing", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));

    const { getByRole, findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} />
    );
    await findAllByText("commit message 1");

    listCommitsMock.mockResolvedValue(makeResponse([]));
    fireEvent.change(getByRole("combobox"), { target: { value: "nomatch" } });

    expect(await findByText('No matching commits for "nomatch"')).toBeTruthy();
    expect(listCommitsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "nomatch", skip: 0 })
    );
  });

  it("shows an error state with retry and refetches on retry", async () => {
    listCommitsMock.mockRejectedValueOnce(new Error("git went away"));
    listCommitsMock.mockResolvedValueOnce(makeResponse([makeCommit(1)]));

    const { findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} />
    );

    expect(await findByText("git went away")).toBeTruthy();
    fireEvent.click(await findByText("Retry"));

    expect((await findAllByText("commit message 1")).length).toBeGreaterThan(0);
    expect(listCommitsMock).toHaveBeenCalledTimes(2);
  });

  it("loads the next page and appends rows", async () => {
    const firstPage = Array.from({ length: 30 }, (_, i) => makeCommit(i));
    listCommitsMock.mockResolvedValueOnce(makeResponse(firstPage, { hasMore: true, total: 31 }));
    listCommitsMock.mockResolvedValueOnce(makeResponse([makeCommit(30)]));

    const { findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={31} />
    );

    fireEvent.click(await findByText("Load more"));

    expect((await findAllByText("commit message 30")).length).toBeGreaterThan(0);
    expect((await findAllByText("commit message 0")).length).toBeGreaterThan(0);
    expect(listCommitsMock).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 30 }));
  });

  it("invokes onClose on Escape in the search input", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));
    const onClose = vi.fn();

    const { getByRole, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} onClose={onClose} />
    );
    await findAllByText("commit message 1");

    fireEvent.keyDown(getByRole("combobox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invokes onClose from the footer close button", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));
    const onClose = vi.fn();

    const { findByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} onClose={onClose} />
    );

    fireEvent.click(await findByText("Close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("expands a commit body on row click", async () => {
    listCommitsMock.mockResolvedValue(
      makeResponse([makeCommit(1, "Detailed body text"), makeCommit(2)])
    );

    const { findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={2} />
    );

    const row = (await findAllByText("commit message 1"))[0]?.closest('[role="option"]');
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    const bodyBefore = (await findByText("Detailed body text")).closest("div[aria-hidden]");
    expect(bodyBefore?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(row!);

    // Re-query after the re-render rather than asserting on pre-click nodes.
    await waitFor(() => {
      const rowAfter = document.querySelector('[role="option"][aria-expanded="true"]');
      expect(rowAfter?.textContent).toContain("commit message 1");
    });
    const bodyAfter = (await findByText("Detailed body text")).closest("div[aria-hidden]");
    expect(bodyAfter?.getAttribute("aria-hidden")).toBe("false");
  });

  it("reflows a hard-wrapped commit body so prose has no mid-paragraph breaks", async () => {
    const wrappedBody =
      "This is the first wrapped line of the body\nand this is its continuation line.";
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1, wrappedBody)]));

    const { findAllByText } = render(<LocalCommitsDropdown cwd="/repo" open initialCount={1} />);

    const row = (await findAllByText("commit message 1"))[0]?.closest('[role="option"]');
    fireEvent.click(row!);

    await waitFor(() => {
      const pre = row!.querySelector("pre");
      expect(pre?.textContent).toBe(
        "This is the first wrapped line of the body and this is its continuation line."
      );
      expect(pre?.textContent).not.toContain("\n");
    });
  });

  it("clears rows from the previous repo when cwd changes while open", async () => {
    listCommitsMock.mockResolvedValueOnce(makeResponse([makeCommit(1)]));

    const { rerender, findAllByText, queryByText } = render(
      <LocalCommitsDropdown cwd="/repo-a" open initialCount={1} />
    );
    await findAllByText("commit message 1");

    listCommitsMock.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<LocalCommitsDropdown cwd="/repo-b" open initialCount={1} />);

    await waitFor(() => expect(queryByText("commit message 1")).toBeNull());
  });

  it("discards an in-flight load-more page when a new search starts", async () => {
    const firstPage = Array.from({ length: 30 }, (_, i) => makeCommit(i));
    listCommitsMock.mockResolvedValueOnce(makeResponse(firstPage, { hasMore: true, total: 60 }));
    let resolveLoadMore: (value: GitCommitListResponse) => void = () => {};
    listCommitsMock.mockImplementationOnce(
      () => new Promise<GitCommitListResponse>((resolve) => (resolveLoadMore = resolve))
    );
    listCommitsMock.mockResolvedValueOnce(makeResponse([makeCommit(100)]));

    const { getByRole, findByText, findAllByText, queryByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={60} />
    );

    fireEvent.click(await findByText("Load more"));
    fireEvent.change(getByRole("combobox"), { target: { value: "needle" } });
    await findAllByText("commit message 100");

    resolveLoadMore(makeResponse([makeCommit(200)], { hasMore: true, total: 60 }));
    await waitFor(() => expect(listCommitsMock).toHaveBeenCalledTimes(3));

    expect(queryByText("commit message 200")).toBeNull();
    expect((await findAllByText("commit message 100")).length).toBeGreaterThan(0);
  });

  it("keeps loaded rows when load-more fails and retries with the same skip", async () => {
    const firstPage = Array.from({ length: 30 }, (_, i) => makeCommit(i));
    listCommitsMock.mockResolvedValueOnce(makeResponse(firstPage, { hasMore: true, total: 31 }));
    listCommitsMock.mockRejectedValueOnce(new Error("page two broke"));
    listCommitsMock.mockResolvedValueOnce(makeResponse([makeCommit(30)]));

    const { findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={31} />
    );

    fireEvent.click(await findByText("Load more"));

    expect(await findByText("page two broke")).toBeTruthy();
    expect((await findAllByText("commit message 0")).length).toBeGreaterThan(0);

    fireEvent.click(await findByText("Retry"));

    expect((await findAllByText("commit message 30")).length).toBeGreaterThan(0);
    expect(listCommitsMock).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 30 }));
  });
});

describe("reflowCommitBody", () => {
  it("collapses a hard-wrapped prose paragraph into one line", () => {
    const body = "This sentence was hard wrapped\nat seventy-two columns\nby the author's editor.";
    expect(reflowCommitBody(body)).toBe(
      "This sentence was hard wrapped at seventy-two columns by the author's editor."
    );
  });

  it("preserves blank-line paragraph separators", () => {
    const body = "First paragraph line one\nline two\n\nSecond paragraph here";
    expect(reflowCommitBody(body)).toBe(
      "First paragraph line one line two\n\nSecond paragraph here"
    );
  });

  it("keeps bullet list items on their own lines", () => {
    const body = "- first bullet\n- second bullet\n- third bullet";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("keeps numbered list items on their own lines", () => {
    const body = "1. first step\n2. second step";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("keeps parenthesized numbered list items on their own lines", () => {
    const body = "1) first step\n2) second step";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("reflows a wrapped prose line that merely starts with a word and colon", () => {
    const body = "This explains the behavior\nNote: it also applies on Windows";
    expect(reflowCommitBody(body)).toBe(
      "This explains the behavior Note: it also applies on Windows"
    );
  });

  it("treats a Key: value line as a trailer only after a blank line", () => {
    const reflowed = "body line\nFixes: a wrapped description that continues";
    expect(reflowCommitBody(reflowed)).toBe(
      "body line Fixes: a wrapped description that continues"
    );

    const trailer = "body line\n\nFixes: #123";
    expect(reflowCommitBody(trailer)).toBe(trailer);
  });

  it("keeps a BREAKING CHANGE footer on its own line", () => {
    const body = "Reworked the API.\n\nBREAKING CHANGE: the old method is gone";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("keeps fenced code blocks intact", () => {
    const body = "Example usage:\n\n```ts\nconst x = 1;\n```";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("normalizes a bare carriage return", () => {
    expect(reflowCommitBody("line one\rline two")).toBe("line one line two");
  });

  it("preserves indented continuation lines verbatim", () => {
    const body = "- a bullet header\n  indented continuation";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("keeps git trailers on their own lines", () => {
    const body =
      "Body of the commit.\n\nCo-authored-by: Jane <jane@example.com>\nSigned-off-by: Joe <joe@example.com>\nFixes: #123";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("preserves indented code blocks", () => {
    const body = "Explanation paragraph.\n\n    const x = 1;\n    const y = 2;";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("leaves a single long URL line untouched", () => {
    const body =
      "https://example.com/a/very/long/path/that/exceeds/the/panel/width/and/keeps/going";
    expect(reflowCommitBody(body)).toBe(body);
  });

  it("normalizes CRLF line endings without leaving stray carriage returns", () => {
    const body = "line one\r\nline two";
    const result = reflowCommitBody(body);
    expect(result).not.toContain("\r");
    expect(result).toBe("line one line two");
  });

  it("returns an empty string unchanged", () => {
    expect(reflowCommitBody("")).toBe("");
  });

  it("is idempotent", () => {
    const body =
      "A wrapped prose paragraph\nthat continues here.\n\n- a bullet\n- another\n\nFixes: #1";
    const once = reflowCommitBody(body);
    expect(reflowCommitBody(once)).toBe(once);
  });
});
