import childProcess, { execFileSync as namedExecFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandKey,
  flushSpawnCensus,
  installSpawnCensus,
  installSpawnCensusFromEnv,
  isSpawnCensusInstalled,
  readSpawnCensus,
  runUncounted,
  SPAWN_CENSUS_DIR_ENV,
  uninstallSpawnCensus,
  type SpawnCensusFile,
} from "../spawnCensus.js";

/** Node's internal launch method; untyped in @types/node. */
function prototypeSpawn(): unknown {
  return (childProcess.ChildProcess.prototype as unknown as { spawn: unknown }).spawn;
}

function totals(file: SpawnCensusFile | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const counts of Object.values(file?.buckets ?? {})) {
    for (const [command, count] of Object.entries(counts))
      out[command] = (out[command] ?? 0) + count;
  }
  return out;
}

describe("commandKey", () => {
  it("keeps only the executable's basename", () => {
    expect(commandKey("/usr/bin/git", ["git", "status", "--porcelain"])).toBe("git");
    expect(commandKey("ps", [])).toBe("ps");
  });

  it("names what a shell ran with -c, by its first word", () => {
    expect(commandKey("/bin/sh", ["/bin/sh", "-c", "ps -o pid= -g 123"])).toBe("sh -c ps");
    expect(commandKey("/bin/zsh", ["-c", '"/usr/bin/lsof" -p 1'])).toBe("zsh -c lsof");
    expect(commandKey("cmd.exe", ["/d", "/s", "/c", "tasklist /fo csv"])).toBe(
      "cmd.exe -c tasklist"
    );
  });

  it("falls back when there is nothing to name", () => {
    expect(commandKey(undefined)).toBe("(unknown)");
    expect(commandKey("/bin/sh", ["-i"])).toBe("sh");
  });
});

describe("spawn census", () => {
  let dir: string;
  const originals = {
    spawnSync: childProcess.spawnSync,
    execSync: childProcess.execSync,
    execFileSync: childProcess.execFileSync,
    spawn: prototypeSpawn(),
  };

  // Node itself rather than `true`/`echo`/`sh`: those exist on a Windows machine
  // only when Git's usr/bin happens to be on PATH, as it is on CI runners.
  const NODE = process.execPath;
  const NODE_KEY = path.basename(NODE);
  const NOOP = ["-e", "0"];
  const SHELL_BUILTIN = process.platform === "win32" ? "ver" : "true";
  const DEFAULT_SHELL = process.platform === "win32" ? "cmd.exe" : "sh";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-census-test-"));
  });

  afterEach(() => {
    uninstallSpawnCensus();
    delete process.env[SPAWN_CENSUS_DIR_ENV];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts async and sync launches by command", async () => {
    expect(installSpawnCensus("main", dir)).toBe(true);

    childProcess.spawnSync(NODE, NOOP);
    childProcess.execSync(SHELL_BUILTIN);
    childProcess.execFileSync(NODE, NOOP);
    namedExecFileSync(NODE, NOOP);
    await promisify(childProcess.execFile)(NODE, NOOP);
    await promisify(childProcess.exec)(SHELL_BUILTIN);
    await new Promise((resolve) => childProcess.spawn(NODE, NOOP).on("close", resolve));

    expect(totals(readSpawnCensus())).toEqual({
      [NODE_KEY]: 5,
      [`${DEFAULT_SHELL} -c ${SHELL_BUILTIN}`]: 2,
    });
  });

  it("names the shell a sync launch actually ran", () => {
    installSpawnCensus("main", dir);
    const command = process.platform === "win32" ? "ver" : "true";
    const explicitShell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    childProcess.spawnSync(command, undefined, { shell: true });
    childProcess.spawnSync(command, { shell: explicitShell });
    childProcess.execFileSync(command, { shell: true });
    childProcess.execSync(command, { shell: explicitShell });
    expect(totals(readSpawnCensus())).toEqual(
      process.platform === "win32"
        ? { "cmd.exe -c ver": 4 }
        : { "sh -c true": 2, "bash -c true": 2 }
    );
  });

  it("keeps each call's return value and errors", () => {
    installSpawnCensus("main", dir);
    expect(
      childProcess.execFileSync(NODE, ["-e", "process.stdout.write('hi\\n')"], { encoding: "utf8" })
    ).toBe("hi\n");
    expect(childProcess.spawnSync(NODE, ["-e", "process.exit(3)"]).status).toBe(3);
    expect(() => childProcess.execFileSync(NODE, ["-e", "process.exit(1)"])).toThrow();
  });

  it("leaves launches inside runUncounted out", () => {
    installSpawnCensus("main", dir);
    runUncounted(() => childProcess.execFileSync(NODE, NOOP));
    childProcess.execFileSync(NODE, NOOP);
    expect(totals(readSpawnCensus())).toEqual({ [NODE_KEY]: 1 });
  });

  it("writes an atomic per-process snapshot", () => {
    installSpawnCensus("pty-host", dir);
    childProcess.execFileSync(NODE, NOOP);
    flushSpawnCensus(true);

    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^pty-host-${process.pid}-\\d+\\.json$`));
    const file = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8")) as SpawnCensusFile;
    expect(file).toMatchObject({ version: 1, role: "pty-host", pid: process.pid, exited: true });
    expect(totals(file)).toEqual({ [NODE_KEY]: 1 });
  });

  it("restores Node's functions on uninstall", () => {
    installSpawnCensus("main", dir);
    expect(childProcess.spawnSync).not.toBe(originals.spawnSync);
    uninstallSpawnCensus();
    expect(childProcess.spawnSync).toBe(originals.spawnSync);
    expect(childProcess.execSync).toBe(originals.execSync);
    expect(childProcess.execFileSync).toBe(originals.execFileSync);
    expect(prototypeSpawn()).toBe(originals.spawn);
    expect(isSpawnCensusInstalled()).toBe(false);
  });

  it("installs from the environment only when asked and allowed", () => {
    expect(installSpawnCensusFromEnv("main")).toBe(false);

    process.env[SPAWN_CENSUS_DIR_ENV] = dir;
    expect(installSpawnCensusFromEnv("main", { allowed: false })).toBe(false);
    expect(process.env[SPAWN_CENSUS_DIR_ENV]).toBeUndefined();
    expect(isSpawnCensusInstalled()).toBe(false);

    process.env[SPAWN_CENSUS_DIR_ENV] = dir;
    expect(installSpawnCensusFromEnv("main")).toBe(true);
    expect(isSpawnCensusInstalled()).toBe(true);
    expect(installSpawnCensus("main", dir)).toBe(false);
  });
});
