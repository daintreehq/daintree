// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PRTooltipData, IssueTooltipData } from "@shared/types/forge";

const { getPRTooltipMock, getIssueTooltipMock, getCredentialStatusMock } = vi.hoisted(() => ({
  getPRTooltipMock: vi.fn<(cwd: string, prNumber: number) => Promise<PRTooltipData | null>>(),
  getIssueTooltipMock:
    vi.fn<(cwd: string, issueNumber: number) => Promise<IssueTooltipData | null>>(),
  getCredentialStatusMock: vi.fn<(providerId: string) => Promise<{ hasCredential: boolean }>>(),
}));

vi.mock("@/clients", () => ({
  forgeClient: {
    getPRTooltip: getPRTooltipMock,
    getIssueTooltip: getIssueTooltipMock,
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: { id: "test-project" } }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: { pluginId: "test.forge", contribution: { id: "provider", name: "Test Forge" } },
    providerId: "test.forge.provider",
    resolvedVia: "hostname",
    loading: false,
    refresh: () => {},
  }),
}));

import { usePRTooltip, useIssueTooltip, invalidateForgeTooltipCaches } from "../useForgeTooltip";

const CWD = "/repo/worktree";

function makePR(title: string): PRTooltipData {
  return { title, state: "open", author: "octocat" } as PRTooltipData;
}

function makeIssue(title: string): IssueTooltipData {
  return { title, state: "open" } as IssueTooltipData;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Each test starts from an empty cache so a previous test's entries can't
  // satisfy a fetch this one expects to reach the client.
  invalidateForgeTooltipCaches();
  getCredentialStatusMock.mockResolvedValue({ hasCredential: true });
  Object.defineProperty(window, "electron", {
    value: { forge: { getCredentialStatus: getCredentialStatusMock } },
    writable: true,
    configurable: true,
  });
});

describe("usePRTooltip caching", () => {
  it("serves a repeat fetch for the same PR from cache without re-hitting the client", async () => {
    getPRTooltipMock.mockResolvedValue(makePR("Original title"));

    const { result } = renderHook(() => usePRTooltip(CWD, 42));

    await act(async () => {
      await result.current.fetchTooltip();
    });
    await act(async () => {
      await result.current.fetchTooltip();
    });

    expect(getPRTooltipMock).toHaveBeenCalledTimes(1);
    expect(result.current.data?.title).toBe("Original title");
  });

  it("re-reads from the provider after a sidebar refresh instead of serving the cached copy", async () => {
    getPRTooltipMock.mockResolvedValue(makePR("Original title"));

    const { result } = renderHook(() => usePRTooltip(CWD, 42));
    await act(async () => {
      await result.current.fetchTooltip();
    });
    expect(getPRTooltipMock).toHaveBeenCalledTimes(1);

    getPRTooltipMock.mockResolvedValue(makePR("Updated title"));
    act(() => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
    });

    await act(async () => {
      await result.current.fetchTooltip();
    });

    expect(getPRTooltipMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data?.title).toBe("Updated title"));
  });

  it("does not let a response that predates the refresh repopulate the cleared cache", async () => {
    // The user hovers (fetch starts), then clicks refresh before the response
    // lands. Writing that pre-refresh response into the cache would make the
    // NEXT hover serve stale data with no request — the exact staleness the
    // refresh was supposed to clear.
    let resolveFirst: (value: PRTooltipData) => void = () => {};
    getPRTooltipMock.mockReturnValueOnce(
      new Promise<PRTooltipData>((resolve) => {
        resolveFirst = resolve;
      })
    );

    const { result } = renderHook(() => usePRTooltip(CWD, 42));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.fetchTooltip();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
    });

    await act(async () => {
      resolveFirst(makePR("Stale title"));
      await pending;
    });

    getPRTooltipMock.mockResolvedValue(makePR("Fresh title"));
    await act(async () => {
      await result.current.fetchTooltip();
    });

    // Two client calls total: the cache must not have been satisfied by the
    // in-flight response that resolved after the invalidation.
    expect(getPRTooltipMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data?.title).toBe("Fresh title"));
  });

  it("does not let a pre-refresh response overwrite a newer one that already resolved", async () => {
    // Ordering matters: the stale request resolves LAST. Fencing only the cache
    // write would still let its setState repaint the open tooltip over the
    // fresh data — and forge badge tooltips do not auto-dismiss, so it would
    // stay wrong on screen.
    let resolveStale: (value: PRTooltipData) => void = () => {};
    getPRTooltipMock.mockReturnValueOnce(
      new Promise<PRTooltipData>((resolve) => {
        resolveStale = resolve;
      })
    );

    const { result } = renderHook(() => usePRTooltip(CWD, 42));

    let stalePending: Promise<void> = Promise.resolve();
    act(() => {
      stalePending = result.current.fetchTooltip();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
    });

    getPRTooltipMock.mockResolvedValue(makePR("Fresh title"));
    await act(async () => {
      await result.current.fetchTooltip();
    });
    await waitFor(() => expect(result.current.data?.title).toBe("Fresh title"));

    await act(async () => {
      resolveStale(makePR("Stale title"));
      await stalePending;
    });

    expect(result.current.data?.title).toBe("Fresh title");
  });
});

describe("useIssueTooltip caching", () => {
  it("re-reads issue detail from the provider after a sidebar refresh", async () => {
    getIssueTooltipMock.mockResolvedValue(makeIssue("Original issue"));

    const { result } = renderHook(() => useIssueTooltip(CWD, 7));
    await act(async () => {
      await result.current.fetchTooltip();
    });
    await act(async () => {
      await result.current.fetchTooltip();
    });
    expect(getIssueTooltipMock).toHaveBeenCalledTimes(1);

    getIssueTooltipMock.mockResolvedValue(makeIssue("Updated issue"));
    act(() => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
    });

    await act(async () => {
      await result.current.fetchTooltip();
    });

    expect(getIssueTooltipMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data?.title).toBe("Updated issue"));
  });
});
