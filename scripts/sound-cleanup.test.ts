import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, realpathSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cleanupStaleWavs } from "./sound-cleanup.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sound-cleanup-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function touch(dir: string, name: string) {
  writeFileSync(join(dir, name), "");
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);
}

describe("cleanupStaleWavs", () => {
  it("deletes orphaned .wav files not in the expected set", () => {
    const dir = makeTempDir();
    touch(dir, "error.wav");
    touch(dir, "stale-orphan.wav");
    const expected = new Set(["error.wav", "chime.wav", "chime.v1.wav"]);

    cleanupStaleWavs(dir, expected);

    expect(listFiles(dir).sort()).toEqual(["error.wav"]);
  });

  it("preserves non-.wav files", () => {
    const dir = makeTempDir();
    touch(dir, "error.wav");
    touch(dir, ".gitkeep");
    touch(dir, "notes.txt");
    const expected = new Set(["error.wav"]);

    cleanupStaleWavs(dir, expected);

    expect(listFiles(dir).sort()).toEqual([".gitkeep", "error.wav", "notes.txt"]);
  });

  it("preserves files with .wav-like extension but different case (.Wav)", () => {
    const dir = makeTempDir();
    touch(dir, "error.Wav");
    touch(dir, "chime.wav");
    const expected = new Set(["chime.wav"]);

    cleanupStaleWavs(dir, expected);

    // error.Wav does not end with lowercase ".wav" — should be preserved
    expect(listFiles(dir).sort()).toEqual(["chime.wav", "error.Wav"]);
  });

  it("does not unlink a directory named something.wav", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "trap.wav"));
    touch(dir, "error.wav");
    const expected = new Set(["error.wav"]);

    // should not throw
    cleanupStaleWavs(dir, expected);

    const entries = readdirSync(dir, { withFileTypes: true });
    const dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs).toContain("trap.wav");
  });

  it("deletes all .wav when expected set is empty", () => {
    const dir = makeTempDir();
    touch(dir, "error.wav");
    touch(dir, "chime.wav");
    const expected = new Set<string>();

    cleanupStaleWavs(dir, expected);

    expect(listFiles(dir)).toEqual([]);
  });
});
