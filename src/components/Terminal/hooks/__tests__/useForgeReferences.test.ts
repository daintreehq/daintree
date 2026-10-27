// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Issue, ListOptions, Page, PR } from "@shared/types/forge";
import type { ResolvedForgeProviderState } from "@/hooks/useResolvedForgeProvider";

const { listIssues, listPRs, resolved } = vi.hoisted(() => ({
  listIssues: vi.fn<(cwd: string, opts?: ListOptions) => Promise<Page<Issue>>>(),
  listPRs: vi.fn<(cwd: string, opts?: ListOptions) => Promise<Page<PR>>>(),
  resolved: vi.fn<(projectId: string | null | undefined) => unknown>(),
}));

vi.mock("@/clients/forgeClient", () => ({ forgeClient: { listIssues, listPRs } }));
vi.mock("@/hooks/useResolvedForgeProvider", () => ({ useResolvedForgeProvider: resolved }));

import { useForgeReferences, _resetForgeReferencesForTests } from "../useForgeReferences";

function provider(
  referencePrefixes: { issue?: string; pr?: string } | undefined,
  issuesVia: "code" | "override" = "code",
  providerId = "github"
): ResolvedForgeProviderState & { refresh: () => void } {
  const entry = {
    pluginId: "daintree.github",
    contribution: { id: providerId, name: providerId, matches: ["forge.test"], referencePrefixes },
  };
  return {
    entry,
    providerId,
    resolvedVia: "hostname",
    issues: {
      entry,
      providerId: issuesVia === "code" ? providerId : "daintree.linear.linear",
      resolvedVia: issuesVia,
    },
    loading: false,
    refresh: () => {},
  };
}

const NO_PROVIDER = {
  entry: null,
  providerId: null,
  resolvedVia: null,
  issues: { entry: null, providerId: null, resolvedVia: null },
  loading: false,
  refresh: () => {},
};

function page<T>(items: T[]): Page<T> {
  return { items, nextCursor: null, hasMore: false };
}

function issue(number: number, updatedAt: number): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    state: "open",
    rawState: "OPEN",
    url: "",
    assignees: [],
    labels: [],
    createdAt: 0,
    updatedAt,
    rawData: null,
  };
}

function pr(number: number, updatedAt: number): PR {
  return {
    number,
    title: `PR ${number}`,
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: "",
    baseRef: "develop",
    headRef: "x",
    createdAt: 0,
    updatedAt,
    rawData: null,
  };
}

interface Props {
  enabled: boolean;
  cwd?: string;
}

function renderReferences(initial: Props) {
  return renderHook(
    ({ enabled, cwd = "/repo" }: Props) => useForgeReferences({ projectId: "p1", cwd, enabled }),
    { initialProps: initial }
  );
}

describe("useForgeReferences", () => {
  let now = 1_000_000;

  beforeEach(() => {
    _resetForgeReferencesForTests();
    listIssues.mockReset().mockResolvedValue(page([issue(14842, 1)]));
    listPRs.mockReset().mockResolvedValue(page([pr(14843, 2)]));
    resolved
      .mockReset()
      .mockImplementation((projectId) =>
        projectId ? provider({ issue: "#", pr: "#" }) : NO_PROVIDER
      );
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves and fetches nothing until a `#` token is being typed", () => {
    const { result } = renderReferences({ enabled: false });
    expect(resolved).toHaveBeenLastCalledWith(null);
    expect(listIssues).not.toHaveBeenCalled();
    expect(listPRs).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it("fetches open issues and pull requests, most recently updated first", async () => {
    const { result } = renderReferences({ enabled: true });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((ref) => ref.reference)).toEqual(["#14843", "#14842"]);
    const opts = { state: "open", sort: "updated", direction: "desc" };
    expect(listIssues).toHaveBeenCalledWith("/repo", expect.objectContaining(opts));
    expect(listPRs).toHaveBeenCalledWith("/repo", expect.objectContaining(opts));
  });

  it("asks once for every composer typing `#` at the same time", async () => {
    const first = renderReferences({ enabled: true });
    const second = renderReferences({ enabled: true });
    await waitFor(() => expect(first.result.current).toHaveLength(2));
    await waitFor(() => expect(second.result.current).toHaveLength(2));
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listPRs).toHaveBeenCalledTimes(1);
  });

  it("shows cached rows at once on the next `#` and only asks again once they're old", async () => {
    const { result, rerender } = renderReferences({ enabled: true });
    await waitFor(() => expect(result.current).toHaveLength(2));
    rerender({ enabled: false });
    expect(result.current).toEqual([]);

    rerender({ enabled: true });
    expect(result.current).toHaveLength(2);
    expect(listPRs).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    now += 60_000;
    listPRs.mockResolvedValue(page([pr(14850, 9), pr(14843, 2)]));
    rerender({ enabled: true });
    await waitFor(() => expect(result.current).toHaveLength(3));
    expect(listPRs).toHaveBeenCalledTimes(2);
  });

  it("fetches nothing when no provider resolves, or it declares no reference prefixes", () => {
    resolved.mockImplementation(() => NO_PROVIDER);
    const none = renderReferences({ enabled: true });
    expect(none.result.current).toEqual([]);

    resolved.mockImplementation(() => provider(undefined));
    const undeclared = renderReferences({ enabled: true });
    expect(undeclared.result.current).toEqual([]);

    expect(listIssues).not.toHaveBeenCalled();
    expect(listPRs).not.toHaveBeenCalled();
  });

  it("leaves issues out when another tracker serves them", async () => {
    resolved.mockImplementation((projectId) =>
      projectId ? provider({ issue: "#", pr: "#" }, "override") : NO_PROVIDER
    );
    const { result } = renderReferences({ enabled: true });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]!.kind).toBe("pr");
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("keeps one list's rows when the other fails", async () => {
    listIssues.mockRejectedValue(new Error("rate limited"));
    const { result } = renderReferences({ enabled: true });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]!.reference).toBe("#14843");
  });

  it("offers nothing when every list fails, and waits before asking again", async () => {
    listIssues.mockRejectedValue(new Error("No credential"));
    listPRs.mockRejectedValue(new Error("No credential"));
    const { result, rerender } = renderReferences({ enabled: true });
    await waitFor(() => expect(listPRs).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(result.current).toEqual([]);

    rerender({ enabled: false });
    rerender({ enabled: true });
    await Promise.resolve();
    expect(listPRs).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    now += 20_000;
    listIssues.mockResolvedValue(page([issue(1, 1)]));
    listPRs.mockResolvedValue(page([]));
    rerender({ enabled: true });
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(listPRs).toHaveBeenCalledTimes(2);
  });

  it("never shows one worktree's rows in another", async () => {
    let finishFirst: (value: Page<PR>) => void = () => {};
    listPRs.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    listIssues.mockResolvedValue(page([]));
    const { result, rerender } = renderReferences({ enabled: true, cwd: "/repo-a" });
    listPRs.mockResolvedValue(page([pr(2, 1)]));
    rerender({ enabled: true, cwd: "/repo-b" });
    await waitFor(() => expect(result.current.map((ref) => ref.number)).toEqual([2]));

    finishFirst(page([pr(1, 1)]));
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.map((ref) => ref.number)).toEqual([2]);
  });

  it("never serves one provider's cached rows once the project resolves to another", async () => {
    const { result, rerender } = renderReferences({ enabled: true });
    await waitFor(() => expect(result.current.map((ref) => ref.number)).toEqual([14843, 14842]));
    rerender({ enabled: false });

    // Same cwd, same prefixes: only the provider tells the two apart.
    resolved.mockImplementation((projectId) =>
      projectId ? provider({ issue: "#", pr: "#" }, "code", "daintree.gitea.gitea") : NO_PROVIDER
    );
    listIssues.mockResolvedValue(page([]));
    listPRs.mockResolvedValue(page([pr(2, 1)]));
    rerender({ enabled: true });
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current.map((ref) => ref.number)).toEqual([2]));
    expect(listPRs).toHaveBeenCalledTimes(2);
  });

  describe("when a remote changes", () => {
    let remoteChanged: () => void = () => {};
    const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

    beforeEach(() => {
      Object.defineProperty(window, "electron", {
        configurable: true,
        value: {
          forge: {
            onRemoteChanged: (callback: () => void) => {
              remoteChanged = callback;
              return () => {
                remoteChanged = () => {};
              };
            },
          },
        },
      });
    });

    afterEach(() => {
      _resetForgeReferencesForTests();
      if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
      else delete (window as { electron?: unknown }).electron;
    });

    async function settle() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    it("asks again on the next `#`, since the repository may be another", async () => {
      const { result, rerender } = renderReferences({ enabled: true });
      await waitFor(() => expect(result.current).toHaveLength(2));
      rerender({ enabled: false });
      act(() => remoteChanged());
      listPRs.mockResolvedValue(page([pr(7, 9)]));
      listIssues.mockResolvedValue(page([]));
      rerender({ enabled: true });
      await waitFor(() => expect(result.current.map((ref) => ref.number)).toEqual([7]));
      expect(listPRs).toHaveBeenCalledTimes(2);
    });

    it("drops the rows on screen and asks again while `#` is still being typed", async () => {
      const { result } = renderReferences({ enabled: true });
      await waitFor(() => expect(result.current).toHaveLength(2));
      listPRs.mockResolvedValue(page([pr(7, 9)]));
      listIssues.mockResolvedValue(page([]));
      act(() => remoteChanged());
      expect(result.current).toEqual([]);
      await waitFor(() => expect(result.current.map((ref) => ref.number)).toEqual([7]));
      expect(listPRs).toHaveBeenCalledTimes(2);
    });

    it("never shows or keeps an answer asked of the remote before it changed", async () => {
      let finishFirst: (value: Page<PR>) => void = () => {};
      listPRs.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      );
      listIssues.mockResolvedValue(page([]));
      const { result, rerender } = renderReferences({ enabled: true });
      await waitFor(() => expect(listPRs).toHaveBeenCalledTimes(1));

      listPRs.mockResolvedValue(page([pr(2, 1)]));
      act(() => remoteChanged());
      await waitFor(() => expect(result.current.map((ref) => ref.number)).toEqual([2]));

      // The old answer lands last.
      await act(async () => finishFirst(page([pr(1, 1)])));
      await settle();
      expect(result.current.map((ref) => ref.number)).toEqual([2]);

      rerender({ enabled: false });
      rerender({ enabled: true });
      await settle();
      expect(result.current.map((ref) => ref.number)).toEqual([2]);
      expect(listPRs).toHaveBeenCalledTimes(2);
    });
  });
});
