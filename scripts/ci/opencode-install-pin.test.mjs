import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import yaml from "js-yaml";

import { OPENCODE_PACKAGE_SPEC, buildInstallArgs } from "./install-opencode.mjs";

// Guards the #11476 pin. The online E2E suite gates release publishes, so the
// OpenCode CLI version it runs against must not change because someone
// unrelated published to npm that day. Three workflows install this CLI, and
// the failure mode is silent: a fourth install site added later, or one of the
// three reverted to a bare `opencode-ai`, still passes CI and still runs the
// gate against a moving target. These assertions are the only enforcement —
// screenshots.yml and the release-gated online runs never fire on a PR.
//
// The pin is asserted as a shape invariant (exact x.y.z, routed through one
// wrapper) rather than against a copied version literal, so bumping the
// version stays a one-line edit in install-opencode.mjs.

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows"
);

const INSTALLER = "scripts/ci/install-opencode.mjs";

// The install sites, and whether each is expected to be conditional. e2e.yml
// and e2e-single.yml install only for the online suite; screenshots.yml always
// needs the CLI. Spelled out here so dropping a site is a deliberate edit.
const EXPECTED_SITES = {
  "e2e.yml": { conditional: true },
  "e2e-single.yml": { conditional: true },
  "screenshots.yml": { conditional: false },
};

function workflowFiles() {
  return readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

function stepsOf(file) {
  const doc = yaml.load(readFileSync(path.join(workflowsDir, file), "utf8"));
  return Object.values(doc?.jobs ?? {}).flatMap((job) => job?.steps ?? []);
}

function openCodeInstallSteps(file) {
  return stepsOf(file).filter((step) => /install opencode/i.test(step?.name ?? ""));
}

describe("OpenCode install pin", () => {
  it("pins an exact version rather than a tag, range or prerelease", () => {
    expect(OPENCODE_PACKAGE_SPEC).toMatch(/^opencode-ai@\d+\.\d+\.\d+$/);
  });

  it("hands that exact spec to the shared npm retry wrapper", () => {
    const args = buildInstallArgs();
    expect(args[0].endsWith("npm-install-retry.mjs")).toBe(true);
    expect(args.slice(1)).toEqual(["-g", OPENCODE_PACKAGE_SPEC]);
  });

  it("installs OpenCode in exactly the expected workflows", () => {
    const found = workflowFiles().filter((f) => openCodeInstallSteps(f).length > 0);
    expect(found.sort()).toEqual(Object.keys(EXPECTED_SITES).sort());
  });

  it("routes every install site through the pinned installer", () => {
    for (const file of Object.keys(EXPECTED_SITES)) {
      const steps = openCodeInstallSteps(file);
      expect(steps, file).toHaveLength(1);
      expect(steps[0].run?.trim(), file).toBe(`node ${INSTALLER}`);
    }
  });

  it("preserves each site's suite condition", () => {
    for (const [file, { conditional }] of Object.entries(EXPECTED_SITES)) {
      const [step] = openCodeInstallSteps(file);
      if (conditional) {
        expect(step.if, file).toMatch(/inputs\.suite\s*==\s*'online'/);
      } else {
        expect(step.if, file).toBeUndefined();
      }
    }
  });

  it("leaves no workflow installing opencode-ai outside the installer", () => {
    // The drift that matters: a new step, or a reverted one, reaching npm
    // directly. Catches sites this file does not otherwise know about.
    const offenders = [];
    for (const file of workflowFiles()) {
      for (const step of stepsOf(file)) {
        const run = step?.run ?? "";
        if (run.includes("opencode-ai")) offenders.push(`${file}: ${step?.name ?? "(unnamed)"}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
