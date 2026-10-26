import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_PATTERNS,
  deriveRepoNames,
  stripPackageScope,
  workspacePatternSegments,
} from "../voiceRepoKeyterms.js";
import { assembleKeyterms } from "../voiceContextKeyterms.js";
import { MAX_KEYTERMS } from "../../../shared/config/voiceKeyterms.js";

const roots: string[] = [];

async function makeRepo(files: Record<string, unknown>, dirs: string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "voice-repo-"));
  roots.push(root);
  for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(content));
  }
  return root;
}

// A directory beside the repo, holding a manifest the repo must never read.
async function makeOutside(name: string): Promise<string> {
  const outside = await mkdtemp(join(tmpdir(), "voice-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "package.json"), JSON.stringify({ name }));
  return outside;
}

// Symlinks need privileges on Windows and mkfifo has no equivalent; CI is Ubuntu.
const posixIt = it.skipIf(process.platform === "win32");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("deriveRepoNames", () => {
  it("reads the package name, workspace packages, directories and dependencies in rank order", async () => {
    const root = await makeRepo(
      {
        "package.json": {
          name: "daintree",
          workspaces: ["packages/*"],
          dependencies: { zustand: "1" },
        },
        "packages/plugin-sdk/package.json": { name: "@daintreehq/plugin-sdk" },
      },
      ["electron", "node_modules/left-pad", ".git"]
    );
    const { names } = await deriveRepoNames(root);
    expect(names).toEqual([
      "daintree",
      "@daintreehq/plugin-sdk",
      "electron",
      "packages",
      "zustand",
    ]);
  });

  it("drops credential-shaped names", async () => {
    const root = await makeRepo({
      "package.json": { name: "app", dependencies: { ghp_abcdefghijklmnop1234: "1", react: "1" } },
    });
    const { names } = await deriveRepoNames(root);
    expect(names).toContain("react");
    expect(names.some((n) => n.startsWith("ghp_"))).toBe(false);
  });

  it("returns nothing for a missing or unparsable root", async () => {
    expect((await deriveRepoNames("/nonexistent/daintree-voice")).names).toEqual([]);
    const root = await makeRepo({});
    await writeFile(join(root, "package.json"), "{not json");
    expect((await deriveRepoNames(root)).names).toEqual([]);
  });

  it("caps workspace package reads in a large monorepo", async () => {
    const files: Record<string, unknown> = {
      "package.json": { name: "mono", workspaces: ["pkgs/*"] },
    };
    for (let i = 0; i < 200; i++) files[`pkgs/p${i}/package.json`] = { name: `pkg-${i}` };
    const root = await makeRepo(files);
    const { names } = await deriveRepoNames(root);
    expect(names.filter((n) => n.startsWith("pkg-")).length).toBeLessThanOrEqual(40);
  });

  it("reads a manifest that starts with a UTF-8 byte-order mark", async () => {
    const root = await makeRepo({});
    await writeFile(join(root, "package.json"), `\uFEFF${JSON.stringify({ name: "bomrepo" })}`);
    expect((await deriveRepoNames(root)).names).toEqual(["bomrepo"]);
  });

  posixIt("does not follow a symlinked root manifest out of the repo", async () => {
    const outside = await makeOutside("outsider");
    const root = await makeRepo({});
    await symlink(join(outside, "package.json"), join(root, "package.json"));
    expect((await deriveRepoNames(root)).names).toEqual([]);
  });

  posixIt("does not follow a symlinked workspace dir out of the repo", async () => {
    const outside = await makeOutside("outsider");
    const globParent = await mkdtemp(join(tmpdir(), "voice-outside-"));
    roots.push(globParent);
    await mkdir(join(globParent, "pkg"));
    await writeFile(join(globParent, "pkg", "package.json"), JSON.stringify({ name: "globbed" }));
    const root = await makeRepo({
      "package.json": { name: "app", workspaces: ["linked", "pkgs/*"] },
    });
    await symlink(outside, join(root, "linked"));
    await symlink(globParent, join(root, "pkgs"));
    expect((await deriveRepoNames(root)).names).toEqual(["app"]);
  });

  posixIt(
    "skips a manifest that is a FIFO or a device without blocking",
    async () => {
      const fifoRoot = await makeRepo({ "package.json": { name: "app", workspaces: ["pipe"] } });
      await mkdir(join(fifoRoot, "pipe"));
      execFileSync("mkfifo", [join(fifoRoot, "pipe", "package.json")]);
      expect((await deriveRepoNames(fifoRoot)).names).toEqual(["app", "pipe"]);

      const deviceRoot = await makeRepo({});
      await symlink("/dev/zero", join(deviceRoot, "package.json"));
      expect((await deriveRepoNames(deviceRoot)).names).toEqual([]);
    },
    2000
  );

  it("rejects a workspace pattern that climbs out with either separator", async () => {
    const parent = await mkdtemp(join(tmpdir(), "voice-parent-"));
    roots.push(parent);
    await mkdir(join(parent, "sibling"));
    await writeFile(join(parent, "sibling", "package.json"), JSON.stringify({ name: "sibling" }));
    await mkdir(join(parent, "repo"));
    await writeFile(
      join(parent, "repo", "package.json"),
      JSON.stringify({
        name: "app",
        workspaces: ["..\\sibling", "../sibling", "packages\\..\\..\\sibling"],
      })
    );
    expect((await deriveRepoNames(join(parent, "repo"))).names).toEqual(["app"]);
  });

  it("stops at the workspace pattern cap even when no pattern finds a package", async () => {
    const missing = (n: number) => Array.from({ length: n }, (_, i) => `missing${i}/*`);
    const withinCap = await makeRepo({
      "package.json": { workspaces: [...missing(MAX_WORKSPACE_PATTERNS - 1), "real"] },
      "real/package.json": { name: "last-in" },
    });
    expect((await deriveRepoNames(withinCap)).names).toContain("last-in");

    const pastCap = await makeRepo({
      "package.json": { workspaces: [...missing(MAX_WORKSPACE_PATTERNS), "real"] },
      "real/package.json": { name: "first-out" },
    });
    expect((await deriveRepoNames(pastCap)).names).not.toContain("first-out");
  });

  it("starts no read once the deadline has passed", async () => {
    const root = await makeRepo({ "package.json": { name: "app" } }, ["electron"]);
    expect((await deriveRepoNames(root, performance.now() - 1)).names).toEqual([]);
  });
});

describe("workspacePatternSegments", () => {
  it("splits on either separator and drops a leading ./", () => {
    expect(workspacePatternSegments("./packages/*")).toEqual(["packages", "*"]);
    expect(workspacePatternSegments("packages\\*")).toEqual(["packages", "*"]);
    expect(workspacePatternSegments("apps/web/")).toEqual(["apps", "web"]);
  });

  it("rejects parent hops, drive letters, absolute paths and deep globs", () => {
    expect(workspacePatternSegments("..\\sibling")).toBeNull();
    expect(workspacePatternSegments("packages\\..\\..\\x")).toBeNull();
    expect(workspacePatternSegments("C:\\elsewhere")).toBeNull();
    expect(workspacePatternSegments("/etc")).toBeNull();
    expect(workspacePatternSegments("\\\\server\\share")).toBeNull();
    expect(workspacePatternSegments("packages/**")).toBeNull();
  });
});

describe("stripPackageScope", () => {
  it("removes a leading scope only", () => {
    expect(stripPackageScope("@daintreehq/plugin-sdk")).toBe("plugin-sdk");
    expect(stripPackageScope("plugin-sdk")).toBe("plugin-sdk");
  });
});

describe("assembleKeyterms repo tier", () => {
  it("adds repository names without exceeding their share or the total", async () => {
    const deps = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`library${"abcdefghij"[i % 10]}${i}x`, "1"])
    );
    const root = await makeRepo({ "package.json": { name: "quartzline", dependencies: deps } });
    const result = await assembleKeyterms({ customDictionary: [], projectPath: root });
    expect(result).toContain("quartzline");
    expect(result.length).toBeLessThanOrEqual(6);
    expect(result.length).toBeLessThanOrEqual(MAX_KEYTERMS);
  });

  it("filters common words from repository names", async () => {
    const root = await makeRepo({ "package.json": { name: "work" } });
    expect(await assembleKeyterms({ customDictionary: [], projectPath: root })).toEqual([]);
  });

  it("ignores a relative project path", async () => {
    expect(await assembleKeyterms({ customDictionary: [], projectPath: "relative/dir" })).toEqual(
      []
    );
  });
});
