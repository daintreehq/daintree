import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  MAX_RETAINED_FILES,
  buildContextFileName,
  contextDir,
  fitContentToResultBudget,
  pruneContextDir,
  readContentPreview,
  releaseContextFilePath,
  reserveContextFilePath,
  _resetReservedPathsForTests,
} from "../copyTreeOutputFile.js";

/**
 * `contextDir()` resolves `os.tmpdir()` per call, and `os.tmpdir()` reads the
 * environment, so pointing the temp vars at a scratch directory redirects the
 * whole module without mocking it. Every platform's lookup order is covered:
 * TMPDIR on POSIX, TEMP/TMP on Windows.
 */
function redirectTmpdir(root: string): void {
  vi.stubEnv("TMPDIR", root);
  vi.stubEnv("TEMP", root);
  vi.stubEnv("TMP", root);
}

async function writeAged(filePath: string, contents: string, ageMs: number): Promise<void> {
  await fs.writeFile(filePath, contents, "utf8");
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, when, when);
}

/**
 * A name shaped like one this module hands out. Pruning only touches its own
 * naming scheme, so a fixture named `stale.xml` would simply be ignored and the
 * test would prove nothing.
 */
function bundleName(label: string, extension = "xml"): string {
  return buildContextFileName({
    projectName: label,
    branch: "main",
    extension,
    timestamp: "2026-07-31T00-00-00-000Z",
  });
}

describe("copyTreeOutputFile", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-ctxfile-"));
    redirectTmpdir(root);
    _resetReservedPathsForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("buildContextFileName", () => {
    it("keeps two names apart when project, branch and timestamp all match", () => {
      const args = {
        projectName: "daintree",
        branch: "main",
        extension: "xml",
        timestamp: "2026-07-31T00-00-00-000Z",
      };
      expect(buildContextFileName(args)).not.toBe(buildContextFileName(args));
    });

    it("strips path separators and shell metacharacters out of both segments", () => {
      const name = buildContextFileName({
        projectName: "../../etc",
        branch: "feature/x;rm -rf /",
        extension: "xml",
        timestamp: "t",
      });
      expect(path.basename(name)).toBe(name);
      expect(name).not.toContain("..");
      expect(name).not.toContain(";");
      expect(name).not.toContain(" ");
    });

    it("falls back to placeholders when sanitizing empties a segment", () => {
      const name = buildContextFileName({
        projectName: "///",
        branch: "!!!",
        extension: "md",
        timestamp: "t",
      });
      expect(name.startsWith("project-head-")).toBe(true);
      expect(name.endsWith(".md")).toBe(true);
    });
  });

  describe("reserveContextFilePath", () => {
    it("creates an owner-only directory and returns a path inside it", async () => {
      const filePath = await reserveContextFilePath({
        worktreePath: "/repos/daintree",
        branch: "main",
        extension: "xml",
      });

      expect(path.dirname(filePath)).toBe(contextDir());
      const stats = await fs.stat(contextDir());
      expect(stats.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o700);
      }
    });

    it("tightens a directory left behind with a wider mode", async () => {
      if (process.platform === "win32") return;
      await fs.mkdir(contextDir(), { recursive: true, mode: 0o777 });
      await fs.chmod(contextDir(), 0o777);

      await reserveContextFilePath({ worktreePath: "/repos/x", extension: "xml" });

      const stats = await fs.stat(contextDir());
      expect(stats.mode & 0o777).toBe(0o700);
    });

    it("refuses a context directory that is a symlink", async () => {
      if (process.platform === "win32") return;
      // A symlink on this predictable name would redirect the write AND the
      // prune sweep into whatever it points at — on a shared /tmp, someone
      // else's choice.
      const target = path.join(root, "victim");
      await fs.mkdir(target);
      const sentinel = path.join(target, "keepme.txt");
      await fs.writeFile(sentinel, "private", "utf8");
      await fs.symlink(target, contextDir());

      await expect(
        reserveContextFilePath({ worktreePath: "/repos/x", extension: "xml" })
      ).rejects.toThrow();

      await expect(fs.access(sentinel)).resolves.toBeUndefined();
      expect(await fs.readdir(target)).toEqual(["keepme.txt"]);
    });

    it("refuses a context directory that is a plain file", async () => {
      await fs.writeFile(contextDir(), "not a directory", "utf8");

      await expect(
        reserveContextFilePath({ worktreePath: "/repos/x", extension: "xml" })
      ).rejects.toThrow();
    });

    it("hands out a distinct path per call", async () => {
      const paths = await Promise.all(
        Array.from({ length: 5 }, () =>
          reserveContextFilePath({ worktreePath: "/repos/x", branch: "main", extension: "xml" })
        )
      );
      expect(new Set(paths).size).toBe(paths.length);
    });
  });

  describe("pruneContextDir", () => {
    it("removes bundles past the age ceiling and keeps fresh ones", async () => {
      await fs.mkdir(contextDir(), { recursive: true });
      const stale = path.join(contextDir(), bundleName("stale"));
      const fresh = path.join(contextDir(), bundleName("fresh"));
      await writeAged(stale, "old", 48 * 60 * 60 * 1000);
      await writeAged(fresh, "new", 60 * 1000);

      await pruneContextDir();

      await expect(fs.access(stale)).rejects.toThrow();
      await expect(fs.access(fresh)).resolves.toBeUndefined();
    });

    it("never deletes a file it did not write, however old", async () => {
      await fs.mkdir(contextDir(), { recursive: true });
      // This directory sits at a predictable path under the temp dir. If it were
      // ever redirected onto somewhere holding real files, the sweep must still
      // only touch its own naming scheme.
      const bystanders = ["notes.txt", "id_rsa", "budget.xlsx", "bundle.xml", "archive.xml.part"];
      for (const name of bystanders) {
        await writeAged(path.join(contextDir(), name), "not ours", 90 * 24 * 60 * 60 * 1000);
      }

      await pruneContextDir();

      expect((await fs.readdir(contextDir())).sort()).toEqual([...bystanders].sort());
    });

    it("expires a partial far sooner than a finished bundle of the same age", async () => {
      await fs.mkdir(contextDir(), { recursive: true });
      const finished = path.join(contextDir(), bundleName("run"));
      const partial = `${finished}.${crypto.randomUUID()}.part`;
      const age = 3 * 60 * 60 * 1000;
      await writeAged(partial, "half", age);
      await writeAged(finished, "whole", age);

      await pruneContextDir();

      await expect(fs.access(partial)).rejects.toThrow();
      await expect(fs.access(finished)).resolves.toBeUndefined();
    });

    it("trims to the retention count, dropping the oldest first", async () => {
      await fs.mkdir(contextDir(), { recursive: true });
      const total = MAX_RETAINED_FILES + 4;
      const names: string[] = [];
      for (let i = 0; i < total; i += 1) {
        const name = bundleName(`bundle${i}`);
        names.push(name);
        // Age descends with the index, so the highest indices are the newest.
        await writeAged(path.join(contextDir(), name), `body-${i}`, (total - i) * 1000);
      }

      await pruneContextDir();

      const remaining = new Set(await fs.readdir(contextDir()));
      expect(remaining.size).toBe(MAX_RETAINED_FILES);
      // The newest MAX_RETAINED_FILES survive; everything older is gone.
      for (const [index, name] of names.entries()) {
        expect(remaining.has(name)).toBe(index >= total - MAX_RETAINED_FILES);
      }
    });

    it("spares a reserved bundle and its in-flight partial that age alone would sweep", async () => {
      const reserved = await reserveContextFilePath({
        worktreePath: "/repos/x",
        branch: "main",
        extension: "xml",
      });
      // Both are old enough for their own ceiling — 48h for a finished bundle,
      // 5h for a partial — so only the reservation keeps them.
      const partial = `${reserved}.${crypto.randomUUID()}.part`;
      await writeAged(reserved, "published", 48 * 60 * 60 * 1000);
      await writeAged(partial, "in flight", 5 * 60 * 60 * 1000);

      await pruneContextDir();

      await expect(fs.access(reserved)).resolves.toBeUndefined();
      await expect(fs.access(partial)).resolves.toBeUndefined();
    });

    it("sweeps a path and its partial once the reservation is released", async () => {
      const reserved = await reserveContextFilePath({
        worktreePath: "/repos/x",
        extension: "xml",
      });
      const partial = `${reserved}.${crypto.randomUUID()}.part`;
      await writeAged(reserved, "done", 48 * 60 * 60 * 1000);
      await writeAged(partial, "half", 5 * 60 * 60 * 1000);

      releaseContextFilePath(reserved);
      await pruneContextDir();

      await expect(fs.access(reserved)).rejects.toThrow();
      await expect(fs.access(partial)).rejects.toThrow();
    });

    it("leaves subdirectories alone", async () => {
      await fs.mkdir(path.join(contextDir(), "nested"), { recursive: true });
      const nested = path.join(contextDir(), "nested", "deep.xml");
      await writeAged(nested, "keep", 72 * 60 * 60 * 1000);

      await pruneContextDir();

      await expect(fs.access(nested)).resolves.toBeUndefined();
    });

    it("is a no-op when the directory does not exist", async () => {
      await expect(pruneContextDir()).resolves.toBeUndefined();
    });
  });

  describe("readContentPreview", () => {
    it("returns a short file whole and does not flag it truncated", async () => {
      const filePath = path.join(root, "small.xml");
      await fs.writeFile(filePath, "<files>hello</files>", "utf8");

      expect(await readContentPreview(filePath, 1024)).toEqual({
        content: "<files>hello</files>",
        truncated: false,
      });
    });

    it("stops at the cap and flags the cut", async () => {
      const filePath = path.join(root, "big.xml");
      await fs.writeFile(filePath, "a".repeat(5000), "utf8");

      const preview = await readContentPreview(filePath, 512);

      expect(preview.truncated).toBe(true);
      expect(Buffer.byteLength(preview.content, "utf8")).toBeLessThanOrEqual(512);
    });

    it.each([
      [511, false],
      [512, false],
      [513, true],
    ])("reports a %i-byte file against a 512-byte cap as truncated=%s", async (size, truncated) => {
      // The boundary case is the interesting one: a file of exactly the cap
      // fills the window with nothing left over, and measuring only the window
      // would report a complete read as cut.
      const filePath = path.join(root, `exact-${size}.xml`);
      await fs.writeFile(filePath, "a".repeat(size), "utf8");

      const preview = await readContentPreview(filePath, 512);

      expect(preview.truncated).toBe(truncated);
      expect(preview.content).toHaveLength(Math.min(size, 512));
    });

    it("returns nothing for a zero-byte window without claiming the file was whole", async () => {
      const filePath = path.join(root, "zero.xml");
      await fs.writeFile(filePath, "abc", "utf8");

      expect(await readContentPreview(filePath, 0)).toEqual({ content: "", truncated: true });
    });

    it("never decodes a partial code point at the cut", async () => {
      const filePath = path.join(root, "multibyte.xml");
      // Each snowman is 3 UTF-8 bytes, so a 100-byte window lands mid-character.
      await fs.writeFile(filePath, "☃".repeat(200), "utf8");

      const preview = await readContentPreview(filePath, 100);

      expect(preview.content).not.toContain("�");
      expect(Buffer.byteLength(preview.content, "utf8") % 3).toBe(0);
    });

    it("reads a file larger than one read() call in full up to the cap", async () => {
      const filePath = path.join(root, "large.xml");
      await fs.writeFile(filePath, "z".repeat(300_000), "utf8");

      const preview = await readContentPreview(filePath, 128 * 1024);

      expect(preview.content).toHaveLength(128 * 1024);
      expect(preview.truncated).toBe(true);
    });
  });

  describe("fitContentToResultBudget", () => {
    const build = (content: string, contentTruncated: boolean) => ({
      filePath: "/tmp/daintree-context/bundle.xml",
      fileCount: 12,
      outputBytes: 999_999,
      content,
      contentTruncated,
    });
    const serializedSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

    it("passes content through untouched when the whole result already fits", () => {
      const fitted = fitContentToResultBudget("<files>tiny</files>", build, false, 4096);

      expect(fitted.content).toBe("<files>tiny</files>");
      expect(fitted.truncated).toBe(false);
      expect(fitted.result.contentTruncated).toBe(false);
    });

    it("keeps the SERIALIZED result inside the budget, not the raw bytes", () => {
      // Every character escapes to six JSON bytes, so raw length is a wildly
      // optimistic estimate of what lands on the wire — the exact trap that
      // makes a raw-byte cap unsafe.
      const controlHeavy = String.fromCharCode(1).repeat(4000);

      const fitted = fitContentToResultBudget(controlHeavy, build, true, 2048);

      expect(serializedSize(fitted.result)).toBeLessThanOrEqual(2048);
      expect(fitted.content.length).toBeLessThan(controlHeavy.length);
      expect(fitted.result.contentTruncated).toBe(true);
    });

    it("marks a result truncated once the budget forced a cut", () => {
      const fitted = fitContentToResultBudget("x".repeat(10_000), build, false, 1024);

      expect(fitted.truncated).toBe(true);
      expect(fitted.result.contentTruncated).toBe(true);
      expect(serializedSize(fitted.result)).toBeLessThanOrEqual(1024);
    });

    it("keeps the already-truncated flag when the head still fits", () => {
      const fitted = fitContentToResultBudget("short", build, true, 4096);

      expect(fitted.content).toBe("short");
      expect(fitted.truncated).toBe(true);
    });

    it("never leaves a lone surrogate half at the cut", () => {
      // Astral characters are surrogate pairs in UTF-16; cutting between the
      // halves would emit an unpaired one.
      const fitted = fitContentToResultBudget("😀".repeat(2000), build, false, 1024);

      expect(fitted.content).toBe(
        // Whatever survived must round-trip through UTF-8 unchanged.
        Buffer.from(fitted.content, "utf8").toString("utf8")
      );
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(fitted.content)).toBe(false);
      expect(serializedSize(fitted.result)).toBeLessThanOrEqual(1024);
    });

    it("drops content entirely when the budget only just clears the metadata", () => {
      const metadataOnly = serializedSize(build("", true));

      const fitted = fitContentToResultBudget("some content", build, false, metadataOnly);

      expect(fitted.content).toBe("");
      expect(fitted.truncated).toBe(true);
      expect(serializedSize(fitted.result)).toBeLessThanOrEqual(metadataOnly);
    });

    it("returns the smallest result it can build when even the metadata overflows", () => {
      // Nothing can be cut to make this fit, so the helper must still return the
      // minimum rather than silently hand back an over-budget result.
      const fitted = fitContentToResultBudget("some content", build, false, 10);

      expect(fitted.content).toBe("");
      expect(fitted.truncated).toBe(true);
      expect(fitted.result.content).toBe("");
    });

    it("does not claim truncation when nothing was actually cut", () => {
      // `"contentTruncated":true` serializes one byte shorter than `false`, so a
      // budget that only the `true` rendering clears must not be met by
      // relabelling the untouched string.
      const content = "x";
      const withFlagOff = serializedSize(build(content, false));

      const fitted = fitContentToResultBudget(content, build, false, withFlagOff - 1);

      expect(fitted.truncated === false || fitted.content.length < content.length).toBe(true);
      expect(serializedSize(fitted.result)).toBeLessThanOrEqual(withFlagOff - 1);
    });
  });
});
