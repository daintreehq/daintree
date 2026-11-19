import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpDiscoveryFile } from "../electron/services/mcp-server/discoveryFile.js";
import {
  daintreeProfileDir,
  startFakeDaintreeApp,
  stopProcess,
} from "../electron/services/mcp-server/__tests__/helpers/fakeDaintreeApp.js";

const SCRIPT_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "daintree-cli.sh");

// Executes the shipped CLI with the app launch stubbed out, then reports the
// argv the launcher actually received. This is what makes the single-token
// `--cli-path=<path>` guarantee testable: asserting the script's source text
// would only restate it, whereas a displaced or word-split value shows up here
// as two argv entries instead of one (#11410).
interface CliOptions {
  cwd?: string;
  env?: Record<string, string>;
}

interface CliRun {
  /** What the stub received, in order; empty when it was never started. */
  argv: string[];
  /** Whether the stub was started at all, even with no arguments. */
  launched: boolean;
  root: string;
  status: number | null;
  stderr: string;
}

async function runCliWith(
  args: string[],
  { expectLaunch, cwd, env }: CliOptions & { expectLaunch: boolean }
): Promise<CliRun> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-sh-"));
  try {
    const argvFile = path.join(root, "argv");
    const binDir = path.join(root, "shim");
    fs.mkdirSync(binDir);

    const recorder = [
      "#!/usr/bin/env bash",
      // NUL-delimited so a value containing spaces stays one field. The redirect
      // creates the file the moment the stub starts, even with no arguments, so
      // the file's existence is the launch record.
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

    const result = spawnSync("bash", [scriptPath, ...args], {
      env: {
        ...process.env,
        ...env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf-8",
      cwd,
      // The backgrounded Linux launch holds stderr open, so a stalled one would
      // block here before the polling deadline below starts.
      timeout: 10_000,
    });
    if (result.error) throw result.error;

    // The Linux branch backgrounds the launch and exits immediately, and the
    // recorder's `>` redirect creates the file before writing it, so wait for a
    // trailing NUL rather than for the file to merely exist. A refused invocation
    // only gets a short grace period: it must never reach the launch at all.
    const deadline = Date.now() + (expectLaunch ? 5000 : 300);
    let raw = "";
    while (Date.now() < deadline) {
      raw = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf-8") : "";
      if (raw.endsWith("\0")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return {
      argv: raw.split("\0").filter((entry) => entry.length > 0),
      launched: fs.existsSync(argvFile),
      root,
      status: result.status,
      stderr: result.stderr,
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function runCli(
  target: string,
  opts: CliOptions = {}
): Promise<{ argv: string[]; root: string }> {
  const result = await runCliWith([target], { ...opts, expectLaunch: true });
  if (result.status !== 0) {
    fs.rmSync(result.root, { recursive: true, force: true });
    throw new Error(`daintree CLI exited ${result.status}: ${result.stderr}`);
  }
  return result;
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

  it.each([false, true])(
    "resolves a relative folder once (exported CDPATH: %s)",
    async (exported) => {
      const { argv, root } = await runCli("my project", {
        cwd: workspace,
        env: exported ? { CDPATH: workspace } : { CDPATH: "" },
      });
      roots.push(root);
      expect(argv).toEqual([
        ...argv.filter((a) => !a.startsWith("--cli-path=")),
        `--cli-path=${fs.realpathSync(projectDir)}`,
      ]);
      expect(argv.filter((a) => a.startsWith("--cli-path="))).toHaveLength(1);
    }
  );

  it("never emits the flag and the path as two separate arguments", async () => {
    const { argv, root } = await runCli(projectDir);
    roots.push(root);

    // The #11410 failure mode: a bare `--cli-path` switch whose value is a
    // detached positional Chromium is free to displace.
    expect(argv).not.toContain("--cli-path");
    expect(argv.filter((entry) => entry.startsWith("--cli-path"))).toHaveLength(1);
  });

  // An unquoted `daintree ~/my project` reaches the script as two operands, the
  // first of which can be a real folder: opening it would be a wrong project and a
  // successful exit.
  it("refuses extra operands with a usage error and never launches the app", async () => {
    const other = path.join(workspace, "other");
    fs.mkdirSync(other);

    const refused = await runCliWith([projectDir, other], { expectLaunch: false });
    roots.push(refused.root);

    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("expected one directory, got 2 arguments");
    expect(refused.stderr).toContain("Usage: daintree [directory]");
    expect(refused.launched).toBe(false);
  });

  it("counts every extra operand, whether or not it names a folder", async () => {
    const refused = await runCliWith(
      [projectDir, path.join(workspace, "no-such-dir"), path.join(workspace, "notes.txt")],
      { expectLaunch: false }
    );
    roots.push(refused.root);

    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("got 3 arguments");
    expect(refused.launched).toBe(false);
  });

  // The usage error must come before directory validation: with a missing first
  // operand the cause is the operand count, and "not a directory" (exit 1) would
  // point the user at the wrong problem.
  it("reports the operand count before checking whether the first operand exists", async () => {
    const refused = await runCliWith([path.join(workspace, "no-such-dir"), projectDir], {
      expectLaunch: false,
    });
    roots.push(refused.root);

    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("got 2 arguments");
    expect(refused.stderr).not.toContain("is not a directory");
    expect(refused.launched).toBe(false);
  });

  it("opens the current directory when no operand is given", async () => {
    const opened = await runCliWith([], { expectLaunch: true, cwd: projectDir });
    roots.push(opened.root);

    expect(opened.status).toBe(0);
    expect(opened.argv).toContain(`--cli-path=${fs.realpathSync(projectDir)}`);
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

  // A tarball install: no binary beside the script, so launching falls through
  // to PATH, where the installed name is the wrapper itself (#17474).
  function pathFallbackLayout() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-path-"));
    roots.push(root);
    const script = path.join(root, "res", "daintree-cli.sh");
    fs.mkdirSync(path.dirname(script));
    fs.copyFileSync(SCRIPT_SOURCE, script);
    fs.chmodSync(script, 0o755);
    const launches = path.join(root, "launches");
    const argvFile = path.join(root, "argv");
    const binDir = (name: string) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      return dir;
    };
    const app = (dir: string, name: string) => {
      const binary = path.join(dir, name);
      fs.writeFileSync(
        binary,
        `#!/usr/bin/env bash\necho "$0" >> ${JSON.stringify(launches)}\nprintf '%s\\0' "$@" > ${JSON.stringify(argvFile)}\n`,
        { mode: 0o755 }
      );
      return binary;
    };
    const wrapperDir = binDir("wrapper-bin");
    const link = path.join(wrapperDir, "daintree");
    fs.symlinkSync(script, link);

    const run = (pathDirs: string[], invoke = link) => {
      // An empty APPDIR still makes the script try /daintree; BASH_ENV can seed
      // bash's command hash and change what the lookup returns.
      const env: NodeJS.ProcessEnv = { ...process.env, APPDIR: path.join(root, "no-appdir") };
      delete env.BASH_ENV;
      env.PATH = [...pathDirs, process.env.PATH ?? ""].join(path.delimiter);
      const { status, stderr, error } = spawnSync("bash", [invoke, projectDir], {
        encoding: "utf-8",
        env,
        timeout: 10_000,
      });
      if (error) throw error;
      return { code: status, stderr };
    };
    // The recorder appends its own path, so a second launch would show as a second line.
    const read = () => ({
      binaries: fs.existsSync(launches)
        ? fs.readFileSync(launches, "utf-8").split("\n").filter(Boolean)
        : [],
      argv: fs.existsSync(argvFile)
        ? fs.readFileSync(argvFile, "utf-8").slice(0, -1).split("\0")
        : [],
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
    // The launch is backgrounded, so wait for the recorder to finish writing.
    const launched = async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !fs.existsSync(argvFile)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await settle();
      return read();
    };
    const idle = async () => {
      await settle();
      return read();
    };
    return { script, link, wrapperDir, binDir, app, run, launched, idle };
  }

  // The fallback would reach a real install through the fixed package paths or
  // PATH and launch it, so these only run where none exists (CI).
  const executable = (candidate: string, mustBeFile: boolean) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      // A directory on PATH is not a match, but the script takes a fixed path
      // on -x alone.
      return !mustBeFile || fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  const appInstalled =
    ["/opt/Daintree/daintree", "/opt/Daintree/daintree-app"].some((c) => executable(c, false)) ||
    (process.env.PATH ?? "")
      .split(path.delimiter)
      .flatMap((dir) => ["daintree", "daintree-app"].map((name) => path.join(dir, name)))
      .some((c) => executable(c, true));

  describe.skipIf(process.platform !== "linux" || appInstalled)(
    "PATH fallback with the wrapper installed on PATH",
    () => {
      it("skips the wrapper and launches the daintree-app after it exactly once", async () => {
        const layout = pathFallbackLayout();
        const binary = layout.app(layout.binDir("app-bin"), "daintree-app");
        const result = layout.run([layout.wrapperDir, path.dirname(binary)]);
        expect(result.code).toBe(0);
        expect(await layout.launched()).toEqual({
          binaries: [binary],
          argv: [`--cli-path=${fs.realpathSync(projectDir)}`],
        });
      });

      it("keeps looking past the wrapper for another match of the same name", async () => {
        const layout = pathFallbackLayout();
        const early = layout.app(layout.binDir("early-bin"), "daintree-app");
        const later = layout.app(layout.binDir("later-bin"), "daintree");
        const result = layout.run([layout.wrapperDir, path.dirname(early), path.dirname(later)]);
        expect(result.code).toBe(0);
        // daintree is tried before daintree-app, wherever each sits on PATH.
        expect((await layout.launched()).binaries).toEqual([later]);
      });

      it("fails with an actionable message when the wrapper is the only match", async () => {
        const layout = pathFallbackLayout();
        const result = layout.run([layout.wrapperDir]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`CLI wrapper (${layout.link})`);
        expect(result.stderr).toContain("put its daintree or daintree-app executable on PATH");
        // A relaunched wrapper would complain about its --cli-path= argument.
        expect(result.stderr).not.toContain("not a directory");
        expect((await layout.idle()).binaries).toEqual([]);
      });

      it("reports a plain miss when the wrapper is not on PATH", () => {
        const layout = pathFallbackLayout();
        const result = layout.run([], layout.script);
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("daintree: Daintree executable not found.\n");
      });
    }
  );

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
    fs.mkdirSync(path.join(root, "app"));
    const binary = path.join(root, "app", "daintree");
    // Node, not `sleep`: Ubuntu 26.04's sleep is a uutils multicall binary
    // that dispatches on its own name, so a copy named daintree exits at once.
    fs.copyFileSync(process.execPath, binary);
    fs.chmodSync(binary, 0o755);
    app = spawn(binary, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(status(false)).toBe("Daintree is running");
  });
});

// `--status --json` for scripts (#17904): the port the running app published
// and the saved MCP setting, beside whether the app's processes are there.
// pgrep is stubbed to find nothing, so a Daintree running on the test machine
// can't decide `running`; only a live runtime file can.
describe.skipIf(process.platform === "win32")("daintree-cli.sh --status --json", () => {
  let home: string;
  let shim: string;
  let app: ChildProcess | null = null;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-json-home-"));
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-cli-json-shim-"));
    fs.writeFileSync(path.join(shim, "pgrep"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  });

  afterEach(async () => {
    if (app) await stopProcess(app);
    app = null;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(shim, { recursive: true, force: true });
  });

  const run = (...args: string[]) =>
    spawnSync("bash", [SCRIPT_SOURCE, ...args], {
      encoding: "utf8",
      env: { PATH: `${shim}${path.delimiter}${process.env.PATH ?? ""}`, HOME: home },
      timeout: 10_000,
    });

  const version = () =>
    run("--version")
      .stdout.trim()
      .replace(/^daintree /, "");

  function saveConfig(config: unknown): void {
    fs.mkdirSync(daintreeProfileDir(home), { recursive: true });
    fs.writeFileSync(
      path.join(daintreeProfileDir(home), "config.json"),
      typeof config === "string" ? config : JSON.stringify(config, null, 2),
      { mode: 0o600 }
    );
  }

  async function publishFromApp(port: number, bundle?: string): Promise<void> {
    app = await startFakeDaintreeApp(home, { bundle });
    fs.mkdirSync(daintreeProfileDir(home), { recursive: true });
    new McpDiscoveryFile({ dir: () => daintreeProfileDir(home), pid: app.pid! }).publish(port);
  }

  it("prints one JSON object with nulls for what it can't read, in every order of the flags", () => {
    for (const args of [
      ["--status", "--json"],
      ["-s", "--json"],
      ["--json", "--status"],
      ["--json", "-s"],
    ]) {
      const result = run(...args);
      expect(result.status).toBe(1);
      expect(result.stdout.endsWith("}\n")).toBe(true);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        version: version(),
        running: false,
        mcpEnabled: null,
        mcpPort: null,
      });
    }
  });

  it.each<[string, unknown, boolean | null]>([
    ["on", { mcpServer: { enabled: true, port: 45454, apiKey: "daintree_k" } }, true],
    [
      "off",
      { projects: { "a b": [1, { c: 'é "q" \\ }' }] }, mcpServer: { enabled: false } },
      false,
    ],
    ["not a boolean", { mcpServer: { enabled: "yes" } }, null],
    ["missing", { mcpServer: { port: 45454 } }, null],
    ["in a file that isn't JSON", '{"mcpServer":{"enabled":true}', null],
  ])("reads the saved MCP setting while nothing serves (%s)", (_name, config, enabled) => {
    saveConfig(config);

    const result = run("--status", "--json");

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      version: version(),
      running: false,
      mcpEnabled: enabled,
      mcpPort: null,
    });
  });

  it("reports the port a live app published, and the app as running", async () => {
    saveConfig({ mcpServer: { enabled: false } });
    await publishFromApp(45461);

    const result = run("--json", "--status");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: version(),
      running: true,
      mcpEnabled: true,
      mcpPort: 45461,
    });
  });

  it.runIf(process.platform === "darwin")(
    "knows the app by its executable under a bundle the user renamed",
    async () => {
      await publishFromApp(45463, "Daintree Work.app");

      expect(JSON.parse(run("--status", "--json").stdout)).toMatchObject({
        running: true,
        mcpPort: 45463,
      });
    }
  );

  it("reads past a runtime file whose app has exited", async () => {
    saveConfig({ mcpServer: { enabled: true } });
    await publishFromApp(45461);
    await stopProcess(app!);

    const result = run("--status", "--json");

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      running: false,
      mcpEnabled: true,
      mcpPort: null,
    });
  });

  it("keeps plain --status as text, and refuses anything more after --json", () => {
    const plain = run("--status");
    expect(plain.status).toBe(1);
    expect(plain.stdout).toBe("Daintree is not running\n");

    const extra = run("--status", "--json", "now");
    expect(extra.status).toBe(2);
    expect(extra.stdout).toBe("");
    expect(extra.stderr).toContain("--json");
  });
});
