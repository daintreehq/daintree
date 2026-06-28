import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FileDecorationProviderImpl,
  ForgeProviderImpl,
} from "../../../../../shared/types/forge.js";
import type { PluginHostApi, PluginWorktreeSnapshot } from "../../../../../shared/types/plugin.js";

const mockGetPRReviewThreads = vi.fn();
const mockBuildPRFileUrl = vi.fn(
  (repo: { owner: string; repo: string }, number: number, path: string): string =>
    `https://example.test/${repo.owner}/${repo.repo}/pull/${number}/files#diff-${path}`
);

vi.mock("../GitHubPRs.js", () => ({
  getPRReviewThreads: (...args: unknown[]) => mockGetPRReviewThreads(...args),
}));

import { clearPRCaches, REVIEW_THREADS_TTL_MS } from "../GitHubCaches.js";
import {
  createReviewDecorationProvider,
  registerReviewDecorationProvider,
} from "../reviewDecorationProvider.js";

function makeHost(worktrees: PluginWorktreeSnapshot[] = []): PluginHostApi {
  return {
    getWorktrees: vi.fn().mockResolvedValue(worktrees),
    registerFileDecorationProvider: vi.fn(),
    onDidChangeWorktrees: vi.fn(),
    invalidateFileDecorations: vi.fn(),
  } as unknown as PluginHostApi;
}

function makeForgeProvider(opts: { withBuildPRFileUrl: boolean }): ForgeProviderImpl {
  if (!opts.withBuildPRFileUrl) {
    return {} as ForgeProviderImpl;
  }
  return {
    buildPRFileUrl: (repo: { owner: string; repo: string }, number: number, path: string) =>
      mockBuildPRFileUrl(repo, number, path),
  } as unknown as ForgeProviderImpl;
}

function makeWorktree(
  path: string,
  prNumber: number,
  owner = "owner",
  repo = "repo"
): PluginWorktreeSnapshot {
  return {
    path,
    linked: { pr: { ref: { number: prNumber, owner, repo } } },
  } as unknown as PluginWorktreeSnapshot;
}

describe("createReviewDecorationProvider", () => {
  let provider: FileDecorationProviderImpl;
  let forgeProvider: ForgeProviderImpl;

  beforeEach(() => {
    mockGetPRReviewThreads.mockReset();
    mockBuildPRFileUrl.mockClear();
    // Default: provider that implements buildPRFileUrl. Individual tests
    // swap in a stripped-down provider to assert the capability-missing path.
    forgeProvider = makeForgeProvider({ withBuildPRFileUrl: true });
    provider = createReviewDecorationProvider(makeHost([]), forgeProvider);
  });

  it("returns empty object for non-worktree-diff scope", async () => {
    const result = await provider.provideDecorations("other-scope", ["src/a.ts"]);
    expect(result).toEqual({});
  });

  it("returns empty object when scope has no path", async () => {
    const result = await provider.provideDecorations("worktree-diff:", ["src/a.ts"]);
    expect(result).toEqual({});
  });

  it("returns empty object when paths array is empty", async () => {
    const result = await provider.provideDecorations("worktree-diff:/some/path", []);
    expect(result).toEqual({});
  });

  it("returns empty object when worktree is not found", async () => {
    const host = makeHost([makeWorktree("/other/path", 1)]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    const result = await provider.provideDecorations("worktree-diff:/missing", ["src/a.ts"]);
    expect(result).toEqual({});
  });

  it("returns empty object when worktree has no PR link", async () => {
    const host = makeHost([{ path: "/some/path" } as PluginWorktreeSnapshot]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);
    expect(result).toEqual({});
  });

  it("produces decorations for files with unresolved threads", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 3, "src/b.ts": 1 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);

    expect(result["src/a.ts"]).toEqual({
      badge: "3",
      tooltip: "3 unresolved review comments",
      color: "text-status-warning",
      url: "https://example.test/owner/repo/pull/42/files#diff-src/a.ts",
    });
    expect(result["src/b.ts"]).toEqual({
      badge: "1",
      tooltip: "1 unresolved review comment",
      color: "text-status-warning",
      url: "https://example.test/owner/repo/pull/42/files#diff-src/b.ts",
    });
    expect(result["src/c.ts"]).toBeUndefined();
  });

  it("filters to only the requested paths", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 5, "src/b.ts": 2 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(Object.keys(result)).toEqual(["src/a.ts"]);
    expect(result["src/a.ts"]!.badge).toBe("5");
  });

  it("appends (partial count) to tooltip when __clampedAt sentinel is present", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({
      "src/a.ts": 100,
      __clampedAt: 500,
    });

    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(result["src/a.ts"]!.tooltip).toBe("100 unresolved review comments (partial count)");
    expect(result.__clampedAt).toBeUndefined(); // sentinel is stripped
  });

  it("does not include (partial count) when sentinel is absent", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 2 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(result["src/a.ts"]!.tooltip).toBe("2 unresolved review comments");
  });

  it("skips files with count 0", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 0, "src/b.ts": 3 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", [
      "src/a.ts",
      "src/b.ts",
    ]);

    expect(result["src/a.ts"]).toBeUndefined();
    expect(result["src/b.ts"]).toBeDefined();
  });

  it("does not produce a decoration for the __clampedAt key even if not explicitly stripped", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({
      "src/a.ts": 1,
      __clampedAt: 500,
    });

    const result = await provider.provideDecorations("worktree-diff:/some/path", [
      "src/a.ts",
      "__clampedAt",
    ]);

    // __clampedAt shouldn't appear — the spread destructure strips it
    expect(result.__clampedAt).toBeUndefined();
  });

  // Issue #9953 regression: the provider-owned `buildPRFileUrl` is the
  // single source of the deep-link. The renderer must NEVER reconstruct
  // a GitHub-shaped URL from a base PR URL.
  it("populates url via the provider's buildPRFileUrl when the capability is present", async () => {
    const host = makeHost([makeWorktree("/some/path", 42, "test-owner", "test-repo")]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 1 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(mockBuildPRFileUrl).toHaveBeenCalledTimes(1);
    expect(mockBuildPRFileUrl).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo" }),
      42,
      "src/a.ts"
    );
    expect(result["src/a.ts"]!.url).toBe(
      "https://example.test/test-owner/test-repo/pull/42/files#diff-src/a.ts"
    );
  });

  // Capability-missing path: a future non-GitHub provider (or an older
  // githubForgeProvider that predates buildPRFileUrl) ships without the
  // builder. The decoration must still be returned — with badge/tooltip/
  // color intact — but `url` is undefined so the renderer skips the click
  // handler. The capability check uses truthiness, not `in`, per the
  // forge.ts:463-466 contract comment.
  it("omits url when the provider does not implement buildPRFileUrl", async () => {
    const strippedProvider = makeForgeProvider({ withBuildPRFileUrl: false });
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host, strippedProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 2 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(result["src/a.ts"]).toBeDefined();
    expect(result["src/a.ts"]!.badge).toBe("2");
    expect(result["src/a.ts"]!.tooltip).toBe("2 unresolved review comments");
    expect(result["src/a.ts"]!.color).toBe("text-status-warning");
    expect(result["src/a.ts"]!.url).toBeUndefined();
    expect(mockBuildPRFileUrl).not.toHaveBeenCalled();
  });

  // Legacy-snapshot guard: a `PluginWorktreeSnapshot` synthesized by the
  // host's snapshot adapter can carry a `linked.pr.ref.number` without
  // populating `owner` / `repo` (e.g. a worktree linked before the
  // canonical ResourceRef projection landed). Building a URL from empty
  // strings would produce `https://github.com///pull/N/files#diff-…` —
  // unsalvageable. The plugin must omit `url` so the badge stays as an
  // indicator but the click target is disabled.
  it("omits url when the snapshot has prNumber but no owner/repo", async () => {
    const host = makeHost([
      {
        path: "/some/path",
        linked: { pr: { ref: { number: 42 } } },
      } as unknown as PluginWorktreeSnapshot,
    ]);
    provider = createReviewDecorationProvider(host, forgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 1 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(result["src/a.ts"]).toBeDefined();
    expect(result["src/a.ts"]!.badge).toBe("1");
    // Builder MUST NOT be called with empty owner/repo — it would emit a
    // broken URL the host can't recover from.
    expect(mockBuildPRFileUrl).not.toHaveBeenCalled();
    expect(result["src/a.ts"]!.url).toBeUndefined();
  });

  // Real-anchor sanity check: a provider instance with a real
  // `buildPRFileUrl` produces a URL whose path/hash match the github.com
  // formula, not a placeholder. Bridges the delegation-only tests above
  // to a concrete anchor (the issue is that the renderer used to wire
  // `${prUrl}/files?file=...` instead of letting the provider author it).
  it("emits a github.com-shaped anchor via the real provider", async () => {
    const { githubForgeProvider } = await import("../forgeProvider.js");
    const host = makeHost([makeWorktree("/some/path", 42, "owner", "repo")]);
    provider = createReviewDecorationProvider(host, githubForgeProvider);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/has space.ts": 1 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", [
      "src/has space.ts",
    ]);

    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update("src/has space.ts", "utf8").digest("hex");
    expect(result["src/has space.ts"]!.url).toBe(
      `https://github.com/owner/repo/pull/42/files#diff-${expected}`
    );
  });
});

describe("registerReviewDecorationProvider", () => {
  function makeRegisterHost() {
    let onChange: ((snapshots: PluginWorktreeSnapshot[]) => void) | undefined;
    let providerImpl: FileDecorationProviderImpl | undefined;
    const host = {
      getWorktrees: vi.fn().mockResolvedValue([]),
      registerFileDecorationProvider: vi.fn((_meta: unknown, impl: FileDecorationProviderImpl) => {
        providerImpl = impl;
        return () => {};
      }),
      onDidChangeWorktrees: vi.fn((cb: (snapshots: PluginWorktreeSnapshot[]) => void) => {
        onChange = cb;
        return () => {};
      }),
      invalidateFileDecorations: vi.fn(),
    } as unknown as PluginHostApi;
    return {
      host,
      emit: (snapshots: PluginWorktreeSnapshot[]) => onChange!(snapshots),
      getProvider: () => providerImpl!,
    };
  }

  function unlinkedWorktree(path: string): PluginWorktreeSnapshot {
    return { path, linked: null } as unknown as PluginWorktreeSnapshot;
  }

  beforeEach(() => {
    mockGetPRReviewThreads.mockReset();
  });

  it("invalidates only PR-linked scopes on the first event", async () => {
    const { host, emit } = makeRegisterHost();
    await registerReviewDecorationProvider(host, makeForgeProvider({ withBuildPRFileUrl: true }));

    emit([makeWorktree("/linked", 42), unlinkedWorktree("/plain")]);

    expect(host.invalidateFileDecorations).toHaveBeenCalledTimes(1);
    expect(host.invalidateFileDecorations).toHaveBeenCalledWith("worktree-diff:/linked");
  });

  it("skips invalidation when linkage is unchanged within the TTL", async () => {
    const { host, emit } = makeRegisterHost();
    await registerReviewDecorationProvider(host, makeForgeProvider({ withBuildPRFileUrl: true }));

    emit([makeWorktree("/linked", 42)]);
    emit([makeWorktree("/linked", 42)]);
    emit([makeWorktree("/linked", 42)]);

    expect(host.invalidateFileDecorations).toHaveBeenCalledTimes(1);
  });

  it("invalidates when the linked PR number changes", async () => {
    const { host, emit } = makeRegisterHost();
    await registerReviewDecorationProvider(host, makeForgeProvider({ withBuildPRFileUrl: true }));

    emit([makeWorktree("/linked", 42)]);
    emit([makeWorktree("/linked", 43)]);

    expect(host.invalidateFileDecorations).toHaveBeenCalledTimes(2);
  });

  it("invalidates when a PR linkage is removed", async () => {
    const { host, emit } = makeRegisterHost();
    await registerReviewDecorationProvider(host, makeForgeProvider({ withBuildPRFileUrl: true }));

    emit([makeWorktree("/linked", 42)]);
    emit([unlinkedWorktree("/linked")]);

    expect(host.invalidateFileDecorations).toHaveBeenCalledTimes(2);
    expect(host.invalidateFileDecorations).toHaveBeenLastCalledWith("worktree-diff:/linked");
  });

  it("invalidates an unchanged linkage again once the TTL elapses", async () => {
    const { host, emit } = makeRegisterHost();
    await registerReviewDecorationProvider(host, makeForgeProvider({ withBuildPRFileUrl: true }));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      emit([makeWorktree("/linked", 42)]);
      nowSpy.mockReturnValue(1_000_000 + REVIEW_THREADS_TTL_MS - 1);
      emit([makeWorktree("/linked", 42)]);
      expect(host.invalidateFileDecorations).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_000_000 + REVIEW_THREADS_TTL_MS);
      emit([makeWorktree("/linked", 42)]);
      expect(host.invalidateFileDecorations).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("invalidates an unchanged linkage within the TTL after a manual cache clear", async () => {
    const { host, emit } = makeRegisterHost();
    await registerReviewDecorationProvider(host, makeForgeProvider({ withBuildPRFileUrl: true }));

    emit([makeWorktree("/linked", 42)]);
    emit([makeWorktree("/linked", 42)]);
    expect(host.invalidateFileDecorations).toHaveBeenCalledTimes(1);

    clearPRCaches();
    emit([makeWorktree("/linked", 42)]);
    expect(host.invalidateFileDecorations).toHaveBeenCalledTimes(2);
  });

  it("serves linkage from the event-fed cache without a snapshot round-trip", async () => {
    const { host, emit, getProvider } = makeRegisterHost();
    await registerReviewDecorationProvider(host, makeForgeProvider({ withBuildPRFileUrl: true }));
    emit([makeWorktree("/some/path", 42)]);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 2 });

    const result = await getProvider().provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(result["src/a.ts"]!.badge).toBe("2");
    expect(host.getWorktrees).not.toHaveBeenCalled();
  });

  it("falls back to host.getWorktrees before the first event seeds the cache", async () => {
    const { host, getProvider } = makeRegisterHost();
    (host.getWorktrees as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeWorktree("/some/path", 42),
    ]);
    await registerReviewDecorationProvider(host, makeForgeProvider({ withBuildPRFileUrl: true }));
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 1 });

    const result = await getProvider().provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(host.getWorktrees).toHaveBeenCalledTimes(1);
    expect(result["src/a.ts"]!.badge).toBe("1");
  });
});
