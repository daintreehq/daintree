/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { LocalCommitsDropdown, reflowCommitBody } from "../LocalCommitsDropdown";
import type { GitCommit, GitCommitListResponse } from "@shared/types/git";

const listCommitsMock = vi.fn();
const listPushCommitsMock = vi.fn();

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
  listPushCommitsMock.mockReset();
  listPushCommitsMock.mockRejectedValue(new Error("no remote"));
  (window as unknown as { electron: unknown }).electron = {
    git: { listCommits: listCommitsMock, listPushCommits: listPushCommitsMock },
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

    expect(await findByText("No commits on this branch yet")).toBeTruthy();
  });

  it("shows the search-specific empty state when a query matches nothing", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));

    const { getByRole, findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} />
    );
    await findAllByText("commit message 1");

    listCommitsMock.mockResolvedValue(makeResponse([]));
    fireEvent.change(getByRole("combobox"), { target: { value: "nomatch" } });

    expect(await findByText("No commits match \u201cnomatch\u201d")).toBeTruthy();
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

  it("clears the search from the empty state and refetches the full list", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));

    const { getByRole, findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} />
    );
    await findAllByText("commit message 1");

    listCommitsMock.mockResolvedValueOnce(makeResponse([]));
    fireEvent.change(getByRole("combobox"), { target: { value: "nomatch" } });
    fireEvent.click(await findByText("Clear search"));

    expect(getByRole("combobox")).toHaveProperty("value", "");
    expect((await findAllByText("commit message 1")).length).toBeGreaterThan(0);
  });

  it("expands a commit body on row click", async () => {
    listCommitsMock.mockResolvedValue(
      makeResponse([makeCommit(1, "Detailed body text"), makeCommit(2)])
    );

    const { findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={2} />
    );

    const row = (await findAllByText("commit message 1"))[0]?.closest('[role="row"]');
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    const bodyBefore = (await findByText("Detailed body text")).closest("div[aria-hidden]");
    expect(bodyBefore?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(row!);

    // Re-query after the re-render rather than asserting on pre-click nodes.
    await waitFor(() => {
      const rowAfter = document.querySelector('[role="row"][aria-expanded="true"]');
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

    const row = (await findAllByText("commit message 1"))[0]?.closest('[role="row"]');
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

    expect(await findByText(/page two broke/)).toBeTruthy();
    expect((await findAllByText("commit message 0")).length).toBeGreaterThan(0);

    fireEvent.click(await findByText("Retry"));

    expect((await findAllByText("commit message 30")).length).toBeGreaterThan(0);
    expect(listCommitsMock).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 30 }));
  });
});

describe("LocalCommitsDropdown push status", () => {
  const pushPreview = (
    hashes: string[],
    rangeBasis: "tracked" | "creates" | "unverified" = "tracked"
  ) => ({
    destination: { remote: "origin", branch: "main" },
    rangeBasis,
    total: hashes.length,
    commits: hashes.map((hash) => ({ hash, date: "", message: "", author: "" })),
  });

  it("marks exactly the commits in the push range and summarises them in the footer", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1), makeCommit(2), makeCommit(3)]));
    listPushCommitsMock.mockResolvedValue(pushPreview(["hash-1", "hash-2"]));

    const { findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" branch="main" open initialCount={3} />
    );
    await findAllByText("commit message 3");
    await findByText("2 not pushed");

    const rowOf = (n: number) =>
      document.getElementById(`local-commit-row-hash-${n}`)?.textContent ?? "";
    expect(rowOf(1)).toContain("Not pushed");
    expect(rowOf(2)).toContain("Not pushed");
    expect(rowOf(3)).not.toContain("Not pushed");
    expect(listPushCommitsMock).toHaveBeenCalledWith("/repo", "main", 100);
  });

  it("marks no rows from an unverified range", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));
    listPushCommitsMock.mockResolvedValue(pushPreview(["hash-1"], "unverified"));

    const { findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" branch="main" open initialCount={1} />
    );
    await findAllByText("commit message 1");
    await findByText(/Couldn't verify what origin\/main has/);

    expect(document.getElementById("local-commit-row-hash-1")?.textContent).not.toContain(
      "Not pushed"
    );
  });

  it("says how many rows it marked when the range is longer than the read", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));
    listPushCommitsMock.mockResolvedValue({ ...pushPreview(["hash-1"]), total: 140 });

    const { findByText } = render(
      <LocalCommitsDropdown cwd="/repo" branch="main" open initialCount={1} />
    );

    expect(await findByText(/newest 1 marked/)).toBeTruthy();
  });

  it("says nothing about the remote while the history read has failed", async () => {
    listCommitsMock.mockRejectedValue(new Error("git went away"));
    listPushCommitsMock.mockResolvedValue(pushPreview([]));

    const { findByText, queryByText } = render(
      <LocalCommitsDropdown cwd="/repo" branch="main" open initialCount={1} />
    );
    await findByText("git went away");
    await waitFor(() => expect(listPushCommitsMock).toHaveBeenCalled());

    expect(queryByText(/Nothing to push/)).toBeNull();
  });

  it("does not read push status without a branch", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));

    const { findAllByText } = render(<LocalCommitsDropdown cwd="/repo" open initialCount={1} />);
    await findAllByText("commit message 1");

    expect(listPushCommitsMock).not.toHaveBeenCalled();
  });
});

describe("LocalCommitsDropdown grid semantics", () => {
  it("keeps the combobox's popup target in every state, including empty", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([]));

    const { getByRole, findByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={0} />
    );
    await findByText("No commits on this branch yet");

    const controls = getByRole("combobox").getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)?.getAttribute("role")).toBe("grid");
  });

  it("puts no interactive control inside an option", async () => {
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1, "body"), makeCommit(2)]));

    const { findAllByText } = render(<LocalCommitsDropdown cwd="/repo" open initialCount={2} />);
    await findAllByText("commit message 2");

    for (const option of document.querySelectorAll('[role="option"]')) {
      expect(option.querySelector("button, a[href], input, [tabindex]")).toBeNull();
    }
    for (const row of document.querySelectorAll('#local-commit-list [role="row"]')) {
      expect(row.querySelector('[role="gridcell"]')).not.toBeNull();
    }
  });

  it("points aria-activedescendant at the Load more row after the last commit", async () => {
    const firstPage = Array.from({ length: 30 }, (_, i) => makeCommit(i));
    listCommitsMock.mockResolvedValueOnce(makeResponse(firstPage, { hasMore: true, total: 31 }));

    const { getByRole, findByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={31} />
    );
    await findByText("Load more");

    const input = getByRole("combobox");
    for (let i = 0; i < 31; i++) fireEvent.keyDown(input, { key: "ArrowDown" });

    const id = input.getAttribute("aria-activedescendant");
    expect(id).toBeTruthy();
    const target = document.getElementById(id!);
    expect(target?.getAttribute("role")).toBe("row");
    expect(target?.textContent).toContain("Load more");
  });

  it("marks whatever aria-activedescendant points at as the cursor row", async () => {
    const firstPage = Array.from({ length: 3 }, (_, i) => makeCommit(i));
    listCommitsMock.mockResolvedValueOnce(makeResponse(firstPage, { hasMore: true, total: 9 }));

    const { getByRole, findByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={9} />
    );
    await findByText("Load more");

    const input = getByRole("combobox");
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      const id = input.getAttribute("aria-activedescendant");
      const marked = document.querySelectorAll('#local-commit-list [data-active="true"]');
      expect(marked).toHaveLength(1);
      expect(marked[0]?.id).toBe(id);
    }
  });

  it("retries a failed read with Enter from the search field", async () => {
    listCommitsMock.mockRejectedValueOnce(new Error("git went away"));
    listCommitsMock.mockResolvedValueOnce(makeResponse([makeCommit(1)]));

    const { getByRole, findByText, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} />
    );
    await findByText("git went away");

    fireEvent.keyDown(getByRole("combobox"), { key: "Enter" });

    expect((await findAllByText("commit message 1")).length).toBeGreaterThan(0);
  });

  it("says so when the hash could not be copied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1)]));

    const { getByRole, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} />
    );
    await findAllByText("commit message 1");

    const input = getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect((await findAllByText("Couldn't copy hash")).length).toBeGreaterThan(0);
  });

  it("copies the active commit's hash with Shift+Enter even when it has a body", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    listCommitsMock.mockResolvedValue(makeResponse([makeCommit(1, "has a body")]));

    const { getByRole, findAllByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} />
    );
    await findAllByText("commit message 1");

    const input = getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(writeText).toHaveBeenCalledWith("hash-1");
    expect(document.getElementById("local-commit-row-hash-1")?.getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("shows git's reason without the IPC transport prefix", async () => {
    listCommitsMock.mockRejectedValue(
      new Error("Error invoking remote method 'git:list-commits': Error: git log timed out")
    );

    const { findByText, queryByText } = render(
      <LocalCommitsDropdown cwd="/repo" open initialCount={1} />
    );

    expect(await findByText("git log timed out")).toBeTruthy();
    expect(queryByText(/Error invoking remote method/)).toBeNull();
  });

  it("does not claim the branch is empty before the history read answers", async () => {
    listCommitsMock.mockImplementation(() => new Promise(() => {}));

    const { queryByText } = render(<LocalCommitsDropdown cwd="/repo" open initialCount={0} />);
    await waitFor(() => expect(listCommitsMock).toHaveBeenCalled());

    expect(queryByText("No commits on this branch yet")).toBeNull();
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

  it("keeps multi-line unindented fenced code on separate lines", () => {
    const body = "```\nconst x = 1;\nconst y = 2;\n```";
    const result = reflowCommitBody(body);
    expect(result).toBe(body);
    // The two code lines must not be joined into one (the #10718 fence bug).
    expect(result).not.toContain("const x = 1; const y = 2;");
    expect(result.split("\n")).toContain("const x = 1;");
    expect(result.split("\n")).toContain("const y = 2;");
  });

  it("reflows prose around a fenced block but keeps the fence verbatim", () => {
    const body =
      "Intro prose line one\nand its continuation.\n\n```\nfoo();\nbar();\n```\n\nClosing prose line\nand its continuation.";
    expect(reflowCommitBody(body)).toBe(
      "Intro prose line one and its continuation.\n\n```\nfoo();\nbar();\n```\n\nClosing prose line and its continuation."
    );
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
