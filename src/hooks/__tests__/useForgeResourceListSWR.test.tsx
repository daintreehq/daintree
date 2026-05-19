import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useForgeResourceListSWR } from "../useForgeResourceListSWR";
import { _resetForTests, nextGeneration } from "@/lib/forgeResourceCache";
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double: only the forge surface is exercised; github is a throwing trap proving isolation
    window.electron = {
      forge: { listIssues, listPRs },
      github: githubTrap,
    } as unknown as typeof window.electron;
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

  it("clears the previous repo's rows on a cache-key change", async () => {
    listIssues.mockResolvedValueOnce({
      items: [makeIssue(1), makeIssue(2)],
      nextCursor: null,
      hasMore: false,
    });

    const { result, rerender } = renderHook((props) => useForgeResourceListSWR(props), {
      initialProps: {
        cwd: "/repo-a",
        providerId: "acme.gitea",
        owner: "acme",
        repo: "alpha",
        type: "issue" as const,
        filterState: "open",
        sortOrder: "created",
      },
    });

    await waitFor(() => expect(result.current.data.map((i) => i.number)).toEqual([1, 2]));

    // Switch to a different repo; its fetch rejects. Stale alpha rows must
    // not bleed through while loading or after the failure.
    listIssues.mockRejectedValueOnce(new Error("nope"));
    rerender({
      cwd: "/repo-b",
      providerId: "acme.gitea",
      owner: "acme",
      repo: "beta",
      type: "issue" as const,
      filterState: "open",
      sortOrder: "created",
    });

    expect(result.current.data).toEqual([]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([]);
    expect(result.current.error).toBe("nope");
  });

  it("does not strand loading when the generation map evicts its key", async () => {
    let resolveFetch: (page: Page<Issue>) => void = () => {};
    listIssues.mockImplementation(
      () =>
        new Promise<Page<Issue>>((resolve) => {
          resolveFetch = resolve;
        })
    );

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

    // Evict the hook's key from the bounded generation map by churning 20+
    // unrelated keys, then let the original in-flight fetch resolve.
    for (let i = 0; i < 25; i++) nextGeneration(`unrelated-${i}`);
    resolveFetch({ items: [makeIssue(9)], nextCursor: null, hasMore: false });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.map((i) => i.number)).toEqual([9]);
  });
});
