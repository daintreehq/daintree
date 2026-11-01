import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RemoteReadCache, repositoryConfigFingerprint } from "../remoteReadCache.js";
import { git, makeRepo, tempRoot } from "./gitFixtures.js";

type Remote = { name: string; url: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A cache over a scripted lister, config fingerprint and clock. */
function harness(maxAgeMs = 1000) {
  const state = { clock: 0, fingerprint: "f1" as string | null };
  const calls: string[] = [];
  let answer: (repoPath: string) => Promise<Remote[]> = async (repoPath) => [
    { name: "origin", url: `git@example.test:${path.basename(repoPath)}.git` },
  ];
  const cache = new RemoteReadCache(
    (repoPath) => {
      calls.push(repoPath);
      return answer(repoPath);
    },
    { now: () => state.clock, fingerprint: async () => state.fingerprint, maxAgeMs }
  );
  return {
    cache,
    state,
    calls,
    answerWith(next: (repoPath: string) => Promise<Remote[]>) {
      answer = next;
    },
  };
}

describe("RemoteReadCache", () => {
  it("reads once while the config is unchanged, handing each caller its own copy", async () => {
    const { cache, calls } = harness();
    const first = await cache.read("/p/a");
    first[0]!.url = "mutated";
    first.push({ name: "extra", url: "x" });
    const second = await cache.read("/p/a");
    expect(second).toEqual([{ name: "origin", url: "git@example.test:a.git" }]);
    second[0]!.url = "mutated";
    second.push({ name: "extra", url: "x" });
    expect(await cache.read("/p/a")).toEqual([{ name: "origin", url: "git@example.test:a.git" }]);
    expect(calls).toEqual(["/p/a"]);
  });

  it("reads again when the config changes", async () => {
    const { cache, state, calls } = harness();
    await cache.read("/p/a");
    state.fingerprint = "f2";
    await cache.read("/p/a");
    await cache.read("/p/a");
    expect(calls).toEqual(["/p/a", "/p/a"]);
  });

  it("reads again once the reading is the max age old, however often it was reused", async () => {
    const { cache, state, calls } = harness(1000);
    await cache.read("/p/a");
    for (const at of [300, 600, 999]) {
      state.clock = at;
      await cache.read("/p/a");
    }
    expect(calls).toHaveLength(1);
    state.clock = 1000;
    await cache.read("/p/a");
    expect(calls).toHaveLength(2);
  });

  it("measures a reading's age from when its read started, not when it finished", async () => {
    const { cache, state, calls, answerWith } = harness(1000);
    const slow = deferred<Remote[]>();
    answerWith(() => slow.promise);
    const reading = cache.read("/p/a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.clock = 900;
    slow.resolve([{ name: "origin", url: "u" }]);
    await reading;
    answerWith(async () => [{ name: "origin", url: "u" }]);
    state.clock = 999;
    await cache.read("/p/a");
    expect(calls).toHaveLength(1);
    state.clock = 1000;
    await cache.read("/p/a");
    expect(calls).toHaveLength(2);
  });

  it("reads again after a config write that landed while git was reading", async () => {
    const { cache, state, answerWith } = harness();
    const slow = deferred<Remote[]>();
    answerWith(() => slow.promise);
    const reading = cache.read("/p/a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.fingerprint = "f2";
    slow.resolve([{ name: "origin", url: "old" }]);
    expect(await reading).toEqual([{ name: "origin", url: "old" }]);
    answerWith(async () => [{ name: "origin", url: "new" }]);
    expect(await cache.read("/p/a")).toEqual([{ name: "origin", url: "new" }]);
  });

  it("drops expired readings, so only recently read repositories are held", async () => {
    const { cache, state } = harness(1000);
    await cache.read("/p/a");
    await cache.read("/p/b");
    state.clock = 500;
    await cache.read("/p/fresh");
    state.clock = 1000;
    await cache.read("/p/new");
    const held = (cache as unknown as { entries: Map<string, unknown> }).entries;
    expect([...held.keys()].sort()).toEqual([path.resolve("/p/fresh"), path.resolve("/p/new")]);
  });

  it("shares one read between lookups that overlap it", async () => {
    const { cache, calls, answerWith } = harness();
    const pending = deferred<Remote[]>();
    answerWith(() => pending.promise);
    const lookups = [cache.read("/p/a"), cache.read("/p/a"), cache.read("/p/b")];
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.resolve([{ name: "origin", url: "u" }]);
    const answers = await Promise.all(lookups);
    expect(calls).toEqual(["/p/a", "/p/b"]);
    expect(answers.every((a) => a.length === 1)).toBe(true);
  });

  it("never keeps a failed read, and a newer read survives an older one failing", async () => {
    const { cache, state, calls, answerWith } = harness();
    const older = deferred<Remote[]>();
    answerWith(() => older.promise);
    const failing = cache.read("/p/a");
    await new Promise((resolve) => setTimeout(resolve, 0));

    state.fingerprint = "f2";
    answerWith(async () => [{ name: "origin", url: "new" }]);
    expect(await cache.read("/p/a")).toEqual([{ name: "origin", url: "new" }]);
    older.reject(new Error("git failed"));
    await expect(failing).rejects.toThrow("git failed");
    expect(await cache.read("/p/a")).toEqual([{ name: "origin", url: "new" }]);
    expect(calls).toHaveLength(2);

    answerWith(async () => {
      throw new Error("again");
    });
    state.fingerprint = "f3";
    await expect(cache.read("/p/a")).rejects.toThrow("again");
    answerWith(async () => []);
    expect(await cache.read("/p/a")).toEqual([]);
    expect(await cache.read("/p/a")).toEqual([]);
    expect(calls).toHaveLength(4);
  });

  it("reads every time when the repository's config can't be found", async () => {
    const { cache, state, calls } = harness();
    await cache.read("/p/a");
    state.fingerprint = null;
    await cache.read("/p/a");
    await cache.read("/p/a");
    state.fingerprint = "f1";
    await cache.read("/p/a");
    expect(calls).toHaveLength(4);
  });
});

describe("repositoryConfigFingerprint", () => {
  let root: string;

  beforeAll(() => {
    root = tempRoot("pah-fingerprint-");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("changes with a remote change, seen from the repository and its linked worktree", async () => {
    const repo = makeRepo(root, "repo", "git@example.test:a/b.git");
    const linked = path.join(root, "linked");
    git(repo, ["worktree", "add", "-q", linked, "-b", "wt"]);
    const before = await repositoryConfigFingerprint(repo);
    expect(before).not.toBeNull();
    expect(await repositoryConfigFingerprint(repo)).toBe(before);
    expect(await repositoryConfigFingerprint(linked)).toBe(before);

    git(linked, ["remote", "set-url", "origin", "git@example.test:a/c.git"]);
    const after = await repositoryConfigFingerprint(repo);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(await repositoryConfigFingerprint(linked)).toBe(after);
  });

  it("follows a folder replaced by another repository", async () => {
    const main = makeRepo(root, "replaced-main", "git@example.test:a/b.git");
    const folder = path.join(root, "replaced");
    git(main, ["worktree", "add", "-q", folder, "-b", "replaced"]);
    expect(await repositoryConfigFingerprint(folder)).toBe(await repositoryConfigFingerprint(main));

    fs.rmSync(folder, { recursive: true, force: true });
    makeRepo(root, "replaced", "git@example.test:c/d.git");
    const before = await repositoryConfigFingerprint(folder);
    git(folder, ["remote", "set-url", "origin", "git@example.test:c/e.git"]);
    const after = await repositoryConfigFingerprint(folder);
    expect(after).not.toBe(before);
    expect(await repositoryConfigFingerprint(main)).not.toBe(after);
  });

  it("tells a rewrite apart when only the file's inode changed", async () => {
    const repo = makeRepo(root, "coarse", "git@example.test:a/b.git");
    const realStat = fs.promises.stat.bind(fs.promises);
    let inode = 1;
    const stat = vi.spyOn(fs.promises, "stat").mockImplementation((async (
      target: fs.PathLike,
      options?: fs.StatOptions
    ) => {
      if (String(target).endsWith(`${path.sep}config`)) {
        return { ino: inode, mtimeMs: 1, ctimeMs: 1, size: 64 } as fs.Stats;
      }
      return realStat(target, options);
    }) as typeof fs.promises.stat);
    try {
      const first = await repositoryConfigFingerprint(repo);
      expect(await repositoryConfigFingerprint(repo)).toBe(first);
      inode = 2;
      expect(await repositoryConfigFingerprint(repo)).not.toBe(first);
    } finally {
      stat.mockRestore();
    }
  });

  it("is null outside a repository", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(await repositoryConfigFingerprint(plain)).toBeNull();
  });
});
