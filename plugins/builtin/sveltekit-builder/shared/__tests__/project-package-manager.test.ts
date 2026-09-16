import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { detectPackageManager } from "../project/packageManager.js";
import {
  createFixtureReader,
  createMemoryReader,
  fixtureWorktree,
} from "../project/__testing__/fixtureReader.js";

const reader = createFixtureReader();
const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", ...extra });

describe("detectPackageManager", () => {
  it("prefers the declared packageManager field over any lockfile", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": manifest({ packageManager: "pnpm@9.12.0" }),
      "/repo/package-lock.json": "{}",
    });

    const detection = await detectPackageManager(memory, "/repo", "/repo");

    expect(detection.name).toBe("pnpm");
    expect(detection.evidence[0]).toContain("packageManager");
  });

  it("lets the nearest declaration win in a workspace", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": manifest({ packageManager: "pnpm@9.0.0" }),
      "/repo/apps/site/package.json": manifest({ packageManager: "yarn@4.1.0" }),
    });

    const nested = await detectPackageManager(memory, "/repo/apps/site", "/repo");
    const root = await detectPackageManager(memory, "/repo", "/repo");

    expect(nested.name).toBe("yarn");
    expect(root.name).toBe("pnpm");
  });

  it("inherits the root declaration when the app declares nothing", async () => {
    const worktree = fixtureWorktree("monorepo");

    const detection = await detectPackageManager(reader, join(worktree, "apps", "site"), worktree);

    expect(detection.name).toBe("pnpm");
  });

  it("falls back to a lockfile when nothing is declared", async () => {
    const plain = fixtureWorktree("plain");
    const grouped = fixtureWorktree("grouped");
    const custom = fixtureWorktree("custom-routes");

    expect((await detectPackageManager(reader, plain, plain)).name).toBe("npm");
    expect((await detectPackageManager(reader, grouped, grouped)).name).toBe("pnpm");
    expect((await detectPackageManager(reader, custom, custom)).name).toBe("yarn");
  });

  it("treats a workspace file and a matching lockfile as agreement", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": manifest({}),
      "/repo/pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "/repo/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "/repo/apps/site/package.json": manifest({}),
    });

    const detection = await detectPackageManager(memory, "/repo/apps/site", "/repo");

    expect(detection.name).toBe("pnpm");
    expect(detection.conflict).toEqual([]);
  });

  it("returns unknown, with the conflicting evidence, rather than guessing", async () => {
    const twoLockfiles = createMemoryReader({
      "/repo/package.json": manifest({}),
      "/repo/package-lock.json": "{}",
      "/repo/yarn.lock": "# yarn lockfile v1\n",
    });
    const workspaceDisagrees = createMemoryReader({
      "/repo/package.json": manifest({}),
      "/repo/pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "/repo/yarn.lock": "# yarn lockfile v1\n",
    });

    const first = await detectPackageManager(twoLockfiles, "/repo", "/repo");
    const second = await detectPackageManager(workspaceDisagrees, "/repo", "/repo");

    expect(first.name).toBe("unknown");
    expect(first.conflict).toHaveLength(2);
    expect(second.name).toBe("unknown");
    expect(second.conflict).toHaveLength(2);
  });

  it("uses the nearest directory that has any lockfile at all", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": manifest({}),
      "/repo/yarn.lock": "# yarn lockfile v1\n",
      "/repo/apps/site/package.json": manifest({}),
      "/repo/apps/site/bun.lockb": "binary",
    });

    const detection = await detectPackageManager(memory, "/repo/apps/site", "/repo");

    expect(detection.name).toBe("bun");
  });

  it("is unknown when there is no evidence, without a conflict to report", async () => {
    const memory = createMemoryReader({ "/repo/package.json": manifest({}) });

    const detection = await detectPackageManager(memory, "/repo", "/repo");

    expect(detection.name).toBe("unknown");
    expect(detection.conflict).toEqual([]);
    expect(detection.evidence).toEqual([]);
  });

  it("treats a declaration it does not recognise as evidence, not as silence", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": manifest({ packageManager: "deno@2.0.0" }),
      "/repo/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const detection = await detectPackageManager(memory, "/repo", "/repo");

    // The lockfile says pnpm and the project says something else entirely.
    // That is a question for the user, not a reason to run the wrong tool.
    expect(detection.name).toBe("unknown");
    expect(detection.conflict[0]).toContain("deno@2.0.0");
  });
});
