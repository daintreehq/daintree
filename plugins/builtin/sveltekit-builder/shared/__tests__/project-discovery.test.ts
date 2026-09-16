import { describe, expect, it } from "vitest";
import { discoverSvelteKitApps, findSvelteKitApps, selectApp } from "../project/discovery.js";
import {
  createFixtureReader,
  createMemoryReader,
  fixtureWorktree,
} from "../project/__testing__/fixtureReader.js";

const reader = createFixtureReader();

describe("findSvelteKitApps", () => {
  it("reports a single-app repo with the app root equal to the worktree root", async () => {
    const worktree = fixtureWorktree("plain");
    const apps = await findSvelteKitApps(reader, worktree);

    expect(apps).toHaveLength(1);
    expect(apps[0]?.appRoot).toBe(worktree);
    expect(apps[0]?.relativePath).toBe(".");
    expect(apps[0]?.packageName).toBe("plain-site");
  });

  it("finds every app in a monorepo and skips workspace packages that are not SvelteKit", async () => {
    const apps = await findSvelteKitApps(reader, fixtureWorktree("monorepo"));

    expect(apps.map((app) => app.packageName)).toEqual(["@acme/docs", "@acme/site"]);
    expect(apps.map((app) => app.relativePath)).toEqual(["apps/docs", "apps/site"]);
  });

  it("keeps the app root distinct from the worktree root", async () => {
    const worktree = fixtureWorktree("monorepo");
    const apps = await findSvelteKitApps(reader, worktree);

    for (const app of apps) {
      expect(app.appRoot.startsWith(worktree)).toBe(true);
      expect(app.appRoot).not.toBe(worktree);
    }
  });

  it("does not descend into installs or build output", async () => {
    const manifest = JSON.stringify({ name: "buried", devDependencies: { "@sveltejs/kit": "^2" } });
    const memory = createMemoryReader({
      "/repo/node_modules/some-dep/package.json": manifest,
      "/repo/node_modules/some-dep/src/routes/+page.svelte": "<p />",
      "/repo/.svelte-kit/generated/package.json": manifest,
      "/repo/dist/package.json": manifest,
      "/repo/build/package.json": manifest,
      "/repo/.git/package.json": manifest,
      "/repo/apps/real/package.json": manifest,
    });

    const apps = await findSvelteKitApps(memory, "/repo");

    expect(apps.map((app) => app.appRoot)).toEqual(["/repo/apps/real"]);
  });

  it("stops at the depth bound instead of walking an arbitrarily deep tree", async () => {
    const manifest = JSON.stringify({ name: "deep", devDependencies: { "@sveltejs/kit": "^2" } });
    const memory = createMemoryReader({
      "/repo/a/package.json": manifest,
      "/repo/a/b/c/package.json": manifest,
    });

    const shallow = await findSvelteKitApps(memory, "/repo", { maxDepth: 1 });
    const deep = await findSvelteKitApps(memory, "/repo", { maxDepth: 3 });

    expect(shallow.map((app) => app.appRoot)).toEqual(["/repo/a"]);
    expect(deep.map((app) => app.appRoot)).toEqual(["/repo/a", "/repo/a/b/c"]);
  });

  it("records the declared range as evidence without treating it as a version", async () => {
    const apps = await findSvelteKitApps(reader, fixtureWorktree("legacy"));

    expect(apps[0]?.declaredKitRange.startsWith("^")).toBe(true);
  });
});

describe("discoverSvelteKitApps", () => {
  it("reports a truncated scan so a partial list cannot pass for the whole tree", async () => {
    const manifest = JSON.stringify({ name: "deep", devDependencies: { "@sveltejs/kit": "^2" } });
    const memory = createMemoryReader({
      "/repo/a/package.json": manifest,
      "/repo/a/b/c/package.json": manifest,
    });

    const truncated = await discoverSvelteKitApps(memory, "/repo", { maxDepth: 1 });
    const whole = await discoverSvelteKitApps(memory, "/repo", { maxDepth: 3 });

    expect(truncated.complete).toBe(false);
    expect(whole.complete).toBe(true);
    // One app found, but another lies past the cutoff: not "the only app".
    expect(truncated.apps).toHaveLength(1);
    expect(selectApp(truncated)).toBeNull();
    expect(selectApp({ ...truncated, complete: true })).not.toBeNull();
  });

  it("still honours an app the caller named on a truncated scan", async () => {
    const manifest = JSON.stringify({ name: "deep", devDependencies: { "@sveltejs/kit": "^2" } });
    const memory = createMemoryReader({
      "/repo/a/package.json": manifest,
      "/repo/a/b/c/package.json": manifest,
    });

    const truncated = await discoverSvelteKitApps(memory, "/repo", { maxDepth: 1 });

    expect(selectApp(truncated, "/repo/a")?.appRoot).toBe("/repo/a");
  });
});

describe("selectApp", () => {
  it("auto-selects only when there is nothing to choose between", async () => {
    const apps = await findSvelteKitApps(reader, fixtureWorktree("monorepo"));

    expect(selectApp(apps)).toBeNull();
    expect(selectApp(apps, apps[1]?.appRoot)?.packageName).toBe("@acme/site");
    expect(selectApp(apps, "/not/an/app")).toBeNull();
    expect(selectApp(apps.slice(0, 1))?.packageName).toBe("@acme/docs");
  });
});
