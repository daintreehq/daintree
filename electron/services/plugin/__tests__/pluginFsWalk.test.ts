// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { mkdtempSync, realpathSync, rmSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PLUGIN_FS_WALK_DEFAULT_LIMIT,
  runWalk,
  validateWalkCall,
  type WalkIo,
} from "../pluginFsWalk.js";
import { checkIgnoredPaths } from "../../../utils/gitCheckIgnore.js";

const realIo: WalkIo = {
  opendir: (dir) => fs.opendir(dir),
  realpath: (dir) => fs.realpath(dir),
  fileSize: (file) =>
    fs.lstat(file).then(
      (s) => (s.isFile() ? s.size : undefined),
      () => undefined
    ),
  checkIgnored: (cwd, paths, signal) => checkIgnoredPaths(cwd, paths, { signal }),
};

let root: string;

async function write(rel: string, contents = "x"): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function fakeDirent(name: string, type: "file" | "dir"): Dirent {
  return {
    name,
    isFile: () => type === "file",
    isDirectory: () => type === "dir",
  } as unknown as Dirent;
}

const walk = (options?: unknown) =>
  runWalk(root, validateWalkCall("p", root, options), realIo, () => {});

const paths = (result: { entries: Array<{ path: string }> }) => result.entries.map((e) => e.path);

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "plugin-walk-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateWalkCall", () => {
  it("applies the defaults", () => {
    expect(validateWalkCall("p", "/r", undefined)).toMatchObject({
      include: null,
      exclude: [],
      maxDepth: 64,
      limit: PLUGIN_FS_WALK_DEFAULT_LIMIT,
      respectGitignore: true,
      includeSize: false,
    });
  });

  it.each([
    [{ limit: 0 }, /limit/],
    [{ limit: 50_001 }, /limit/],
    [{ limit: 1.5 }, /limit/],
    [{ maxDepth: 0 }, /maxDepth/],
    [{ include: "*.ts" }, /include/],
    [{ exclude: [""] }, /exclude/],
    [{ include: Array.from({ length: 65 }, () => "*") }, /at most 64/],
    [{ respectGitignore: "yes" }, /respectGitignore/],
    [{ includeSize: 1 }, /includeSize/],
    [null, /options must be an object/],
  ])("rejects %j", (options, message) => {
    expect(() => validateWalkCall("p", "/r", options)).toThrow(message);
  });

  it("rejects an empty root", () => {
    expect(() => validateWalkCall("p", "", undefined)).toThrow(/root/);
  });
});

describe("runWalk", () => {
  it("lists the tree in one sorted order, directories before their contents", async () => {
    await write("b.txt");
    await write("a/z.txt");
    await write("a-b.txt");
    await write("a/b/c.txt");
    const result = await walk();
    expect(result.truncated).toBe(false);
    expect(result.entries).toEqual([
      { path: "a", type: "dir" },
      { path: "a/b", type: "dir" },
      { path: "a/b/c.txt", type: "file" },
      { path: "a/z.txt", type: "file" },
      { path: "a-b.txt", type: "file" },
      { path: "b.txt", type: "file" },
    ]);
  });

  it("filters output by include without pruning the walk", async () => {
    await write("src/deep/x.ts");
    await write("src/y.js");
    await write("z.ts");
    expect(paths(await walk({ include: ["**/*.ts"] }))).toEqual(["src/deep/x.ts", "z.ts"]);
  });

  it("prunes an excluded directory", async () => {
    await write("node_modules/pkg/index.js");
    await write("src/dist/out.js");
    await write("src/a.ts");
    expect(paths(await walk({ exclude: ["node_modules", "**/dist"] }))).toEqual([
      "src",
      "src/a.ts",
    ]);
  });

  it("stops at maxDepth", async () => {
    await write("a/b/c.txt");
    expect(paths(await walk({ maxDepth: 1 }))).toEqual(["a"]);
    expect(paths(await walk({ maxDepth: 2 }))).toEqual(["a", "a/b"]);
  });

  it("truncates breadth-first at the limit, the same way every time", async () => {
    await write("deep/deeper/x.txt");
    await write("top1.txt");
    await write("top2.txt");
    const first = await walk({ limit: 3 });
    expect(first.truncated).toBe(true);
    expect(paths(first)).toEqual(["deep", "top1.txt", "top2.txt"]);
    expect(paths(await walk({ limit: 3 }))).toEqual(paths(first));
  });

  it("is not truncated when the limit is met exactly", async () => {
    await write("a.txt");
    await write("b.txt");
    const result = await walk({ limit: 2 });
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(2);
  });

  it("reports sizes only when asked", async () => {
    await write("a.txt", "hello");
    expect((await walk()).entries[0]).toEqual({ path: "a.txt", type: "file" });
    expect((await walk({ includeSize: true })).entries[0]).toEqual({
      path: "a.txt",
      type: "file",
      size: 5,
    });
  });

  it("neither follows nor lists a symlink, even one pointing outside the root", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "plugin-walk-outside-")));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "s");
      await write("inside.txt");
      await fs.symlink(outside, path.join(root, "escape"));
      await fs.symlink(path.join(root, "inside.txt"), path.join(root, "alias.txt"));
      expect(paths(await walk())).toEqual(["inside.txt"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not enter a directory that no longer resolves to where it was listed", async () => {
    await write("sub/file.txt");
    const io: WalkIo = {
      ...realIo,
      realpath: async (dir) => (dir.endsWith("sub") ? "/elsewhere" : fs.realpath(dir)),
    };
    const result = await runWalk(root, validateWalkCall("p", root, undefined), io, () => {});
    expect(paths(result)).toEqual(["sub"]);
  });

  it("rejects when the root cannot be read", async () => {
    await write("f.txt");
    await expect(
      runWalk(path.join(root, "f.txt"), validateWalkCall("p", root, undefined), realIo, () => {})
    ).rejects.toThrow();
  });

  it("stops when the checkpoint throws and when the signal aborts", async () => {
    await write("a/b.txt");
    await expect(
      runWalk(root, validateWalkCall("p", root, undefined), realIo, () => {
        throw new Error("PLUGIN_UNLOADED");
      })
    ).rejects.toThrow(/PLUGIN_UNLOADED/);
    const controller = new AbortController();
    controller.abort();
    await expect(walk({ signal: controller.signal })).rejects.toThrow();
  });

  describe("in a git repository", () => {
    beforeEach(() => {
      git("init", "-q");
    });

    it("leaves out ignored entries and .git, and does not descend into an ignored directory", async () => {
      await write(".gitignore", "build/\n*.log\n");
      await write("build/out.js");
      await write("debug.log");
      await write("src/a.ts");
      expect(paths(await walk())).toEqual([".gitignore", "src", "src/a.ts"]);
    });

    it("keeps a tracked file that matches an ignore rule", async () => {
      await write("keep.log");
      git("add", "keep.log");
      await write(".gitignore", "*.log\n");
      expect(paths(await walk())).toEqual([".gitignore", "keep.log"]);
    });

    it("lists a nested repository without entering it", async () => {
      await write("vendor/lib/code.js");
      execFileSync("git", ["init", "-q"], { cwd: path.join(root, "vendor/lib"), stdio: "ignore" });
      await write("main.ts");
      expect(paths(await walk())).toEqual(["main.ts", "vendor", "vendor/lib"]);
    });

    it("spends no examine budget on a nested repository it will not enter", async () => {
      for (const name of ["a", "b", "c", "d", "e"]) await write(`vendor/lib/${name}.js`);
      execFileSync("git", ["init", "-q"], { cwd: path.join(root, "vendor/lib"), stdio: "ignore" });
      await write("main.ts");
      const result = await runWalk(root, validateWalkCall("p", root, undefined), realIo, () => {}, {
        maxVisited: 4,
      });
      expect(result.truncated).toBe(false);
      expect(paths(result)).toEqual(["main.ts", "vendor", "vendor/lib"]);
    });

    it("lists everything with respectGitignore: false", async () => {
      await write(".gitignore", "*.log\n");
      await write("debug.log");
      expect(paths(await walk({ respectGitignore: false, exclude: [".git"] }))).toEqual([
        ".gitignore",
        "debug.log",
      ]);
    });
  });

  it("walks a directory outside any repository with ignore rules on", async () => {
    await write(".gitignore", "*.log\n");
    await write("debug.log");
    const io: WalkIo = {
      ...realIo,
      checkIgnored: async () => {
        throw new Error("git check-ignore failed: exit 128: not a git repository");
      },
    };
    const result = await runWalk(root, validateWalkCall("p", root, undefined), io, () => {});
    expect(paths(result)).toEqual([".gitignore", "debug.log"]);
  });
});

describe("runWalk cost bounds", () => {
  it("keeps what it collected when the visit budget runs out mid-level", async () => {
    for (const name of ["a", "b", "c", "d"]) await write(`${name}.txt`);
    const result = await runWalk(root, validateWalkCall("p", root, undefined), realIo, () => {}, {
      maxVisited: 3,
    });
    expect(result.truncated).toBe(true);
    // Which three depends on the filesystem's enumeration order; they still come back sorted.
    const listed = paths(result);
    expect(listed).toHaveLength(3);
    expect(listed).toEqual([...listed].sort());
    for (const p of listed) expect(["a.txt", "b.txt", "c.txt", "d.txt"]).toContain(p);
  });

  it("is not truncated when a directory holds exactly the visit budget", async () => {
    for (const name of ["a", "b", "c"]) await write(`${name}.txt`);
    const result = await runWalk(root, validateWalkCall("p", root, undefined), realIo, () => {}, {
      maxVisited: 3,
    });
    expect(result.truncated).toBe(false);
    expect(paths(result)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("reads a huge flat directory only as far as the budget, and closes it", async () => {
    let reads = 0;
    let closed = 0;
    const io: WalkIo = {
      ...realIo,
      realpath: async (dir) => dir,
      opendir: async () => ({
        read: async () => {
          reads++;
          return fakeDirent(`f${String(1_000_000 - reads).padStart(7, "0")}.txt`, "file");
        },
        close: async () => {
          closed++;
        },
      }),
    };
    const result = await runWalk(
      "/huge",
      validateWalkCall("p", "/huge", { limit: 1, respectGitignore: false }),
      io,
      () => {},
      { maxVisited: 5_000 }
    );
    expect(reads).toBe(5_001);
    expect(closed).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(1);
    // The smallest name among those read: sorting still applies to the bounded set.
    expect(paths(result)).toEqual([`f${String(1_000_000 - 5_000).padStart(7, "0")}.txt`]);
  });

  it("leaves out a subdirectory whose handle fails to close, and fails on the root", async () => {
    await write("sub/file.txt");
    await write("top.txt");
    const failingClose = (target: string): WalkIo => ({
      ...realIo,
      opendir: async (dir) => {
        const handle = await fs.opendir(dir);
        return {
          read: () => handle.read(),
          close: async () => {
            await handle.close();
            if (dir === target) throw new Error("EIO: close failed");
          },
        };
      },
    });
    const call = validateWalkCall("p", root, { respectGitignore: false });
    const sub = await runWalk(root, call, failingClose(path.join(root, "sub")), () => {});
    expect(paths(sub)).toEqual(["sub", "top.txt"]);
    await expect(runWalk(root, call, failingClose(root), () => {})).rejects.toThrow(/EIO/);
  });

  it("sorts a large level correctly across its yielding merge", async () => {
    const names = Array.from({ length: 7_000 }, (_, i) => `n${(i * 7919) % 7_000}`);
    const io: WalkIo = {
      ...realIo,
      realpath: async (dir) => dir,
      opendir: async () => {
        let i = 0;
        return {
          read: async () => (i < names.length ? fakeDirent(names[i++]!, "file") : null),
          close: async () => {},
        };
      },
    };
    const result = await runWalk(
      "/big",
      validateWalkCall("p", "/big", { limit: 50_000, respectGitignore: false }),
      io,
      () => {}
    );
    expect(result.truncated).toBe(false);
    expect(paths(result)).toEqual([...names].sort());
  });

  it("omits a size when the file's directory moved after it was listed", async () => {
    await write("sub/a.txt", "hello");
    await write("b.txt", "hi");
    let listed = false;
    const io: WalkIo = {
      ...realIo,
      fileSize: async (file) => {
        listed = true;
        return realIo.fileSize(file);
      },
      realpath: async (dir) =>
        listed && dir.endsWith("sub") ? "/elsewhere/sub" : fs.realpath(dir),
    };
    const result = await runWalk(
      root,
      validateWalkCall("p", root, { includeSize: true }),
      io,
      () => {}
    );
    expect(result.entries).toEqual([
      { path: "b.txt", type: "file", size: 2 },
      { path: "sub", type: "dir" },
      { path: "sub/a.txt", type: "file" },
    ]);
  });

  it("truncates when the glob budget is spent", async () => {
    for (const name of ["a", "b", "c", "d"]) await write(`${name}.txt`);
    const result = await runWalk(
      root,
      validateWalkCall("p", root, { include: ["*.txt"] }),
      realIo,
      () => {},
      { maxGlobTests: 2 }
    );
    expect(result.truncated).toBe(true);
    expect(paths(result)).toEqual(["a.txt", "b.txt"]);
  });

  it("drops a directory whose path moved while it was being read", async () => {
    await write("sub/file.txt");
    let calls = 0;
    const io: WalkIo = {
      ...realIo,
      realpath: async (dir) => {
        if (dir.endsWith("sub") && ++calls === 2) return "/elsewhere";
        return fs.realpath(dir);
      },
    };
    const result = await runWalk(root, validateWalkCall("p", root, undefined), io, () => {});
    expect(paths(result)).toEqual(["sub"]);
  });

  it("turns ignore filtering off when git may misreport a tracked file", async () => {
    await write("debug.log");
    const io: WalkIo = {
      ...realIo,
      checkIgnored: async (_cwd, all) => new Set(all),
      hasTrackedIgnored: async () => true,
    };
    const result = await runWalk(root, validateWalkCall("p", root, undefined), io, () => {});
    expect(paths(result)).toEqual(["debug.log"]);
  });

  it("yields to the event loop on a large level", async () => {
    await Promise.all(Array.from({ length: 2100 }, (_, i) => write(`f${i}.txt`)));
    let yields = 0;
    const io: WalkIo = {
      ...realIo,
      yieldNow: async () => {
        yields++;
      },
    };
    await runWalk(root, validateWalkCall("p", root, undefined), io, () => {});
    expect(yields).toBeGreaterThan(0);
  });
});
