import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  E2E_TEMP_MANIFEST_ENV,
  E2E_TEMP_PREFIX,
  isRemovableTempPath,
  reapStaleTempDirs,
  recordTempDir,
  removeRecordedTempDirs,
} from "../tempDirs";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tempdirs-test-root-"));
  outside = mkdtempSync(path.join(tmpdir(), "tempdirs-test-outside-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "file.txt"), "x");
  return dir;
}

describe("isRemovableTempPath", () => {
  it("accepts a prefixed direct child of the root", () => {
    expect(isRemovableTempPath(makeDir(`${E2E_TEMP_PREFIX}abc`), root)).toBe(true);
  });

  it("rejects dirs without the prefix, nested dirs, relative paths and symlinks", () => {
    expect(isRemovableTempPath(makeDir("other-abc"), root)).toBe(false);
    const nested = path.join(makeDir(`${E2E_TEMP_PREFIX}parent`), `${E2E_TEMP_PREFIX}child`);
    mkdirSync(nested);
    expect(isRemovableTempPath(nested, root)).toBe(false);
    expect(isRemovableTempPath(`${E2E_TEMP_PREFIX}rel`, root)).toBe(false);
    const link = path.join(root, `${E2E_TEMP_PREFIX}link`);
    symlinkSync(outside, link, "dir");
    expect(isRemovableTempPath(link, root)).toBe(false);
  });
});

describe("recordTempDir / removeRecordedTempDirs", () => {
  it("removes recorded dirs and never follows a symlink out of the root", () => {
    const manifest = path.join(root, "manifest.txt");
    writeFileSync(manifest, "");
    const env = { [E2E_TEMP_MANIFEST_ENV]: manifest };
    const keepMe = path.join(outside, "keep.txt");
    writeFileSync(keepMe, "precious");

    const a = makeDir(`${E2E_TEMP_PREFIX}a`);
    const b = makeDir(`${E2E_TEMP_PREFIX}b`);
    symlinkSync(outside, path.join(b, "escape"), "dir");
    const link = path.join(root, `${E2E_TEMP_PREFIX}link`);
    symlinkSync(outside, link, "dir");
    const unprefixed = makeDir("not-ours");
    for (const dir of [a, b, a, link, unprefixed]) recordTempDir(dir, env);

    expect(readFileSync(manifest, "utf8").trim().split("\n")).toHaveLength(5);
    const { removed, skipped } = removeRecordedTempDirs(manifest, root);

    expect(removed.sort()).toEqual([a, b].sort());
    expect(skipped.sort()).toEqual([link, unprefixed].sort());
    expect(existsSync(a) || existsSync(b)).toBe(false);
    expect(readFileSync(keepMe, "utf8")).toBe("precious");
  });

  it("is a no-op without a manifest", () => {
    expect(() => recordTempDir(path.join(root, "x"), {})).not.toThrow();
  });
});

describe("reapStaleTempDirs", () => {
  it("reaps only prefixed entries older than the cutoff", () => {
    const now = Date.now();
    const old = makeDir(`${E2E_TEMP_PREFIX}old`);
    const fresh = makeDir(`${E2E_TEMP_PREFIX}fresh`);
    const foreignOld = makeDir("someone-else-old");
    const past = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path.join(old, "file.txt"), past, past);
    utimesSync(old, past, past);
    utimesSync(foreignOld, past, past);

    const reaped = reapStaleTempDirs(root, 24 * 60 * 60 * 1000, now);

    expect(reaped).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreignOld)).toBe(true);
  });

  it("spares an old dir with recent writes below it, or listed by a live run's manifest", () => {
    const now = Date.now();
    const past = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
    const busy = makeDir(`${E2E_TEMP_PREFIX}busy`);
    mkdirSync(path.join(busy, ".claude"));
    writeFileSync(path.join(busy, ".claude", "session.jsonl"), "x");
    utimesSync(busy, past, past);
    utimesSync(path.join(busy, ".claude"), past, past);
    const listed = makeDir(`${E2E_TEMP_PREFIX}listed`);
    utimesSync(path.join(listed, "file.txt"), past, past);
    utimesSync(listed, past, past);
    writeFileSync(path.join(root, `${E2E_TEMP_PREFIX}manifest-live.txt`), `${listed}\n`);

    expect(reapStaleTempDirs(root, 24 * 60 * 60 * 1000, now)).toEqual([]);
    expect(existsSync(busy) && existsSync(listed)).toBe(true);
  });
});
