import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyWorktreeIncludeFiles } from "../worktreeInclude.js";

/**
 * Runs real git: the "matches a pattern AND git ignores it" rule rests on how
 * `ls-files --exclude-from` and `check-ignore` actually behave, which a mocked
 * spawn would simply restate.
 */

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function makeRepo(files: Record<string, string>, tracked: string[] = []): string {
  const root = tempDir("daintree-wtinclude-src-");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: GIT_ENV });
  git(["init", "-b", "main", "."]);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  if (tracked.length > 0) {
    git(["add", "-f", "--", ...tracked]);
    git(["commit", "-m", "init"]);
  }
  return root;
}

function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("copyWorktreeIncludeFiles", () => {
  it("copies only files that match an include pattern and are gitignored", async () => {
    const src = makeRepo(
      {
        ".gitignore": ".env\n*.local.json\ncerts/\nbuild/\n",
        ".worktreeinclude":
          "# local config\n.env\n**/*.local.json\ncerts/*\n!certs/skip.pem\nnotes.txt\ntracked.env\n",
        ".env": "SECRET=1",
        "app/settings.local.json": "{}",
        "certs/dev.pem": "cert",
        "certs/skip.pem": "skip",
        "build/out.js": "built",
        "notes.txt": "untracked but not ignored",
        "tracked.env": "tracked",
      },
      [".gitignore", ".worktreeinclude", "tracked.env"]
    );
    const dest = tempDir("daintree-wtinclude-dest-");

    const result = await copyWorktreeIncludeFiles(src, dest);

    expect(listFiles(dest)).toEqual([".env", "app/settings.local.json", "certs/dev.pem"]);
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("SECRET=1");
    expect(result.copied).toBe(3);
  });

  it("does nothing when the repo has no .worktreeinclude", async () => {
    const src = makeRepo({ ".gitignore": ".env\n", ".env": "x" }, [".gitignore"]);
    const dest = tempDir("daintree-wtinclude-dest-");

    const result = await copyWorktreeIncludeFiles(src, dest);

    expect(listFiles(dest)).toEqual([]);
    expect(result.copied).toBe(0);
  });

  it("does not throw when the source is not a git repository", async () => {
    const src = tempDir("daintree-wtinclude-nogit-");
    write(src, ".worktreeinclude", ".env\n");
    write(src, ".env", "x");
    const dest = tempDir("daintree-wtinclude-dest-");

    await expect(copyWorktreeIncludeFiles(src, dest)).resolves.toMatchObject({ copied: 0 });
    expect(listFiles(dest)).toEqual([]);
  });

  it("ignores a .worktreeinclude that is not a regular file", async () => {
    const src = makeRepo({ ".gitignore": ".env\n", ".env": "x" }, [".gitignore"]);
    mkdirSync(join(src, ".worktreeinclude"));
    const dest = tempDir("daintree-wtinclude-dest-");

    await expect(copyWorktreeIncludeFiles(src, dest)).resolves.toMatchObject({ copied: 0 });
  });

  it("skips an oversized .worktreeinclude entirely", async () => {
    const src = makeRepo(
      {
        ".gitignore": ".env\n",
        ".worktreeinclude": ".env\n" + "#".repeat(70 * 1024) + "\n",
        ".env": "x",
      },
      [".gitignore"]
    );
    const dest = tempDir("daintree-wtinclude-dest-");

    await expect(copyWorktreeIncludeFiles(src, dest)).resolves.toMatchObject({ copied: 0 });
    expect(listFiles(dest)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("preserves file permissions", async () => {
    const src = makeRepo(
      {
        ".gitignore": "*.pem\nrun.sh\n",
        ".worktreeinclude": "*.pem\nrun.sh\n",
        "key.pem": "k",
        "run.sh": "#!/bin/sh",
      },
      [".gitignore"]
    );
    chmodSync(join(src, "key.pem"), 0o600);
    chmodSync(join(src, "run.sh"), 0o755);
    const dest = tempDir("daintree-wtinclude-dest-");

    await copyWorktreeIncludeFiles(src, dest);

    expect(statSync(join(dest, "key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dest, "run.sh")).mode & 0o777).toBe(0o755);
  });

  it("never overwrites an existing destination file", async () => {
    const src = makeRepo(
      { ".gitignore": ".env\n", ".worktreeinclude": ".env\n", ".env": "from-main" },
      [".gitignore"]
    );
    const dest = tempDir("daintree-wtinclude-dest-");
    write(dest, ".env", "worktree-override");

    const result = await copyWorktreeIncludeFiles(src, dest);

    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("worktree-override");
    expect(result).toMatchObject({ copied: 0, skippedExisting: 1 });
  });

  it("skips oversized files and keeps copying the rest", async () => {
    const src = makeRepo(
      {
        ".gitignore": "*.env\n",
        ".worktreeinclude": "*.env\n",
        "big.env": "x".repeat(64),
        "small.env": "ok",
      },
      [".gitignore"]
    );
    const dest = tempDir("daintree-wtinclude-dest-");

    const result = await copyWorktreeIncludeFiles(src, dest, { maxFileBytes: 16 });

    expect(listFiles(dest)).toEqual(["small.env"]);
    expect(result).toMatchObject({ copied: 1, skippedOversized: 1 });
  });

  it("stops at the total size limit", async () => {
    const src = makeRepo(
      {
        ".gitignore": "*.env\n",
        ".worktreeinclude": "*.env\n",
        "a.env": "x".repeat(10),
        "b.env": "x".repeat(10),
      },
      [".gitignore"]
    );
    const dest = tempDir("daintree-wtinclude-dest-");

    const result = await copyWorktreeIncludeFiles(src, dest, { maxTotalBytes: 15 });

    expect(listFiles(dest)).toEqual(["a.env"]);
    expect(result).toMatchObject({ copied: 1, skippedOversized: 1 });
  });

  it("stops at the file count limit", async () => {
    const src = makeRepo(
      {
        ".gitignore": "*.env\n",
        ".worktreeinclude": "*.env\n",
        "a.env": "1",
        "b.env": "2",
        "c.env": "3",
      },
      [".gitignore"]
    );
    const dest = tempDir("daintree-wtinclude-dest-");

    const result = await copyWorktreeIncludeFiles(src, dest, { maxFiles: 2 });

    expect(listFiles(dest)).toEqual(["a.env", "b.env"]);
    expect(result).toMatchObject({ copied: 2, skippedOverLimit: 1 });
  });

  it.skipIf(process.platform === "win32")("does not copy or follow symlinks", async () => {
    const outside = tempDir("daintree-wtinclude-outside-");
    write(outside, "secret.txt", "outside");
    const src = makeRepo({ ".gitignore": "*.env\n", ".worktreeinclude": "*.env\n" }, [
      ".gitignore",
    ]);
    symlinkSync(join(outside, "secret.txt"), join(src, "linked.env"));
    const dest = tempDir("daintree-wtinclude-dest-");

    const result = await copyWorktreeIncludeFiles(src, dest);

    expect(listFiles(dest)).toEqual([]);
    expect(result.skippedUnsafe).toBe(1);
  });

  it.skipIf(process.platform === "win32")(
    "does not write through a symlinked directory in the new worktree",
    async () => {
      const outside = tempDir("daintree-wtinclude-outside-");
      const src = makeRepo(
        {
          ".gitignore": "config/local.json\n",
          ".worktreeinclude": "config/local.json\n",
          "config/local.json": "{}",
        },
        [".gitignore"]
      );
      const dest = tempDir("daintree-wtinclude-dest-");
      symlinkSync(outside, join(dest, "config"));

      const result = await copyWorktreeIncludeFiles(src, dest);

      expect(readdirSync(outside)).toEqual([]);
      expect(result).toMatchObject({ copied: 0, skippedUnsafe: 1 });
    }
  );

  it("never copies a nested repository's .git contents", async () => {
    const src = makeRepo({ ".gitignore": "vendor/\n", ".worktreeinclude": "vendor/\n" }, [
      ".gitignore",
    ]);
    const nested = join(src, "vendor", "lib");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-b", "main", "."], {
      cwd: nested,
      stdio: ["ignore", "ignore", "pipe"],
      env: GIT_ENV,
    });
    write(src, "vendor/plain.txt", "plain");
    const dest = tempDir("daintree-wtinclude-dest-");

    await copyWorktreeIncludeFiles(src, dest);

    expect(listFiles(dest)).toEqual(["vendor/plain.txt"]);
    expect(existsSync(join(dest, "vendor", "lib", ".git"))).toBe(false);
  });
});
