import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import path from "path";
import os from "os";

import { resilientAtomicWriteFile, resilientAtomicWriteFileSync } from "../fs.js";

describe("dir fsync integration (real fs, no mocks)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-dirsync-int-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("async write survives with dir fsync", async () => {
    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, '{"key":"value"}', "utf-8");

    const content = await readFile(target, "utf-8");
    expect(content).toBe('{"key":"value"}');
  });

  it("sync write survives with dir fsync", () => {
    const target = path.join(tmpDir, "test.json");
    resilientAtomicWriteFileSync(target, "synctest", "utf-8");

    const content = readFileSync(target, "utf-8");
    expect(content).toBe("synctest");
  });

  it("leaves no temp files after write", () => {
    const target = path.join(tmpDir, "test.json");
    resilientAtomicWriteFileSync(target, "data", "utf-8");

    const files = readdirSync(tmpDir);
    expect(files).toEqual(["test.json"]);
  });

  it("overwrites existing file atomically", async () => {
    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, "original", "utf-8");
    await resilientAtomicWriteFile(target, "updated", "utf-8");

    const content = await readFile(target, "utf-8");
    expect(content).toBe("updated");
  });
});
