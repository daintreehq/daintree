/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Issue, IssueComment, Page } from "@shared/types/forge";

const mockGetIssue = vi.fn();
const mockListIssueComments = vi.fn();

vi.mock("@/clients", () => ({
  forgeClient: {
    getIssue: (...args: unknown[]) => mockGetIssue(...args),
    listIssueComments: (...args: unknown[]) => mockListIssueComments(...args),
  },
}));

import {
  ISSUE_COMMENT_MAX_PAGES,
  ISSUE_PROMPT_READ_TIMEOUT_MS,
  loadIssuePromptContext,
  useIssuePromptContext,
} from "../useIssuePromptContext";

const ROOT = "/repo";

function makeIssue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body of ${number}`,
    state: "open",
    rawState: "OPEN",
    url: `https://github.com/acme/app/issues/${number}`,
    assignees: [],
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    rawData: null,
    ...overrides,
  };
}

function makeComment(n: number): IssueComment {
  return {
    id: String(n),
    body: `comment ${n}`,
    url: "",
    author: { login: `user${n}`, rawData: null },
    createdAt: Date.UTC(2026, 0, 1) + n,
    rawData: null,
  };
}

function page(items: IssueComment[], nextCursor: string | null): Page<IssueComment> {
  return { items, nextCursor, hasMore: nextCursor !== null };
}

function unsupportedError(): Error {
  // How an AppError arrives in the renderer: its code rides the message prefix.
  return new Error(
    "[AppError|UNSUPPORTED] The active forge provider does not support reading issue comments"
  );
}

beforeEach(() => {
  mockGetIssue.mockReset();
  mockListIssueComments.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadIssuePromptContext", () => {
  it("quotes the fresh issue with the newest comments from every page", async () => {
    mockGetIssue.mockResolvedValue(makeIssue(7, { body: "fresh body" }));
    const all = Array.from({ length: 150 }, (_, i) => makeComment(i + 1));
    mockListIssueComments
      .mockResolvedValueOnce(page(all.slice(0, 100), "c2"))
      .mockResolvedValueOnce(page(all.slice(100), null));

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitHub",
    });

    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.comments).toBe("read");
    expect(read.context.text).toContain("fresh body");
    expect(read.context.text).toContain("Comments (newest 5 of 150):");
    expect(read.context.text).toContain("comment 150");
    expect(read.context.text).toContain("comment 146");
    expect(read.context.text).not.toMatch(/comment 145(?!\d)/);
    expect(mockListIssueComments).toHaveBeenNthCalledWith(2, ROOT, 7, {
      perPage: 100,
      cursor: "c2",
    });
  });

  it("quotes the issue alone when the provider can't serve comments", async () => {
    mockGetIssue.mockResolvedValue(makeIssue(7));
    mockListIssueComments.mockRejectedValue(unsupportedError());

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitLab",
    });

    expect(read).toMatchObject({ status: "ready", comments: "unsupported" });
  });

  it("keeps the issue when reading its comments fails", async () => {
    mockGetIssue.mockResolvedValue(makeIssue(7));
    mockListIssueComments.mockRejectedValue(new Error("rate limited"));

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitHub",
    });

    expect(read).toMatchObject({ status: "ready", comments: "failed" });
    if (read.status === "ready") expect(read.context.text).toContain("couldn't be read");
  });

  it("leaves out a thread longer than it reads instead of calling its start the newest", async () => {
    mockGetIssue.mockResolvedValue(makeIssue(7));
    mockListIssueComments.mockImplementation((_cwd, _n, opts: { cursor?: string }) =>
      Promise.resolve(page([makeComment(1)], `after-${opts.cursor ?? "start"}`))
    );

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitHub",
    });

    expect(mockListIssueComments).toHaveBeenCalledTimes(ISSUE_COMMENT_MAX_PAGES);
    expect(read).toMatchObject({ status: "ready", comments: "too-long" });
    if (read.status === "ready") expect(read.context.commentsIncluded).toBe(0);
  });

  it("stops on a cursor that comes round again", async () => {
    mockGetIssue.mockResolvedValue(makeIssue(7));
    mockListIssueComments
      .mockResolvedValueOnce(page([makeComment(1)], "A"))
      .mockResolvedValueOnce(page([makeComment(2)], "B"))
      .mockResolvedValueOnce(page([makeComment(3)], "A"));

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitHub",
    });

    expect(read).toMatchObject({ status: "ready", comments: "failed" });
  });

  it("stops on a cursor that doesn't move", async () => {
    mockGetIssue.mockResolvedValue(makeIssue(7));
    mockListIssueComments.mockResolvedValue(page([makeComment(1)], "same"));

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitHub",
    });

    expect(mockListIssueComments).toHaveBeenCalledTimes(2);
    expect(read).toMatchObject({ status: "ready", comments: "failed" });
  });

  it("reports an issue the provider no longer has", async () => {
    mockGetIssue.mockResolvedValue(null);

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "Linear",
    });

    expect(read).toEqual({ status: "error", reason: "not found" });
    expect(mockListIssueComments).not.toHaveBeenCalled();
  });

  it("reports a failed issue read in the error's own words", async () => {
    mockGetIssue.mockRejectedValue(new Error("Bad credentials"));

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitHub",
    });

    expect(read).toEqual({ status: "error", reason: "Bad credentials" });
  });

  it("gives up on a read that outlasts its budget", async () => {
    vi.useFakeTimers();
    mockGetIssue.mockReturnValue(new Promise(() => {}));

    const pending = loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitHub",
    });
    await vi.advanceTimersByTimeAsync(ISSUE_PROMPT_READ_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ status: "error", reason: "timed out" });
  });
});

describe("loadIssuePromptContext's deadline", () => {
  it("starts no comments read once the issue read has spent the budget", async () => {
    vi.useFakeTimers();
    mockGetIssue.mockImplementation(async () => {
      // The issue arrives just as the budget runs out; no timer has fired yet.
      vi.setSystemTime(Date.now() + ISSUE_PROMPT_READ_TIMEOUT_MS);
      return makeIssue(7);
    });

    const read = await loadIssuePromptContext({
      cwd: ROOT,
      issue: { number: 7 },
      providerName: "GitHub",
    });

    expect(mockListIssueComments).not.toHaveBeenCalled();
    expect(read).toMatchObject({ status: "ready", comments: "failed" });
  });
});

describe("useIssuePromptContext", () => {
  function render(initial: { enabled: boolean; issue: Issue | null }) {
    return renderHook(
      (props: { enabled: boolean; issue: Issue | null }) =>
        useIssuePromptContext({
          enabled: props.enabled,
          cwd: ROOT,
          issue: props.issue,
          providerId: "daintree.github",
          providerName: "GitHub",
        }),
      { initialProps: initial }
    );
  }

  it("reads nothing while off", () => {
    const { result } = render({ enabled: false, issue: makeIssue(1) });
    expect(result.current.state).toEqual({ status: "off" });
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  it("loads, then offers the quote", async () => {
    mockGetIssue.mockResolvedValue(makeIssue(1));
    mockListIssueComments.mockResolvedValue(page([], null));

    const { result } = render({ enabled: true, issue: makeIssue(1) });
    expect(result.current.state).toEqual({ status: "loading" });

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("never offers one issue's quote for another, even when the first settles late", async () => {
    let resolveFirst: (issue: Issue) => void = () => {};
    mockGetIssue.mockImplementation((_cwd: string, n: number) =>
      n === 1
        ? new Promise<Issue>((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(makeIssue(2))
    );
    mockListIssueComments.mockResolvedValue(page([], null));

    const { result, rerender } = render({ enabled: true, issue: makeIssue(1) });
    rerender({ enabled: true, issue: makeIssue(2) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => {
      resolveFirst(makeIssue(1));
    });

    const state = result.current.state;
    expect(state.status === "ready" && state.context.text).toContain("Issue #2 from GitHub");
  });

  it("reads afresh when turned back on, never offering the last read meanwhile", async () => {
    mockGetIssue.mockResolvedValueOnce(makeIssue(1)).mockReturnValue(new Promise(() => {}));
    mockListIssueComments.mockResolvedValue(page([], null));
    const issue = makeIssue(1);

    const { result, rerender } = render({ enabled: true, issue });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    rerender({ enabled: false, issue });
    rerender({ enabled: true, issue });

    expect(result.current.state).toEqual({ status: "loading" });
    expect(mockGetIssue).toHaveBeenCalledTimes(2);
  });

  it("doesn't read again for the same issue handed over as a new object", async () => {
    mockGetIssue.mockResolvedValue(makeIssue(1));
    mockListIssueComments.mockResolvedValue(page([], null));

    const { result, rerender } = render({ enabled: true, issue: makeIssue(1) });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    rerender({ enabled: true, issue: makeIssue(1) });

    expect(result.current.state.status).toBe("ready");
    expect(mockGetIssue).toHaveBeenCalledTimes(1);
  });

  it("reads again on retry", async () => {
    mockGetIssue.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(makeIssue(1));
    mockListIssueComments.mockResolvedValue(page([], null));

    const { result } = render({ enabled: true, issue: makeIssue(1) });
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: "error", reason: "offline" })
    );

    act(() => result.current.retry());
    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(mockGetIssue).toHaveBeenCalledTimes(2);
  });
});
