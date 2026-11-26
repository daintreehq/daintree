import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import os from "os";
import { fileURLToPath } from "url";
import path from "path";
import { load } from "js-yaml";

// Guards the Homebrew tap publish (#16419, #16420). Release workflows only fire on a v*
// tag or a manual dispatch, so they never run on a PR: these structural
// assertions are the only CI enforcement of who may write to the tap and when.

const workflowsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows"
);
const readWorkflow = (file) => readFileSync(path.join(workflowsDir, file), "utf8");

const JOB_ID = "publish-homebrew-tap";
const jobs = load(readWorkflow("release-macos.yml")).jobs;
const job = jobs[JOB_ID];
const steps = job?.steps ?? [];
const stepNamed = (name) => steps.find((s) => s.name === name);
const stepIndex = (name) => steps.findIndex((s) => s.name === name);

const INSTALL_JOB_ID = "verify-homebrew-install";
const installJob = jobs[INSTALL_JOB_ID];
const installSteps = installJob?.steps ?? [];
const installStep = (name) => installSteps.find((s) => s.name === name);

const SECRET_GATE = "steps.tap-secret.outputs.configured == 'true'";
const WRITTEN_GATE = "steps.cask.outputs.written == 'true'";

// Evaluates the job's `if:` for the clause shapes it uses, so the gate is held
// to its outcome rather than its spelling. Any other clause (an `|| true`, a
// stray `&& false`) is unsupported and fails the test instead of passing it.
function evaluateIf(expression, { ref, inputs = {} }) {
  const github = { ref, ref_name: ref.replace(/^refs\/(tags|heads)\//, "") };
  const read = (name) => {
    if (name === "github.ref") return github.ref;
    if (name === "github.ref_name") return github.ref_name;
    if (name.startsWith("inputs.")) return inputs[name.slice("inputs.".length)];
    throw new Error(`unsupported context ${name}`);
  };
  const results = String(expression)
    .split("&&")
    .map((clause) => clause.trim())
    .map((clause) => {
      let m;
      if ((m = /^startsWith\(([\w.]+), '([^']*)'\)$/.exec(clause))) {
        return String(read(m[1]) ?? "").startsWith(m[2]);
      }
      if ((m = /^!contains\(([\w.]+), '([^']*)'\)$/.exec(clause))) {
        return !String(read(m[1]) ?? "").includes(m[2]);
      }
      if ((m = /^(inputs\.\w+) != true$/.exec(clause))) return read(m[1]) !== true;
      throw new Error(`unsupported clause in ${JOB_ID}.if: ${clause}`);
    });
  return results.every(Boolean);
}

function runSecretCheck(token) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tap-secret-"));
  try {
    const output = path.join(dir, "github-output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", stepNamed("Check Homebrew tap deploy key").run], {
      encoding: "utf8",
      env: { ...process.env, HOMEBREW_TAP_DEPLOY_KEY: token, GITHUB_OUTPUT: output },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("release-macos.yml Homebrew tap publish (#16419)", () => {
  it("runs only after the R2 publish succeeded", () => {
    expect(job, `release-macos.yml must define ${JOB_ID}`).toBeDefined();
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(needs).toContain("publish-daintree");
    // Any status function replaces the implicit success() that makes needs block.
    expect(String(job.if)).not.toMatch(/\b(success|always|failure|cancelled)\s*\(/);
    expect(job).not.toHaveProperty("continue-on-error");
  });

  it.each([
    ["a stable tag push", { ref: "refs/tags/v0.49.0" }, true],
    [
      "a stable tag dispatch",
      { ref: "refs/tags/v0.49.0", inputs: { dry_run: false, skip_notarization: false } },
      true,
    ],
    ["an rc tag", { ref: "refs/tags/v0.50.0-rc.1" }, false],
    ["a beta tag", { ref: "refs/tags/v0.50.0-beta.2" }, false],
    ["a build-metadata tag", { ref: "refs/tags/v0.50.0+build.7" }, false],
    ["a dry run on a tag", { ref: "refs/tags/v0.49.0", inputs: { dry_run: true } }, false],
    [
      "a skip_notarization run",
      { ref: "refs/tags/v0.49.0", inputs: { skip_notarization: true } },
      false,
    ],
    ["a branch dispatch", { ref: "refs/heads/develop", inputs: { dry_run: false } }, false],
    ["a dry run on a branch", { ref: "refs/heads/develop", inputs: { dry_run: true } }, false],
  ])("decides %s", (_label, event, runs) => {
    expect(evaluateIf(job.if, event)).toBe(runs);
  });

  it("serializes tap writes across tags without dropping a waiting release", () => {
    expect(job.concurrency).toEqual({
      group: "homebrew-tap",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  it("checks the deploy key secret first", () => {
    const check = stepNamed("Check Homebrew tap deploy key");
    expect(stepIndex("Check Homebrew tap deploy key")).toBe(0);
    expect(check.id).toBe("tap-secret");
    expect(check.env).toEqual({
      HOMEBREW_TAP_DEPLOY_KEY: "${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}",
    });
  });

  it.skipIf(process.platform === "win32")("skips with a notice when the key is empty", () => {
    const { status, stdout, output } = runSecretCheck("");
    expect(status).toBe(0);
    expect(output).toBe("configured=false\n");
    expect(stdout).toMatch(
      /^::notice::Homebrew tap update skipped — HOMEBREW_TAP_DEPLOY_KEY secret not configured/m
    );
  });

  it.skipIf(process.platform === "win32")("goes ahead silently when the key is set", () => {
    const { status, stdout, output } = runSecretCheck("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(status).toBe(0);
    expect(output).toBe("configured=true\n");
    expect(stdout).toBe("");
  });

  it.each([
    ["Check out repository", SECRET_GATE],
    ["Check out Homebrew tap", SECRET_GATE],
    ["Set up Node.js", SECRET_GATE],
    ["Generate cask", SECRET_GATE],
    ["Audit cask", WRITTEN_GATE],
    ["Push cask to the tap", WRITTEN_GATE],
  ])("gates %s", (name, gate) => {
    expect(stepNamed(name)?.if).toBe(gate);
  });

  it("has no step the gate table above doesn't know", () => {
    expect(steps.map((s) => s.name)).toEqual([
      "Check Homebrew tap deploy key",
      "Check out repository",
      "Check out Homebrew tap",
      "Set up Node.js",
      "Generate cask",
      "Audit cask",
      "Push cask to the tap",
    ]);
  });

  it("hashes against the tap's current cask, so an old tag can't roll it back", () => {
    const generate = stepNamed("Generate cask");
    expect(generate.id).toBe("cask");
    const command = generate.run.trim();
    expect(command.startsWith("node scripts/ci/homebrew-cask.mjs")).toBe(true);
    expect(command).toContain('--version "${GITHUB_REF_NAME#v}"');
    expect(command).toContain("--existing homebrew-tap/Casks/daintree.rb");
    expect(command).toContain('--out "$RUNNER_TEMP/daintree.rb"');
  });

  it("checks the tap out with its deploy key, and keeps it for the push", () => {
    const tap = stepNamed("Check out Homebrew tap");
    expect(tap.uses).toBe("actions/checkout@v6");
    expect(tap.with).toEqual({
      repository: "daintreehq/homebrew-tap",
      "ssh-key": "${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}",
      path: "homebrew-tap",
      "fetch-depth": 1,
    });
  });

  it("references the deploy key only in the secret check and the tap checkout", () => {
    const users = steps.filter((s) => JSON.stringify(s).includes("secrets.")).map((s) => s.name);
    expect(users).toEqual(["Check Homebrew tap deploy key", "Check out Homebrew tap"]);
    const source = readWorkflow("release-macos.yml");
    expect(source.match(/secrets\.HOMEBREW_TAP_DEPLOY_KEY\b/g)).toHaveLength(2);
    expect(source).not.toMatch(/HOMEBREW_TAP_TOKEN/);
  });

  it("gives the job token read access only", () => {
    expect(job.permissions).toEqual({ contents: "read" });
  });

  it("fails the push when the audit fails", () => {
    const audit = stepNamed("Audit cask");
    expect(audit.run).toMatch(/^set -euo pipefail$/m);
    expect(audit.run).toMatch(/^brew style --cask daintree-release\/audit\/daintree$/m);
    expect(audit.run).toMatch(
      /^brew audit --cask --strict --online --arch=all daintree-release\/audit\/daintree$/m
    );
    expect(audit.run).not.toMatch(/\|\|\s*(true|:)/);
    expect(audit).not.toHaveProperty("continue-on-error");
    expect(stepIndex("Audit cask")).toBeLessThan(stepIndex("Push cask to the tap"));
  });

  it("pushes the cask from the tap checkout, never forced", () => {
    const push = stepNamed("Push cask to the tap");
    expect(push["working-directory"]).toBe("homebrew-tap");
    expect(push.run).toContain('cp "$RUNNER_TEMP/daintree.rb" Casks/daintree.rb');
    expect(push.run).toMatch(/^git push origin HEAD$/m);
    expect(push.run).not.toMatch(/--force|\s-f\b/);
  });

  it("keeps credentials out of the source checkout", () => {
    const source = stepNamed("Check out repository");
    expect(source.with["persist-credentials"]).toBe(false);
    expect(source.with).not.toHaveProperty("token");
    expect(source.with).not.toHaveProperty("ssh-key");
  });

  it.each(["nightly-publish.yml", "release-linux.yml", "release-windows.yml"])(
    "%s never writes to another repository or the tap",
    (file) => {
      const source = readWorkflow(file);
      expect(source).not.toMatch(/homebrew/i);
      const otherJobs = load(source).jobs;
      for (const [id, other] of Object.entries(otherJobs)) {
        for (const step of other.steps ?? []) {
          expect(step.run ?? "", `${file} ${id} must not git push`).not.toMatch(/\bgit push\b/);
        }
      }
    }
  );
});

const posixOnly = it.skipIf(process.platform === "win32");
// The seed step reads brew's JSON with jq, which macOS 15 and GitHub's hosted
// images ship; a machine without it can't run that step at all.
const hasJq = spawnSync("jq", ["--version"]).status === 0;
const withJq = it.skipIf(process.platform === "win32" || !hasJq);

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: isolatedGitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function isolatedGitEnv(extra = {}) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    ...extra,
  };
}

describe("release-macos.yml Homebrew tap commit output (#16420)", () => {
  it("outputs the commit the push step reports", () => {
    expect(job.outputs).toEqual({ "tap-commit": "${{ steps.push.outputs.commit }}" });
    expect(stepNamed("Push cask to the tap").id).toBe("push");
  });

  posixOnly("reports the pushed commit, and the tap's commit when it already matches", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tap-push-"));
    try {
      const remote = path.join(dir, "remote.git");
      const tap = path.join(dir, "homebrew-tap");
      const runnerTemp = path.join(dir, "runner-temp");
      mkdirSync(runnerTemp);
      git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
      git(dir, "clone", "--quiet", remote, tap);
      mkdirSync(path.join(tap, "Casks"));
      writeFileSync(path.join(tap, "Casks/daintree.rb"), 'version "1.2.2"\n');
      git(tap, "add", ".");
      git(tap, "commit", "--quiet", "-m", "daintree 1.2.2");
      git(tap, "push", "--quiet", "origin", "HEAD:main");
      const generated = 'cask "daintree" do\n  version "2.0.0"\nend\n';
      writeFileSync(path.join(runnerTemp, "daintree.rb"), generated);

      const runPush = (refName = "v2.0.0") => {
        const output = path.join(dir, `github-output-${Math.random()}`);
        writeFileSync(output, "");
        const result = spawnSync("bash", ["-c", stepNamed("Push cask to the tap").run], {
          cwd: tap,
          encoding: "utf8",
          env: isolatedGitEnv({
            GITHUB_REF_NAME: refName,
            GITHUB_OUTPUT: output,
            RUNNER_TEMP: runnerTemp,
          }),
        });
        return { ...result, output: readFileSync(output, "utf8") };
      };

      const pushed = runPush();
      expect(pushed.status, pushed.stderr).toBe(0);
      const remoteHead = git(remote, "rev-parse", "main");
      expect(git(remote, "log", "-1", "--format=%s", "main")).toBe("daintree 2.0.0");
      expect(git(remote, "show", "main:Casks/daintree.rb") + "\n").toBe(generated);
      expect(pushed.output).toBe(`commit=${remoteHead}\n`);

      const again = runPush();
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/^::notice::Homebrew tap already carries daintree 2\.0\.0\.$/m);
      expect(git(remote, "rev-parse", "main")).toBe(remoteHead);
      expect(again.output).toBe(`commit=${remoteHead}\n`);

      // Another writer moves the tap: the push is refused and no commit is reported.
      const other = path.join(dir, "other");
      git(dir, "clone", "--quiet", remote, other);
      writeFileSync(path.join(other, "README.md"), "other\n");
      git(other, "add", ".");
      git(other, "commit", "--quiet", "-m", "other");
      git(other, "push", "--quiet", "origin", "HEAD:main");
      const competing = git(remote, "rev-parse", "main");
      writeFileSync(path.join(runnerTemp, "daintree.rb"), 'version "2.0.1"\n');
      const rejected = runPush("v2.0.1");
      expect(rejected.status).not.toBe(0);
      expect(rejected.output).toBe("");
      expect(git(remote, "rev-parse", "main")).toBe(competing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const fixtureCask = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__/homebrew/daintree.rb"),
  "utf8"
);
const fixtureZapTrash = [
  ...fixtureCask.slice(fixtureCask.indexOf("zap ")).matchAll(/"(~[^"]+)"/g),
].map((m) => m[1]);

function brewInfoJson(trash) {
  const zap = trash === undefined ? [] : [{ zap: [{ launchctl: "org.daintree.app.host", trash }] }];
  return JSON.stringify({
    formulae: [],
    casks: [{ token: "daintree", artifacts: [{ app: ["Daintree.app"] }, ...zap] }],
  });
}

// Runs an install-job step with stub commands on PATH (a `brew` whose `info`
// prints the given JSON, plus any others), and HOME, RUNNER_TEMP and APP inside
// a scratch directory.
function runInstallStep(
  dir,
  name,
  { infoJson = brewInfoJson(fixtureZapTrash), stubs = {}, env = {} } = {}
) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(dir, "brew-info.json"), infoJson);
  const allStubs = {
    brew: `[[ "$*" == "info --json=v2 --cask daintreehq/tap/daintree" ]] && exec cat "${path.join(dir, "brew-info.json")}"\nexit 64`,
    ...stubs,
  };
  for (const [command, body] of Object.entries(allStubs)) {
    writeFileSync(path.join(bin, command), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, command), 0o755);
  }
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner-temp");
  mkdirSync(home, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const result = spawnSync("bash", ["-c", installStep(name).run], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...installJob.env,
      EXPECTED_ARCH: "arm64",
      GITHUB_REF_NAME: "v1.2.3",
      HOME: home,
      RUNNER_TEMP: runnerTemp,
      APP: path.join(dir, "Daintree.app"),
      ...env,
      // Last, so the stubs always shadow the real tools.
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    },
  });
  return { ...result, home, runnerTemp };
}

// Each stub answers only the exact call the step should make, so a changed
// flag or path fails the check instead of reading a canned answer.
const spctlStub = (verdict, source, status = 0) =>
  `[[ "$*" == "--assess --type execute --verbose=4 --ignore-cache --no-cache $APP" ]] || exit 64\n` +
  `echo "$APP: ${verdict}" >&2; echo "source=${source}" >&2; exit ${status}`;
const appStubs = ({
  version = "1.2.3",
  host = "arm64",
  binary = "arm64",
  spctl = spctlStub("accepted", "Notarized Developer ID"),
} = {}) => ({
  plutil: `[[ "$*" == "-extract CFBundleShortVersionString raw -o - $APP/Contents/Info.plist" ]] || exit 64\necho "${version}"`,
  uname: `[[ "$*" == "-m" ]] && echo "${host}" || echo Darwin`,
  lipo: `[[ "$*" == "-archs $APP/Contents/MacOS/Daintree" ]] || exit 64\necho "${binary}"`,
  spctl,
});

describe("release-macos.yml Homebrew install check (#16420)", () => {
  it("runs only when the tap job reports a commit", () => {
    expect(installJob, `release-macos.yml must define ${INSTALL_JOB_ID}`).toBeDefined();
    expect(installJob.needs).toEqual([JOB_ID]);
    expect(installJob.if).toBe(`needs.${JOB_ID}.outputs.tap-commit != ''`);
    expect(installJob).not.toHaveProperty("continue-on-error");
  });

  it("installs on Apple Silicon and Intel", () => {
    expect(installJob["runs-on"]).toBe("${{ matrix.runner }}");
    expect(installJob.strategy).toEqual({
      "fail-fast": false,
      matrix: {
        include: [
          { runner: "macos-15", arch: "arm64" },
          { runner: "macos-15-intel", arch: "x86_64" },
        ],
      },
    });
    expect(installJob.env.EXPECTED_ARCH).toBe("${{ matrix.arch }}");
  });

  it("installs from the public tap at that commit, with no credentials", () => {
    expect(installJob.permissions).toEqual({});
    expect(JSON.stringify(installJob)).not.toMatch(/secrets\.|github\.token/);
    expect(installSteps.filter((s) => s.uses)).toEqual([]);
    expect(installJob.env).toMatchObject({
      HOMEBREW_NO_AUTO_UPDATE: "1",
      CASK: "daintreehq/tap/daintree",
      TAP_COMMIT: `\${{ needs.${JOB_ID}.outputs.tap-commit }}`,
    });
  });

  it("has every check, in order", () => {
    expect(installSteps.map((s) => s.name)).toEqual([
      "Tap daintreehq/tap at the published commit",
      "Install cask",
      "Check installed app",
      "Seed zap paths",
      "Uninstall cask with zap",
      "Check app and zap paths are gone",
    ]);
    for (const step of installSteps) {
      expect(step, step.name).not.toHaveProperty("if");
      expect(step, step.name).not.toHaveProperty("continue-on-error");
      expect(step.run, step.name).not.toMatch(/\|\|\s*(true|:)/);
    }
  });

  it("pins the tap to the published commit and trusts it before installing", () => {
    const run = installStep("Tap daintreehq/tap at the published commit").run;
    expect(run).toMatch(/^set -euo pipefail$/m);
    expect(run).toMatch(/^brew tap daintreehq\/tap$/m);
    expect(run).toContain('cat-file -e "$TAP_COMMIT^{commit}"');
    expect(run).toContain('fetch --quiet origin "$TAP_COMMIT"');
    expect(run).toContain('checkout --quiet --detach "$TAP_COMMIT"');
    expect(run).toMatch(
      /if brew trust --help >\/dev\/null 2>&1; then\s+brew trust --cask "\$CASK"/
    );
    expect(installStep("Install cask").run.trim()).toBe('brew install --cask "$CASK"');
    expect(installStep("Uninstall cask with zap").run.trim()).toBe(
      'brew uninstall --zap --cask "$CASK"'
    );
  });

  it("checks the installed version, architecture and Gatekeeper", () => {
    const run = installStep("Check installed app").run;
    expect(run).toMatch(/^set -euo pipefail$/m);
    expect(run).toContain('expected_version="${GITHUB_REF_NAME#v}"');
    expect(run).toContain("CFBundleShortVersionString");
    expect(run).toContain('lipo -archs "$APP/Contents/MacOS/Daintree"');
    expect(run).toContain('"$archs" != "$EXPECTED_ARCH"');
    expect(run).toContain('"$host_arch" != "$EXPECTED_ARCH"');
    expect(run).toContain(
      'spctl --assess --type execute --verbose=4 --ignore-cache --no-cache "$APP" 2>&1'
    );
    expect(run).toContain(
      `[[ "$assess_status" -ne 0 ]] || ! grep -q '^source=Notarized Developer ID$'`
    );
  });

  posixOnly.each([
    ["the arm64 app matches", "arm64", {}, null],
    ["the Intel app matches", "x86_64", { host: "x86_64", binary: "x86_64" }, null],
    [
      "the version is older",
      "arm64",
      { version: "1.2.2" },
      "installed Daintree 1.2.2, expected 1.2.3",
    ],
    [
      "the runner is the wrong arch",
      "arm64",
      { host: "x86_64" },
      "runner is x86_64, expected arm64",
    ],
    [
      "the Intel runner is arm64",
      "x86_64",
      { binary: "x86_64" },
      "runner is arm64, expected x86_64",
    ],
    [
      "the binary is universal",
      "arm64",
      { binary: "x86_64 arm64" },
      "installed binary is x86_64 arm64",
    ],
    ["the binary is the other arch", "arm64", { binary: "x86_64" }, "installed binary is x86_64"],
    [
      "Gatekeeper rejects it",
      "arm64",
      { spctl: spctlStub("rejected", "Unnotarized Developer ID", 3) },
      "Gatekeeper did not accept",
    ],
    [
      "Gatekeeper fails while naming a notarized source",
      "arm64",
      { spctl: spctlStub("rejected", "Notarized Developer ID", 3) },
      "Gatekeeper did not accept",
    ],
    [
      "Gatekeeper accepts it from another source",
      "arm64",
      { spctl: spctlStub("accepted", "Developer ID") },
      "Gatekeeper did not accept",
    ],
  ])("app check when %s", (_label, arch, stubs, error) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tap-app-"));
    try {
      const result = runInstallStep(dir, "Check installed app", {
        stubs: appStubs(stubs),
        env: { EXPECTED_ARCH: arch },
      });
      if (error === null) {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain("source=Notarized Developer ID");
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(`::error::${error}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  withJq("seeds every zap trash path, and fails until zap removes them all", () => {
    expect(fixtureZapTrash.length).toBeGreaterThan(10);
    const dir = mkdtempSync(path.join(os.tmpdir(), "tap-zap-"));
    try {
      const seeded = runInstallStep(dir, "Seed zap paths");
      expect(seeded.status, seeded.stderr).toBe(0);
      expect(seeded.stdout).toContain(`Seeded ${fixtureZapTrash.length} zap paths.`);
      const paths = readFileSync(path.join(seeded.runnerTemp, "zap-seeded"), "utf8")
        .trim()
        .split("\n");
      expect(paths).toEqual(
        fixtureZapTrash.map((t) => `${seeded.home}${t.slice(1)}`.replaceAll("*", "seed"))
      );
      for (const p of paths) {
        expect(p.startsWith(`${seeded.home}/`), p).toBe(true);
        expect(p).not.toContain("*");
        expect(statSync(p).isDirectory(), p).toBe(!p.endsWith(".plist"));
      }
      expect(paths).toContain(
        `${seeded.home}/Library/LaunchAgents/org.daintree.app.schedules.seed.plist`
      );
      expect(paths).toContain(`${seeded.home}/Library/Services/Open in Daintree.workflow`);

      const left = runInstallStep(dir, "Check app and zap paths are gone");
      expect(left.status).toBe(1);
      expect(left.stdout.match(/^::error::zap left /gm)).toHaveLength(paths.length);

      for (const p of paths.slice(1)) rmSync(p, { recursive: true, force: true });
      const oneLeft = runInstallStep(dir, "Check app and zap paths are gone");
      expect(oneLeft.status).toBe(1);
      expect(oneLeft.stdout.trim()).toBe(`::error::zap left ${paths[0]}`);

      rmSync(paths[0], { recursive: true, force: true });
      symlinkSync(path.join(dir, "nowhere"), paths[0]);
      const dangling = runInstallStep(dir, "Check app and zap paths are gone");
      expect(dangling.status).toBe(1);
      expect(dangling.stdout.trim()).toBe(`::error::zap left ${paths[0]}`);

      rmSync(paths[0], { force: true });
      expect(runInstallStep(dir, "Check app and zap paths are gone").status).toBe(0);

      mkdirSync(path.join(dir, "Daintree.app"));
      const app = runInstallStep(dir, "Check app and zap paths are gone");
      expect(app.status).toBe(1);
      expect(app.stdout).toMatch(/::error::.*Daintree\.app is still installed/);

      rmSync(path.join(dir, "Daintree.app"), { recursive: true });
      symlinkSync(path.join(dir, "nowhere"), path.join(dir, "Daintree.app"));
      const appLink = runInstallStep(dir, "Check app and zap paths are gone");
      expect(appLink.status).toBe(1);
      expect(appLink.stdout).toMatch(/::error::.*Daintree\.app is still installed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  withJq("fails when the cask declares nothing to zap", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tap-zap-"));
    try {
      const result = runInstallStep(dir, "Seed zap paths", { infoJson: brewInfoJson(undefined) });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/^::error::the cask declares no zap trash paths$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  withJq("seeds a zap that names a single trash path", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tap-zap-"));
    try {
      const result = runInstallStep(dir, "Seed zap paths", {
        infoJson: brewInfoJson("~/.daintree"),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Seeded 1 zap paths.");
      expect(statSync(path.join(result.home, ".daintree")).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A stub brew that logs its calls; the tap repository is a real clone.
  function runTapStep(dir, tapDir, commit) {
    const log = path.join(dir, "brew.log");
    const brew = [
      `echo "$*" >> "${log}"`,
      'case "$*" in',
      '  --version|"tap daintreehq/tap"|"trust --help"|"trust --cask daintreehq/tap/daintree") exit 0 ;;',
      `  "--repository daintreehq/tap") echo "${tapDir}" ;;`,
      "  *) exit 64 ;;",
      "esac",
    ].join("\n");
    const result = runInstallStep(dir, "Tap daintreehq/tap at the published commit", {
      stubs: { brew },
      env: { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", TAP_COMMIT: commit },
    });
    return { ...result, calls: readFileSync(log, "utf8").trim().split("\n") };
  }

  posixOnly.each([
    ["already in the clone", false],
    ["missing from a shallow clone", true],
  ])("pins the tap to a commit %s", (_label, shallow) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tap-pin-"));
    try {
      const remote = path.join(dir, "remote.git");
      const work = path.join(dir, "work");
      git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
      git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
      git(dir, "clone", "--quiet", remote, work);
      writeFileSync(path.join(work, "cask"), "1\n");
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", "published");
      const published = git(work, "rev-parse", "HEAD");
      writeFileSync(path.join(work, "cask"), "2\n");
      git(work, "commit", "--quiet", "-am", "newer");
      git(work, "push", "--quiet", "origin", "HEAD:main");

      const tapDir = path.join(dir, "tap");
      if (shallow) {
        git(dir, "clone", "--quiet", "--depth", "1", `file://${remote}`, tapDir);
        expect(
          spawnSync("git", ["-C", tapDir, "cat-file", "-e", `${published}^{commit}`]).status
        ).not.toBe(0);
      } else {
        git(dir, "clone", "--quiet", remote, tapDir);
        // Any fetch now fails, so the step must use the commit it already has.
        git(tapDir, "remote", "set-url", "origin", path.join(dir, "missing.git"));
      }

      const result = runTapStep(dir, tapDir, published);
      expect(result.status, result.stderr).toBe(0);
      expect(git(tapDir, "rev-parse", "HEAD")).toBe(published);
      expect(spawnSync("git", ["-C", tapDir, "symbolic-ref", "-q", "HEAD"]).status).not.toBe(0);
      expect(result.calls).toEqual([
        "--version",
        "tap daintreehq/tap",
        "--repository daintreehq/tap",
        "trust --help",
        "trust --cask daintreehq/tap/daintree",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
