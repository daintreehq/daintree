import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBoundedTextFile, readDirectory, readTextFile } from "../fs.js";
import { createWorkspaceReader } from "../reader.js";

let base: string;
let root: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picker-reader-")));
  root = path.join(base, "repo");
  fs.mkdirSync(path.join(root, "app", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "package.json"), '﻿{"name":"site"}');
  fs.writeFileSync(path.join(root, "app", "src", "big.txt"), "x".repeat(64));
  // A sibling whose name starts with the worktree's: a prefix check would let it in.
  fs.mkdirSync(path.join(base, "repo-other"));
  fs.writeFileSync(path.join(base, "repo-other", "secret.json"), '{"secret":true}');
  fs.writeFileSync(path.join(base, "outside.json"), '{"outside":true}');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("createWorkspaceReader", () => {
  it("reads inside the worktree, without the BOM", async () => {
    const reader = createWorkspaceReader(root);

    await expect(readTextFile(reader, path.join(root, "app", "package.json"))).resolves.toBe(
      '{"name":"site"}'
    );
    await expect(reader.stat(root)).resolves.toEqual({ isDirectory: true, isFile: false });
    expect((await readDirectory(reader, root)).map((entry) => entry.name)).toEqual(["app"]);
  });

  it("refuses a path that climbs out, or a sibling sharing the worktree's prefix", async () => {
    const reader = createWorkspaceReader(root);

    for (const target of [
      path.join(root, "..", "outside.json"),
      path.join(base, "repo-other", "secret.json"),
      path.join(base, "outside.json"),
    ]) {
      await expect(reader.readFile(target)).rejects.toThrow("outside the workspace");
      await expect(reader.stat(target)).rejects.toThrow("outside the workspace");
      await expect(readTextFile(reader, target)).resolves.toBeNull();
    }
    await expect(reader.readdir(path.join(base, "repo-other"))).rejects.toThrow(
      "outside the workspace"
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a link inside the worktree that leads out of it, and follows one that stays in",
    async () => {
      fs.symlinkSync(path.join(base, "outside.json"), path.join(root, "app", "escape.json"));
      fs.symlinkSync(path.join(base, "repo-other"), path.join(root, "app", "escaped-dir"));
      fs.symlinkSync(path.join(root, "app", "package.json"), path.join(root, "app", "alias.json"));
      const reader = createWorkspaceReader(root);

      await expect(reader.readFile(path.join(root, "app", "escape.json"))).rejects.toThrow(
        "outside the workspace"
      );
      await expect(reader.readdir(path.join(root, "app", "escaped-dir"))).rejects.toThrow(
        "outside the workspace"
      );
      await expect(readTextFile(reader, path.join(root, "app", "alias.json"))).resolves.toBe(
        '{"name":"site"}'
      );
    }
  );

  it("tells a refused file from a missing one", async () => {
    const reader = createWorkspaceReader(root);
    const read = (target: string, limitBytes = 1_024) =>
      readBoundedTextFile(reader, target, { limitBytes });

    await expect(read(path.join(root, "app", "missing.json"))).resolves.toEqual({
      status: "missing",
    });
    await expect(read(path.join(root, "app", "src"))).resolves.toEqual({ status: "not-a-file" });
    await expect(read(path.join(root, "app", "src", "big.txt"), 16)).resolves.toEqual({
      status: "too-large",
    });
  });

  it("lets an abort through instead of reporting the file missing", async () => {
    const controller = new AbortController();
    const reader = createWorkspaceReader(root, controller.signal);
    controller.abort();

    await expect(
      readTextFile(reader, path.join(root, "app", "package.json"), { signal: controller.signal })
    ).rejects.toBeDefined();
    await expect(reader.readdir(root)).rejects.toBeDefined();
  });
});
