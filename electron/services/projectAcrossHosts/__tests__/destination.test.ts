import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDestination, suggestDestination } from "../destination.js";
import { makeRepo, tempRoot } from "./gitFixtures.js";

let root: string;
const URL = "git@github.com:daintreehq/daintree.git";

beforeAll(() => {
  root = tempRoot("pah-dest-");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("checkDestination", () => {
  it("is free when nothing is there or the folder is empty", async () => {
    expect((await checkDestination(path.join(root, "absent"), [URL])).status).toBe("free");
    fs.mkdirSync(path.join(root, "empty"));
    expect((await checkDestination(path.join(root, "empty"), [URL])).status).toBe("free");
  });

  it("recognises a clone of the same repository", async () => {
    const dir = makeRepo(root, "clone", "https://github.com/daintreehq/daintree");
    expect(await checkDestination(dir, [URL])).toMatchObject({
      status: "same-repository",
      suggestion: null,
    });
  });

  it("refuses anything else and suggests the next free sibling", async () => {
    const taken = path.join(root, "taken");
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, "notes.txt"), "mine");
    fs.mkdirSync(`${taken}-2`);
    expect(await checkDestination(taken, [URL])).toMatchObject({
      status: "occupied",
      suggestion: `${taken}-3`,
    });
    makeRepo(root, "other-repo", "git@github.com:someone/else.git");
    expect((await checkDestination(path.join(root, "other-repo"), [URL])).status).toBe("occupied");
  });

  it("refuses relative paths and the disk root", async () => {
    expect((await checkDestination("relative/dir", [URL])).status).toBe("invalid");
    expect((await checkDestination("/", [URL])).status).toBe("invalid");
  });
});

describe("suggestDestination", () => {
  it("mirrors the client's path under the host's home when it is free", async () => {
    const home = path.join(root, "home-a");
    const check = await suggestDestination({
      homeDir: home,
      projectsDir: path.join(home, "Projects"),
      homeRelativePath: "Projects/Daintree/daintree",
      repoName: "daintree",
      remoteUrls: [URL],
    });
    expect(check).toMatchObject({
      status: "free",
      path: path.join(home, "Projects", "Daintree", "daintree"),
    });
  });

  it("falls back to the projects folder plus the repo name, stepping past what's taken", async () => {
    const home = path.join(root, "home-b");
    const mirrored = path.join(home, "work", "daintree");
    fs.mkdirSync(mirrored, { recursive: true });
    fs.writeFileSync(path.join(mirrored, "x"), "x");
    const projects = path.join(home, "Projects");
    fs.mkdirSync(path.join(projects, "daintree"), { recursive: true });
    fs.writeFileSync(path.join(projects, "daintree", "y"), "y");
    const check = await suggestDestination({
      homeDir: home,
      projectsDir: projects,
      homeRelativePath: "work/daintree",
      repoName: "daintree",
      remoteUrls: [URL],
    });
    expect(check).toMatchObject({ status: "free", path: path.join(projects, "daintree-2") });
  });

  it("ignores a relative path that climbs out of home", async () => {
    const home = path.join(root, "home-c");
    const check = await suggestDestination({
      homeDir: home,
      projectsDir: path.join(home, "Projects"),
      homeRelativePath: "../escape",
      repoName: "daintree",
      remoteUrls: [URL],
    });
    expect(check.path).toBe(path.join(home, "Projects", "daintree"));
  });
});
