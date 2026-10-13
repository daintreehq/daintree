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
async function runCli(target: string): Promise<{ argv: string[]; root: string }> {
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

  // The Linux branch backgrounds the launch and exits immediately, and the
  // recorder's `>` redirect creates the file before writing it — so wait for a
  // trailing NUL rather than for the file to merely exist.
  const deadline = Date.now() + 5000;
  let raw = "";
  while (Date.now() < deadline) {
    raw = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf-8") : "";
    if (raw.endsWith("\0")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

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

  it("passes the project directory as a single --cli-path= argument", async () => {
    const { argv, root } = await runCli(projectDir);
    roots.push(root);

    // `pwd -P` in the script resolves symlinks (macOS /var -> /private/var).
    const expected = fs.realpathSync(projectDir);
    expect(argv).toContain(`--cli-path=${expected}`);
  });

  it("never emits the flag and the path as two separate arguments", async () => {
    const { argv, root } = await runCli(projectDir);
    roots.push(root);

    // The #11410 failure mode: a bare `--cli-path` switch whose value is a
    // detached positional Chromium is free to displace.
    expect(argv).not.toContain("--cli-path");
    expect(argv.filter((entry) => entry.startsWith("--cli-path"))).toHaveLength(1);
  });

  it("keeps a path containing spaces in one argument", async () => {
    const { argv, root } = await runCli(projectDir);
    roots.push(root);

    const cliArg = argv.find((entry) => entry.startsWith("--cli-path="));
    expect(cliArg).toBeDefined();
    expect(cliArg).toContain("my project");
  });

  // The deb's /usr/bin/daintree is a symlink to resources/daintree-cli.sh, beside
  // the binary's directory: build/linux/postinst.sh.
  function packagedLinuxLayout() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-pkg-"));
    roots.push(root);
    const resources = path.join(root, "opt", "Daintree", "resources");
    fs.mkdirSync(resources, { recursive: true });
    const script = path.join(resources, "daintree-cli.sh");
    fs.copyFileSync(SCRIPT_SOURCE, script);
    fs.chmodSync(script, 0o755);
    const argvFile = path.join(root, "argv");
    fs.writeFileSync(
      path.join(root, "opt", "Daintree", "daintree"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > ${JSON.stringify(argvFile)}\n`,
      { mode: 0o755 }
    );
    const link = path.join(root, "usr-bin", "daintree");
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(script, link);
    return { resources, link, argvFile };
  }

  it("reads the version from a packaged app.asar's build stamp", () => {
    const { resources, link } = packagedLinuxLayout();
    fs.writeFileSync(
      path.join(resources, "app.asar"),
      Buffer.concat([
        Buffer.from([0, 1, 2, 255]),
        Buffer.from('{"daintreeBuildInfo":1,"version":"1.2.3-nightly.4","commit":"abc123"}'),
      ])
    );
    expect(execFileSync("bash", [link, "--version"], { encoding: "utf-8" }).trim()).toBe(
      "daintree 1.2.3-nightly.4"
    );
  });

  // Run as /usr/bin/daintree, the script's own command line matches the
  // process pattern; it must not count itself as a running app. pgrep is
  // stubbed so a Daintree running on the test machine can't decide it.
  it.skipIf(process.platform !== "linux")("doesn't count its own process as a running app", () => {
    const { link } = packagedLinuxLayout();
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-pgrep-"));
    roots.push(shimDir);
    const status = (pgrepOutput: string) => {
      fs.writeFileSync(path.join(shimDir, "pgrep"), `#!/usr/bin/env bash\n${pgrepOutput}\n`, {
        mode: 0o755,
      });
      try {
        const stdout = execFileSync("bash", [link, "--status"], {
          encoding: "utf-8",
          env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}` },
        });
        return { code: 0, stdout: stdout.trim() };
      } catch (error) {
        const failed = error as { status: number; stdout: string };
        return { code: failed.status, stdout: failed.stdout.trim() };
      }
    };
    // pgrep runs as the script's child, so its parent pid is the script's own.
    expect(status('echo "$PPID"')).toEqual({ code: 1, stdout: "Daintree is not running" });
    // A match only counts when the process runs the app's binary; this shell
    // and a pid that isn't there don't (the "--status" block below covers one that does).
    expect(status('echo "$PPID"; echo $$; echo 999999')).toEqual({
      code: 1,
      stdout: "Daintree is not running",
    });
  });

  it.skipIf(process.platform !== "linux")(
    "launches the packaged binary through the /usr/bin symlink",
    async () => {
      const { link, argvFile } = packagedLinuxLayout();
      execFileSync("bash", [link, projectDir], { encoding: "utf-8" });
      const deadline = Date.now() + 5000;
      let raw = "";
      while (Date.now() < deadline && !raw.endsWith("\0")) {
        raw = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf-8") : "";
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(raw.split("\0").filter(Boolean)).toEqual([
        `--cli-path=${fs.realpathSync(projectDir)}`,
      ]);
    }
  );
});

// --status looks at what each matching process actually runs: a shell whose
// command line names the CLI (`bash -c '/usr/bin/daintree --status; …'`) used
// to read as a running app. Linux only: it reads /proc.
describe.runIf(process.platform === "linux")("daintree-cli.sh --status", () => {
  let root: string;
  let app: ReturnType<typeof import("node:child_process").spawn> | null = null;

  const anotherDaintreeRuns = () =>
    execFileSync(
      "bash",
      ["-c", 'for p in $(pgrep -x daintree); do readlink "/proc/$p/exe"; done'],
      {
        encoding: "utf8",
      }
    )
      .split("\n")
      .some((exe) => exe.replace(/ \(deleted\)$/, "").endsWith("/daintree"));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-status-"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.copyFileSync(SCRIPT_SOURCE, path.join(root, "bin", "daintree"));
    fs.chmodSync(path.join(root, "bin", "daintree"), 0o755);
  });

  afterEach(() => {
    app?.kill("SIGKILL");
    app = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const status = (viaShell: boolean) => {
    const cli = path.join(root, "bin", "daintree");
    const args = viaShell ? ["-c", `${cli} --status; :`] : [cli, "--status"];
    try {
      return execFileSync("bash", args, { encoding: "utf8" }).trim();
    } catch (error) {
      return String((error as { stdout?: string }).stdout ?? "").trim();
    }
  };

  it("doesn't count a shell that names the CLI", () => {
    if (anotherDaintreeRuns()) return;
    expect(status(true)).toBe("Daintree is not running");
  });

  it("counts a process running a binary named daintree", async () => {
    const { spawn } = await import("node:child_process");
    const sleeper = execFileSync("bash", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
    fs.mkdirSync(path.join(root, "app"));
    const binary = path.join(root, "app", "daintree");
    fs.copyFileSync(sleeper, binary);
    fs.chmodSync(binary, 0o755);
    app = spawn(binary, ["30"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(status(false)).toBe("Daintree is running");
  });
});
