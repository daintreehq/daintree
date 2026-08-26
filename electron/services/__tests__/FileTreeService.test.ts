import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileTreeService, _normalizeWin32LinkTarget } from "../FileTreeService.js";

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

  it("blocks dirPath values that resolve through symlinks outside base path", async (ctx) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-outside-"));
    await fs.writeFile(path.join(outsideDir, "outside.txt"), "outside");

    const linkPath = path.join(tempDir, "external-link");

    try {
      try {
        await fs.symlink(outsideDir, linkPath, "dir");
      } catch (error) {
        // Some environments disallow symlink creation. Skipped, not returned:
        // a returning test reports green with no assertions, which reads as
        // coverage this suite would not actually have.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") ctx.skip();
        throw error;
      }

      // The link is listed now (#11939) — but only as a terminal node. Descent
      // is still refused, which is the guard that makes it terminal: the
      // renderer is told not to ask, and this is what holds if it asks anyway.
      const nodes = await service.getFileTree(tempDir);
      const link = nodes.find((node) => node.name === "external-link");
      expect(link?.symlink?.targetKind).toBe("external");
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
   * Create a link, or mark the calling test SKIPPED on a platform that forbids
   * them outright.
   *
   * `ctx.skip()` rather than an early `return`: a returning test reports green
   * with no assertions, which is indistinguishable from real coverage in CI —
   * and this is exactly the suite whose Windows result matters, since junctions
   * take the same code path. Scoped to the creation call alone, so any other
   * failure still surfaces.
   */
  async function symlinkOrSkip(
    ctx: { skip: () => void },
    target: string,
    linkPath: string,
    type?: "file" | "dir"
  ): Promise<void> {
    try {
      await fs.symlink(target, linkPath, type);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") ctx.skip();
      throw error;
    }
  }

  it("lists a relative in-root symlink to a file and reports the target's kind", async (ctx) => {
    // The `node_modules/.bin` shape from the issue: a link in one directory
    // pointing at a file in a sibling one, written relative to the link's own
    // directory rather than to any process cwd.
    await fs.mkdir(path.join(tempDir, "acorn", "bin"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".bin"), { recursive: true });
    const realFile = path.join(tempDir, "acorn", "bin", "acorn");
    await fs.writeFile(realFile, "#!/usr/bin/env node\n");
    await symlinkOrSkip(ctx, "../acorn/bin/acorn", path.join(tempDir, ".bin", "acorn"));

    const nodes = await service.getFileTree(tempDir, ".bin");
    const link = nodes.find((node) => node.name === "acorn");

    expect(link).toBeDefined();
    expect(link?.isDirectory).toBe(false);
    // Canonical form, because that is how the kernel resolves it — on macOS
    // `os.tmpdir()` itself sits under a symlinked prefix (`/var` →
    // `/private/var`), so the two spellings genuinely differ here.
    expect(link?.symlink).toEqual({
      target: await fs.realpath(realFile),
      targetKind: "file",
    });
  });

  it("resolves a relative target against the real directory, not the lexical one", async (ctx) => {
    // Listing happens THROUGH a directory link, and the entry inside it is a
    // relative link that climbs. The kernel resolves `../target` against the
    // link's real parent (`packages/pkg/bin`), giving `packages/pkg/target` —
    // resolving against the lexical parent (`alias`) would name the wrong file
    // at the root and misreport, or lose, a perfectly good in-root link.
    await fs.mkdir(path.join(tempDir, "packages", "pkg", "bin"), { recursive: true });
    const realTarget = path.join(tempDir, "packages", "pkg", "target");
    await fs.writeFile(realTarget, "x");
    await symlinkOrSkip(ctx, "packages/pkg/bin", path.join(tempDir, "alias"), "dir");
    await symlinkOrSkip(ctx, "../target", path.join(tempDir, "packages", "pkg", "bin", "tool"));

    const link = (await service.getFileTree(tempDir, "alias")).find((node) => node.name === "tool");

    expect(link?.symlink?.target).toBe(await fs.realpath(realTarget));
    expect(link?.symlink?.targetKind).toBe("file");
  });

  it("accepts an absolute in-root target written in canonical form", async (ctx) => {
    // `tempDir` is the non-canonical spelling on macOS; a link written with
    // the canonical one points at the very same workspace and must not read as
    // external just because the two strings differ.
    const realFile = path.join(tempDir, "app.ts");
    await fs.writeFile(realFile, "export {};");
    const canonicalTarget = await fs.realpath(realFile);
    await symlinkOrSkip(ctx, canonicalTarget, path.join(tempDir, "canonical-link.ts"));
    // Non-vacuous: on a platform where the two spellings coincide this proves
    // nothing, so skip rather than pass.
    if (canonicalTarget === realFile) ctx.skip();

    const link = (await service.getFileTree(tempDir)).find(
      (node) => node.name === "canonical-link.ts"
    );

    expect(link?.symlink?.targetKind).toBe("file");
  });

  it("reports the target's size and mtime for a resolved link, not the link's own", async (ctx) => {
    const realFile = path.join(tempDir, "app.ts");
    await fs.writeFile(realFile, "export {};");
    // Push the target's mtime somewhere the link's cannot coincidentally land:
    // created milliseconds apart, the two would otherwise share a timestamp on
    // a coarse filesystem and the assertion would hold for the wrong reason.
    const distantPast = new Date(Date.now() - 86_400_000);
    await fs.utimes(realFile, distantPast, distantPast);
    await symlinkOrSkip(ctx, realFile, path.join(tempDir, "link.ts"));
    const targetStat = await fs.stat(realFile);
    const linkStat = await fs.lstat(path.join(tempDir, "link.ts"));

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "link.ts");

    expect(link?.size).toBe(targetStat.size);
    expect(link?.mtimeMs).toBe(targetStat.mtimeMs);
    // Non-vacuous on both axes: link and target genuinely disagree about size
    // and about mtime, so reading either off the wrong stat fails here.
    expect(linkStat.size).not.toBe(targetStat.size);
    expect(linkStat.mtimeMs).not.toBe(targetStat.mtimeMs);
  });

  it("lists an in-root symlink to a directory as a directory and descends through it", async (ctx) => {
    await fs.mkdir(path.join(tempDir, "real"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "real", "inner.ts"), "export {};");
    await symlinkOrSkip(ctx, path.join(tempDir, "real"), path.join(tempDir, "aliased"), "dir");

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "aliased");
    expect(link?.isDirectory).toBe(true);
    expect(link?.symlink?.targetKind).toBe("directory");

    // Descent works, and paths stay expressed THROUGH the link so the tree can
    // address the rows it renders.
    const children = await service.getFileTree(tempDir, "aliased");
    expect(children.map((node) => node.path)).toEqual(["aliased/inner.ts"]);
  });

  it("follows a link that points at another link", async (ctx) => {
    await fs.writeFile(path.join(tempDir, "app.ts"), "export {};");
    await symlinkOrSkip(ctx, path.join(tempDir, "app.ts"), path.join(tempDir, "first.ts"));
    await symlinkOrSkip(ctx, path.join(tempDir, "first.ts"), path.join(tempDir, "second.ts"));

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "second.ts");

    // `realpath` collapses the whole chain, so the far end is what is reported
    // — not the intermediate link.
    expect(link?.symlink?.targetKind).toBe("file");
    expect(link?.isDirectory).toBe(false);
  });

  it("sorts an in-root directory symlink with the directories", async (ctx) => {
    // Ordering keys off `isDirectory`, which for a link means the target's
    // kind — so a link to a folder must not sink into the file group.
    await fs.mkdir(path.join(tempDir, "zzz-real"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "aaa-file.ts"), "");
    await symlinkOrSkip(ctx, path.join(tempDir, "zzz-real"), path.join(tempDir, "mmm-link"), "dir");

    const names = (await service.getFileTree(tempDir)).map((node) => node.name);

    expect(names).toEqual(["mmm-link", "zzz-real", "aaa-file.ts"]);
  });

  it("marks a dangling in-root symlink broken", async (ctx) => {
    await symlinkOrSkip(ctx, path.join(tempDir, "gone.ts"), path.join(tempDir, "dangling.ts"));

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "dangling.ts");

    expect(link?.symlink?.targetKind).toBe("broken");
    expect(link?.isDirectory).toBe(false);
  });

  it("reports no size for an unresolved link rather than the target string's length", async (ctx) => {
    await symlinkOrSkip(ctx, path.join(tempDir, "gone.ts"), path.join(tempDir, "dangling.ts"));
    const linkStat = await fs.lstat(path.join(tempDir, "dangling.ts"));

    const link = (await service.getFileTree(tempDir)).find((node) => node.name === "dangling.ts");

    expect(link?.size).toBeUndefined();
    // The link's own mtime is the only honest timestamp left, and it is shown.
    expect(link?.mtimeMs).toBe(linkStat.mtimeMs);
    // Non-vacuous: there really was a plausible-looking number to leak.
    expect(linkStat.size).toBeGreaterThan(0);
  });

  it("classifies a link out of the root as external, never as broken", async (ctx) => {
    // The semantic half of the no-probe rule; the syscall half — that no
    // `realpath`/`lstat` is aimed at the target at all — is asserted against
    // the filesystem mock in `FileTreeService.adversarial.test.ts`, which is
    // the only place a *non*-call can be observed.
    //
    // Both links below name a path that does not exist. `"broken"` is the
    // answer for the one the listing resolved and found missing; `"external"`
    // is the answer for the one it classified without looking.
    const outsideMissing = path.join(os.tmpdir(), "daintree-file-tree-absent-11939", "nope");
    await expect(fs.lstat(outsideMissing)).rejects.toThrow();
    await symlinkOrSkip(ctx, outsideMissing, path.join(tempDir, "outward"));
    await symlinkOrSkip(ctx, path.join(tempDir, "gone.ts"), path.join(tempDir, "inward"));

    const nodes = await service.getFileTree(tempDir);

    expect(nodes.find((node) => node.name === "outward")?.symlink).toEqual({
      target: outsideMissing,
      targetKind: "external",
    });
    expect(nodes.find((node) => node.name === "inward")?.symlink?.targetKind).toBe("broken");
  });

  it("refuses a link that is lexically inside the root but canonically escapes it", async (ctx) => {
    // `hop` resolves outside, so `through-hop → ./hop/secret.txt` passes a
    // purely lexical containment check and still lands out of the workspace.
    // The canonical check on the resolved path is what catches it, and that is
    // the boundary the whole design rests on.
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-file-tree-hop-"));
    try {
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "x");
      await symlinkOrSkip(ctx, outsideDir, path.join(tempDir, "hop"), "dir");
      await symlinkOrSkip(ctx, "./hop/secret.txt", path.join(tempDir, "through-hop"));

      const link = (await service.getFileTree(tempDir)).find((node) => node.name === "through-hop");

      expect(link).toBeDefined();
      expect(link?.symlink?.targetKind).toBe("external");
      // No metadata crosses the boundary with it.
      expect(link?.isDirectory).toBe(false);
      expect(link?.size).toBeUndefined();
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("keeps listing the rest of a directory when one link is unresolvable", async (ctx) => {
    // One bad entry must not take the listing with it — the old behaviour
    // dropped every link silently, and the new one must not swing to throwing.
    await fs.writeFile(path.join(tempDir, "app.ts"), "export {};");
    await symlinkOrSkip(ctx, path.join(tempDir, "gone.ts"), path.join(tempDir, "dangling.ts"));

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

/**
 * Windows junctions store their target in the NT namespace, so `readlink`
 * hands back an extended-length path. The rule runs only on Windows, but the
 * logic is pure and its failure mode — an in-root junction classified as
 * external, or worse a remote share classified as local — is worth pinning on
 * every platform rather than waiting for a Windows run to find it (#11939).
 */
describe("_normalizeWin32LinkTarget", () => {
  it("unwraps the drive-letter form so an in-root junction stays in-root", () => {
    expect(_normalizeWin32LinkTarget(String.raw`\\?\C:\repo\target`)).toBe(
      String.raw`C:\repo\target`
    );
  });

  it("maps the UNC form back to a share path instead of a relative one", () => {
    // The trap: dropping four characters would leave `UNC\server\share`,
    // which is RELATIVE — it would resolve under the workspace root and let a
    // remote share pass as local. It has to become a real UNC path, which
    // stays a distinct root and is rejected by containment.
    const unwrapped = _normalizeWin32LinkTarget(String.raw`\\?\UNC\server\share\x`);
    expect(unwrapped).toBe(String.raw`\\server\share\x`);
    expect(path.win32.isAbsolute(unwrapped)).toBe(true);
  });

  it("leaves any other namespace path wearing its prefix, so it cannot be mistaken for local", () => {
    const volumeGuid = String.raw`\\?\Volume{b75e2c83}\x`;
    expect(_normalizeWin32LinkTarget(volumeGuid)).toBe(volumeGuid);
  });

  it("passes ordinary targets through untouched", () => {
    expect(_normalizeWin32LinkTarget(String.raw`..\target`)).toBe(String.raw`..\target`);
    expect(_normalizeWin32LinkTarget(String.raw`C:\repo\target`)).toBe(String.raw`C:\repo\target`);
    expect(_normalizeWin32LinkTarget("../acorn/bin/acorn")).toBe("../acorn/bin/acorn");
  });
});
