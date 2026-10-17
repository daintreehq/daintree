import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real filesystem calls, against a disk of Windows paths with a dead share.
vi.mock("node:fs", async (importOriginal) =>
  (await import("./helpers/virtualWindowsFs.js")).withVirtualWindowsFiles(await importOriginal())
);

import { virtualWindowsFiles } from "./helpers/virtualWindowsFs.js";
import {
  buildWindowsAgentLaunchScript,
  resolveWindowsAgentExecutable,
} from "../windowsAgentLaunch.js";
import { cliSpawnTarget } from "../windowsCliSpawn.js";
import { resetWindowsExecutableCache } from "../windowsExecutable.js";

const npm = "C:\\Users\\me\\AppData\\Roaming\\npm";
const node = "C:\\Program Files\\nodejs\\node.exe";
const script = `${npm}\\node_modules\\codex\\cli.js`;
const env = {
  Path: `\\\\nas\\tools;${npm};C:\\Program Files\\nodejs`,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  SystemRoot: "C:\\Windows",
};

beforeEach(() => {
  resetWindowsExecutableCache();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  virtualWindowsFiles.set(
    {
      [`${npm}\\codex.cmd`]:
        '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\codex\\cli.js" %*\r\n',
      [script]: "",
      [node]: "",
    },
    { hang: ["\\\\nas\\tools"] }
  );
  virtualWindowsFiles.syncCalls.length = 0;
});

afterEach(() => {
  virtualWindowsFiles.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a Windows agent launch with a dead share first on PATH", () => {
  it("resolves the npm shim and its Node without one synchronous filesystem call", async () => {
    const command = "codex --model gpt-5";
    let settled = false;
    const resolving = resolveWindowsAgentExecutable(command, { env, cwd: "C:\\project" }).then(
      (executable) => {
        settled = true;
        return executable;
      }
    );

    // The loop keeps turning while the share holds its call; the lookup waits
    // for it only as long as the PATH entry timeout.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    const executable = await resolving;

    const launch = buildWindowsAgentLaunchScript(command, executable, env);
    expect(launch).toContain(`$start.FileName = '${node}'`);
    expect(launch).toContain(`"${script}" "--model" "gpt-5"`);
    expect(virtualWindowsFiles.syncCalls).toEqual([]);
  });

  it("answers version and help probes the same way, past the share already written off", async () => {
    await vi.advanceTimersByTimeAsync(0);
    const first = cliSpawnTarget("codex", ["--version"], "win32", { env });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(first).resolves.toEqual({
      command: node,
      args: [script, "--version"],
      shell: false,
    });

    // Written off now: the next probe does not wait on it again.
    let settled = false;
    void cliSpawnTarget("codex", ["--help"], "win32", { env }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(virtualWindowsFiles.syncCalls).toEqual([]);
  });
});
