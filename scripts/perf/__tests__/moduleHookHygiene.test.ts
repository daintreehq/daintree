import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Does importing the scenario matrix register a process-global module hook?
 *
 * It must not. `scenarios/index.ts` imports every scenario module eagerly, so
 * anything a fixture does at module scope is done in EVERY perf process,
 * whichever id `--scenario` names. A `module.registerHooks` call there is the
 * worst version of that: Node runs resolve hooks last-registered-first, so
 * whichever fixture happened to be imported last silently owned the `electron`
 * specifier for every other family. Thirteen scenarios — PERF-057/058,
 * PERF-320..325 and PERF-360..364 — were dead on that for an unknown length of
 * time, and PERF-074..077 were revived only by a later fixture registering a
 * SECOND hook to shadow the first back out. That is a fix whose correctness
 * depends on import order.
 *
 * The invariant here replaces both. Every fixture registers its hooks from its
 * own loader, so the seam exists in the runs that asked for it and nowhere
 * else, and no fixture has to out-order another.
 *
 * TWO CHECKS, because either alone is weak:
 *
 *   1. BEHAVIOURAL — `moduleHookProbe.ts` patches `module.registerHooks` and
 *      `module.register`, imports the whole matrix, and reports every
 *      registration with the frame that made it. This catches a hook installed
 *      at import time by any route, including a transitive one.
 *   2. LEXICAL — no `lib/*.ts` may call an installer at column zero. This
 *      catches a fixture that would register at import time but happens to bail
 *      early today (`if (process.env.VITEST) return;` sits above the
 *      registration in every one of them), which the probe cannot see.
 *
 * The probe proves itself before its result is trusted: it registers one inert
 * identity hook after the matrix is loaded and reports whether its own counter
 * saw it, so a probe that patched the wrong object fails rather than passing a
 * dirty matrix.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERF_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(PERF_ROOT, "../..");
const PROBE = path.join(HERE, "moduleHookProbe.ts");
const LIB_DIR = path.join(PERF_ROOT, "lib");

/** Importing 156 scenario modules under tsx, cold. */
const PROBE_TIMEOUT_MS = 120_000;

interface ProbeResult {
  ok: boolean;
  message?: string;
  patchedApis?: string[];
  scenarioCount?: number;
  selfCheckObserved?: boolean;
  registrations?: Array<{ api: string; origin: string }>;
}

/**
 * The child must NOT look like a Vitest process. Every fixture skips its
 * registration when `VITEST` is set, so an inherited flag would turn this into
 * a probe that can never fail.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("VITEST")) continue;
    env[key] = value;
  }
  return env;
}

function runProbe(): Promise<{ result: ProbeResult | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", PROBE], {
      cwd: REPO_ROOT,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.on("close", () => {
      clearTimeout(timer);
      const line = stdout
        .split("\n")
        .map((raw) => raw.trim())
        .filter(Boolean)
        .at(-1);
      let result: ProbeResult | null = null;
      if (line !== undefined) {
        try {
          result = JSON.parse(line) as ProbeResult;
        } catch {
          result = null;
        }
      }
      resolve({ result, stdout, stderr });
    });
  });
}

describe("perf fixture module-hook hygiene", () => {
  it(
    "registers no module hook while the whole scenario matrix is imported",
    async () => {
      const { result, stdout, stderr } = await runProbe();

      expect(
        result,
        `moduleHookProbe produced no JSON line.\nstdout: ${stdout.slice(-800)}\nstderr: ${stderr.slice(-800)}`
      ).not.toBeNull();
      const probe = result as ProbeResult;
      expect(probe.ok, probe.message ?? "probe failed").toBe(true);

      // The probe's own apparatus check. Without it a probe that patched the
      // wrong object would report a clean matrix forever.
      expect(probe.patchedApis, "probe patched no module API").not.toEqual([]);
      expect(probe.selfCheckObserved, "the probe did not observe its own hook").toBe(true);
      expect(probe.scenarioCount ?? 0).toBeGreaterThan(100);

      const registrations = probe.registrations ?? [];
      const detail = registrations.map((entry) => `${entry.api} ${entry.origin}`).join("\n");
      expect(
        registrations,
        `A fixture registered a module hook at import time. ` +
          `scenarios/index.ts imports every scenario module, so this hook is live in every ` +
          `perf run and decides the 'electron' specifier for families that never asked for ` +
          `it. Register it from the fixture's own loader instead.\n${detail}`
      ).toEqual([]);
    },
    PROBE_TIMEOUT_MS + 30_000
  );

  it("has no lib/ fixture mutating process-global state at module scope", () => {
    // Column zero inside a `lib/*.ts` module is module scope. Every installer in
    // this directory is a top-level `function`, so its call sites are either
    // indented (inside a loader) or not; and an environment write is the same
    // defect with a different global — `process.env` is inherited by every child
    // a fixture forks, so one fixture's flag reaches another family's subject.
    const patterns: ReadonlyArray<readonly [RegExp, string]> = [
      [/^[a-zA-Z_$][a-zA-Z0-9_$]*\(\);?\s*$/, "bare call"],
      [/^process\.env\b.*=/, "environment write"],
    ];
    const offenders: string[] = [];

    for (const entry of readdirSync(LIB_DIR)) {
      if (!entry.endsWith(".ts")) continue;
      const lines = readFileSync(path.join(LIB_DIR, entry), "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const [pattern, kind] of patterns) {
          if (!pattern.test(line)) continue;
          offenders.push(`${entry}:${index + 1}: ${kind}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `A lib/ fixture mutates process-global state at module scope. ` +
        `scenarios/index.ts imports every scenario module, so it does so in EVERY perf ` +
        `run — move it into the fixture's own loader.\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
