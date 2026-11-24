import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBlobs, readBlobSizes } from "../catFileBatch.js";

let repoDir: string;

function git(args: string[], input?: Buffer): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    input,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

function hashBlob(content: Buffer): string {
  return git(["hash-object", "-w", "--stdin"], content);
}

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cat-file-batch-"));
  git(["init", "-q"]);
});

afterAll(() => fs.rmSync(repoDir, { recursive: true, force: true }));

describe("catFileBatch (real git)", () => {
  it("sizes and reads blobs byte for byte, newlines and NULs included", async () => {
    const blobs = [
      Buffer.from("line one\nline two\n"),
      Buffer.from([0, 0x0a, 0x0a, 0xff, 0, 0x0a]),
      Buffer.alloc(0),
      Buffer.from("é ✓ no trailing newline"),
    ];
    const oids = blobs.map(hashBlob);

    const sizes = await readBlobSizes(repoDir, [...oids, oids[0]]);
    expect([...sizes.values()]).toEqual(blobs.map((blob) => blob.length));

    const contents = await readBlobs(repoDir, sizes);
    expect(oids.map((oid) => contents.get(oid))).toEqual(blobs);
  });

  it("rejects an id git does not have", async () => {
    await expect(readBlobSizes(repoDir, ["0".repeat(40)])).rejects.toThrow(/missing/);
  });

  it("rejects an object that is not a blob", async () => {
    const blob = hashBlob(Buffer.from("x\n"));
    const tree = git(["mktree"], Buffer.from(`100644 blob ${blob}\tx\n`));
    await expect(readBlobSizes(repoDir, [tree])).rejects.toThrow(/tree/);
  });

  it("rejects a read whose size disagrees with git's answer", async () => {
    const oid = hashBlob(Buffer.from("four"));
    await expect(readBlobs(repoDir, new Map([[oid, 3]]))).rejects.toThrow(/could not read/);
  });

  it("refuses anything but a full object id before starting git", async () => {
    await expect(readBlobSizes(repoDir, [":README.md"])).rejects.toThrow(/Invalid object id/);
    await expect(readBlobSizes(repoDir, ["abc123"])).rejects.toThrow(/Invalid object id/);
  });
});
