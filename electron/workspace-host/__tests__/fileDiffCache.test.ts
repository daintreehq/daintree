import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
// cache exists to avoid, and the `rev-parse` + `var` pair behind each
// freshness probe. simple-git's ESM build binds `spawn` by name.
let diffSpawns = 0;
let probeSpawns = 0;
const originalSpawn = childProcess.spawn;

/**
 * Runs once when the next git process whose argv includes `command` exits,
 * before the service sees its output: a change landing between two of the
 * service's own steps.
 */
let afterNext: { command: string; run: () => void } | null = null;

// Git 2.42+ names the config files it reads in `git var -l`, which is what
// lets a continuation reuse its probe instead of spawning one per window.
const gitListsConfigFiles = /^GIT_CONFIG_GLOBAL=/m.test(git(os.tmpdir(), "var", "-l"));

describe("getFileDiff paging over a real repo", () => {
  let tmp: string;
  let repo: string;
  let service: WorkspaceService;
  let last: DiffResult | null;

  let home: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // The service's git reads the user's global config, which the hardened env
    // can't redirect: point it at a home of the test's own, with no system file.
    home = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "file-diff-home-")));
    for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    (childProcess as { spawn: typeof originalSpawn }).spawn = ((...args: unknown[]) => {
      const argv = Array.isArray(args[1]) ? (args[1] as string[]) : [];
      if (argv.includes("diff")) diffSpawns++;
      if (argv.includes("rev-parse") || argv.includes("var")) probeSpawns++;
      const child = (originalSpawn as (...a: unknown[]) => ReturnType<typeof originalSpawn>)(
        ...args
      );
      const hook = afterNext;
      if (hook && argv.includes(hook.command)) {
        afterNext = null;
        child.once("exit", hook.run);
      }
      return child;
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
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    afterNext = null;
    rmSync(path.join(home, ".gitconfig"), { force: true });
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

  function expectedDiff(
    file: string,
    cwd = repo,
    ignoreWhitespace = false,
    env: NodeJS.ProcessEnv = GIT_ENV
  ): string {
    return execFileSync(
      "git",
      [
        "diff",
        "HEAD",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--submodule=short",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        "--",
        file,
      ],
      { cwd, env, encoding: "utf-8" }
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
    // Both on the first window: the unpinned diff that turned out not to fit,
    // then the one pinned to the freshness key that fills the cache.
    expect(diffSpawns - before).toBe(2);
  });

  it("fills the cache from a first window that does not fit", async () => {
    const set = vi.spyOn(FileDiffCache.prototype, "set");
    try {
      const result = await page("a.txt", 0);
      expect(result.truncated).toBe(true);
      expect(set).toHaveBeenCalledTimes(1);
      const before = diffSpawns;
      await page("a.txt", result.nextOffset!);
      expect(diffSpawns).toBe(before);
    } finally {
      set.mockRestore();
    }
  });

  it("keeps a first read that fits one window free of freshness probes", async () => {
    const set = vi.spyOn(FileDiffCache.prototype, "set");
    const diffsBefore = diffSpawns;
    const probesBefore = probeSpawns;
    try {
      const result = await page("a.txt", 0, { maxBytes: 1_000_000 });
      expect(result.truncated).toBe(false);
      expect(diffSpawns - diffsBefore).toBe(1);
      expect(probeSpawns).toBe(probesBefore);
      expect(set).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
    }
  });

  it.skipIf(!gitListsConfigFiles)("probes freshness once for a whole paged read", async () => {
    const before = probeSpawns;
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      offset = (await page("a.txt", offset)).nextOffset;
      pages++;
    }
    expect(pages).toBeGreaterThan(10);
    // From the first window's cache fill: `rev-parse` and `var -l`, then
    // `var -l` again to confirm the config stood still while it was statted.
    expect(probeSpawns - before).toBe(3);
  });

  it.skipIf(!gitListsConfigFiles)(
    "never reuses a probe whose config moved between its two reads",
    async () => {
      const extra = path.join(tmp, "extra.gitconfig");
      afterNext = { command: "var", run: () => git(repo, "config", "include.path", extra) };
      const set = vi.spyOn(FileDiffCache.prototype, "set");
      let first: DiffResult;
      try {
        first = await page("a.txt", 0);
        // The two reads disagreed, so no key came out of that probe to cache under.
        expect(set).not.toHaveBeenCalled();
      } finally {
        set.mockRestore();
      }
      expect(git(repo, "config", "include.path").trim()).toBe(extra);

      // The include arrived after `var -l` answered: no window may lean on that
      // answer, so each probes again, and an edit to the included file shows.
      const before = probeSpawns;
      const second = await page("a.txt", first.nextOffset!);
      expect(probeSpawns - before).toBe(2);
      writeFileSync(extra, "[diff]\n\tnoprefix = true\n");
      await expectRestMatches("a.txt", second.nextOffset!, expectedDiff("a.txt"));
    }
  );

  it("sends what the cache-filling pass found when the file changes between passes", async () => {
    afterNext = {
      command: "diff",
      run: () => writeFileSync(path.join(repo, "a.txt"), content("old")),
    };
    const set = vi.spyOn(FileDiffCache.prototype, "set");
    try {
      const result = await page("a.txt", 0);
      expect(result).toMatchObject({ diff: "NO_CHANGES", totalBytes: 0 });
      expect(set).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
    }
  });

  it("probes every window again once an include could pull in any file", async () => {
    git(repo, "config", "include.path", path.join(tmp, "extra.gitconfig"));
    const before = probeSpawns;
    const first = await page("a.txt", 0);
    const second = await page("a.txt", first.nextOffset!);
    await page("a.txt", second.nextOffset!);
    expect(probeSpawns - before).toBe(6);
    await expectRestMatches("a.txt", 0, expectedDiff("a.txt"));
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

  it.skipIf(!gitListsConfigFiles)(
    "recomputes after a config file is rewritten and put back",
    async () => {
      // Same effective config, so the same hash: only the file's stats can tell
      // that a diff computed in between may have read something else.
      const { offset } = await continuationAfter("a.txt", () => {
        git(repo, "config", "diff.noprefix", "true");
        git(repo, "config", "--unset", "diff.noprefix");
      });
      await expectRestMatches("a.txt", offset, expectedDiff("a.txt"));
    }
  );

  it.skipIf(!gitListsConfigFiles || process.platform === "win32")(
    "reuses its probe through a symlinked cwd whose gitfile is relative",
    async () => {
      renameSync(path.join(repo, ".git"), path.join(tmp, "meta.git"));
      writeFileSync(path.join(repo, ".git"), "gitdir: ../meta.git\n");
      const alias = path.join(tmp, "alias");
      symlinkSync(repo, alias);
      const before = probeSpawns;
      await expectRestMatches("a.txt", 0, expectedDiff("a.txt"), { cwd: alias });
      expect(probeSpawns - before).toBe(3);
    }
  );

  it("recomputes after a global config change", async () => {
    const globalConfig = path.join(home, ".gitconfig");
    const { offset } = await continuationAfter("a.txt", () =>
      writeFileSync(globalConfig, "[diff]\n\tnoprefix = true\n")
    );
    const full = expectedDiff("a.txt", repo, false, {
      ...GIT_ENV,
      GIT_CONFIG_GLOBAL: globalConfig,
    });
    expect(full).not.toBe(expectedDiff("a.txt"));
    await expectRestMatches("a.txt", offset, full);
  });

  it.skipIf(process.platform === "win32")(
    "recomputes when the git dir a gitfile names is a symlink that is retargeted",
    async () => {
      const one = path.join(tmp, "one");
      const two = path.join(tmp, "two");
      git(repo, "worktree", "add", "-q", "-b", "one", one);
      writeFileSync(path.join(repo, "a.txt"), content("moved"));
      git(repo, "commit", "-q", "-am", "moved");
      git(repo, "worktree", "add", "-q", "-b", "two", two);
      const admin = (dir: string) => readFileSync(path.join(dir, ".git"), "utf-8").slice(8).trim();
      const link = path.join(tmp, "current");
      symlinkSync(admin(one), link);
      writeFileSync(path.join(one, ".git"), `gitdir: ${link}\n`);
      writeFileSync(path.join(one, "a.txt"), content("new"));
      const adminTwo = admin(two);

      await continuationAfter(
        "a.txt",
        () => {
          rmSync(link);
          symlinkSync(adminTwo, link);
        },
        { cwd: one }
      );
    }
  );

  it("recomputes after HEAD moves in a linked worktree", async () => {
    const linked = path.join(tmp, "linked");
    git(repo, "worktree", "add", "-q", "-b", "side", linked);
    writeFileSync(path.join(linked, "a.txt"), content("new"));
    const { result } = await continuationAfter(
      "a.txt",
      () => git(linked, "commit", "-q", "-am", "take it"),
      { cwd: linked }
    );
    expect(result).toMatchObject({ diff: "NO_CHANGES", totalBytes: 0 });
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

  it.skipIf(process.platform === "win32")(
    "diffs an untracked symlink as its target and recomputes when it is retargeted",
    async () => {
      symlinkSync("a.txt", path.join(repo, "link"));
      const untracked = { status: "untracked", maxBytes: 20 };
      const first = await page("link", 0, untracked);
      const second = await page("link", first.nextOffset!, untracked);
      const get = vi.spyOn(FileDiffCache.prototype, "get");
      try {
        await page("link", second.nextOffset!, untracked);
        expect(get).toHaveBeenCalled();
        expect(get.mock.results.at(-1)?.value).toBeInstanceOf(Uint8Array);
      } finally {
        get.mockRestore();
      }
      // The same file through another spelling: following the link would see
      // nothing change.
      rmSync(path.join(repo, "link"));
      symlinkSync("./a.txt", path.join(repo, "link"));
      let rest = "";
      for (let next: number | null = second.nextOffset!; next !== null;) {
        const window = await page("link", next, untracked);
        rest += window.diff;
        next = window.nextOffset;
      }
      const whole = (await page("link", 0, { status: "untracked", maxBytes: 4096 })).diff;
      expect(whole).toContain("new file mode 120000");
      expect(whole).toContain("\n+./a.txt\n\\ No newline at end of file");
      expect(rest).toBe(whole.slice(second.nextOffset!));
    }
  );

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
    // Both versions have the same size. Make the metadata change explicit on
    // filesystems that coalesce rapid writes into one timestamp tick.
    const changedAt = new Date(Date.now() + 2_000);
    utimesSync(path.join(repo, "u.txt"), changedAt, changedAt);
    const third = await page("u.txt", second.nextOffset!, untracked);
    expect(third.diff).toContain("final");
    expect(third.diff).not.toContain("draft");
  });
});

describe("getFileDiff index sides over a real repo", () => {
  let tmp: string;
  let repo: string;
  let service: WorkspaceService;
  let last: DiffResult | null;

  beforeAll(async () => {
    const { WorkspaceService } = await import("../WorkspaceService.js");
    service = new WorkspaceService((event) => {
      if (event.type === "get-file-diff-result") last = event;
    });
  });

  afterAll(() => service.dispose());

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "file-diff-side-")));
    repo = path.join(tmp, "repo");
    git(tmp, "init", "-q", "-b", "main", repo);
    writeFileSync(path.join(repo, "a.txt"), "base\n");
    writeFileSync(path.join(repo, "gone.txt"), "going\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function diffOf(file: string, status: string, side?: "staged" | "unstaged") {
    last = null;
    await service.getFileDiff("req", repo, file, status, false, 0, undefined, side);
    if (!last) throw new Error("no result");
    return (last as DiffResult).diff;
  }

  it("splits a partially staged file into HEAD→index and index→working tree", async () => {
    writeFileSync(path.join(repo, "a.txt"), "staged\n");
    git(repo, "add", "a.txt");
    writeFileSync(path.join(repo, "a.txt"), "working\n");

    const staged = await diffOf("a.txt", "modified", "staged");
    expect(staged).toContain("-base");
    expect(staged).toContain("+staged");
    expect(staged).not.toContain("working");

    const unstaged = await diffOf("a.txt", "modified", "unstaged");
    expect(unstaged).toContain("-staged");
    expect(unstaged).toContain("+working");
    expect(unstaged).not.toContain("base");

    const combined = await diffOf("a.txt", "modified");
    expect(combined).toContain("-base");
    expect(combined).toContain("+working");
  });

  it("keeps the two sides apart across repeated reads", async () => {
    writeFileSync(path.join(repo, "a.txt"), "staged\n");
    git(repo, "add", "a.txt");
    writeFileSync(path.join(repo, "a.txt"), "working\n");

    for (let i = 0; i < 2; i++) {
      expect(await diffOf("a.txt", "modified", "staged")).toContain("+staged");
      expect(await diffOf("a.txt", "modified", "unstaged")).toContain("+working");
    }
  });

  it("shows a staged new file as added at its staged content, not the edited copy", async () => {
    writeFileSync(path.join(repo, "new.txt"), "first\n");
    git(repo, "add", "new.txt");
    writeFileSync(path.join(repo, "new.txt"), "second\n");

    const staged = await diffOf("new.txt", "added", "staged");
    expect(staged).toContain("new file mode");
    expect(staged).toContain("+first");
    expect(staged).not.toContain("second");

    const unstaged = await diffOf("new.txt", "modified", "unstaged");
    expect(unstaged).toContain("-first");
    expect(unstaged).toContain("+second");
  });

  it("shows a staged deletion on the staged side and nothing on the unstaged side", async () => {
    git(repo, "rm", "-q", "gone.txt");

    expect(await diffOf("gone.txt", "deleted", "staged")).toContain("deleted file mode");
    expect(await diffOf("gone.txt", "deleted", "unstaged")).toBe("NO_CHANGES");
  });

  it("shows an unstaged deletion of a tracked file on the unstaged side only", async () => {
    rmSync(path.join(repo, "gone.txt"));

    expect(await diffOf("gone.txt", "deleted", "unstaged")).toContain("deleted file mode");
    expect(await diffOf("gone.txt", "deleted", "staged")).toBe("NO_CHANGES");
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
