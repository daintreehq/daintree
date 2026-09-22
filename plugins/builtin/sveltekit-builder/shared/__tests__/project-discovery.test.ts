import { describe, expect, it } from "vitest";
import { discoverSvelteKitApps, findSvelteKitApps, selectApp } from "../project/discovery.js";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_METADATA_BYTES,
  type ProjectFileReader,
} from "../project/fs.js";
import {
  createFixtureReader,
  createMemoryReader,
  fixtureWorktree,
} from "../project/__testing__/fixtureReader.js";

const reader = createFixtureReader();

const KIT_MANIFEST = JSON.stringify({ name: "app", devDependencies: { "@sveltejs/kit": "^2" } });

/**
 * A memory tree behind the bounded read the production reader supplies:
 * refusals come from the read itself, and `pipes` stand in for the paths whose
 * opened descriptor turns out not to be a regular file.
 */
function createBoundedReader(
  files: Record<string, string>,
  pipes: readonly string[] = []
): ProjectFileReader {
  const memory = createMemoryReader(files);
  return {
    ...memory,
    async readBoundedText(path, { limitBytes, signal }) {
      signal?.throwIfAborted();
      if (pipes.includes(path)) return { status: "not-a-file" };
      let text: string;
      try {
        text = await memory.readFile(path);
      } catch {
        return { status: "missing" };
      }
      return text.length > limitBytes ? { status: "too-large" } : { status: "ok", text };
    },
  };
}

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

  it("does not descend into installs, build output or hidden scratch directories", async () => {
    const manifest = JSON.stringify({ name: "buried", devDependencies: { "@sveltejs/kit": "^2" } });
    const memory = createMemoryReader({
      "/repo/node_modules/some-dep/package.json": manifest,
      "/repo/node_modules/some-dep/src/routes/+page.svelte": "<p />",
      "/repo/.svelte-kit/generated/package.json": manifest,
      "/repo/dist/package.json": manifest,
      "/repo/build/package.json": manifest,
      "/repo/.git/package.json": manifest,
      "/repo/.tmp/performance/baseline-source/package.json": manifest,
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

describe("a scan is bounded by what it reads, not only by how far it walks", () => {
  it("refuses a manifest past the metadata cap instead of parsing it", async () => {
    // Padding inside an ignored field: the JSON is valid and declares SvelteKit,
    // so only the byte cap can keep it out.
    const huge = JSON.stringify({
      name: "huge",
      description: "x".repeat(MAX_METADATA_BYTES),
      devDependencies: { "@sveltejs/kit": "^2" },
    });
    const bounded = createBoundedReader({
      "/repo/huge/package.json": huge,
      "/repo/small/package.json": KIT_MANIFEST,
    });

    const apps = await findSvelteKitApps(bounded, "/repo");

    expect(apps.map((app) => app.appRoot)).toEqual(["/repo/small"]);
  });

  it("refuses an oversized manifest even through a reader with no bounded read", async () => {
    // The fallback measures after the read rather than during it, which is all
    // a fixture tree or a proxied host can offer — but it still refuses.
    const memory = createMemoryReader({
      "/repo/huge/package.json": JSON.stringify({
        name: "huge",
        description: "x".repeat(MAX_METADATA_BYTES),
        devDependencies: { "@sveltejs/kit": "^2" },
      }),
    });

    expect(await findSvelteKitApps(memory, "/repo")).toEqual([]);
  });

  it("never treats a package.json that is not a regular file as an app", async () => {
    // A FIFO named `package.json` reads as whatever its writer feels like
    // sending, for as long as it likes. The walk past it must carry on.
    const bounded = createBoundedReader(
      { "/repo/pipe/package.json": KIT_MANIFEST, "/repo/real/package.json": KIT_MANIFEST },
      ["/repo/pipe/package.json"]
    );

    const apps = await findSvelteKitApps(bounded, "/repo");

    expect(apps.map((app) => app.appRoot)).toEqual(["/repo/real"]);
  });

  it("caps the entries one directory listing contributes and says the scan is partial", async () => {
    const memory = createMemoryReader({ "/repo/package.json": KIT_MANIFEST });
    const crowded: ProjectFileReader = {
      ...memory,
      async readdir(path) {
        if (path !== "/repo") return [];
        return Array.from({ length: MAX_DIRECTORY_ENTRIES + 10 }, (_, index) => ({
          name: `d${index}`,
          isDirectory: true,
          isFile: false,
        }));
      },
    };

    const discovery = await discoverSvelteKitApps(crowded, "/repo", { maxDirectories: 10 });

    expect(discovery.complete).toBe(false);
  });

  it("calls a directory it could not list a partial scan, not an empty one", async () => {
    const memory = createMemoryReader({
      "/repo/apps/site/package.json": KIT_MANIFEST,
      "/repo/private/keep": "",
    });
    const unreadable: ProjectFileReader = {
      ...memory,
      async readdir(path, options) {
        if (path === "/repo/private") throw new Error("EACCES: permission denied");
        return memory.readdir(path, options);
      },
    };

    const discovery = await discoverSvelteKitApps(unreadable, "/repo");

    // The app that was readable is still reported; what is missing is the claim
    // that nothing else is there.
    expect(discovery.apps.map((app) => app.appRoot)).toEqual(["/repo/apps/site"]);
    expect(discovery.complete).toBe(false);
  });

  it("descends into a directory a listing describes as neither file nor directory", async () => {
    const memory = createMemoryReader({
      "/repo/apps/site/package.json": KIT_MANIFEST,
    });
    // The shape production `host.fs` returns for a symlink: a monorepo whose
    // `apps/site` is a link would otherwise be skipped, and the scan would call
    // itself complete having never looked.
    const opaque: ProjectFileReader = {
      ...memory,
      async readdir(path, options) {
        const entries = await memory.readdir(path, options);
        return entries.map((entry) =>
          entry.name === "site" ? { name: entry.name, isDirectory: false, isFile: false } : entry
        );
      },
    };

    const discovery = await discoverSvelteKitApps(opaque, "/repo");

    expect(discovery.apps.map((app) => app.appRoot)).toEqual(["/repo/apps/site"]);
    expect(discovery.complete).toBe(true);
  });

  it("counts an entry it could not stat as a subtree it never read", async () => {
    const memory = createMemoryReader({ "/repo/apps/site/package.json": KIT_MANIFEST });
    const broken: ProjectFileReader = {
      ...memory,
      async readdir(path, options) {
        const entries = await memory.readdir(path, options);
        return entries.map((entry) =>
          entry.name === "site" ? { name: entry.name, isDirectory: false, isFile: false } : entry
        );
      },
      async stat(path, options) {
        if (path === "/repo/apps/site") throw new Error("ELOOP: too many symbolic links");
        return memory.stat(path, options);
      },
    };

    const discovery = await discoverSvelteKitApps(broken, "/repo");

    expect(discovery.apps).toEqual([]);
    expect(discovery.complete).toBe(false);
  });
});

describe("closing the workspace stops the scan", () => {
  it("abandons the walk rather than reading every remaining directory", async () => {
    const controller = new AbortController();
    const files: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1)
      files[`/repo/d${index}/package.json`] = KIT_MANIFEST;
    const bounded = createBoundedReader(files);
    let reads = 0;
    const counted: ProjectFileReader = {
      ...bounded,
      async readBoundedText(path, options) {
        reads += 1;
        // The close lands while the scan is in flight, as it does when a view
        // goes away mid-walk.
        if (reads === 3) controller.abort();
        return bounded.readBoundedText!(path, options);
      },
    };

    await expect(
      discoverSvelteKitApps(counted, "/repo", { signal: controller.signal })
    ).rejects.toThrow(/abort/i);
    expect(reads).toBeLessThan(10);
  });

  it("reports an aborted read as an abort, never as a missing file", async () => {
    // Swallowing it would leave the walk running to the end of the tree,
    // reading nothing and reporting an empty worktree.
    const bounded = createBoundedReader({ "/repo/a/package.json": KIT_MANIFEST });

    await expect(
      discoverSvelteKitApps(bounded, "/repo", { signal: AbortSignal.abort() })
    ).rejects.toThrow(/abort/i);
  });
});
