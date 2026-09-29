import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import { sliceUtf8Window } from "../../../shared/utils/boundedOutput.js";
import { FileDiffCache } from "../fileDiffCache.js";

vi.mock("../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn(() => Promise.resolve({ unsubscribe: vi.fn() })),
}));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
}

function content(tag: string, count = 400): string {
  return Array.from({ length: count }, (_, i) => `${tag} ${i} é ✓ ${"x".repeat(40)}`).join("\n");
}

type DiffResult = Extract<WorkspaceHostEvent, { type: "get-file-diff-result" }>;

// Counts the `git diff` processes the service spawns, which is the cost the
// cache exists to avoid. simple-git's ESM build binds `spawn` by name.
let diffSpawns = 0;
const originalSpawn = childProcess.spawn;

describe("getFileDiff paging over a real repo", () => {
  let tmp: string;
  let repo: string;
  let service: WorkspaceService;
  let last: DiffResult | null;

  beforeAll(async () => {
    (childProcess as { spawn: typeof originalSpawn }).spawn = ((...args: unknown[]) => {
      if (Array.isArray(args[1]) && args[1].includes("diff")) diffSpawns++;
      return (originalSpawn as (...a: unknown[]) => ReturnType<typeof originalSpawn>)(...args);
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    const { WorkspaceService } = await import("../WorkspaceService.js");
    service = new WorkspaceService((event) => {
      if (event.type === "get-file-diff-result") last = event;
    });
  });

  afterAll(() => {
    (childProcess as { spawn: typeof originalSpawn }).spawn = originalSpawn;
    syncBuiltinESMExports();
    service.dispose();
  });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "file-diff-cache-")));
    repo = path.join(tmp, "repo");
    git(tmp, "init", "-q", "-b", "main", repo);
    writeFileSync(path.join(repo, "a.txt"), content("old"));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    writeFileSync(path.join(repo, "a.txt"), content("new"));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  interface PageOptions {
    status?: string;
    maxBytes?: number;
    ignoreWhitespace?: boolean;
    cwd?: string;
  }

  async function page(file: string, offset: number, options: PageOptions = {}) {
    last = null;
    await service.getFileDiff(
      "req",
      options.cwd ?? repo,
      file,
      options.status ?? "modified",
      options.ignoreWhitespace ?? false,
      offset,
      options.maxBytes ?? 997
    );
    if (!last) throw new Error("no result");
    return last as DiffResult;
  }

  function expectedDiff(file: string, cwd = repo, ignoreWhitespace = false): string {
    return git(
      cwd,
      "diff",
      "HEAD",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--submodule=short",
      ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
      "--",
      file
    );
  }

  /** Reads from `offset` to the end, checking each window against `full`. */
  async function expectRestMatches(
    file: string,
    offset: number | null,
    full: string,
    options: PageOptions = {}
  ) {
    const maxBytes = options.maxBytes ?? 997;
    while (offset !== null) {
      const result = await page(file, offset, options);
      const expected = sliceUtf8Window(full, offset, maxBytes);
      expect(result).toMatchObject({
        diff: expected.content,
        offset: expected.offset,
        totalBytes: expected.totalBytes,
        truncated: expected.truncated,
        nextOffset: expected.nextOffset,
      });
      offset = result.nextOffset;
    }
  }

  /**
   * Fills the cache with a continuation read, applies `mutate`, and requires
   * the next continuation to run git again — then returns that window.
   */
  async function continuationAfter(file: string, mutate: () => void, options: PageOptions = {}) {
    const first = await page(file, 0, options);
    const second = await page(file, first.nextOffset!, options);
    const third = await page(file, second.nextOffset!, options);
    expect(third.truncated).toBe(true);
    const before = diffSpawns;
    // Proves the cache is live, so the recompute below is the mutation's doing.
    await page(file, third.nextOffset!, options);
    expect(diffSpawns).toBe(before);
    mutate();
    const result = await page(file, third.nextOffset!, options);
    expect(diffSpawns).toBe(before + 1);
    return { result, offset: third.nextOffset! };
  }

  it("serves every window byte-identical to slicing the uncached diff", async () => {
    await expectRestMatches("a.txt", 0, expectedDiff("a.txt"));
  });

  it("runs git diff twice however many windows a read takes", async () => {
    const before = diffSpawns;
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      offset = (await page("a.txt", offset)).nextOffset;
      pages++;
    }
    expect(pages).toBeGreaterThan(10);
    // First window, then the cache fill.
    expect(diffSpawns - before).toBe(2);
  });

  it("never caches from a first-window read", async () => {
    const set = vi.spyOn(FileDiffCache.prototype, "set");
    try {
      const result = await page("a.txt", 0);
      expect(result.truncated).toBe(true);
      expect(set).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
    }
  });

  it("recomputes after the worktree file changes", async () => {
    const { offset } = await continuationAfter("a.txt", () =>
      writeFileSync(path.join(repo, "a.txt"), content("newer"))
    );
    const full = expectedDiff("a.txt");
    expect(full).toContain("+newer 399");
    await expectRestMatches("a.txt", offset, full);
  });

  it("recomputes after an index-only change", async () => {
    const { offset } = await continuationAfter("a.txt", () => git(repo, "add", "a.txt"));
    await expectRestMatches("a.txt", offset, expectedDiff("a.txt"));
  });

  it("recomputes after HEAD moves", async () => {
    const { result } = await continuationAfter("a.txt", () =>
      git(repo, "commit", "-q", "-am", "take it")
    );
    expect(result).toMatchObject({ diff: "NO_CHANGES", totalBytes: 0 });
  });

  it("recomputes after a repository config change", async () => {
    const { offset } = await continuationAfter("a.txt", () =>
      git(repo, "config", "diff.noprefix", "true")
    );
    await expectRestMatches("a.txt", offset, expectedDiff("a.txt"));
  });

  it("recomputes after a .gitattributes change alters how git renders the diff", async () => {
    const { result } = await continuationAfter("a.txt", () =>
      writeFileSync(path.join(repo, ".gitattributes"), "a.txt -diff\n")
    );
    expect(result).toMatchObject({ diff: "BINARY_FILE", totalBytes: 0 });
  });

  it("sees .gitattributes above a cwd that is below the repository root", async () => {
    const sub = path.join(repo, "sub");
    mkdirSync(sub);
    writeFileSync(path.join(sub, "b.txt"), content("old"));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "sub");
    writeFileSync(path.join(sub, "b.txt"), content("new"));
    const { result } = await continuationAfter(
      "b.txt",
      () => writeFileSync(path.join(repo, ".gitattributes"), "*.txt -diff\n"),
      { cwd: sub }
    );
    expect(result).toMatchObject({ diff: "BINARY_FILE", totalBytes: 0 });
  });

  it("recomputes after a dangling symlink is retargeted", async () => {
    const target = (tag: string) => `missing-${tag}-${"t".repeat(200)}`;
    symlinkSync(target("one"), path.join(repo, "link"));
    git(repo, "add", "link");
    git(repo, "commit", "-q", "-m", "link");
    rmSync(path.join(repo, "link"));
    symlinkSync(target("two"), path.join(repo, "link"));
    const { offset } = await continuationAfter(
      "link",
      () => {
        rmSync(path.join(repo, "link"));
        symlinkSync(target("three"), path.join(repo, "link"));
      },
      { maxBytes: 40 }
    );
    await expectRestMatches("link", offset, expectedDiff("link"), { maxBytes: 40 });
  });

  it("keeps whitespace-insensitive diffs apart from exact ones", async () => {
    writeFileSync(path.join(repo, "a.txt"), content("old").replaceAll(" ", "  ") + "\nextra");
    const first = await page("a.txt", 0, { maxBytes: 40 });
    await page("a.txt", first.nextOffset!, { maxBytes: 40 });
    const ignoring = { maxBytes: 40, ignoreWhitespace: true };
    const full = expectedDiff("a.txt", repo, true);
    expect(full.length).toBeLessThan(expectedDiff("a.txt").length);
    await expectRestMatches("a.txt", first.nextOffset!, full, ignoring);
  });

  it("recomputes an untracked file's diff after it is rewritten", async () => {
    writeFileSync(path.join(repo, "u.txt"), content("draft"));
    const untracked = { status: "untracked" };
    const first = await page("u.txt", 0, untracked);
    const second = await page("u.txt", first.nextOffset!, untracked);
    const get = vi.spyOn(FileDiffCache.prototype, "get");
    try {
      await page("u.txt", second.nextOffset!, untracked);
      expect(get.mock.results.at(-1)?.value).not.toBeNull();
    } finally {
      get.mockRestore();
    }
    writeFileSync(path.join(repo, "u.txt"), content("final"));
    const third = await page("u.txt", second.nextOffset!, untracked);
    expect(third.diff).toContain("final");
    expect(third.diff).not.toContain("draft");
  });
});

describe("FileDiffCache bounds", () => {
  afterEach(() => vi.useRealTimers());

  it("evicts least-recently-used entries past the entry cap", () => {
    const cache = new FileDiffCache();
    const bytes = new Uint8Array(8);
    for (const key of ["a", "b", "c", "d"]) cache.set(key, "f", bytes);
    expect(cache.get("a", "f")).not.toBeNull();
    cache.set("e", "f", bytes);
    expect(cache.get("b", "f")).toBeNull();
    for (const key of ["a", "c", "d", "e"]) expect(cache.get(key, "f")).not.toBeNull();
    cache.dispose();
  });

  it("evicts to stay under the byte cap and never holds an oversized entry", () => {
    const cache = new FileDiffCache();
    const big = new Uint8Array(40 * 1024 * 1024);
    cache.set("a", "f", big);
    cache.set("b", "f", big);
    expect(cache.get("a", "f")).toBeNull();
    expect(cache.get("b", "f")).toBe(big);
    cache.set("huge", "f", new Uint8Array(65 * 1024 * 1024));
    expect(cache.get("huge", "f")).toBeNull();
    cache.dispose();
  });

  it("holds nothing once disposed", () => {
    const cache = new FileDiffCache();
    cache.dispose();
    cache.set("a", "f", new Uint8Array(8));
    expect(cache.get("a", "f")).toBeNull();
  });

  it("misses on a changed freshness key and drops idle entries", () => {
    vi.useFakeTimers();
    const cache = new FileDiffCache();
    cache.set("a", "f1", new Uint8Array(8));
    expect(cache.get("a", "f2")).toBeNull();
    expect(cache.get("a", "f1")).toBeNull();
    cache.set("a", "f1", new Uint8Array(8));
    vi.advanceTimersByTime(120_000);
    expect(cache.get("a", "f1")).toBeNull();
    cache.dispose();
  });
});
