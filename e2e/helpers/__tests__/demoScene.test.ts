import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  buildScene,
  describeScene,
  validateScene,
  worktreeDirName,
  type DemoScene,
} from "../demoScene";

let demoRoot: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.DAINTREE_DEMO_ROOT;
  demoRoot = mkdtempSync(path.join(tmpdir(), "demo-scene-"));
  process.env.DAINTREE_DEMO_ROOT = demoRoot;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.DAINTREE_DEMO_ROOT;
  else process.env.DAINTREE_DEMO_ROOT = previousRoot;
  rmSync(demoRoot, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Porcelain status for one path, or null when git reports it clean.
 *
 * Deliberately not routed through `git()`: the two-character status field is
 * space-padded, so trimming the output turns an unstaged " M" into "M " and
 * makes the assertion read the wrong column.
 */
function statusFor(cwd: string, file: string): string | null {
  const line = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })
    .split("\n")
    .find((entry) => entry.endsWith(file));
  return line ? line.slice(0, 2) : null;
}

function minimalScene(overrides: Partial<DemoScene> = {}): DemoScene {
  return { slug: "scene", files: { "README.md": "# scene\n" }, ...overrides };
}

function messageFrom(run: () => void): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("validateScene", () => {
  it("reports every problem in one throw rather than the first", () => {
    const message = messageFrom(() =>
      validateScene({ slug: "Bad Slug", files: {}, worktrees: [{ branch: "d" }, { branch: "d" }] })
    );

    expect(message).toContain("slug");
    expect(message).toContain("files");
    expect(message).toContain("used more than once");
  });

  it("rejects a non-object scene outright", () => {
    expect(() => validateScene("nope")).toThrow(/JSON object/);
    expect(() => validateScene(null)).toThrow(/JSON object/);
  });

  it("catches a misspelled field instead of silently ignoring it", () => {
    // The failure this prevents: `aheadCommit` is dropped, the branch builds
    // level, and the author never learns why the ahead count is missing.
    const message = messageFrom(() =>
      validateScene(
        minimalScene({ worktrees: [{ branch: "feature/x", aheadCommit: [] }] } as never)
      )
    );
    expect(message).toContain('unknown field "aheadCommit"');
  });

  it("rejects a string where a boolean is required", () => {
    const message = messageFrom(() => validateScene(minimalScene({ remote: "true" } as never)));
    expect(message).toContain("remote: expected a boolean");
  });

  it("rejects a worktree branch that collides with the default branch", () => {
    expect(() =>
      validateScene(minimalScene({ defaultBranch: "trunk", worktrees: [{ branch: "trunk" }] }))
    ).toThrow(/default branch/);
  });

  it("honours a custom default branch when deciding collisions", () => {
    expect(() =>
      validateScene(minimalScene({ defaultBranch: "trunk", worktrees: [{ branch: "main" }] }))
    ).not.toThrow();
  });

  it("rejects push when the scene declares no remote", () => {
    expect(() =>
      validateScene(minimalScene({ worktrees: [{ branch: "feature/x", push: true }] }))
    ).toThrow(/push requires/);
  });

  it("rejects ahead-commits without a push, which would report no ahead count", () => {
    const message = messageFrom(() =>
      validateScene(
        minimalScene({
          worktrees: [
            { branch: "feature/x", aheadCommits: [{ message: "m", files: { "a.ts": "x" } }] },
          ],
        })
      )
    );
    expect(message).toContain("aheadCommits requires push");
  });

  it("accepts ahead-commits once push and remote are declared", () => {
    expect(() =>
      validateScene(
        minimalScene({
          remote: true,
          worktrees: [
            {
              branch: "feature/x",
              push: true,
              aheadCommits: [{ message: "m", files: { "a.ts": "x" } }],
            },
          ],
        })
      )
    ).not.toThrow();
  });

  it.each([
    ["../escape.txt", "parent traversal"],
    ["nested/../../escape.txt", "traversal after nesting"],
    ["/etc/passwd", "absolute posix path"],
    ["\\rooted.txt", "windows-rooted path"],
    ["C:/windows/system32/x.txt", "drive-qualified path"],
    [".git/config", "git control file"],
    [".GIT/hooks/post-checkout", "git control file, odd case"],
    [".git", "worktree gitdir pointer"],
  ])("rejects %s (%s) as a file key", (key) => {
    expect(() => validateScene(minimalScene({ files: { [key]: "x" } }))).toThrow(/relative path/);
  });

  it("allows a nested relative path that stays inside the tree", () => {
    expect(() => validateScene(minimalScene({ files: { "src/deep/file.ts": "x" } }))).not.toThrow();
  });

  it("checks paths inside ahead-commits and recipes, not just top-level files", () => {
    const ahead = messageFrom(() =>
      validateScene(
        minimalScene({
          remote: true,
          worktrees: [
            {
              branch: "feature/x",
              push: true,
              aheadCommits: [{ message: "m", files: { "../out.txt": "x" } }],
            },
          ],
        })
      )
    );
    expect(ahead).toContain("relative path");

    const recipe = messageFrom(() =>
      validateScene(minimalScene({ recipes: [{ filename: "../../../victim.json", content: {} }] }))
    );
    expect(recipe).toContain("inside .daintree/recipes");
  });

  it("rejects a recipe the app's loader would silently ignore", () => {
    const message = messageFrom(() =>
      validateScene(minimalScene({ recipes: [{ filename: "build.yaml", content: {} }] }))
    );
    expect(message).toContain('must end in ".json"');
  });

  it("rejects two branches that would share one worktree directory", () => {
    const colliding = ["feature/a-b", "feature-a/b"];
    expect(new Set(colliding.map(worktreeDirName)).size).toBe(1);

    const message = messageFrom(() =>
      validateScene(minimalScene({ worktrees: colliding.map((branch) => ({ branch })) }))
    );
    expect(message).toContain("both map to worktree directory");
  });

  it("rejects a branch that is a git ref-namespace prefix of another", () => {
    const message = messageFrom(() =>
      validateScene(minimalScene({ worktrees: [{ branch: "feature" }, { branch: "feature/x" }] }))
    );
    expect(message).toContain("git allows only one");
  });

  it("rejects a slug that would name its own sibling directories", () => {
    expect(() => validateScene(minimalScene({ slug: "scene-worktrees" }))).toThrow(/-worktrees/);
    expect(() => validateScene(minimalScene({ slug: "scene-origin" }))).toThrow(/-origin/);
  });
});

describe("buildScene", () => {
  it("commits the declared files on the default branch", () => {
    const built = buildScene(
      minimalScene({ defaultBranch: "trunk", files: { "src/a.ts": "export const a = 1;\n" } })
    );

    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], built.dir)).toBe("trunk");
    expect(git(["status", "--porcelain"], built.dir)).toBe("");
    expect(readFileSync(path.join(built.dir, "src/a.ts"), "utf8")).toContain("export const a");
  });

  it("keeps its ownership marker out of the committed tree", () => {
    // A marker git can see would show up in the app's file browser on camera.
    const built = buildScene(minimalScene());
    expect(git(["ls-files"], built.dir).split("\n")).not.toContain(".daintree-demo-scene");
    expect(git(["status", "--porcelain"], built.dir)).toBe("");
  });

  it("commits recipes where the app looks for them", () => {
    const built = buildScene(
      minimalScene({
        recipes: [{ filename: "review.json", content: { name: "Review", agents: [] } }],
      })
    );

    const tracked = git(["ls-files"], built.dir).split("\n");
    expect(tracked).toContain(".daintree/recipes/review.json");
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(built.dir, ".daintree/recipes/review.json"), "utf8")
    );
    expect(parsed).toEqual({ name: "Review", agents: [] });
  });

  it("distinguishes an edited committed file from a brand-new one", () => {
    const built = buildScene(
      minimalScene({
        worktrees: [
          {
            branch: "feature/dirty",
            files: { "src/base.ts": "// base\n" },
            uncommittedFiles: { "src/base.ts": "// edited\n", "src/new.ts": "// new\n" },
          },
        ],
      })
    );

    const worktree = built.worktrees[0]!;
    expect(statusFor(worktree.path, "src/base.ts")).toBe(" M");
    expect(statusFor(worktree.path, "src/new.ts")).toBe("??");
  });

  it("makes a pushed branch ahead by exactly its ahead-commit count, with an upstream set", () => {
    const aheadCommits = [
      { message: "first", files: { "src/one.ts": "// 1\n" } },
      { message: "second", files: { "src/two.ts": "// 2\n" } },
    ];
    const built = buildScene(
      minimalScene({
        remote: true,
        worktrees: [
          {
            branch: "feature/ahead",
            files: { "src/base.ts": "// base\n" },
            push: true,
            aheadCommits,
          },
        ],
      })
    );

    const worktree = built.worktrees[0]!;
    // Resolved through @{upstream}, not a hardcoded ref: Daintree suppresses the
    // ahead count entirely unless the branch actually has a tracking branch.
    expect(git(["rev-parse", "--abbrev-ref", "@{upstream}"], worktree.path)).toBe(
      "origin/feature/ahead"
    );
    const [behind, ahead] = git(
      ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
      worktree.path
    )
      .split(/\s+/)
      .map(Number);
    expect(behind).toBe(0);
    expect(ahead).toBe(aheadCommits.length);
  });

  it("gives a pushed branch with no commits of its own a level upstream", () => {
    const built = buildScene(
      minimalScene({ remote: true, worktrees: [{ branch: "feature/level", push: true }] })
    );

    const worktree = built.worktrees[0]!;
    const [behind, ahead] = git(
      ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
      worktree.path
    )
      .split(/\s+/)
      .map(Number);
    expect(behind).toBe(0);
    expect(ahead).toBe(0);
  });

  it("wires origin to a bare repo that actually holds the pushed default branch", () => {
    const built = buildScene(minimalScene({ remote: true }));

    expect(git(["remote", "get-url", "origin"], built.dir)).toBe(built.remotePath);
    expect(git(["rev-parse", "HEAD"], built.dir)).toBe(
      git(["rev-parse", "main"], built.remotePath!)
    );
  });

  it("omits a remote when the scene does not ask for one", () => {
    const built = buildScene(minimalScene());
    expect(built.remotePath).toBeNull();
    expect(() => git(["remote", "get-url", "origin"], built.dir)).toThrow();
  });

  it("registers every declared worktree with git", () => {
    const branches = ["feature/a", "feature/b"];
    const built = buildScene(minimalScene({ worktrees: branches.map((branch) => ({ branch })) }));

    const listed = git(["worktree", "list"], built.dir);
    for (const worktree of built.worktrees) {
      expect(existsSync(worktree.path)).toBe(true);
      expect(listed).toContain(worktree.path);
    }
    expect(built.worktrees.map((w) => w.branch)).toEqual(branches);
  });

  it("builds a scene reproducibly when the host config would sabotage it", () => {
    // Global signing config makes `git commit` fail outright on many dev
    // machines; the builder has to be immune to whatever the host has set.
    const hostConfig = path.join(demoRoot, "hostile.gitconfig");
    writeFileSync(hostConfig, "[commit]\n\tgpgsign = true\n[user]\n\tsigningkey = nope\n");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = hostConfig;
    try {
      const built = buildScene(minimalScene());
      expect(git(["log", "--oneline"], built.dir)).toContain("initial commit");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });
});

describe("describeScene", () => {
  it("reports the same paths buildScene produces", () => {
    const declared = minimalScene({
      remote: true,
      worktrees: [{ branch: "feature/a", push: true }, { branch: "feature/b" }],
    });
    const actual = buildScene(declared);
    const described = describeScene(declared);

    expect(described.dir).toBe(actual.dir);
    expect(described.remotePath).toBe(actual.remotePath);
    expect(described.worktrees).toEqual(actual.worktrees);
  });

  it("leaves the repository untouched, including work done since the build", () => {
    // This is the whole reason it exists: rendering a shot card or tearing a
    // demo down must never delete what a recording session has produced.
    const built = buildScene(minimalScene({ worktrees: [{ branch: "feature/a" }] }));
    const recorded = path.join(built.worktrees[0]!.path, "recorded-during-a-take.ts");
    writeFileSync(recorded, "// written mid-session\n");
    const head = git(["rev-parse", "HEAD"], built.dir);

    describeScene(minimalScene({ worktrees: [{ branch: "feature/a" }] }));

    expect(existsSync(recorded)).toBe(true);
    expect(git(["rev-parse", "HEAD"], built.dir)).toBe(head);
  });

  it("refuses to release directories it does not own, and says so", () => {
    // Reporting the failure matters as much as refusing it: a teardown that
    // swallowed this would print success while the directory was still there.
    const victim = path.join(demoRoot, "scene");
    mkdirSync(victim, { recursive: true });
    writeFileSync(path.join(victim, "important.txt"), "real work");

    expect(() => describeScene(minimalScene()).cleanup()).toThrow(/Could not remove/);
    expect(existsSync(path.join(victim, "important.txt"))).toBe(true);
  });

  it("releases a scene it does own", () => {
    const built = buildScene(minimalScene({ remote: true, worktrees: [{ branch: "feature/a" }] }));

    describeScene(minimalScene({ remote: true, worktrees: [{ branch: "feature/a" }] })).cleanup();

    expect(existsSync(built.dir)).toBe(false);
    expect(existsSync(built.remotePath!)).toBe(false);
  });
});

describe("buildScene ownership", () => {
  it("refuses to delete a directory it did not create", () => {
    const victim = path.join(demoRoot, "scene");
    mkdirSync(victim, { recursive: true });
    writeFileSync(path.join(victim, "important.txt"), "real work\n");

    expect(() => buildScene(minimalScene())).toThrow(/Refusing to delete/);
    expect(readFileSync(path.join(victim, "important.txt"), "utf8")).toBe("real work\n");
  });

  it("reclaims an empty leftover directory rather than dead-ending", () => {
    mkdirSync(path.join(demoRoot, "scene"), { recursive: true });
    expect(() => buildScene(minimalScene())).not.toThrow();
  });

  it("removes the tree, its worktrees and its remote while leaving siblings alone", () => {
    const sentinel = path.join(demoRoot, "unrelated-project");
    mkdirSync(sentinel, { recursive: true });
    writeFileSync(path.join(sentinel, "keep.txt"), "keep\n");

    const built = buildScene(
      minimalScene({ remote: true, worktrees: [{ branch: "feature/a", push: true }] })
    );
    const worktreePath = built.worktrees[0]!.path;

    built.cleanup();

    expect(existsSync(built.dir)).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(built.remotePath!)).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(demoRoot)).toBe(true);
  });

  it("is idempotent, so a second cleanup is harmless", () => {
    const built = buildScene(minimalScene());
    built.cleanup();
    expect(() => built.cleanup()).not.toThrow();
  });

  it("will not let a stale handle delete a newer build of the same slug", () => {
    const first = buildScene(minimalScene({ files: { "README.md": "# first\n" } }));
    const second = buildScene(minimalScene({ files: { "README.md": "# second\n" } }));

    first.cleanup();

    expect(existsSync(second.dir)).toBe(true);
    expect(readFileSync(path.join(second.dir, "README.md"), "utf8")).toContain("second");
  });

  it("clears a stale origin when a rebuild drops the remote", () => {
    const withRemote = buildScene(minimalScene({ remote: true }));
    const originPath = withRemote.remotePath!;
    expect(existsSync(originPath)).toBe(true);

    const withoutRemote = buildScene(minimalScene());

    expect(withoutRemote.remotePath).toBeNull();
    expect(existsSync(originPath)).toBe(false);
  });

  it("leaves nothing behind when a build fails part-way", () => {
    // `bad..name` is invalid git ref syntax, so it survives validation and
    // fails at `worktree add` — after the first worktree already succeeded.
    const scene = minimalScene({ worktrees: [{ branch: "feature/a" }, { branch: "bad..name" }] });

    expect(() => buildScene(scene)).toThrow(/worktree add/);
    expect(existsSync(path.join(demoRoot, "scene"))).toBe(false);
    expect(existsSync(path.join(demoRoot, "scene-worktrees"))).toBe(false);
    expect(existsSync(demoRoot)).toBe(true);
  });

  it("rebuilds over the leftovers of a previous take", () => {
    const first = buildScene(minimalScene({ files: { "README.md": "# first\n" } }));
    expect(readFileSync(path.join(first.dir, "README.md"), "utf8")).toContain("first");

    const second = buildScene(minimalScene({ files: { "README.md": "# second\n" } }));
    expect(readFileSync(path.join(second.dir, "README.md"), "utf8")).toContain("second");
    expect(git(["log", "--oneline"], second.dir).split("\n")).toHaveLength(1);
  });
});
