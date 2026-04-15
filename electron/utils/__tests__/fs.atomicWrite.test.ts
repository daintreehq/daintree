import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import path from "path";
import os from "os";
import {
  resilientAtomicWriteFile,
  resilientAtomicWriteFileSync,
  resilientDirectWriteFile,
} from "../fs.js";

describe("resilientAtomicWriteFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-atomic-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes data atomically to the target path", async () => {
    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, '{"key":"value"}', "utf-8");

    const content = await readFile(target, "utf-8");
    expect(content).toBe('{"key":"value"}');
  });

  it("leaves no temp files after successful write", async () => {
    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, "data", "utf-8");

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

  it("throws ENOENT when parent directory does not exist", async () => {
    const target = path.join(tmpDir, "nonexistent", "test.json");
    await expect(resilientAtomicWriteFile(target, "data")).rejects.toThrow();
  });

  it("cleans up temp file on write failure (no parent dir)", async () => {
    const target = path.join(tmpDir, "nonexistent", "test.json");
    try {
      await resilientAtomicWriteFile(target, "data");
    } catch {
      // expected
    }

    const files = readdirSync(tmpDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("resilientAtomicWriteFileSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "daintree-atomic-sync-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes data atomically to the target path", () => {
    const target = path.join(tmpDir, "test.json");
    resilientAtomicWriteFileSync(target, '{"key":"value"}', "utf-8");

    const content = readFileSync(target, "utf-8");
    expect(content).toBe('{"key":"value"}');
  });

  it("leaves no temp files after successful write", () => {
    const target = path.join(tmpDir, "test.json");
    resilientAtomicWriteFileSync(target, "data", "utf-8");

    const files = readdirSync(tmpDir);
    expect(files).toEqual(["test.json"]);
  });

  it("throws when parent directory does not exist", () => {
    const target = path.join(tmpDir, "nonexistent", "test.json");
    expect(() => resilientAtomicWriteFileSync(target, "data")).toThrow();
  });
});

describe("resilientDirectWriteFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-direct-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes data directly to the target path", async () => {
    const target = path.join(tmpDir, "test.txt");
    await resilientDirectWriteFile(target, "hello", "utf-8");

    const content = await readFile(target, "utf-8");
    expect(content).toBe("hello");
  });
});
