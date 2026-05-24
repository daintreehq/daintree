import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDecorationProviderImpl } from "../../../../../shared/types/forge.js";
import type { PluginHostApi, PluginWorktreeSnapshot } from "../../../../../shared/types/plugin.js";

const mockGetPRReviewThreads = vi.fn();

vi.mock("../GitHubPRs.js", () => ({
  getPRReviewThreads: (...args: unknown[]) => mockGetPRReviewThreads(...args),
}));

import { createReviewDecorationProvider } from "../reviewDecorationProvider.js";

function makeHost(worktrees: PluginWorktreeSnapshot[] = []): PluginHostApi {
  return {
    getWorktrees: vi.fn().mockResolvedValue(worktrees),
    registerFileDecorationProvider: vi.fn(),
    onDidChangeWorktrees: vi.fn(),
    invalidateFileDecorations: vi.fn(),
  } as unknown as PluginHostApi;
}

function makeWorktree(path: string, prNumber: number): PluginWorktreeSnapshot {
  return {
    path,
    linked: { pr: { ref: { number: prNumber } } },
  } as unknown as PluginWorktreeSnapshot;
}

describe("createReviewDecorationProvider", () => {
  let provider: FileDecorationProviderImpl;

  beforeEach(() => {
    mockGetPRReviewThreads.mockReset();
    provider = createReviewDecorationProvider(makeHost([]));
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
    provider = createReviewDecorationProvider(host);
    const result = await provider.provideDecorations("worktree-diff:/missing", ["src/a.ts"]);
    expect(result).toEqual({});
  });

  it("returns empty object when worktree has no PR link", async () => {
    const host = makeHost([{ path: "/some/path" } as PluginWorktreeSnapshot]);
    provider = createReviewDecorationProvider(host);
    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);
    expect(result).toEqual({});
  });

  it("produces decorations for files with unresolved threads", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host);
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
    });
    expect(result["src/b.ts"]).toEqual({
      badge: "1",
      tooltip: "1 unresolved review comment",
      color: "text-status-warning",
    });
    expect(result["src/c.ts"]).toBeUndefined();
  });

  it("filters to only the requested paths", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 5, "src/b.ts": 2 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(Object.keys(result)).toEqual(["src/a.ts"]);
    expect(result["src/a.ts"]!.badge).toBe("5");
  });

  it("appends (partial count) to tooltip when __clampedAt sentinel is present", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host);
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
    provider = createReviewDecorationProvider(host);
    mockGetPRReviewThreads.mockResolvedValueOnce({ "src/a.ts": 2 });

    const result = await provider.provideDecorations("worktree-diff:/some/path", ["src/a.ts"]);

    expect(result["src/a.ts"]!.tooltip).toBe("2 unresolved review comments");
  });

  it("skips files with count 0", async () => {
    const host = makeHost([makeWorktree("/some/path", 42)]);
    provider = createReviewDecorationProvider(host);
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
    provider = createReviewDecorationProvider(host);
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
});
