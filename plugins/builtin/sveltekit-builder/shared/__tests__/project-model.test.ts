import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ProjectModelResultSchema } from "../protocol.js";
import { inspectProject, inspectWorktree } from "../project/index.js";
import { createFixtureReader, fixtureWorktree } from "../project/__testing__/fixtureReader.js";

const reader = createFixtureReader();

describe("inspectProject", () => {
  it("produces a model the frozen wire schema accepts", async () => {
    const worktree = fixtureWorktree("plain");
    const { model } = await inspectProject(reader, { worktreeRoot: worktree, appRoot: worktree });

    expect(() => ProjectModelResultSchema.parse(model)).not.toThrow();
    expect(model.support.level).toBe("full");
    expect(model.packageManager).toBe("npm");
    expect(model.routes.map((route) => route.routeId)).toEqual(["/", "/about"]);
  });

  it("reports a below-baseline app as previewable, with its routes intact", async () => {
    const worktree = fixtureWorktree("legacy");
    const { model, support } = await inspectProject(reader, {
      worktreeRoot: worktree,
      appRoot: worktree,
    });

    expect(() => ProjectModelResultSchema.parse(model)).not.toThrow();
    expect(model.support.level).toBe("preview-only");
    expect(support.missingInstall).toEqual([]);
    expect(model.routes).toHaveLength(1);
  });

  it("keeps the app root and the worktree root as separate identities", async () => {
    const worktree = fixtureWorktree("monorepo");
    const appRoot = join(worktree, "apps", "site");
    const { model } = await inspectProject(reader, { worktreeRoot: worktree, appRoot });

    expect(model.appRoot).toBe(appRoot);
    expect(model.routes[0]?.pageFile).toBe("apps/site/src/routes/+page.svelte");
  });
});

describe("inspectWorktree", () => {
  it("inspects the only app without being told which one it is", async () => {
    const worktree = fixtureWorktree("plain");
    const { apps, inspection } = await inspectWorktree(reader, worktree);

    expect(apps).toHaveLength(1);
    expect(inspection?.model.appRoot).toBe(worktree);
    expect(inspection?.app?.packageName).toBe("plain-site");
  });

  it("refuses to choose between two apps in a monorepo", async () => {
    const { apps, inspection } = await inspectWorktree(reader, fixtureWorktree("monorepo"));

    expect(apps).toHaveLength(2);
    expect(inspection).toBeNull();
  });

  it("inspects the named app and resolves its hoisted toolchain", async () => {
    const worktree = fixtureWorktree("monorepo");
    const appRoot = join(worktree, "apps", "docs");
    const { inspection } = await inspectWorktree(reader, worktree, appRoot);

    expect(inspection?.app?.packageName).toBe("@acme/docs");
    expect(inspection?.model.packageManager).toBe("pnpm");
    expect(inspection?.model.support.level).toBe("full");
    expect(inspection?.model.versions.svelte).not.toBeNull();
  });

  it("carries the install-versus-unsupported distinction out of the model", async () => {
    const worktree = fixtureWorktree("missing-install");
    const { inspection } = await inspectWorktree(reader, worktree);

    expect(inspection?.model.support.level).toBe("preview-only");
    expect(inspection?.support.missingInstall).toEqual(["kit"]);
    expect(inspection?.packageManager.name).toBe("unknown");
  });

  it("says whether the routes directory was read or assumed", async () => {
    const custom = await inspectWorktree(reader, fixtureWorktree("custom-routes"));
    const plain = await inspectWorktree(reader, fixtureWorktree("plain"));

    expect(custom.inspection?.routesDirectory.source).toBe("svelte.config");
    expect(plain.inspection?.routesDirectory.source).toBe("default");
  });
});
