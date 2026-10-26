import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveRepoNames, stripPackageScope } from "../voiceRepoKeyterms.js";
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
