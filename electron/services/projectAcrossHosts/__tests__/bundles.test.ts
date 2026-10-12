import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BundleStore } from "../bundles.js";
import { git, makeRepo, tempRoot, testGit } from "./gitFixtures.js";

let root: string;

beforeEach(() => {
  root = tempRoot("bundle-store-");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("BundleStore.create", () => {
  it("carries HEAD, branches and tags, never the stash, backups or notes", async () => {
    const repo = makeRepo(root, "repo");
    git(repo, ["branch", "feature"]);
    git(repo, ["tag", "v1"]);
    fs.writeFileSync(path.join(repo, "secret.txt"), "work in progress");
    git(repo, ["add", "secret.txt"]);
    git(repo, ["stash", "-q"]);
    git(repo, ["update-ref", "refs/original/refs/heads/main", "HEAD"]);
    git(repo, ["notes", "add", "-m", "private note"]);
    const store = new BundleStore(() => path.join(root, "bundles"));
    const created = await store.create(testGit, repo);
    const heads = git(root, ["bundle", "list-heads", created.path])
      .split("\n")
      .map((line) => line.split(" ")[1]);
    expect(heads).toEqual(
      expect.arrayContaining(["HEAD", "refs/heads/main", "refs/heads/feature"])
    );
    expect(heads).toContain("refs/tags/v1");
    expect(heads.some((ref) => /stash|original|notes/.test(ref ?? ""))).toBe(false);
  });
});
