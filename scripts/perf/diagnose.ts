import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBenchmark } from "./config/benchmarkClasses";
import { hashHarnessSources } from "./lib/harnessHash";
import type { PerfMode, PerfRunSummary } from "./types";

/**
 * `npm run perf diagnose` — the evidence-rich rerun, kept apart from the number.
 *
 * A measurement run answers "did this move". It cannot answer "why", and the
 * instrumentation that could would change the thing being measured. So they are
 * two runs: `perf smoke` takes the number, and this takes the evidence.
 *
 * THE RULE THAT MAKES IT USABLE
 *   A profiled run is SLOWER, sometimes by a lot, and its durations are not
 *   comparable to anything. Every artifact this writes is stamped accordingly
 *   and the manifest says so in a field a reader cannot miss, because the one
 *   way to waste a diagnostic bundle is to quote its timings back as a result.
 *
 * WHAT IT COLLECTS
 *   A V8 CPU profile and a heap allocation profile from the scenario's own
 *   process, the raw per-iteration samples, the summary with its full
 *   provenance, and a manifest tying them to a commit, a harness hash and a
 *   machine. That is the whole of what a plain-Node scenario can produce. The
 *   guide also asks for Chromium traces, screenshots and renderer profiles;
 *   those belong to a journey benchmark running under Electron and are not
 *   reachable from here, which the manifest states rather than leaving implied.
 *
 * WHY IT IS A SEPARATE COMMAND AND NOT A FLAG
 *   A flag on `run.ts` would put profiling one keystroke away from a run whose
 *   number someone means to keep, and the summary it wrote would look exactly
 *   like an ordinary one. The bundle is the boundary.
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(perfDir, "..", "..");

class UsageError extends Error {}

interface DiagnoseOptions {
  scenarioId: string;
  mode: PerfMode;
  outDir: string;
}

function parseArgs(argv: string[]): DiagnoseOptions {
  let scenarioId: string | undefined;
  let mode: PerfMode = "smoke";
  let outDir = path.resolve(process.cwd(), ".tmp/perf-diagnostics");

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${token} expects a value`);
      }
      i += 1;
      return value;
    };
    if (token === "--scenario") {
      scenarioId = next().toUpperCase();
      continue;
    }
    if (token === "--mode") {
      const value = next();
      if (!["smoke", "ci", "nightly", "soak"].includes(value)) {
        throw new UsageError(`unknown --mode ${value}`);
      }
      mode = value as PerfMode;
      continue;
    }
    if (token === "--out-dir") {
      outDir = path.resolve(process.cwd(), next());
      continue;
    }
    throw new UsageError(`unknown flag ${token}. Known: --scenario, --mode, --out-dir`);
  }

  if (!scenarioId) {
    throw new UsageError("--scenario is required and takes exactly one id");
  }
  return { scenarioId, mode, outDir };
}

function runProfiled(options: DiagnoseOptions, staging: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        // V8's own profilers. Both write into the staging directory, so the
        // bundle is assembled from what the run produced rather than from
        // anything this file reconstructs afterwards.
        "--cpu-prof",
        "--cpu-prof-dir",
        path.join(staging, "cpu"),
        "--heap-prof",
        "--heap-prof-dir",
        path.join(staging, "heap"),
        "--import",
        "tsx",
        path.join(perfDir, "run.ts"),
        "--mode",
        options.mode,
        "--scenario",
        options.scenarioId,
        "--label",
        "diagnostic",
        // STRUCTURAL: `run.ts` writes history only for a `benchmark` run, so a
        // profiled duration cannot reach the trend even if this line were
        // dropped. `--no-history` rides along as the explicit belt.
        "--purpose",
        "diagnostic",
        "--no-history",
        "--json",
        path.join(staging, "summary.json"),
        "--out-dir",
        path.join(staging, "results"),
      ],
      { stdio: ["ignore", "inherit", "inherit"], cwd: repoRoot }
    );
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

interface ArtifactRecord {
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * Each artifact with its size and digest.
 *
 * A bundle read a month later is only evidence if its contents can be shown to
 * be the ones the manifest describes; a filename cannot do that.
 */
function describeArtifacts(dir: string): ArtifactRecord[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(dir, entry.name);
        const contents = fs.readFileSync(full);
        return {
          name: entry.name,
          bytes: contents.length,
          sha256: createHash("sha256").update(contents).digest("hex"),
        };
      });
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");

  fs.mkdirSync(options.outDir, { recursive: true });
  // Assembled under a temporary name and renamed into place, so a bundle that
  // exists is always a bundle that finished. A half-written one is the shape
  // that gets read as complete a week later.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "perf-diagnose-"));
  const bundle = path.join(options.outDir, `${options.scenarioId}-${stamp}`);

  console.log(
    `[diagnose] ${options.scenarioId} under the CPU and heap profilers. ` +
      `Every duration this produces is inflated by the instrumentation and is ` +
      `NOT comparable to a measured run.\n`
  );

  const code = await runProfiled(options, staging);
  if (code !== 0) {
    // Moved into place under a `-failed` name rather than left in a temp
    // directory the caller has to be told about, and rather than deleted: the
    // profiles a failed run produced are often the point. What must not happen
    // is a half-assembled bundle sitting under the ordinary name, where a later
    // reader takes it for a complete one.
    const failed = `${bundle}-failed`;
    try {
      fs.renameSync(staging, failed);
      console.error(`[diagnose] the scenario exited ${code}. Partial bundle: ${failed}`);
    } catch {
      fs.rmSync(staging, { recursive: true, force: true });
      console.error(`[diagnose] the scenario exited ${code} and the bundle could not be kept.`);
    }
    process.exitCode = 1;
    return;
  }

  let summary: PerfRunSummary | null = null;
  try {
    summary = JSON.parse(fs.readFileSync(path.join(staging, "summary.json"), "utf-8"));
  } catch {
    summary = null;
  }

  const benchmarkClass = classifyBenchmark(options.scenarioId);
  const manifest = {
    kind: "perf-diagnostic-bundle",
    schemaVersion: 1,
    scenarioId: options.scenarioId,
    mode: options.mode,
    startedAt: startedAt.toISOString(),
    // The single most important field. A reader who takes one thing from this
    // file should take this.
    durationsComparable: false,
    durationsComparableReason:
      "collected under --cpu-prof and --heap-prof, which inflate every timing; " +
      "compare against a run taken by `npm run perf <mode>` without profilers, never against this",
    benchmarkClass: benchmarkClass
      ? { kind: benchmarkClass.kind, family: benchmarkClass.family, claim: benchmarkClass.claim }
      : null,
    environment: summary?.environment ?? null,
    protocol: summary?.protocol ?? null,
    // `enforced: false, valid: true` reads as "checked and fine" when it means
    // "not checked". Stated as a status so it cannot.
    integrityStatus: summary?.integrity
      ? summary.integrity.enforced
        ? summary.integrity.valid
          ? "enforced-valid"
          : "enforced-invalid"
        : summary.integrity.valid
          ? "not-enforced-no-issues"
          : "not-enforced-issues-present"
      : "unknown",
    integrity: summary?.integrity ?? null,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
    },
    harnessHash: hashHarnessSources(),
    artifacts: {
      cpuProfiles: describeArtifacts(path.join(staging, "cpu")),
      heapProfiles: describeArtifacts(path.join(staging, "heap")),
      results: describeArtifacts(path.join(staging, "results")),
      summary: fs.existsSync(path.join(staging, "summary.json")) ? "summary.json" : null,
    },
    // Split, because "we did not collect it" covers two different facts and
    // conflating them tells a reader the wrong thing about what is possible.
    notApplicable: {
      items: [
        "Chromium trace, renderer CPU profile, long-animation-frame data",
        "screenshots at phase boundaries",
      ],
      reason:
        "this scenario runs in plain Node with no Electron and no renderer, so these do not " +
        "exist for it; they belong to a journey benchmark",
    },
    notImplemented: {
      items: ["process-tree and resource timeline", "application logs"],
      reason:
        "reachable in principle from a Node scenario and not built yet; the guide asks for " +
        "them and this bundle does not have them",
    },
    scope:
      "mechanism-benchmark diagnostics. The guide's §11.9 describes a journey rerun with " +
      "traces and screenshots; this is the plain-Node subset of it.",
  };

  fs.writeFileSync(
    path.join(staging, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8"
  );
  fs.renameSync(staging, bundle);

  console.log(`\n[diagnose] bundle: ${bundle}`);
  console.log(`[diagnose] manifest: ${path.join(bundle, "manifest.json")}`);
  const cpu = manifest.artifacts.cpuProfiles[0]?.name;
  if (cpu) {
    console.log(
      `[diagnose] open ${path.join(bundle, "cpu", cpu)} in Chrome DevTools ` +
        `(Performance > Load profile) to see where the time went`
    );
  }
  console.log(
    `[diagnose] durations in this bundle are inflated by the profilers. ` +
      `Take the number from an unprofiled run.`
  );
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`[diagnose] ${error.message}`);
  } else {
    console.error("[diagnose] failed", error);
  }
  process.exit(1);
});
