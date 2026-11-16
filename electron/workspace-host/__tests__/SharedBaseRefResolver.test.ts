import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ENTRIES,
  RESOLUTION_MAX_AGE_MS,
  SharedBaseRefResolver,
  type SharedBaseRequest,
} from "../SharedBaseRefResolver.js";

interface Repo {
  remotes: string[];
  /** Calls made through every git this repo handed out, in order. */
  calls: string[][];
  /** While set, every git call waits on it. */
  gate: Promise<void> | null;
}

function makeRepo(remotes: string[] = ["origin"]): Repo {
  return { remotes, calls: [], gate: null };
}

function gitFor(repo: Repo, signal: AbortSignal) {
  return {
    async raw(args: string[]): Promise<string> {
      repo.calls.push(args);
      if (repo.gate) await repo.gate;
      if (signal.aborted) throw new Error("Abort signal received");
      if (args[0] === "remote") return `${repo.remotes.join("\n")}\n`;
      if (args[0] === "rev-parse") throw new Error("no upstream configured");
      if (args[0] === "for-each-ref") {
        const patterns = args.slice(args.indexOf("--") + 1);
        return `${patterns.join("\n")}\n`;
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    },
  };
}

function probes(repo: Repo): number {
  return repo.calls.filter((args) => args[0] === "remote").length;
}

/** Lets every pending stat and cached read settle, so callers reach their wait. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SharedBaseRefResolver", () => {
  let commonDir: string;
  let mtimes: Map<string, number>;

  const statMtime = async (path: string): Promise<number> =>
    mtimes.get(path) ?? (path.endsWith("config.worktree") ? -1 : 1_000);

  function request(
    repo: Repo,
    worktree: string,
    overrides: Partial<SharedBaseRequest> = {}
  ): SharedBaseRequest {
    return {
      gitDir: join(commonDir, "worktrees", worktree),
      commonDir,
      branch: `feature/${worktree}`,
      baseBranch: "main",
      wslInvocation: undefined,
      signal: new AbortController().signal,
      statMtime,
      createGit: async (signal) => gitFor(repo, signal),
      ...overrides,
    };
  }

  beforeEach(() => {
    commonDir = mkdtempSync(join(tmpdir(), "shared-base-ref-"));
    writeFileSync(join(commonDir, "config"), '[remote "origin"]\n\turl = git@example.com:o/r\n');
    mtimes = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(commonDir, { recursive: true, force: true });
  });

  it("probes once for linked worktrees that share the repository's config", async () => {
    const repo = makeRepo(["origin", "upstream"]);
    const resolver = new SharedBaseRefResolver();

    const results = await Promise.all(
      ["a", "b", "c"].map((wt) => resolver.resolve(request(repo, wt)))
    );

    expect(probes(repo)).toBe(1);
    expect(results[0]).toMatchObject({ compareRef: "upstream/main", remote: "upstream" });
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it("serves later siblings from the cache until the stamp moves, then probes once more", async () => {
    const repo = makeRepo();
    const resolver = new SharedBaseRefResolver();
    for (const wt of ["a", "b", "c"]) await resolver.resolve(request(repo, wt));
    expect(probes(repo)).toBe(1);

    // A fetch writes the base's loose remote ref.
    mtimes.set(join(commonDir, "refs", "remotes", "origin", "main"), 2_000);
    for (const wt of ["a", "b", "c"]) await resolver.resolve(request(repo, wt));
    expect(probes(repo)).toBe(2);
  });

  it("resolves privately for a worktree with its own config.worktree", async () => {
    const shared = makeRepo(["origin"]);
    const overridden = makeRepo(["origin", "upstream"]);
    mtimes.set(join(commonDir, "worktrees", "b", "config.worktree"), 500);
    const resolver = new SharedBaseRefResolver();

    const [a, b, c] = await Promise.all([
      resolver.resolve(request(shared, "a")),
      resolver.resolve(request(overridden, "b")),
      resolver.resolve(request(shared, "c")),
    ]);

    expect(probes(shared)).toBe(1);
    expect(probes(overridden)).toBe(1);
    expect(a?.compareRef).toBe("origin/main");
    expect(c).toBe(a);
    expect(b?.compareRef).toBe("upstream/main");
  });

  it("resolves privately when the repository config has a conditional include", async () => {
    writeFileSync(
      join(commonDir, "config"),
      '[remote "origin"]\n\turl = x\n[includeIf "onbranch:release/**"]\n\tpath = release.inc\n'
    );
    const repo = makeRepo();
    const resolver = new SharedBaseRefResolver();

    await Promise.all(["a", "b"].map((wt) => resolver.resolve(request(repo, wt))));

    expect(probes(repo)).toBe(2);
  });

  it("resolves privately when the repository config includes another file at all", async () => {
    // The included file could hold conditions of its own.
    writeFileSync(
      join(commonDir, "config"),
      '[remote "origin"]\n\turl = x\n[include]\n\tpath = more.inc\n'
    );
    const repo = makeRepo();
    const resolver = new SharedBaseRefResolver();

    await Promise.all(["a", "b"].map((wt) => resolver.resolve(request(repo, wt))));

    expect(probes(repo)).toBe(2);
  });

  it("starts sharing again once the include is gone", async () => {
    writeFileSync(join(commonDir, "config"), '[IncludeIf "gitdir:/elsewhere/"]\n\tpath = x\n');
    const repo = makeRepo();
    const resolver = new SharedBaseRefResolver();
    await resolver.resolve(request(repo, "a"));
    await resolver.resolve(request(repo, "b"));
    expect(probes(repo)).toBe(2);

    writeFileSync(join(commonDir, "config"), '[remote "origin"]\n\turl = x\n');
    mtimes.set(join(commonDir, "config"), 2_000);
    await resolver.resolve(request(repo, "a"));
    await resolver.resolve(request(repo, "b"));
    expect(probes(repo)).toBe(3);
  });

  it("never hands one repository's or distro's answer to another", async () => {
    const otherDir = mkdtempSync(join(tmpdir(), "shared-base-ref-other-"));
    try {
      writeFileSync(join(otherDir, "config"), '[remote "origin"]\n\turl = y\n');
      const forkLayout = makeRepo(["origin", "upstream"]);
      const plain = makeRepo(["origin"]);
      const resolver = new SharedBaseRefResolver();
      const wsl = (distro: string) => ({ distro }) as SharedBaseRequest["wslInvocation"];

      const here = await resolver.resolve(request(forkLayout, "a"));
      const there = await resolver.resolve(
        request(plain, "b", { commonDir: otherDir, gitDir: join(otherDir, "worktrees", "b") })
      );
      const ubuntu = await resolver.resolve(
        request(forkLayout, "c", { wslInvocation: wsl("Ubuntu") })
      );
      const debian = await resolver.resolve(request(plain, "d", { wslInvocation: wsl("Debian") }));

      expect(here?.compareRef).toBe("upstream/main");
      expect(there?.compareRef).toBe("origin/main");
      expect(ubuntu?.compareRef).toBe("upstream/main");
      expect(debian?.compareRef).toBe("origin/main");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("keeps separate answers per base branch and per git runtime", async () => {
    const repo = makeRepo();
    const resolver = new SharedBaseRefResolver();

    await resolver.resolve(request(repo, "a"));
    await resolver.resolve(request(repo, "b", { baseBranch: "develop" }));
    await resolver.resolve(
      request(repo, "c", {
        wslInvocation: { distro: "Ubuntu" } as SharedBaseRequest["wslInvocation"],
      })
    );
    await resolver.resolve(request(repo, "d", { baseBranch: "develop" }));

    expect(probes(repo)).toBe(3);
  });

  it("hands a cancelled leader's probe to one live joiner", async () => {
    const repo = makeRepo();
    const gate = deferred();
    repo.gate = gate.promise;
    const resolver = new SharedBaseRefResolver();
    const leader = new AbortController();

    const led = resolver.resolve(request(repo, "a", { signal: leader.signal }));
    await vi.waitFor(() => expect(probes(repo)).toBe(1));
    const joined = [resolver.resolve(request(repo, "b")), resolver.resolve(request(repo, "c"))];
    await settle();

    leader.abort();
    repo.gate = null;
    gate.resolve();

    expect(await led).toBeNull();
    const [b, c] = await Promise.all(joined);
    expect(b?.compareRef).toBe("origin/main");
    expect(c).toBe(b);
    expect(probes(repo)).toBe(2);
  });

  it("caches nothing a cancelled probe read", async () => {
    const repo = makeRepo();
    const resolver = new SharedBaseRefResolver();
    const pass = new AbortController();
    const git = gitFor(repo, pass.signal);
    await resolver.resolve(
      request(repo, "a", {
        signal: pass.signal,
        createGit: async () => ({
          raw: async (args: string[]) => {
            pass.abort();
            return git.raw(args);
          },
        }),
      })
    );

    const next = await resolver.resolve(request(repo, "b"));
    expect(next?.availableRemotes).toEqual(["origin"]);
    expect(probes(repo)).toBe(2);
  });

  it("stops a joiner's wait as soon as its own signal aborts", async () => {
    const repo = makeRepo();
    const gate = deferred();
    repo.gate = gate.promise;
    const resolver = new SharedBaseRefResolver();
    const joiner = new AbortController();

    const led = resolver.resolve(request(repo, "a"));
    await vi.waitFor(() => expect(probes(repo)).toBe(1));
    const joined = resolver.resolve(request(repo, "b", { signal: joiner.signal }));
    await settle();
    joiner.abort();

    expect(await joined).toBeNull();
    repo.gate = null;
    gate.resolve();
    expect((await led)?.compareRef).toBe("origin/main");
    expect(probes(repo)).toBe(1);
  });

  it("publishes nothing from a probe that outlives clear()", async () => {
    const repo = makeRepo();
    const gate = deferred();
    repo.gate = gate.promise;
    const resolver = new SharedBaseRefResolver();

    const stale = resolver.resolve(request(repo, "a"));
    await vi.waitFor(() => expect(probes(repo)).toBe(1));
    resolver.clear();
    repo.gate = null;
    gate.resolve();
    await stale;

    await resolver.resolve(request(repo, "b"));
    expect(probes(repo)).toBe(2);
  });

  it("re-probes an ambiguous answer once it ages out, and an unambiguous one never", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ambiguous = makeRepo(["origin", "upstream"]);
    const single = makeRepo(["origin"]);
    const resolver = new SharedBaseRefResolver();
    await resolver.resolve(request(ambiguous, "a"));
    await resolver.resolve(request(single, "b", { baseBranch: "develop" }));

    now += RESOLUTION_MAX_AGE_MS;
    await resolver.resolve(request(ambiguous, "c"));
    await resolver.resolve(request(single, "d", { baseBranch: "develop" }));

    expect(probes(ambiguous)).toBe(2);
    expect(probes(single)).toBe(1);
  });

  it("trims back under its cap after a burst of held entries overflowed it", async () => {
    // No config file, so scoping resolves without a read and callers reach
    // the map in the order they asked.
    mtimes.set(join(commonDir, "config"), -1);
    const repo = makeRepo();
    const gate = deferred();
    repo.gate = gate.promise;
    const resolver = new SharedBaseRefResolver();
    const base = (i: number) => `base-${i}`;
    const burst = MAX_ENTRIES + 44;

    const pending = Array.from({ length: burst }, (_, i) =>
      resolver.resolve(request(repo, "a", { baseBranch: base(i) }))
    );
    await vi.waitFor(() => expect(probes(repo)).toBe(burst));
    repo.gate = null;
    gate.resolve();
    await Promise.all(pending);

    await resolver.resolve(request(repo, "a", { baseBranch: "one-more" }));
    const before = probes(repo);
    await resolver.resolve(request(repo, "a", { baseBranch: base(burst - 1) }));
    expect(probes(repo)).toBe(before);
    await resolver.resolve(request(repo, "a", { baseBranch: base(44) }));
    expect(probes(repo)).toBe(before + 1);
  });

  it("holds the cached answer while a stat fails unexpectedly", async () => {
    const repo = makeRepo();
    const resolver = new SharedBaseRefResolver();
    await resolver.resolve(request(repo, "a"));

    const failingPackedRefs = async (path: string) => {
      if (path.endsWith("packed-refs")) throw new Error("EIO");
      return statMtime(path);
    };
    const held = await resolver.resolve(request(repo, "b", { statMtime: failingPackedRefs }));

    expect(held?.compareRef).toBe("origin/main");
    expect(probes(repo)).toBe(1);
  });
});
