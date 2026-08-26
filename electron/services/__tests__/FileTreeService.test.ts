import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileTreeService } from "../FileTreeService.js";

// The temp dirs created below are NOT git repos, and that is no longer a
// special case: this service is a raw listing with no git dependency at all.
// Deciding what belongs in a context is `CopyTreeService.getFileTree`'s job
// (#11439).
describe("FileTreeService", () => {
  let tempDir: string;
  let service: FileTreeService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-"));
    service = new FileTreeService();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects leading path traversal attempts instead of remapping paths", async () => {
    await fs.mkdir(path.join(tempDir, "safe"), { recursive: true });

    await expect(service.getFileTree(tempDir, "../safe")).rejects.toThrow(
      "path traversal not allowed"
    );
  });

  it("rejects nested traversal segments", async () => {
    await fs.mkdir(path.join(tempDir, "safe"), { recursive: true });

    await expect(service.getFileTree(tempDir, "nested/../../safe")).rejects.toThrow(
      "path traversal not allowed"
    );
  });

  it("allows valid relative paths", async () => {
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "src", "main.ts"), "console.log('ok');");

    const result = await service.getFileTree(tempDir, "src");

    expect(result).toEqual([
      expect.objectContaining({
        name: "main.ts",
        path: "src/main.ts",
        isDirectory: false,
      }),
    ]);
  });

  it("sorts sibling names in natural numeric order", async () => {
    // The old lexicographic comparator sorts version_10 between version_1 and
    // version_2; assert the full natural order instead. Input is scrambled so
    // the result can't accidentally pass by echoing insertion order.
    const names = [
      "version_10",
      "version_1",
      "version_9",
      "version_2",
      "version_8",
      "version_3",
      "version_7",
      "version_4",
      "version_6",
      "version_5",
    ];
    for (const name of names) {
      await fs.writeFile(path.join(tempDir, name), "");
    }

    const result = await service.getFileTree(tempDir);

    expect(result.map((node) => node.name)).toEqual([
      "version_1",
      "version_2",
      "version_3",
      "version_4",
      "version_5",
      "version_6",
      "version_7",
      "version_8",
      "version_9",
      "version_10",
    ]);
  });

  it("orders bare numeric names numerically", async () => {
    for (const name of ["10", "2"]) {
      await fs.writeFile(path.join(tempDir, name), "");
    }

    const result = await service.getFileTree(tempDir);

    expect(result.map((node) => node.name)).toEqual(["2", "10"]);
  });

  it("keeps directories before files regardless of name order", async () => {
    await fs.mkdir(path.join(tempDir, "z"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "a"), "");

    const result = await service.getFileTree(tempDir);

    expect(result.map(({ name, isDirectory }) => ({ name, isDirectory }))).toEqual([
      { name: "z", isDirectory: true },
      { name: "a", isDirectory: false },
    ]);
  });

  it("breaks leading-zero ties deterministically rather than by readdir order", async () => {
    // Leading-zero variants share the same numeric value, so ICU numeric
    // collation ranks them equal; without a tiebreak the order would fall
    // through to filesystem enumeration order. Building the same set in two
    // opposite creation orders must therefore yield identical listings, with
    // the equal-valued group ahead of file2.
    const names = ["file2", "file1", "file01", "file001"];
    const forwardDir = path.join(tempDir, "forward");
    const reverseDir = path.join(tempDir, "reverse");
    await fs.mkdir(forwardDir);
    await fs.mkdir(reverseDir);
    for (const name of names) {
      await fs.writeFile(path.join(forwardDir, name), "");
    }
    for (const name of [...names].reverse()) {
      await fs.writeFile(path.join(reverseDir, name), "");
    }

    const forward = (await service.getFileTree(tempDir, "forward")).map((node) => node.name);
    const reverse = (await service.getFileTree(tempDir, "reverse")).map((node) => node.name);

    expect(forward).toEqual(reverse);
    expect(forward).toEqual(["file001", "file01", "file1", "file2"]);
  });

  it("returns every entry including .git and gitignored paths", async () => {
    // Migrated from the old raw-mode suite. The listing takes no view on
    // visibility: the file browser hides entries client-side (#11330) and the
    // context picker asks CopyTree (#11439), so filtering anything here would
    // rob both callers of a choice.
    await fs.writeFile(path.join(tempDir, ".gitignore"), "dist/\n");
    await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "app.ts"), "export {};");

    const nodes = await service.getFileTree(tempDir);

    expect(nodes.map((node) => node.name).sort()).toEqual([".git", ".gitignore", "app.ts", "dist"]);
  });

  it("blocks dirPath values that resolve through symlinks outside base path", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-outside-"));
    await fs.writeFile(path.join(outsideDir, "outside.txt"), "outside");

    const linkPath = path.join(tempDir, "external-link");

    try {
      try {
        await fs.symlink(outsideDir, linkPath, "dir");
      } catch (error) {
        // Some environments disallow symlink creation; skip instead of failing unrelated behavior.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          return;
        }
        throw error;
      }

      // The link is listed now (#11939) — but only as a terminal node. Descent
      // is still refused, which is the guard that makes it terminal: the
      // renderer is told not to ask, and this is what holds if it asks anyway.
      const nodes = await service.getFileTree(tempDir);
      const link = nodes.find((node) => node.name === "external-link");
      expect(link?.symlink?.insideRoot).toBe(false);
      expect(link?.isDirectory).toBe(false);

      await expect(service.getFileTree(tempDir, "external-link")).rejects.toThrow(
        "path traversal not allowed"
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

/**
 * Symlinks are entries, not omissions (#11939). Every test here builds real
 * links on a real filesystem, because the behaviour under test is precisely
 * how the OS resolves them — a mocked `fs` would assert the mock.
 */
describe("FileTreeService symlinks (#11939)", () => {
  let tempDir: string;
  let service: FileTreeService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-symlink-"));
    service = new FileTreeService();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Create a link, or bail out of the calling test on a platform that forbids
   * them outright. Scoped to the creation call alone: a later failure is a real
   * failure, and swallowing it would turn the whole suite into a silent no-op
   * on the platform that most needs it (Windows, where junctions take this
   * same path).
   */
  async function symlinkOrSkip(
    target: string,
    linkPath: string,
    type?: "file" | "dir"
  ): Promise<boolean> {
    try {
      await fs.symlink(target, linkPath, type);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return false;
      throw error;
    }
  }

  it("lists a relative in-root symlink to a file and reports the target's kind", async () => {
    // The `node_modules/.bin` shape from the issue: a link in one directory
    // pointing at a file in a sibling one, written relative to the link's own
    // directory rather than to any process cwd.
    await fs.mkdir(path.join(tempDir, "acorn", "bin"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".bin"), { recursive: true });
    const realFile = path.join(tempDir, "acorn", "bin", "acorn");
    await fs.writeFile(realFile, "#!/usr/bin/env node\n");
    if (!(await symlinkOrSkip("../acorn/bin/acorn", path.join(tempDir, ".bin", "acorn")))) return;

    const nodes = await service.getFileTree(tempDir, ".bin");
    const link = nodes.find((node) => node.name === "acorn");

    expect(link).toBeDefined();
    expect(link?.isDirectory).toBe(false);
    expect(link?.symlink).toEqual({
      target: realFile,
      targetKind: "file",
      insideRoot: true,
    });
  });

  it("reports the target's size and mtime for a resolved link, not the link's own", async () => {
    // A symlink's own `lstat.size` is the byte length of the stored target
    // string — a real number that means nothing as a file size. Compared
    // against the target's actual stat rather than a literal so this asserts
    // the value is plumbed from the right syscall.
    const realFile = path.join(tempDir, "app.ts");
    await fs.writeFile(realFile, "export {};");
    if (!(await symlinkOrSkip(realFile, path.join(tempDir, "link.ts")))) return;
    const targetStat = await fs.stat(realFile);
    const linkStat = await fs.lstat(path.join(tempDir, "link.ts"));

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "link.ts");

    expect(link?.size).toBe(targetStat.size);
    expect(link?.mtimeMs).toBe(targetStat.mtimeMs);
    // Non-vacuous: the two stats genuinely disagree, so reading the wrong one
    // would have been caught.
    expect(linkStat.size).not.toBe(targetStat.size);
  });

  it("lists an in-root symlink to a directory as a directory and descends through it", async () => {
    await fs.mkdir(path.join(tempDir, "real"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "real", "inner.ts"), "export {};");
    if (!(await symlinkOrSkip(path.join(tempDir, "real"), path.join(tempDir, "aliased"), "dir")))
      return;

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "aliased");
    expect(link?.isDirectory).toBe(true);
    expect(link?.symlink?.targetKind).toBe("directory");
    expect(link?.symlink?.insideRoot).toBe(true);

    // Descent through the link works and paths stay expressed through it, so
    // the tree can address the rows it renders.
    const children = await service.getFileTree(tempDir, "aliased");
    expect(children.map((node) => node.path)).toEqual(["aliased/inner.ts"]);
  });

  it("sorts an in-root directory symlink with the directories", async () => {
    // Ordering keys off `isDirectory`, which for a link means the target's
    // kind — so a link to a folder must not sink into the file group.
    await fs.mkdir(path.join(tempDir, "zzz-real"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "aaa-file.ts"), "");
    if (
      !(await symlinkOrSkip(path.join(tempDir, "zzz-real"), path.join(tempDir, "mmm-link"), "dir"))
    )
      return;

    const names = (await service.getFileTree(tempDir)).map((node) => node.name);

    expect(names).toEqual(["mmm-link", "zzz-real", "aaa-file.ts"]);
  });

  it("marks a dangling in-root symlink broken", async () => {
    if (!(await symlinkOrSkip(path.join(tempDir, "gone.ts"), path.join(tempDir, "dangling.ts"))))
      return;

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "dangling.ts");

    expect(link?.symlink?.targetKind).toBe("broken");
    expect(link?.symlink?.insideRoot).toBe(false);
    expect(link?.isDirectory).toBe(false);
  });

  it("reports no size for an unresolved link rather than the target string's length", async () => {
    if (!(await symlinkOrSkip(path.join(tempDir, "gone.ts"), path.join(tempDir, "dangling.ts"))))
      return;
    const linkStat = await fs.lstat(path.join(tempDir, "dangling.ts"));

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "dangling.ts");

    expect(link?.size).toBeUndefined();
    // The link's own mtime is the only honest timestamp left, and it is shown.
    expect(link?.mtimeMs).toBe(linkStat.mtimeMs);
    // Non-vacuous: there really was a plausible-looking number to leak.
    expect(linkStat.size).toBeGreaterThan(0);
  });

  it("never dereferences an out-of-root target, even to learn whether it exists", async () => {
    // The distinction this pins: a link the listing DID follow and found
    // missing reports "broken"; one it deliberately never followed reports
    // "unknown". Both point at a path that does not exist, so the only thing
    // separating the two answers is whether a syscall was made — which is
    // exactly the probe (and, on a dead network mount, the hang) that
    // out-of-root targets must not cost.
    const outsideMissing = path.join(os.tmpdir(), "daintree-file-tree-absent-11939", "nope");
    if (!(await symlinkOrSkip(outsideMissing, path.join(tempDir, "outward")))) return;
    if (!(await symlinkOrSkip(path.join(tempDir, "gone.ts"), path.join(tempDir, "inward")))) return;

    const nodes = await service.getFileTree(tempDir);

    expect(nodes.find((node) => node.name === "outward")?.symlink).toEqual({
      target: outsideMissing,
      targetKind: "unknown",
      insideRoot: false,
    });
    expect(nodes.find((node) => node.name === "inward")?.symlink?.targetKind).toBe("broken");
  });

  it("refuses a link that is lexically inside the root but canonically escapes it", async () => {
    // `hop` resolves to the filesystem root, so `through-hop -> ./hop/etc`
    // passes a purely lexical containment check and still lands outside. The
    // canonical check is what catches it — and until it does, nothing stats
    // the target.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-hop-"));
    try {
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "x");
      if (!(await symlinkOrSkip(outsideDir, path.join(tempDir, "hop"), "dir"))) return;
      if (!(await symlinkOrSkip("./hop/secret.txt", path.join(tempDir, "through-hop")))) return;

      const link = (await service.getFileTree(tempDir)).find((node) => node.name === "through-hop");

      expect(link).toBeDefined();
      expect(link?.symlink?.insideRoot).toBe(false);
      expect(link?.symlink?.targetKind).toBe("unknown");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("keeps listing the rest of a directory when one link is unresolvable", async () => {
    // One bad entry must not take the listing with it — the old behaviour
    // dropped every link silently, and the new one must not swing to throwing.
    await fs.writeFile(path.join(tempDir, "app.ts"), "export {};");
    if (!(await symlinkOrSkip(path.join(tempDir, "gone.ts"), path.join(tempDir, "dangling.ts"))))
      return;

    const names = (await service.getFileTree(tempDir)).map((node) => node.name);

    expect(names).toEqual(["app.ts", "dangling.ts"]);
  });
});

describe("FileTreeService mtimeMs (#11620)", () => {
  let tempDir: string;
  let service: FileTreeService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-mtime-"));
    service = new FileTreeService();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reports a file's modified time, matching what the filesystem records", async () => {
    const filePath = path.join(tempDir, "a.ts");
    await fs.writeFile(filePath, "x");
    const stat = await fs.lstat(filePath);

    const nodes = await service.getFileTree(tempDir, "");
    const node = nodes.find((n) => n.name === "a.ts");

    // Compared against the real stat rather than a literal: this asserts the
    // value is actually plumbed through, not that a constant was copied.
    expect(node?.mtimeMs).toBe(stat.mtimeMs);
  });

  it("reports a directory's modified time too", async () => {
    // The directory branch returns early, before the size read — it needs its
    // own mtime treatment or every folder row would show an em-dash.
    const dirPath = path.join(tempDir, "pkg");
    await fs.mkdir(dirPath);
    const stat = await fs.lstat(dirPath);

    const nodes = await service.getFileTree(tempDir, "");
    const node = nodes.find((n) => n.name === "pkg");

    expect(node?.isDirectory).toBe(true);
    expect(node?.mtimeMs).toBe(stat.mtimeMs);
  });

  it("reflects a rewrite rather than caching the first read", async () => {
    const filePath = path.join(tempDir, "a.ts");
    await fs.writeFile(filePath, "one");
    const first = (await service.getFileTree(tempDir, "")).find((n) => n.name === "a.ts")?.mtimeMs;

    // Push the mtime forward explicitly: a same-millisecond rewrite would make
    // the assertion below vacuous on a fast filesystem.
    const later = new Date(Date.now() + 60_000);
    await fs.writeFile(filePath, "two");
    await fs.utimes(filePath, later, later);

    const second = (await service.getFileTree(tempDir, "")).find((n) => n.name === "a.ts")?.mtimeMs;

    expect(second).toBeGreaterThan(first!);
  });

  it("still reports a byte size alongside the modified time", async () => {
    await fs.writeFile(path.join(tempDir, "a.ts"), "hello");

    const node = (await service.getFileTree(tempDir, "")).find((n) => n.name === "a.ts");

    expect(node).toMatchObject({ size: 5 });
    expect(node?.mtimeMs).toBeGreaterThan(0);
  });
});
