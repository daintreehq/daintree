import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { isBuiltin } from "module";
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

const SETUP_NODE_INSTALL = "./.github/actions/setup-node-install";

// Any package-manager token, not only `npm install`: `npm --no-save install x`
// puts its options before the subcommand.
const PACKAGE_MANAGER = /\b(npm|npx|yarn|pnpm|corepack|bun)\b/;

const NODE_SCRIPT = /\bnode\s[^\n]*?["']?(?:\.\/)?(scripts\/[^\s"']+\.[mc]?js)\b/;

// Every `node` line must name a repo script, so an invocation this parser can't
// read fails the guard instead of escaping the import check.
const scriptsRunByAction = () =>
  steps
    .flatMap((s) => (s.run ?? "").split("\n"))
    .filter((line) => /\bnode\s/.test(line))
    .map((line) => {
      const match = line.match(NODE_SCRIPT);
      expect(match, `node invocation "${line.trim()}"`).not.toBeNull();
      return match[1];
    });

// Static, side-effect and dynamic imports, re-exports and require(), following
// relative imports so a package reached through a local helper still counts.
const SPECIFIER = /(?:\bfrom\s*|^\s*import\s*|\b(?:import|require)\s*\(\s*)["']([^"']+)["']/gm;

const bareImports = (rel, seen) => {
  if (seen.has(rel)) return [];
  seen.add(rel);
  return [...read(rel).matchAll(SPECIFIER)].flatMap(([, spec]) => {
    if (spec.startsWith(".")) return bareImports(path.join(path.dirname(rel), spec), seen);
    if (isBuiltin(spec)) return [];
    return [
      spec
        .split("/")
        .slice(0, spec.startsWith("@") ? 2 : 1)
        .join("/"),
    ];
  });
};

describe("publish-daintree composite (#15625)", () => {
  it("installs packages only through the locked setup-node-install step", () => {
    const installs = steps.filter((s) => s.uses === SETUP_NODE_INSTALL);
    expect(installs).toHaveLength(1);
    expect(installs[0].with?.install_args ?? "").not.toMatch(/--omit|--only|--production/);

    for (const step of steps) {
      expect(step.run ?? "", `step "${step.name}"`).not.toMatch(PACKAGE_MANAGER);
    }
  });

  it("installs through `npm ci` after the clean checkout and before any script runs", () => {
    const setup = load(read(".github/actions/setup-node-install/action.yml"));
    const install = setup.runs.steps.find((s) => s.name === "Install dependencies");
    expect(install.run).toMatch(/^\s*node scripts\/ci\/npm-ci-retry\.mjs\b/m);
    expect(read("scripts/ci/npm-ci-retry.mjs")).toContain('const npmArgs = ["ci"');

    // The checkout runs `git clean -ffdx`, which would delete node_modules if
    // it came after the install.
    const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkouts).toHaveLength(1);
    const checkoutIdx = steps.indexOf(checkouts[0]);
    const installIdx = steps.findIndex((s) => s.uses === SETUP_NODE_INSTALL);
    const firstScriptIdx = steps.findIndex((s) => /\bnode\s/.test(s.run ?? ""));
    expect(installIdx).toBeGreaterThan(checkoutIdx);
    expect(firstScriptIdx).toBeGreaterThan(installIdx);
  });

  it("resolves every package the composite's scripts import from the lockfile", () => {
    const scripts = scriptsRunByAction();
    expect(scripts).toEqual(
      expect.arrayContaining([
        "scripts/ci/check-version-monotonic.mjs",
        "scripts/ci/verify-r2-uploads.mjs",
        "scripts/ci/verify-r2-metadata.mjs",
      ])
    );

    const seen = new Set();
    const imported = new Set(scripts.flatMap((script) => bareImports(script, seen)));
    expect([...imported]).toEqual(expect.arrayContaining(["js-yaml", "semver"]));

    for (const name of imported) {
      const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      expect(declared, `${name} declared in package.json`).toBeDefined();
      expect(lock.packages[`node_modules/${name}`]?.version, `${name} locked`).toBeDefined();
    }
  });
});
