import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  E2E_SKIP_FIRST_RUN_DIALOGS_ARG,
  IDLE_HARNESS_ARG,
} from "../electron/setup/runtimeFlags.ts";
import { IDLE_HARNESS_CONFIG_ENV } from "../electron/services/idleHarnessMeasurement.ts";
import { SPAWN_CENSUS_DIR_ENV } from "../electron/utils/spawnCensus.ts";
import {
  CENSUS_DIR_ENV,
  CONFIG_ENV,
  IDLE_HARNESS_ARGS,
  cellConfig,
  cellName,
  distributeTerminals,
  enumerateMatrix,
  extractIdleResult,
  headline,
  judgeRun,
  parseArgs,
  reapProcessGroup,
  sanitizeEnv,
  stats,
  summariseCell,
} from "./run-idle-harness.mjs";

describe("launch contract", () => {
  it("speaks the app's flag and environment names", () => {
    expect(IDLE_HARNESS_ARGS).toContain(IDLE_HARNESS_ARG);
    expect(IDLE_HARNESS_ARGS).toContain(E2E_SKIP_FIRST_RUN_DIALOGS_ARG);
    expect(CONFIG_ENV).toBe(IDLE_HARNESS_CONFIG_ENV);
    expect(CENSUS_DIR_ENV).toBe(SPAWN_CENSUS_DIR_ENV);
  });

  it("keeps GPU compositing on, unlike the freeze harness", () => {
    expect(IDLE_HARNESS_ARGS).not.toContain("--disable-gpu");
    expect(IDLE_HARNESS_ARGS).not.toContain("--disable-software-rasterizer");
  });
});

describe("parseArgs", () => {
  it("defaults to one quiet, focused project for five minutes", () => {
    expect(parseArgs([])).toEqual({
      options: {
        projects: 1,
        terminals: 0,
        runs: 1,
        windowSeconds: 300,
        settleSeconds: 30,
        stream: false,
        blurred: false,
        all: false,
        json: null,
      },
    });
  });

  it("reads every flag", () => {
    const { options } = parseArgs([
      "--projects=3",
      "--terminals=19",
      "--stream",
      "--blurred",
      "--runs=4",
      "--window-seconds=60",
      "--settle-seconds=0",
      "--json=/tmp/idle.json",
    ]);
    expect(options).toMatchObject({
      projects: 3,
      terminals: 19,
      stream: true,
      blurred: true,
      runs: 4,
      windowSeconds: 60,
      settleSeconds: 0,
      json: path.resolve("/tmp/idle.json"),
    });
  });

  it("rejects what it cannot honour", () => {
    expect(parseArgs(["--stream"]).errors).toEqual(["--stream needs at least one terminal"]);
    expect(parseArgs(["--projects=6"]).errors).toHaveLength(1);
    expect(parseArgs(["--projects=0"]).errors).toHaveLength(1);
    expect(parseArgs(["--terminals=1.5"]).errors).toHaveLength(1);
    expect(parseArgs(["--json="]).errors).toEqual(["--json needs a path"]);
    expect(parseArgs(["--disable-gpu"]).errors).toEqual(["unknown argument --disable-gpu"]);
    expect(parseArgs(["--all=false"]).errors).toEqual(["--all takes no value"]);
    expect(parseArgs(["--terminals=1", "--stream=false"]).errors).toEqual([
      "--stream takes no value",
    ]);
  });

  it("lets --all stand in for a single cell's stream flag", () => {
    expect(parseArgs(["--all", "--stream"]).options.all).toBe(true);
  });
});

describe("distributeTerminals", () => {
  it("splits evenly with the remainder on the active side", () => {
    expect(distributeTerminals(1, 19)).toEqual([19]);
    expect(distributeTerminals(3, 19)).toEqual([7, 6, 6]);
    expect(distributeTerminals(5, 19)).toEqual([4, 4, 4, 4, 3]);
    expect(distributeTerminals(3, 0)).toEqual([0, 0, 0]);
    expect(distributeTerminals(3, 1)).toEqual([1, 0, 0]);
  });
});

describe("enumerateMatrix", () => {
  it("is the issue's 18 valid cells, none streaming without a terminal", () => {
    const cells = enumerateMatrix();
    expect(cells).toHaveLength(18);
    expect(new Set(cells.map(cellName)).size).toBe(18);
    expect(cells.some((cell) => cell.stream && cell.terminals === 0)).toBe(false);
    for (const projects of [1, 3, 5]) {
      expect(cells.filter((cell) => cell.projects === projects)).toHaveLength(6);
    }
  });
});

describe("cellConfig", () => {
  const base = { windowSeconds: 300, settleSeconds: 30, samplerPath: "/tmp/s" };

  it("protects a cached project only when one exists with a terminal", () => {
    expect(cellConfig({ projects: 3, terminals: 19, stream: true, blurred: false }, base)).toEqual({
      cell: "p3-t19-stream-focused",
      terminalsPerProject: [7, 6, 6],
      stream: true,
      blurred: false,
      protectedProjectIndex: 1,
      windowMs: 300_000,
      settleMs: 30_000,
      samplerPath: "/tmp/s",
    });
    expect(
      cellConfig({ projects: 1, terminals: 19, stream: false, blurred: true }, base)
        .protectedProjectIndex
    ).toBeNull();
    expect(
      cellConfig({ projects: 5, terminals: 0, stream: false, blurred: false }, base)
        .protectedProjectIndex
    ).toBeNull();
    expect(
      cellConfig({ projects: 3, terminals: 1, stream: true, blurred: false }, base)
        .protectedProjectIndex
    ).toBeNull();
  });
});

describe("sanitizeEnv", () => {
  it("drops inherited Daintree switches and run-as-Node flags", () => {
    expect(
      sanitizeEnv({
        PATH: "/usr/bin",
        HOME: "/Users/x",
        DAINTREE_E2E_MODE: "1",
        daintree_demo: "1",
        ELECTRON_RUN_AS_NODE: "1",
        ATOM_SHELL_INTERNAL_RUN_AS_NODE: "1",
        EMPTY: undefined,
      })
    ).toEqual({ PATH: "/usr/bin", HOME: "/Users/x" });
  });
});

describe("extractIdleResult", () => {
  it("parses the last RESULT line", () => {
    const output =
      '[IDLE-HARNESS] RESULT {"cell":"old"}\nnoise\n[IDLE-HARNESS] RESULT {"cell":"new"}\n[IDLE-HARNESS] COMPLETE\n';
    expect(extractIdleResult(output)).toEqual({ cell: "new" });
  });

  it("returns null when absent or torn", () => {
    expect(extractIdleResult("nothing")).toBeNull();
    expect(extractIdleResult('[IDLE-HARNESS] RESULT {"cell":')).toBeNull();
  });
});

describe("judgeRun", () => {
  const ok = { code: 0, signal: null, timedOut: false, output: "[IDLE-HARNESS] COMPLETE\n" };
  const result = { valid: true, failures: [] };

  it("accepts a complete, valid run whatever its numbers", () => {
    expect(judgeRun(ok, result)).toBeNull();
  });

  it("names why a run does not count", () => {
    expect(judgeRun({ ...ok, timedOut: true }, result)).toBe("timed out");
    expect(judgeRun(ok, null)).toBe("no RESULT line");
    expect(judgeRun(ok, { valid: false, failures: ["a", "b"] })).toBe("a; b");
    expect(judgeRun({ ...ok, code: 1 }, result)).toBe("exited with code 1 (signal null)");
    expect(judgeRun({ ...ok, output: "" }, result)).toBe("no COMPLETE marker");
    expect(judgeRun({ ...ok, output: "[IDLE-HARNESS] FAILED — x\n" }, result)).toBe(
      "harness reported a failure"
    );
  });
});

describe("stats / summariseCell", () => {
  it("reports min, median and max over finite values", () => {
    expect(stats([3, 1, null, 2, Number.NaN])).toEqual({ n: 3, min: 1, median: 2, max: 3 });
    expect(stats([4, 1])).toEqual({ n: 2, min: 1, median: 2.5, max: 4 });
    expect(stats([])).toBeNull();
  });

  it("aggregates headline figures and per-label CPU across runs", () => {
    const run = (cpu, gpu) => ({
      tree: {
        cpuPercent: cpu,
        idleWakeupsPerSec: 10,
        interruptWakeupsPerSec: 20,
        byLabel: { gpu: { cpuPercent: gpu } },
      },
      spawns: { perSecond: 1 },
      daemons: { sysmond: { cpuPercent: 0.5 }, fseventsd: null },
      workspaceHosts: { restarts: 0 },
      resourceProfile: { transitions: [] },
    });
    expect(headline(run(1, 0.2))).toEqual({
      cpuPercent: 1,
      idleWakeupsPerSec: 10,
      interruptWakeupsPerSec: 20,
      spawnsPerSec: 1,
      sysmondCpuPercent: 0.5,
      fseventsdCpuPercent: null,
      workspaceHostRestarts: 0,
      profileTransitions: 0,
    });
    const summary = summariseCell([run(1, 0.2), run(3, 0.6), run(2, 0.4)]);
    expect(summary.cpuPercent).toEqual({ n: 3, min: 1, median: 2, max: 3 });
    expect(summary.fseventsdCpuPercent).toBeNull();
    expect(summary.cpuPercentByLabel.gpu).toEqual({ n: 3, min: 0.2, median: 0.4, max: 0.6 });
  });
});

describe("reapProcessGroup", () => {
  it("kills the whole group, addressed by the negated leader pid", () => {
    const calls = [];
    const kill = (pid, signal) => calls.push([pid, signal]);
    expect(reapProcessGroup(4321, { platform: "darwin", kill })).toBe(true);
    expect(calls).toEqual([[-4321, "SIGKILL"]]);
  });

  it("never signals without a real group to aim at", () => {
    const kill = () => {
      throw new Error("must not be called");
    };
    expect(reapProcessGroup(4321, { platform: "win32", kill })).toBe(false);
    expect(reapProcessGroup(undefined, { platform: "darwin", kill })).toBe(false);
    expect(reapProcessGroup(0, { platform: "darwin", kill })).toBe(false);
  });

  it("treats an already-empty group as nothing to do", () => {
    const kill = () => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };
    expect(reapProcessGroup(4321, { platform: "darwin", kill })).toBe(false);
  });
});
