import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readWorktreeCreationStamp,
  WORKTREE_CREATION_STAMP_FILE,
  writeWorktreeCreationStamp,
} from "../worktreeCreationStamp.js";

describe("worktreeCreationStamp", () => {
  let gitDir: string;

  beforeEach(async () => {
    gitDir = await mkdtemp(path.join(os.tmpdir(), "daintree-stamp-"));
  });

  afterEach(async () => {
    await rm(gitDir, { recursive: true, force: true });
  });

  it("reads back what was written", async () => {
    await writeWorktreeCreationStamp(gitDir, { createdAt: 123, branch: "feature/x" });
    expect(await readWorktreeCreationStamp(gitDir)).toEqual({
      createdAt: 123,
      branch: "feature/x",
    });
  });

  it("reads no stamp as null", async () => {
    expect(await readWorktreeCreationStamp(gitDir)).toBeNull();
  });

  it("never overwrites a stamp already there", async () => {
    await writeWorktreeCreationStamp(gitDir, { createdAt: 1, branch: "a" });
    await expect(
      writeWorktreeCreationStamp(gitDir, { createdAt: 2, branch: "b" })
    ).rejects.toThrow();
    expect(await readWorktreeCreationStamp(gitDir)).toEqual({ createdAt: 1, branch: "a" });
  });

  it.each([
    ["not JSON", "daintree"],
    ["not an object", "42"],
    ["missing fields", JSON.stringify({ createdAt: 1 })],
    ["a time that isn't a number", '{"createdAt":"soon","branch":"x"}'],
    ["a time that overflows", '{"createdAt":1e400,"branch":"x"}'],
  ])("rejects a stamp that is %s rather than read it either way", async (_label, text) => {
    await writeFile(path.join(gitDir, WORKTREE_CREATION_STAMP_FILE), text);
    await expect(readWorktreeCreationStamp(gitDir)).rejects.toThrow();
  });

  it("writes one JSON line", async () => {
    await writeWorktreeCreationStamp(gitDir, { createdAt: 5, branch: "b" });
    const text = await readFile(path.join(gitDir, WORKTREE_CREATION_STAMP_FILE), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trim().split("\n")).toHaveLength(1);
  });
});
