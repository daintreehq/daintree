import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  PROJECT_CONTEXT_LIMITS,
  ProjectContextSchema,
} from "../../../../../../shared/elementPicker/projectContext.js";
import type { ProjectFileReader } from "../../fs.js";
import { sveltekitAdapter } from "../adapter.js";
import { sveltekitProjectAdapter } from "../registration.js";
import {
  createFixtureReader,
  createMemoryReader,
  fixtureWorktree,
} from "../__testing__/fixtureReader.js";

const WORKSPACE = "ws-1";

function describeApp(
  worktreePath: string,
  pathname: string,
  {
    appRoot = worktreePath,
    reader = createFixtureReader(),
  }: { appRoot?: string; reader?: ProjectFileReader } = {}
) {
  return sveltekitAdapter.describe({
    workspaceId: WORKSPACE,
    roots: { worktreePath, appRoot },
    pathname,
    reader,
    signal: new AbortController().signal,
  });
}

function filesOf(context: Awaited<ReturnType<typeof describeApp>>) {
  return context.route?.files.map(({ role, file }) => `${role} ${file.path}`) ?? null;
}

describe("the SvelteKit project adapter", () => {
  it("names the files that render a dynamic route, with the data module that feeds it", async () => {
    const context = await describeApp(fixtureWorktree("grouped"), "/blog/hello-world");

    expect(ProjectContextSchema.safeParse(context).success).toBe(true);
    expect(context.route?.routeId).toBe("/blog/[slug]");
    expect(filesOf(context)).toEqual([
      "page src/routes/blog/[slug]/+page.svelte",
      "layout src/routes/+layout.svelte",
      "data src/routes/blog/[slug]/+page.ts",
    ]);
    expect(context.route?.files.every(({ file }) => file.workspaceId === WORKSPACE)).toBe(true);
  });

  it("names no page for an endpoint or for a path no route serves", async () => {
    const worktree = fixtureWorktree("grouped");

    expect((await describeApp(worktree, "/api/health")).route).toBeNull();
    expect((await describeApp(worktree, "/nowhere/at/all")).route).toBeNull();
  });

  it("says where the routes were read from", async () => {
    const context = await describeApp(fixtureWorktree("custom-routes"), "/contact");

    expect(context.routes).toEqual({
      directory: "src/pages",
      source: "svelte.config",
      basePath: "",
      complete: true,
    });
    expect(filesOf(context)).toEqual(["page src/pages/contact/+page.svelte"]);
  });

  it("names no route when the routes directory had to be assumed", async () => {
    const reader = createMemoryReader({
      "/repo/package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } }),
      "/repo/svelte.config.js": "import config from './config.js';\nexport default config;",
      "/repo/src/routes/+page.svelte": "<h1>Home</h1>",
    });

    const context = await describeApp("/repo", "/", { reader });

    expect(context.routes.source).toBe("unresolved");
    expect(context.route).toBeNull();
  });

  it("keeps route files outside the app out of the context", async () => {
    const reader = createMemoryReader({
      "/repo/app/package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } }),
      "/repo/app/svelte.config.js": 'export default { kit: { files: { routes: "../routes" } } };',
      "/repo/routes/+page.svelte": "<h1>Home</h1>",
    });

    const context = await describeApp("/repo", "/", { appRoot: "/repo/app", reader });

    expect(context.routes).toMatchObject({ directory: "routes", source: "svelte.config" });
    expect(context.route).toEqual({ routeId: "/", files: [] });
  });

  it("describes the app it was given in a monorepo, with the toolchain hoisted above it", async () => {
    const worktree = fixtureWorktree("monorepo");
    const context = await describeApp(worktree, "/", { appRoot: join(worktree, "apps", "site") });

    expect(context.appPath).toBe("apps/site");
    expect(filesOf(context)).toEqual(["page apps/site/src/routes/+page.svelte"]);
    expect(context.toolchain.versions.svelte).not.toBeNull();
  });

  it("reports an untested toolchain as a diagnostic, with its routes intact", async () => {
    const context = await describeApp(fixtureWorktree("legacy"), "/");

    expect(context.toolchain.verdict).toBe("untested");
    expect(context.toolchain.reasons.length).toBeGreaterThan(0);
    expect(context.route).not.toBeNull();
  });

  it("separates a missing install from an untested one", async () => {
    const context = await describeApp(fixtureWorktree("missing-install"), "/");

    expect(context.toolchain.verdict).toBe("untested");
    expect(context.toolchain.missingInstall.length).toBeGreaterThan(0);
  });

  it("stays inside the contract when the project hands it strings longer than the contract allows", async () => {
    const segment = "a".repeat(PROJECT_CONTEXT_LIMITS.routeIdLength);
    const range = `^2.0.0 || ${"x".repeat(PROJECT_CONTEXT_LIMITS.reasonLength)}`;
    const reader = createMemoryReader({
      "/repo/package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": range } }),
      "/repo/src/routes/+page.svelte": "<h1>Home</h1>",
      [`/repo/src/routes/${segment}/+page.svelte`]: "<h1>Long</h1>",
    });

    const long = await describeApp("/repo", `/${segment}`, { reader });
    const home = await describeApp("/repo", "/", { reader });

    expect(ProjectContextSchema.safeParse(long).success).toBe(true);
    // Withheld rather than cut short into the id of some other route.
    expect(long.route).toBeNull();
    expect(home.route?.routeId).toBe("/");
    const declared = long.toolchain.reasons.find((reason) => reason.includes("@sveltejs/kit"));
    expect(declared?.endsWith("…")).toBe(true);
  });

  it("ends as an abort rather than as an empty reading", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      sveltekitAdapter.describe({
        workspaceId: WORKSPACE,
        roots: { worktreePath: fixtureWorktree("plain"), appRoot: fixtureWorktree("plain") },
        pathname: "/",
        reader: createFixtureReader(),
        signal: controller.signal,
      })
    ).rejects.toBeDefined();
  });
});

describe("the SvelteKit adapter registration", () => {
  it("detects an app that declares Kit, and nothing else", () => {
    expect(sveltekitProjectAdapter.detects({ devDependencies: { "@sveltejs/kit": "^2" } })).toBe(
      true
    );
    expect(sveltekitProjectAdapter.detects({ dependencies: { "@sveltejs/kit": "^2" } })).toBe(true);
    expect(sveltekitProjectAdapter.detects({ devDependencies: { svelte: "^5", vite: "^7" } })).toBe(
      false
    );
    expect(sveltekitProjectAdapter.detects({})).toBe(false);
  });

  it("loads the adapter it describes", async () => {
    await expect(sveltekitProjectAdapter.load()).resolves.toBe(sveltekitAdapter);
  });
});
