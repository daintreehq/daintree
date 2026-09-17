import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { SUPPORTED_BASELINE } from "../model.js";
import {
  assessSupport,
  detectInstallStyle,
  majorVersion,
  readInstalledVersionReport,
  readInstalledVersions,
} from "../project/versions.js";
import { declaredDependencies } from "../project/discovery.js";
import { readJsonFile } from "../project/fs.js";
import {
  createFixtureReader,
  createMemoryReader,
  fixtureWorktree,
} from "../project/__testing__/fixtureReader.js";

const reader = createFixtureReader();

async function declaredOf(appRoot: string): Promise<Record<string, string>> {
  const manifest = await readJsonFile(reader, join(appRoot, "package.json"));
  return manifest ? declaredDependencies(manifest) : {};
}

describe("readInstalledVersions", () => {
  it("reads the resolved version rather than the declared range", async () => {
    const worktree = fixtureWorktree("plain");
    const versions = await readInstalledVersions(reader, worktree, worktree);
    const declared = await declaredOf(worktree);

    for (const [key, pkg] of [
      ["svelte", "svelte"],
      ["kit", "@sveltejs/kit"],
      ["tailwind", "tailwindcss"],
      ["vite", "vite"],
    ] as const) {
      expect(versions[key]).not.toBeNull();
      expect(versions[key]).not.toBe(declared[pkg]);
      expect(versions[key]).not.toMatch(/^[\^~]/);
    }
  });

  it("finds a hoisted install from a workspace app that has no node_modules of its own", async () => {
    const worktree = fixtureWorktree("monorepo");
    const appRoot = join(worktree, "apps", "site");

    const fromApp = await readInstalledVersions(reader, appRoot, worktree);
    const fromRoot = await readInstalledVersions(reader, worktree, worktree);

    expect(fromApp).toEqual(fromRoot);
    expect(fromApp.svelte).not.toBeNull();
  });

  it("does not climb above the worktree root", async () => {
    const worktree = fixtureWorktree("monorepo");
    const appRoot = join(worktree, "apps", "site");

    const contained = await readInstalledVersions(reader, appRoot, appRoot);

    expect(contained.svelte).toBeNull();
    expect(contained.kit).toBeNull();
  });

  it("reports a package that is declared but not installed as absent", async () => {
    const worktree = fixtureWorktree("missing-install");
    const versions = await readInstalledVersions(reader, worktree, worktree);

    expect(versions.tailwind).toBeNull();
    expect(versions.kit).toBeNull();
    expect(versions.svelte).not.toBeNull();
  });
});

describe("majorVersion", () => {
  it("reads a major out of the forms npm actually writes", () => {
    expect(majorVersion("5.0.0-next.42")).toBe(5);
    expect(majorVersion("v4.1.2")).toBe(4);
    expect(majorVersion("11")).toBe(11);
  });

  it("refuses to invent one for a non-version specifier", () => {
    expect(majorVersion("workspace:*")).toBeNull();
    expect(majorVersion("link:../svelte")).toBeNull();
    expect(majorVersion(null)).toBeNull();
  });

  it("validates the whole version, not just its first digits", () => {
    expect(majorVersion("5.garbage")).toBeNull();
    expect(majorVersion("5.0.0 (patched)")).toBeNull();
    expect(majorVersion("5.0.0+build.7")).toBe(5);
  });
});

describe("assessSupport", () => {
  it("grants full support only when every gated package clears its floor", async () => {
    const worktree = fixtureWorktree("plain");
    const assessment = assessSupport(
      await readInstalledVersions(reader, worktree, worktree),
      await declaredOf(worktree)
    );

    expect(assessment.verdict.level).toBe("full");
    expect(assessment.missingInstall).toEqual([]);
  });

  it("names the package and the version found for every gated package below its major", async () => {
    const worktree = fixtureWorktree("legacy");
    const versions = await readInstalledVersions(reader, worktree, worktree);
    const assessment = assessSupport(versions, await declaredOf(worktree));

    expect(assessment.verdict.level).toBe("preview-only");
    const reasons = assessment.verdict.level === "preview-only" ? assessment.verdict.reasons : [];
    expect(reasons).toHaveLength(2);
    expect(reasons.some((text) => text.startsWith("tailwindcss "))).toBe(false);
    for (const [pkg, found] of [
      ["svelte", versions.svelte],
      ["@sveltejs/kit", versions.kit],
    ] as const) {
      const reason = reasons.find((text) => text.startsWith(`${pkg} `));
      expect(reason).toBeDefined();
      expect(reason).toContain(String(found));
    }
  });

  it("does not gate on vite, which the baseline sets no floor for", async () => {
    const worktree = fixtureWorktree("plain");
    const versions = await readInstalledVersions(reader, worktree, worktree);
    const assessment = assessSupport({ ...versions, vite: "2.0.0" }, await declaredOf(worktree));

    expect(assessment.verdict.level).toBe("full");
  });

  it("gates on each package's supported major, above as well as below", () => {
    const declared = { svelte: "^5", "@sveltejs/kit": "^2", tailwindcss: "^4" };
    const atFloor = assessSupport(
      {
        svelte: `${SUPPORTED_BASELINE.svelteMajor}.0.0`,
        kit: `${SUPPORTED_BASELINE.kitMajor}.0.0`,
        tailwind: `${SUPPORTED_BASELINE.tailwindMajor}.0.0`,
        vite: null,
      },
      declared
    );
    const oneBelow = assessSupport(
      {
        svelte: `${SUPPORTED_BASELINE.svelteMajor - 1}.9.9`,
        kit: `${SUPPORTED_BASELINE.kitMajor}.0.0`,
        tailwind: `${SUPPORTED_BASELINE.tailwindMajor}.0.0`,
        vite: null,
      },
      declared
    );

    const oneAbove = assessSupport(
      {
        svelte: `${SUPPORTED_BASELINE.svelteMajor + 1}.0.0`,
        kit: `${SUPPORTED_BASELINE.kitMajor}.0.0`,
        tailwind: `${SUPPORTED_BASELINE.tailwindMajor}.0.0`,
        vite: null,
      },
      declared
    );
    const kitAbove = assessSupport(
      {
        svelte: `${SUPPORTED_BASELINE.svelteMajor}.0.0`,
        kit: `${SUPPORTED_BASELINE.kitMajor + 1}.0.0`,
        tailwind: null,
        vite: null,
      },
      declared
    );

    expect(atFloor.verdict.level).toBe("full");
    expect(oneBelow.verdict.level).toBe("preview-only");
    expect(oneAbove.verdict.level).toBe("preview-only");
    expect(kitAbove.verdict.level).toBe("preview-only");
    const reasons = oneAbove.verdict.level === "preview-only" ? oneAbove.verdict.reasons : [];
    expect(reasons[0]).toMatch(/newer than direct editing supports/);
  });

  it("does not let Tailwind decide direct editing: classes are written exactly as typed", () => {
    const declared = { svelte: "^5", "@sveltejs/kit": "^2", tailwindcss: "^3" };
    const tailwind3 = assessSupport(
      { svelte: "5.0.0", kit: "2.0.0", tailwind: "3.4.17", vite: null },
      declared
    );
    const notInstalled = assessSupport(
      { svelte: "5.0.0", kit: "2.0.0", tailwind: null, vite: null },
      declared
    );

    expect(tailwind3.verdict.level).toBe("full");
    expect(notInstalled.verdict.level).toBe("full");
  });

  it("separates 'not installed' from 'too old', because the remedy differs", async () => {
    const worktree = fixtureWorktree("missing-install");
    const assessment = assessSupport(
      await readInstalledVersions(reader, worktree, worktree),
      await declaredOf(worktree)
    );

    expect(assessment.missingInstall).toEqual(["kit"]);
    const reasons = assessment.verdict.level === "preview-only" ? assessment.verdict.reasons : [];
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/install/i);
  });

  it("treats an app without Tailwind as fully supported, and an undeclared Svelte as not", () => {
    const plainCss = assessSupport(
      { svelte: "5.0.0", kit: "2.0.0", tailwind: null, vite: "7.0.0" },
      { svelte: "^5", "@sveltejs/kit": "^2" }
    );
    expect(plainCss.missingInstall).toEqual([]);
    expect(plainCss.verdict.level).toBe("full");

    const noSvelte = assessSupport(
      { svelte: null, kit: "2.0.0", tailwind: "4.0.0", vite: "7.0.0" },
      { "@sveltejs/kit": "^2", tailwindcss: "^4" }
    );
    expect(noSvelte.missingInstall).toEqual([]);
    const reasons = noSvelte.verdict.level === "preview-only" ? noSvelte.verdict.reasons : [];
    expect(reasons[0]).toContain("not a dependency");
  });

  it("does not trust a node_modules copy that Plug'n'Play would not resolve", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": "{}",
      "/repo/.pnp.cjs": "// yarn pnp runtime",
    });
    const installStyle = await detectInstallStyle(memory, "/repo", "/repo");

    // A stale node_modules from a previous linker is not what the app loads.
    const assessment = assessSupport(
      { svelte: "5.2.0", kit: "2.15.0", tailwind: "4.0.0", vite: "7.0.0" },
      { svelte: "^5", "@sveltejs/kit": "^2", tailwindcss: "^4" },
      { installStyle }
    );

    expect(assessment.verdict.level).toBe("preview-only");
    expect(assessment.missingInstall).toEqual([]);
  });

  it("stops at an unreadable nearer package rather than reporting an outer one", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": "{}",
      "/repo/node_modules/svelte/package.json": '{"name":"svelte","version":"5.9.0"}',
      "/repo/apps/site/package.json": "{}",
      "/repo/apps/site/node_modules/svelte/package.json": "{ this is not json",
    });

    const report = await readInstalledVersionReport(memory, "/repo/apps/site", "/repo");
    const assessment = assessSupport(
      report.versions,
      { svelte: "^5", "@sveltejs/kit": "^2", tailwindcss: "^4" },
      { resolutions: report.resolutions }
    );

    expect(report.versions.svelte).toBeNull();
    expect(report.resolutions.svelte).toBe("unresolved");
    expect(report.resolutions.kit).toBe("absent");
    expect(assessment.missingInstall).not.toContain("svelte");
    const reasons = assessment.verdict.level === "preview-only" ? assessment.verdict.reasons : [];
    expect(
      reasons.some((reason) => reason.startsWith("svelte ") && /could not be read/.test(reason))
    ).toBe(true);
  });

  it("prefers an app-local install over the hoisted one", async () => {
    const memory = createMemoryReader({
      "/repo/node_modules/svelte/package.json": '{"name":"svelte","version":"5.9.0"}',
      "/repo/apps/site/node_modules/svelte/package.json": '{"name":"svelte","version":"4.2.19"}',
    });

    const report = await readInstalledVersionReport(memory, "/repo/apps/site", "/repo");

    expect(report.versions.svelte).toBe("4.2.19");
  });

  it("does not tell a Plug'n'Play project to run install", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": "{}",
      "/repo/.pnp.cjs": "// yarn pnp runtime",
      "/repo/.yarnrc.yml": "nodeLinker: pnp\n",
    });
    const installStyle = await detectInstallStyle(memory, "/repo", "/repo");
    const declared = { svelte: "^5", "@sveltejs/kit": "^2", tailwindcss: "^4" };

    const pnp = assessSupport(
      { svelte: null, kit: null, tailwind: null, vite: null },
      declared,
      installStyle
    );
    const plain = assessSupport({ svelte: null, kit: null, tailwind: null, vite: null }, declared);

    expect(installStyle).toBe("pnp");
    expect(pnp.verdict.level).toBe("preview-only");
    expect(pnp.missingInstall).toEqual([]);
    expect(plain.missingInstall).toHaveLength(2);
    const reasons = pnp.verdict.level === "preview-only" ? pnp.verdict.reasons : [];
    expect(reasons).toHaveLength(2);
    expect(reasons.every((reason) => !/install dependencies/i.test(reason))).toBe(true);
  });

  it("refuses full support when a version cannot be read as a major", () => {
    const assessment = assessSupport(
      { svelte: "workspace:*", kit: "2.0.0", tailwind: "4.0.0", vite: null },
      { svelte: "workspace:*" }
    );

    expect(assessment.verdict.level).toBe("preview-only");
    expect(assessment.missingInstall).toEqual([]);
  });
});
