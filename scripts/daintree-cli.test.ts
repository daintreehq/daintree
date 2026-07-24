import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "daintree-cli.sh");

// Executes the shipped CLI with the app launch stubbed out, then reports the
// argv the launcher actually received. This is what makes the single-token
// `--cli-path=<path>` guarantee testable: asserting the script's source text
// would only restate it, whereas a displaced or word-split value shows up here
// as two argv entries instead of one (#11410).
function runCli(target: string): { argv: string[]; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-sh-"));
  const argvFile = path.join(root, "argv");
  const binDir = path.join(root, "shim");
  fs.mkdirSync(binDir);

  const recorder = [
    "#!/usr/bin/env bash",
    // NUL-delimited so a value containing spaces stays one field.
    `printf '%s\\0' "$@" > ${JSON.stringify(argvFile)}`,
    "",
  ].join("\n");

  let scriptPath: string;
  if (process.platform === "darwin") {
    // The script derives the bundle from its own location when installed
    // inside one, so no Spotlight/`/Applications` lookup is involved.
    scriptPath = path.join(root, "Daintree.app", "Contents", "MacOS", "bin", "daintree");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    // macOS hands off through `open -a <bundle> --args …`.
    const openShim = path.join(binDir, "open");
    fs.writeFileSync(openShim, recorder, { mode: 0o755 });
  } else {
    // Linux resolves the binary as ../daintree relative to the script's dir.
    scriptPath = path.join(root, "opt", "bin", "daintree");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(path.join(root, "opt", "daintree"), recorder, { mode: 0o755 });
  }

  fs.copyFileSync(SCRIPT_SOURCE, scriptPath);
  fs.chmodSync(scriptPath, 0o755);

  execFileSync("bash", [scriptPath, target], {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    encoding: "utf-8",
  });

  // The Linux branch backgrounds the launch and exits immediately.
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(argvFile) && Date.now() < deadline) {
    execFileSync("sleep", ["0.05"]);
  }

  const raw = fs.readFileSync(argvFile, "utf-8");
  return { argv: raw.split("\0").filter((entry) => entry.length > 0), root };
}

describe.skipIf(process.platform === "win32")("daintree-cli.sh", () => {
  let projectDir: string;
  let workspace: string;
  const roots: string[] = [];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-target-"));
    // A space is the case the two-token form silently word-split.
    projectDir = path.join(workspace, "my project");
    fs.mkdirSync(projectDir);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes the project directory as a single --cli-path= argument", () => {
    const { argv, root } = runCli(projectDir);
    roots.push(root);

    // `pwd -P` in the script resolves symlinks (macOS /var -> /private/var).
    const expected = fs.realpathSync(projectDir);
    expect(argv).toContain(`--cli-path=${expected}`);
  });

  it("never emits the flag and the path as two separate arguments", () => {
    const { argv, root } = runCli(projectDir);
    roots.push(root);

    // The #11410 failure mode: a bare `--cli-path` switch whose value is a
    // detached positional Chromium is free to displace.
    expect(argv).not.toContain("--cli-path");
    expect(argv.filter((entry) => entry.startsWith("--cli-path"))).toHaveLength(1);
  });

  it("keeps a path containing spaces in one argument", () => {
    const { argv, root } = runCli(projectDir);
    roots.push(root);

    const cliArg = argv.find((entry) => entry.startsWith("--cli-path="));
    expect(cliArg).toBeDefined();
    expect(cliArg).toContain("my project");
  });
});
