import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useForgeResourceListSWR } from "../useForgeResourceListSWR";
import { _resetForTests } from "@/lib/forgeResourceCache";
import type { Issue, PR, Page } from "@shared/types/forge";

// @vitest-environment jsdom

const makeIssue = (n: number): Issue => ({
  number: n,
  title: `Issue ${n}`,
  body: "",
  state: "open",
  rawState: "opened",
  url: `https://fake.test/acme/widgets/issues/${n}`,
  assignees: [],
  labels: [],
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

const makePR = (n: number): PR => ({
  number: n,
  title: `PR ${n}`,
  body: "",
  state: "open",
  rawState: "opened",
  isDraft: false,
  merged: false,
  url: `https://fake.test/acme/widgets/pull/${n}`,
  baseRef: "main",
  headRef: `feat-${n}`,
  createdAt: 0,
  updatedAt: 0,
  rawData: null,
});

// A GitHub IPC surface that throws on any access. If the forge data path
// reaches around to `window.electron.github`, these tests fail loudly —
// proving provider isolation.
const githubTrap = new Proxy(
  {},
  {
    get() {
      throw new Error("window.electron.github must not be touched by the forge data path");
    },
  }
);

const listIssues = vi.fn<() => Promise<Page<Issue>>>();
const listPRs = vi.fn<() => Promise<Page<PR>>>();

describe("useForgeResourceListSWR (fake provider, no GitHub IPC)", () => {
  beforeEach(() => {
    _resetForTests();
    listIssues.mockReset();
    listPRs.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electron = {
      forge: { listIssues, listPRs },
      github: githubTrap,
    };
  });

  it("renders an issue list sourced entirely from the forge IPC path", async () => {
    listIssues.mockResolvedValue({
      items: [makeIssue(1), makeIssue(2)],
      nextCursor: null,
      hasMore: false,
    });

    const { result } = renderHook(() =>
      useForgeResourceListSWR({
        cwd: "/repo",
        providerId: "acme.gitea",
        owner: "acme",
        repo: "widgets",
        type: "issue",
        filterState: "open",
        sortOrder: "created",
      })
    );

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.map((i) => i.number)).toEqual([1, 2]);
    expect(result.current.error).toBeNull();
    expect(listIssues).toHaveBeenCalledWith({ cwd: "/repo", opts: {} });
  });

  it("renders a PR list without touching window.electron.github", async () => {
    listPRs.mockResolvedValue({
      items: [makePR(7)],
      nextCursor: "c1",
      hasMore: true,
    });

    const { result } = renderHook(() =>
      useForgeResourceListSWR({
        cwd: "/repo",
        providerId: "acme.gitea",
        owner: "acme",
        repo: "widgets",
        type: "pr",
        filterState: "open",
        sortOrder: "created",
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.map((p) => p.number)).toEqual([7]);
    expect(result.current.hasMore).toBe(true);
    expect(listPRs).toHaveBeenCalledTimes(1);
  });

  it("surfaces a provider error without crashing the list", async () => {
    listIssues.mockRejectedValue(new Error("Rate limit exceeded"));

    const { result } = renderHook(() =>
      useForgeResourceListSWR({
        cwd: "/repo",
        providerId: "acme.gitea",
        owner: "acme",
        repo: "widgets",
        type: "issue",
        filterState: "open",
        sortOrder: "created",
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Rate limit exceeded");
    expect(result.current.data).toEqual([]);
  });

  it("serves cached rows immediately on a remount, then revalidates", async () => {
    listIssues.mockResolvedValue({
      items: [makeIssue(1)],
      nextCursor: null,
      hasMore: false,
    });

    const params = {
      cwd: "/repo",
      providerId: "acme.gitea",
      owner: "acme",
      repo: "widgets",
      type: "issue" as const,
      filterState: "open",
      sortOrder: "created",
    };

    const first = renderHook(() => useForgeResourceListSWR(params));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const second = renderHook(() => useForgeResourceListSWR(params));
    // Cache hit — data is present synchronously, no loading skeleton.
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.data.map((i) => i.number)).toEqual([1]);
    await waitFor(() => expect(second.result.current.refreshing).toBe(false));
    expect(listIssues).toHaveBeenCalledTimes(2);
  });
});
