import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../run";
import { getScenariosForMode } from "../scenarios";

const execFileAsync = promisify(execFile);
const perfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(perfDir, "..", "..");

// Real ids from the real matrix — a hardcoded id would rot the day a scenario
// is renamed, and the point of these tests is that the parser agrees with the
// registry rather than with a copy of it.
const smokeIds = getScenariosForMode("smoke").map((scenario) => scenario.id);
const [firstId, secondId] = smokeIds;

describe("parseArgs — defaults", () => {
  it("runs the whole smoke matrix with no arguments", () => {
    const cli = parseArgs([]);
    expect(cli.mode).toBe("smoke");
    expect(cli.scenarioIds).toBeNull();
    expect(cli.updateBaseline).toBe(false);
    expect(cli.iterations).toBeUndefined();
    expect(cli.warmups).toBeUndefined();
  });

  it("derives the baseline path from the mode", () => {
    expect(parseArgs(["--mode", "nightly"]).baselinePath).toContain("baseline.nightly.json");
    expect(parseArgs(["--mode", "ci"]).baselinePath).toContain("baseline.ci.json");
  });
});

describe("parseArgs — strict rejection", () => {
  it("rejects a mistyped flag instead of running the whole matrix", () => {
    // The failure this strictness exists for: `--secnario` used to be dropped
    // silently, so a typo ran all 70 scenarios and looked like it had worked.
    expect(() => parseArgs(["--secnario", firstId])).toThrow(UsageError);
    expect(() => parseArgs(["--secnario", firstId])).toThrow(/Unknown flag --secnario/);
  });

  it("names the flags it does know so the typo is fixable from the message", () => {
    let message = "";
    try {
      parseArgs(["--iteration", "4"]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("--iterations");
    expect(message).toContain("--scenario");
  });

  it("rejects a stray positional argument", () => {
    expect(() => parseArgs([firstId])).toThrow(/Unexpected argument/);
  });

  it("rejects an unknown mode and lists the known ones", () => {
    expect(() => parseArgs(["--mode", "nightlyy"])).toThrow(/Invalid --mode/);
    expect(() => parseArgs(["--mode", "nightlyy"])).toThrow(/nightly/);
  });

  it("rejects a value flag with no value, including one swallowed by the next flag", () => {
    expect(() => parseArgs(["--scenario"])).toThrow(/--scenario expects a value/);
    expect(() => parseArgs(["--label", "--json", "out.json"])).toThrow(/--label expects a value/);
  });

  it("rejects a value handed to a switch", () => {
    expect(() => parseArgs(["--update-baseline=yes"])).toThrow(/takes no value/);
  });
});

describe("parseArgs — --scenario", () => {
  it("accepts repeated flags and comma-separated lists interchangeably", () => {
    const repeated = parseArgs(["--scenario", firstId, "--scenario", secondId]);
    const commas = parseArgs(["--scenario", `${firstId},${secondId}`]);
    expect(repeated.scenarioIds).toEqual([firstId, secondId]);
    expect(commas.scenarioIds).toEqual(repeated.scenarioIds);
  });

  it("dedupes and tolerates whitespace and lowercase input", () => {
    const cli = parseArgs(["--scenario", ` ${firstId.toLowerCase()}, ${firstId} `]);
    expect(cli.scenarioIds).toEqual([firstId]);
  });

  it("rejects an unknown id and lists what is available for the mode", () => {
    let message = "";
    try {
      parseArgs(["--scenario", "PERF-9999"]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("PERF-9999");
    expect(message).toContain(firstId);
  });

  it("rejects an id that exists but not in the requested mode", () => {
    const smokeSet = new Set(smokeIds);
    const nonSmokeId = getScenariosForMode("nightly")
      .map((scenario) => scenario.id)
      .find((id) => !smokeSet.has(id));
    // Guards the test itself: if every nightly scenario is also a smoke one
    // there is nothing to assert, and a silent pass would be misleading.
    expect(nonSmokeId).toBeDefined();
    expect(() => parseArgs(["--mode", "smoke", "--scenario", nonSmokeId!])).toThrow(
      /Unknown scenario id/
    );
    expect(() => parseArgs(["--mode", "nightly", "--scenario", nonSmokeId!])).not.toThrow();
  });
});

describe("parseArgs — sample-count overrides", () => {
  it("accepts a positive iteration count", () => {
    expect(parseArgs(["--iterations", "3"]).iterations).toBe(3);
  });

  it("rejects an iteration count that would measure nothing", () => {
    expect(() => parseArgs(["--iterations", "0"])).toThrow(/--iterations/);
    expect(() => parseArgs(["--iterations", "-2"])).toThrow(/--iterations/);
  });

  it("rejects a non-integer sample count rather than silently flooring it", () => {
    expect(() => parseArgs(["--iterations", "2.5"])).toThrow(/--iterations/);
    expect(() => parseArgs(["--warmups", "lots"])).toThrow(/--warmups/);
  });

  it("accepts zero warmups, which is a meaningful request", () => {
    expect(parseArgs(["--warmups", "0"]).warmups).toBe(0);
  });
});

describe("parseArgs — run identity", () => {
  it("carries label, json path, and machine override", () => {
    const cli = parseArgs([
      "--label",
      "before",
      "--json",
      "/tmp/before.json",
      "--machine",
      "greg-macbook",
    ]);
    expect(cli.label).toBe("before");
    expect(cli.jsonPath).toBe("/tmp/before.json");
    expect(cli.machineLabel).toBe("greg-macbook");
  });

  it("accepts the --flag=value form", () => {
    const cli = parseArgs([`--mode=ci`, `--label=after`, `--scenario=${firstId}`]);
    expect(cli.mode).toBe("ci");
    expect(cli.label).toBe("after");
    expect(cli.scenarioIds).toEqual([firstId]);
  });

  it("sets the update-baseline switch without consuming the next token", () => {
    const cli = parseArgs(["--update-baseline", "--label", "regen"]);
    expect(cli.updateBaseline).toBe(true);
    expect(cli.label).toBe("regen");
  });

  it("refuses to write a baseline from a filtered run", () => {
    // A baseline built from one scenario replaces every other scenario's
    // reference with nothing, and the file it produces is indistinguishable
    // from a complete one.
    expect(() => parseArgs(["--scenario", firstId, "--update-baseline"])).toThrow(
      /--update-baseline needs the whole matrix/
    );
    expect(() => parseArgs(["--update-baseline"])).not.toThrow();
  });

  it("rejects a repeated scalar flag rather than taking the last one", () => {
    // `index.ts` prepends `--mode <mode>`, so last-wins would let
    // `npm run perf smoke -- --mode nightly` run nightly under a smoke banner.
    expect(() => parseArgs(["--mode", "smoke", "--mode", "nightly"])).toThrow(
      /--mode given more than once/
    );
  });
});

describe("run.ts as a process", () => {
  // The parser tests above import the module, which is only safe because the
  // harness self-starts on an entrypoint check. If that check ever evaluated
  // false for a real invocation the harness would exit 0 having measured
  // nothing — invisible in every other test. These spawn the real thing.
  // A rejected flag fails during parsing, so no scenario is ever executed.
  async function runCli(args: string[]): Promise<{ code: number; stderr: string }> {
    try {
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", path.join(perfDir, "run.ts"), ...args],
        { cwd: repoRoot }
      );
      return { code: 0, stderr: "" };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
    }
  }

  it("exits non-zero with a single readable line on a bad flag", { timeout: 60_000 }, async () => {
    const { code, stderr } = await runCli(["--mode", "smoke", "--bogusflag"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown flag --bogusflag");
    // A usage mistake prints one line, not the harness-crash path and its stack.
    expect(stderr).not.toContain("run failed");
  });

  it("exits non-zero on an unknown scenario id", { timeout: 60_000 }, async () => {
    const { code, stderr } = await runCli(["--mode", "smoke", "--scenario", "PERF-9999"]);
    expect(code).toBe(1);
    expect(stderr).toContain("PERF-9999");
  });
});
