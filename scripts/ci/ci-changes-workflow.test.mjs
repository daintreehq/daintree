import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";

// ci.yml runs on pull requests only and gives each one just the jobs its diff
// needs. The `changes` job decides that, so a classifier that quietly reports
// "false", or a job wired to the wrong output, would skip lint, tests or build
// on a PR that needed them, with ci-ok green.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = load(readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
const { jobs } = workflow;
const classify = jobs.changes.steps.find((s) => s.name === "Classify changed files");
const OUTPUTS = ["base", "code", "packages", "catalog", "workflow", "github"];

const GIT_FIXTURE_CONFIG = [
  "user.email=ci@example.test",
  "user.name=CI",
  "commit.gpgsign=false",
  "tag.gpgsign=false",
  "core.hooksPath=/dev/null",
].flatMap((setting) => ["-c", setting]);

function write(dir, file, content) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

// Builds the shape of a pull request's merge commit: the base branch moves on
// after the PR branched (so a diff against the wrong parent would pick up the
// base's own change), and HEAD merges the PR with the base tip as first parent.
// Then runs the step's own script there.
function classifyDiff({ add = [], move = [], event = "pull_request" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ci-changes-job-"));
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const git = (...args) =>
      execFileSync("git", [...GIT_FIXTURE_CONFIG, ...args], {
        cwd: dir,
        env,
        encoding: "utf8",
      }).trim();
    git("init", "-q", "-b", "develop");
    write(dir, "seed.txt", "seed\n");
    for (const [from] of move) write(dir, from, "moved\n");
    git("add", "-A");
    git("commit", "-q", "-m", "root");
    git("checkout", "-q", "-b", "feature");
    for (const file of add) write(dir, file, "changed\n");
    for (const [from, to] of move) {
      mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      git("mv", from, to);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "feature");
    git("checkout", "-q", "develop");
    write(dir, "src/base-only.ts", "base moved on\n");
    write(dir, "packages/base-only.ts", "base moved on\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base moves on");
    const expectedBase = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-ff", "-m", "merge", "feature");

    const outputFile = path.join(dir, "github-output");
    writeFileSync(outputFile, "");
    execFileSync("bash", ["-c", classify.run], {
      cwd: dir,
      env: {
        ...env,
        EVENT: event,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
        RUNNER_TEMP: dir,
      },
      stdio: "ignore",
    });
    const lines = readFileSync(outputFile, "utf8").trim().split("\n");
    return { expectedBase, outputs: Object.fromEntries(lines.map((line) => line.split("="))) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const out = (files) => classifyDiff({ add: files }).outputs;

describe("ci.yml triggers", () => {
  it("runs on pull requests to main and develop and on dispatch, never on a push", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(workflow.on.pull_request.branches).toEqual(["main", "develop"]);
    expect([...workflow.on.pull_request.types].sort()).toEqual(
      ["opened", "ready_for_review", "reopened", "synchronize"].sort()
    );
  });
});

describe("ci.yml changes job", () => {
  it("exports every classifier output and feeds the step the event", () => {
    expect(classify.id).toBe("diff");
    expect(classify.env.EVENT).toBe("${{ github.event_name }}");
    for (const name of OUTPUTS) {
      expect(jobs.changes.outputs[name], name).toBe(`\${{ steps.diff.outputs.${name} }}`);
    }
    const checkout = jobs.changes.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.with["fetch-depth"]).toBeGreaterThanOrEqual(2);
  });

  it("diffs the merge commit against its first parent, the base tip", () => {
    const { expectedBase, outputs } = classifyDiff({ add: ["README.md"] });
    expect(outputs.base).toBe(expectedBase);
    // The base's own change to src/ and packages/ must not count as the PR's.
    expect(outputs).toMatchObject({ code: "false", packages: "false" });
  });

  it("marks a code change", () => {
    expect(out(["src/components/Foo.tsx"])).toMatchObject({
      code: "true",
      packages: "false",
      catalog: "false",
      workflow: "false",
      github: "false",
    });
  });

  it("treats Markdown and docs/ as docs-only, and anything else as code", () => {
    expect(out(["docs/development.md", "src/README.md"]).code).toBe("false");
    expect(out(["docs/images/diagram.png"]).code).toBe("false");
    expect(out(["docs/development.md", "src/a.ts"]).code).toBe("true");
    expect(out(["docsite/index.ts"]).code).toBe("true");
  });

  it("counts a file moved out of a gated area against that area", () => {
    const moved = classifyDiff({ move: [["scripts/perf/driver.ts", "docs/driver.ts"]] }).outputs;
    expect(moved.code).toBe("true");
    const outOfPackages = classifyDiff({
      move: [["packages/plugin-sdk/src/a.ts", "docs/a.ts"]],
    }).outputs;
    expect(outOfPackages.packages).toBe("true");
  });

  it.each([
    "packages/plugin-sdk/src/index.ts",
    "shared/types/plugin.ts",
    "plugins/sample-project/acme.requests/index.ts",
    "electron/schemas/plugin.ts",
    "electron/types/archiver.d.ts",
    "electron/services/plugin/pluginIconAssets.ts",
    "electron/services/PluginArchive.ts",
    "electron/utils/pluginArchiveConstants.ts",
    "src/panel/index.ts",
    "src/pluginUi/dates.ts",
    "src/services/plugin/tailwind/candidateTokenizer.ts",
    "src/styles/design-contract.css",
    "src/components/ui/Button.tsx",
    "src/components/PluginKit/Table.tsx",
    "src/index.css",
    "scripts/lib/plugin-style-contract.mjs",
    "scripts/build-plugin-ui-browser.mjs",
    "scripts/ci/packages-consumer-smoke.mjs",
    "scripts/ci/check-api-surface.mjs",
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    ".github/workflows/ci.yml",
    ".github/actions/install/action.yml",
  ])("runs packages for %s", (file) => {
    expect(out([file]).packages).toBe("true");
  });

  it.each([
    "src/components/Foo.tsx",
    "src/store/projectStore.ts",
    "electron/services/GitService.ts",
    "scripts/ci/other.mjs",
    "packages/plugin-sdk/README.md",
    "shared/README.md",
    "plugins/catalog.json",
    ".github/workflows/e2e.yml",
  ])("skips packages for %s", (file) => {
    expect(out([file]).packages).toBe("false");
  });

  it("flags catalog, CI workflow and .github changes, anchored", () => {
    expect(out(["plugins/catalog.json"]).catalog).toBe("true");
    expect(out(["plugins/catalog.json.bak"]).catalog).toBe("false");
    expect(out([".github/workflows/ci.yml"])).toMatchObject({ workflow: "true", github: "true" });
    expect(out([".github/actions/install/action.yml"]).workflow).toBe("true");
    expect(out([".github/workflows/e2e.yml"])).toMatchObject({ workflow: "false", github: "true" });
    expect(out([".github/workflows/ci.yml.orig"]).workflow).toBe("false");
  });

  it("runs everything except the catalog check, with no base, on a manual dispatch", () => {
    const { outputs } = classifyDiff({ add: ["src/a.ts"], event: "workflow_dispatch" });
    expect(outputs).toEqual({
      base: "",
      code: "true",
      packages: "true",
      catalog: "false",
      workflow: "true",
      github: "true",
    });
  });
});

describe("ci.yml job gating", () => {
  it("skips a draft entirely, gate included, and runs a dispatch", () => {
    expect(jobs.changes.if).toBe(
      "github.event_name != 'pull_request' || !github.event.pull_request.draft"
    );
    expect(jobs["ci-ok"].if).toBe("${{ always() && needs.changes.result != 'skipped' }}");
  });

  it("always runs static, and gates every other job on its own output", () => {
    const gates = {
      static: undefined,
      lint: "needs.changes.outputs.code == 'true'",
      test: "needs.changes.outputs.code == 'true'",
      build: "needs.changes.outputs.code == 'true'",
      packages: "needs.changes.outputs.packages == 'true'",
      "plugin-catalog": "needs.changes.outputs.catalog == 'true'",
    };
    for (const [name, gate] of Object.entries(gates)) {
      expect(jobs[name].needs, name).toBe("changes");
      expect(jobs[name].if, name).toBe(gate);
    }
  });

  it("gates ci-ok on every job, and fails it on any failure or cancellation", () => {
    const gated = Object.keys(jobs).filter((name) => name !== "ci-ok");
    expect([...jobs["ci-ok"].needs].sort()).toEqual(gated.sort());
    const check = jobs["ci-ok"].steps.find((s) => s.name === "Check results");
    expect(check.if).toBe(
      "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')"
    );
    expect(check.run).toBe("exit 1");
  });

  it("runs the affected unit tests against the PR's base, and the whole suite without one", () => {
    const run = jobs.test.steps.find((s) => s.name === "Test (vitest, affected files)");
    expect(run.if).toBeUndefined();
    expect(run.env.BASE).toBe("${{ needs.changes.outputs.base }}");
    expect(run.run).toBe('npx vitest run --passWithNoTests ${BASE:+--changed "$BASE"}');
    const checkout = jobs.test.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.with["fetch-depth"]).toBeGreaterThanOrEqual(2);
  });

  it("runs the fs-read workflow guards when .github changes, even after a unit failure", () => {
    const guards = jobs.test.steps.find((s) => s.name === "Test (workflow guards)");
    expect(guards.if).toBe(
      "${{ !cancelled() && needs.changes.outputs.base != '' && needs.changes.outputs.github == 'true' }}"
    );
    expect(guards.run).toBe("npx vitest run scripts/ci");
  });

  it("puts a macOS runner on the host scripts only when the unit selection reaches them", () => {
    const select = jobs.test.steps.find((s) => s.id === "select");
    expect(select.run).toContain("hostInstaller\\.realShell\\.test\\.ts");
    expect(select.run).toContain('echo "host_scripts=${host}" >> "$GITHUB_OUTPUT"');
    expect(jobs.test.outputs.host_scripts).toBe("${{ steps.select.outputs.host_scripts }}");

    const mac = jobs["host-scripts-macos"];
    expect(mac["runs-on"]).toMatch(/^macos-/);
    expect(mac.needs).toEqual(["changes", "test"]);
    expect(mac.if).toBe(
      "${{ !cancelled() && (needs.test.outputs.host_scripts == 'true' || needs.changes.outputs.workflow == 'true') }}"
    );
    expect(mac.steps.at(-1).run).toBe(
      "npx vitest run electron/remote/client/__tests__/hostInstaller.realShell.test.ts"
    );
  });

  it("never passes a failed step through", () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(job["continue-on-error"], name).toBeUndefined();
      for (const s of job.steps)
        expect(s["continue-on-error"], `${name}: ${s.name}`).toBeUndefined();
    }
  });
});
