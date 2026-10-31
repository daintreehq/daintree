import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { load } from "js-yaml";

// Regression guard for #15625: the publish composite ran a second, unpinned
// `npm install js-yaml semver` after the locked install. A bare `npm install
// <pkg>` re-resolves that package from the registry even with `--no-save`, so
// the version gate and the R2 verify scripts ran whatever the registry served
// inside the caret range rather than the reviewed lockfile versions. Release
// workflows never run on a PR, so these structural assertions are the only
// enforcement in CI.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

const action = load(read(".github/actions/publish-daintree/action.yml"));
const steps = action.runs.steps;
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));

const PACKAGE_MANAGER_CALL = /\b(npm\s+(install|i|add|ci|update|exec)|npx|yarn|pnpm)\b/;

const scriptsRunByAction = () =>
  steps.flatMap((s) =>
    [...(s.run ?? "").matchAll(/\bnode\s+(scripts\/\S+\.mjs)/g)].map((m) => m[1])
  );

const bareImports = (source) =>
  [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith(".") && !spec.startsWith("node:"))
    .map((spec) =>
      spec
        .split("/")
        .slice(0, spec.startsWith("@") ? 2 : 1)
        .join("/")
    );

describe("publish-daintree composite (#15625)", () => {
  it("installs packages only through the locked setup-node-install step", () => {
    const installs = steps.filter((s) => s.uses === "./.github/actions/setup-node-install");
    expect(installs).toHaveLength(1);
    expect(installs[0].with?.install_args ?? "").not.toMatch(/--omit|--only|--production/);

    for (const step of steps) {
      expect(step.run ?? "", `step "${step.name}"`).not.toMatch(PACKAGE_MANAGER_CALL);
    }
  });

  it("installs through `npm ci` before any gate or verify script runs", () => {
    const setup = load(read(".github/actions/setup-node-install/action.yml"));
    const install = setup.runs.steps.find((s) => s.name === "Install dependencies");
    expect(install.run).toContain("node scripts/ci/npm-ci-retry.mjs");
    expect(read("scripts/ci/npm-ci-retry.mjs")).toContain('const npmArgs = ["ci"');

    const installIdx = steps.findIndex((s) => s.uses === "./.github/actions/setup-node-install");
    const firstScriptIdx = steps.findIndex((s) => /\bnode\s+scripts\//.test(s.run ?? ""));
    expect(firstScriptIdx).toBeGreaterThan(installIdx);
  });

  it("resolves every package the composite's scripts import from the lockfile", () => {
    const scripts = scriptsRunByAction();
    expect(scripts).toContain("scripts/ci/check-version-monotonic.mjs");

    const imported = new Set(scripts.flatMap((script) => bareImports(read(script))));
    expect([...imported]).toEqual(expect.arrayContaining(["js-yaml", "semver"]));

    for (const name of imported) {
      const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      expect(declared, `${name} declared in package.json`).toBeDefined();
      expect(lock.packages[`node_modules/${name}`]?.version, `${name} locked`).toBeDefined();
    }
  });
});
