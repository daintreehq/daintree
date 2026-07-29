import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import yaml from "js-yaml";

import { OPENCODE_PACKAGE_SPEC, buildInstallArgs, runInstall } from "./install-opencode.mjs";

// Guards the #11476 pin. The online E2E suite gates release publishes, so the
// OpenCode CLI version it runs against must not change because someone
// unrelated published to npm that day. Three workflows install this CLI, and
// the failure mode is silent: a fourth install site added later, or one of the
// three reverted to a bare `opencode-ai`, still passes CI and still runs the
// gate against a moving target. These assertions are the only enforcement —
// screenshots.yml and the release-gated online runs never fire on a PR.
//
// Two things have to hold for the pin to actually pin, and each fails in a way
// that looks fine in the YAML:
//   1. Every install routes through the one wrapper. Sites are discovered by
//      what they RUN, not by step name — a renamed step that shells out to npm
//      directly would satisfy any name-shaped assertion.
//   2. The installed version survives startup. OpenCode self-updates, so
//      without OPENCODE_DISABLE_AUTOUPDATE the pin covers only the artifact npm
//      wrote, and the gate still ends up on whatever shipped today.
//
// The pin is asserted as a shape invariant (exact x.y.z) rather than against a
// copied version literal, so bumping it stays a one-line edit in
// install-opencode.mjs.

const ciDir = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(ciDir, "../../.github/workflows");

const INSTALLER = "scripts/ci/install-opencode.mjs";

// The install sites, and the condition each must keep. e2e.yml and
// e2e-single.yml install only for the online suite; screenshots.yml always
// needs the CLI. Spelled out here so changing one is a deliberate edit.
const EXPECTED_SITES = {
  "e2e.yml": "inputs.suite == 'online'",
  "e2e-single.yml": "inputs.suite == 'online'",
  "screenshots.yml": null,
};

function workflowFiles() {
  return readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

function parse(file) {
  return yaml.load(readFileSync(path.join(workflowsDir, file), "utf8"));
}

function stepsOf(file) {
  return Object.values(parse(file)?.jobs ?? {}).flatMap((job) => job?.steps ?? []);
}

/** Discover by what the step RUNS, so a rename cannot hide a site. */
function installerSteps(file) {
  return stepsOf(file).filter((step) => (step?.run ?? "").includes(INSTALLER));
}

/** `if:` may or may not be wrapped in ${{ }}; compare the expression itself. */
function normalizeCondition(value) {
  if (value === undefined || value === null) return null;
  return String(value)
    .trim()
    .replace(/^\$\{\{(.*)\}\}$/s, "$1")
    .trim();
}

describe("OpenCode install pin", () => {
  it("pins an exact version rather than a tag, range or prerelease", () => {
    expect(OPENCODE_PACKAGE_SPEC).toMatch(/^opencode-ai@\d+\.\d+\.\d+$/);
  });

  it("hands that exact spec to the shared npm retry wrapper", () => {
    const args = buildInstallArgs();
    expect(args[0]).toBe(path.join(ciDir, "npm-install-retry.mjs"));
    expect(args.slice(1)).toEqual(["-g", OPENCODE_PACKAGE_SPEC]);
  });

  it("actually spawns node with those arguments", () => {
    // buildInstallArgs() staying correct would not stop the executable path
    // from being swapped back to an unpinned invocation.
    const calls = [];
    const status = runInstall((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].args).toEqual(buildInstallArgs());
  });

  it("reports a failing install rather than swallowing it", () => {
    expect(runInstall(() => ({ status: 7 }))).toBe(7);
    expect(runInstall(() => ({ error: new Error("spawn failed") }))).toBe(1);
    expect(runInstall(() => ({ signal: "SIGINT" }))).toBeGreaterThan(128);
  });

  it("installs OpenCode in exactly the expected workflows", () => {
    const found = workflowFiles().filter((f) => installerSteps(f).length > 0);
    expect(found.sort()).toEqual(Object.keys(EXPECTED_SITES).sort());
  });

  it("routes every install site through the pinned installer exactly once", () => {
    for (const file of Object.keys(EXPECTED_SITES)) {
      const steps = installerSteps(file);
      expect(steps, file).toHaveLength(1);
      expect(steps[0].run?.trim(), file).toBe(`node ${INSTALLER}`);
    }
  });

  it("preserves each site's suite condition exactly", () => {
    // A substring check would accept `inputs.suite == 'online' || true`, which
    // installs on every suite while looking correct.
    for (const [file, condition] of Object.entries(EXPECTED_SITES)) {
      const [step] = installerSteps(file);
      expect(normalizeCondition(step.if), file).toBe(condition);
    }
  });

  it("disables the CLI self-update wherever it is installed", () => {
    // Without this the pinned binary upgrades itself on first launch and the
    // gate runs an unpinned version anyway.
    for (const file of Object.keys(EXPECTED_SITES)) {
      expect(parse(file)?.env?.OPENCODE_DISABLE_AUTOUPDATE, file).toBe("1");
    }
  });

  it("leaves no workflow referencing opencode-ai outside the installer", () => {
    // Scan whole steps, not just `run`: an install can also hide in an `env`
    // indirection (`npm i -g "$PKG"`) or a `with:` input to a local action.
    const offenders = [];
    for (const file of workflowFiles()) {
      for (const step of stepsOf(file)) {
        if (JSON.stringify(step ?? {}).includes("opencode-ai")) {
          offenders.push(`${file}: ${step?.name ?? "(unnamed)"}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
