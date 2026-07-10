import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PERF_MARKS } from "../../shared/perf/marks";
import { findPackagedExecutable } from "./lib/packagedLaunch";
import { mean, percentile, round, stdDev } from "./lib/stats";

// Direct-spawn launch benchmark with interleaved A/B support.
//
// Like perf cold-start, this harness spawns the packaged executable directly
// and reads the app's own NDJSON perf marks (DAINTREE_PERF_CAPTURE). Its extra
// responsibility is interleaving two binaries so machine-state drift lands on
// both variants equally.
//
// A/B mode alternates launches between two binaries (A, B, A, B, ...) so slow
// machine-state drift (thermals, page cache, background load) lands on both
// variants equally instead of biasing whichever variant ran last.
//
//   npm run perf launch-ab -- --runs 15                       # current release/ build
//   npm run perf launch-ab -- --a <exeA> --b <exeB> --runs 15 # interleaved A/B
//   npm run perf launch-ab -- --warm ...                      # per-variant persisted
//                                                             # profile + warmup boot

interface RunMetrics {
  osToAppBootMs: number | null;
  windowCreatedMs: number | null;
  windowShownMs: number | null;
  rendererReadyMs: number | null;
  firstInteractiveMs: number | null;
  /** osToAppBoot + firstInteractive: spawn() to interactive, the user-perceived total. */
  perceivedTotalMs: number | null;
}

interface VariantRun {
  index: number;
  metrics: RunMetrics;
  failed?: boolean;
  error?: string;
}

interface MarkRecord {
  mark: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

const METRIC_LABELS: Array<{ key: keyof RunMetrics; label: string }> = [
  { key: "osToAppBootMs", label: "spawn -> app_boot_start (os+framework)" },
  { key: "windowCreatedMs", label: "boot -> main_window_created" },
  { key: "windowShownMs", label: "boot -> main_window_shown" },
  { key: "rendererReadyMs", label: "boot -> renderer_ready" },
  { key: "firstInteractiveMs", label: "boot -> first_interactive (headline)" },
  { key: "perceivedTotalMs", label: "spawn -> first_interactive (perceived)" },
];

function parseNdjsonMarks(ndjsonPath: string): Map<string, MarkRecord> {
  const marks = new Map<string, MarkRecord>();
  if (!fs.existsSync(ndjsonPath)) return marks;
  for (const line of fs.readFileSync(ndjsonPath, "utf8").trim().split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as MarkRecord;
      // First-wins, matching parseBootDuration in packagedLaunch.ts.
      if (!marks.has(record.mark)) marks.set(record.mark, record);
    } catch {
      // Skip lines truncated mid-write.
    }
  }
  return marks;
}

function extractMetrics(marks: Map<string, MarkRecord>): RunMetrics {
  const boot = marks.get(PERF_MARKS.APP_BOOT_START);
  const rel = (name: string): number | null => {
    const m = marks.get(name);
    if (!m || !boot) return null;
    return round(m.elapsedMs - boot.elapsedMs, 1);
  };
  const osToAppBoot =
    boot && typeof boot.meta?.osToAppBootMs === "number" ? round(boot.meta.osToAppBootMs, 1) : null;
  const firstInteractive = rel(PERF_MARKS.RENDERER_FIRST_INTERACTIVE);
  return {
    osToAppBootMs: osToAppBoot,
    windowCreatedMs: rel(PERF_MARKS.MAIN_WINDOW_CREATED),
    windowShownMs: rel(PERF_MARKS.MAIN_WINDOW_SHOWN),
    rendererReadyMs: rel(PERF_MARKS.RENDERER_READY),
    firstInteractiveMs: firstInteractive,
    perceivedTotalMs:
      osToAppBoot !== null && firstInteractive !== null
        ? round(osToAppBoot + firstInteractive, 1)
        : null,
  };
}

function waitForExit(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function launchOnce(
  executablePath: string,
  options: { userDataDir?: string; timeoutMs?: number } = {}
): Promise<RunMetrics> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const ownsDir = !options.userDataDir;
  const userDataDir =
    options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "daintree-launch-ab-"));
  const ndjsonPath = path.join(userDataDir, "perf-metrics.ndjson");
  // Persistent (warm) dirs accumulate marks across launches; first-wins
  // parsing would then read the previous boot. Clear before each launch.
  fs.rmSync(ndjsonPath, { force: true });

  const env: Record<string, string | undefined> = {
    ...process.env,
    DAINTREE_PERF_CAPTURE: "1",
    DAINTREE_PERF_METRICS_FILE: ndjsonPath,
    DAINTREE_PERF_SPAWN_WALL_MS: String(Date.now()),
    DAINTREE_E2E_MODE: "1",
    DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS: "1",
    NODE_ENV: "production",
  };
  // A dev shell's inherited compile-cache env would silently warm "cold" runs;
  // force the app to own its cache inside userDataDir (same hygiene as
  // packagedLaunch.ts).
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  delete env.ELECTRON_RUN_AS_NODE;

  const proc = spawn(executablePath, [`--user-data-dir=${userDataDir}`], {
    env,
    stdio: "ignore",
    detached: false,
  });

  try {
    const deadline = Date.now() + timeoutMs;
    let sawFirstInteractive = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`app exited early with code ${proc.exitCode}`);
      }
      if (fs.existsSync(ndjsonPath)) {
        const txt = fs.readFileSync(ndjsonPath, "utf8");
        if (txt.includes(`"${PERF_MARKS.RENDERER_FIRST_INTERACTIVE}"`)) {
          sawFirstInteractive = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!sawFirstInteractive) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for renderer_first_interactive`);
    }
    // Small grace so trailing marks (flushes racing the reveal) land on disk.
    await new Promise((r) => setTimeout(r, 250));
    return extractMetrics(parseNdjsonMarks(ndjsonPath));
  } finally {
    proc.kill("SIGTERM");
    const exited = await waitForExit(proc, 5_000);
    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await waitForExit(proc, 2_000);
    }
    if (ownsDir) {
      // Post-exit cleanup can race lingering helpers; best effort.
      setTimeout(() => {
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          // Best effort.
        }
      }, 500).unref();
    } else {
      // Reused (warm) profile dir: clear stale singleton-lock files so a
      // slow-exiting previous instance can't make the next launch defer to it
      // and exit early (same hygiene as packagedLaunch.ts).
      try {
        for (const entry of fs.readdirSync(userDataDir)) {
          if (entry.startsWith("Singleton")) {
            try {
              fs.unlinkSync(path.join(userDataDir, entry));
            } catch {
              // Best effort.
            }
          }
        }
      } catch {
        // Best effort.
      }
    }
  }
}

interface Variant {
  name: string;
  exe: string;
  warmDir?: string;
  runs: VariantRun[];
}

function summarize(
  variant: Variant
): Record<
  string,
  { n: number; p50: number; mean: number; stdDev: number; min: number; max: number }
> {
  const out: Record<
    string,
    { n: number; p50: number; mean: number; stdDev: number; min: number; max: number }
  > = {};
  for (const { key } of METRIC_LABELS) {
    const values = variant.runs
      .filter((r) => !r.failed)
      .map((r) => r.metrics[key])
      .filter((v): v is number => typeof v === "number");
    if (values.length === 0) continue;
    out[key] = {
      n: values.length,
      p50: round(percentile(values, 50), 1),
      mean: round(mean(values), 1),
      stdDev: round(stdDev(values), 1),
      min: round(Math.min(...values), 1),
      max: round(Math.max(...values), 1),
    };
  }
  return out;
}

function fmt(v: number): string {
  return `${v.toFixed(1)}`;
}

function renderReport(variants: Variant[]): string {
  const lines: string[] = [];
  const summaries = variants.map((v) => ({ variant: v, stats: summarize(v) }));

  for (const { variant, stats } of summaries) {
    const failed = variant.runs.filter((r) => r.failed);
    lines.push(`── ${variant.name} (${variant.exe})`);
    lines.push(
      `   runs=${variant.runs.length} ok=${variant.runs.length - failed.length} failed=${failed.length}`
    );
    for (const f of failed) lines.push(`   run ${f.index + 1} FAILED: ${f.error}`);
    lines.push(
      "   metric                                      p50      mean     stdDev   min      max"
    );
    for (const { key, label } of METRIC_LABELS) {
      const s = stats[key];
      if (!s) continue;
      lines.push(
        `   ${label.padEnd(42)} ${fmt(s.p50).padStart(8)} ${fmt(s.mean).padStart(8)} ${fmt(s.stdDev).padStart(8)} ${fmt(s.min).padStart(8)} ${fmt(s.max).padStart(8)}`
      );
    }
    lines.push("");
  }

  if (summaries.length === 2) {
    const [a, b] = summaries;
    lines.push(`── delta: ${b.variant.name} vs ${a.variant.name} (negative = faster)`);
    lines.push("   metric                                      p50 delta          mean delta");
    for (const { key, label } of METRIC_LABELS) {
      const sa = a.stats[key];
      const sb = b.stats[key];
      if (!sa || !sb) continue;
      const dP50 = sb.p50 - sa.p50;
      const dMean = sb.mean - sa.mean;
      const pctP50 = sa.p50 !== 0 ? (dP50 / sa.p50) * 100 : 0;
      const pctMean = sa.mean !== 0 ? (dMean / sa.mean) * 100 : 0;
      lines.push(
        `   ${label.padEnd(42)} ${`${dP50 >= 0 ? "+" : ""}${fmt(dP50)}ms (${pctP50 >= 0 ? "+" : ""}${pctP50.toFixed(1)}%)`.padStart(20)} ${`${dMean >= 0 ? "+" : ""}${fmt(dMean)}ms (${pctMean >= 0 ? "+" : ""}${pctMean.toFixed(1)}%)`.padStart(20)}`
      );
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      a: { type: "string" },
      b: { type: "string" },
      "label-a": { type: "string", default: "A" },
      "label-b": { type: "string", default: "B" },
      runs: { type: "string", short: "n", default: "10" },
      warm: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: npm run perf launch-ab -- [--a exeA --b exeB] [--runs N] [--warm] [--json]

Direct-spawn launch benchmark. With --a/--b, alternates launches between two
packaged binaries and reports per-variant stats plus the delta. Without them,
benchmarks the binary under release/.

  --runs N   measured launches PER VARIANT (default 10)
  --warm     per-variant persisted profile + one unmeasured warmup boot, so
             measured runs hit the Node compile cache and Chromium code cache
  --json     structured output for diffing
`);
    return;
  }

  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`Invalid --runs: ${values.runs}`);
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const variants: Variant[] = [];
  if (values.a || values.b) {
    if (!values.a || !values.b) {
      console.error("--a and --b must both be provided for A/B mode");
      process.exit(1);
    }
    variants.push({ name: values["label-a"] ?? "A", exe: path.resolve(values.a), runs: [] });
    variants.push({ name: values["label-b"] ?? "B", exe: path.resolve(values.b), runs: [] });
  } else {
    const exe = findPackagedExecutable(projectRoot);
    if (!exe) {
      console.error("No packaged binary under release/. Build one: npm run package:local");
      process.exit(1);
    }
    variants.push({ name: "release", exe, runs: [] });
  }

  for (const v of variants) {
    if (!fs.existsSync(v.exe)) {
      console.error(`Executable not found: ${v.exe}`);
      process.exit(1);
    }
  }

  if (values.warm) {
    for (const v of variants) {
      v.warmDir = fs.mkdtempSync(path.join(os.tmpdir(), `daintree-launch-warm-${v.name}-`));
      console.error(`[warm] ${v.name}: warmup boot into ${v.warmDir}`);
      try {
        await launchOnce(v.exe, { userDataDir: v.warmDir });
      } catch (error) {
        // A failed warmup means the profile never got a populated cache;
        // keeping the dir would silently report cache-cold samples as warm.
        console.error(
          `[warm] ${v.name} warmup failed: ${String(error)} — falling back to cold (fresh profile per run)`
        );
        try {
          fs.rmSync(v.warmDir, { recursive: true, force: true });
        } catch {
          // Best effort.
        }
        v.warmDir = undefined;
      }
    }
  }

  // Interleave rounds, alternating within-round order (A,B then B,A) so any
  // short-lived teardown/page-cache effect from the preceding sample lands on
  // both variants equally, not always on the same one.
  for (let r = 0; r < runs; r += 1) {
    const order = r % 2 === 0 ? variants : [...variants].reverse();
    for (const v of order) {
      const tag = `[${v.name} ${r + 1}/${runs}]`;
      try {
        const metrics = await launchOnce(v.exe, v.warmDir ? { userDataDir: v.warmDir } : {});
        v.runs.push({ index: r, metrics });
        console.error(
          `${tag} first_interactive=${metrics.firstInteractiveMs}ms perceived=${metrics.perceivedTotalMs}ms`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        v.runs.push({
          index: r,
          failed: true,
          error: message,
          metrics: {
            osToAppBootMs: null,
            windowCreatedMs: null,
            windowShownMs: null,
            rendererReadyMs: null,
            firstInteractiveMs: null,
            perceivedTotalMs: null,
          },
        });
        console.error(`${tag} FAILED: ${message}`);
      }
      // Idle gap so teardown of one launch doesn't bleed into the next sample.
      await new Promise((rr) => setTimeout(rr, 750));
    }
  }

  for (const v of variants) {
    if (v.warmDir) {
      try {
        fs.rmSync(v.warmDir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  }

  if (values.json) {
    const summaries = variants.map((v) => summarize(v));
    // Mirror the text report's delta table so structured consumers don't
    // recompute (and drift from) what the human-readable output shows.
    let deltas:
      | Record<string, { p50Ms: number; p50Pct: number; meanMs: number; meanPct: number }>
      | undefined;
    if (variants.length === 2) {
      deltas = {};
      for (const { key } of METRIC_LABELS) {
        const sa = summaries[0][key];
        const sb = summaries[1][key];
        if (!sa || !sb) continue;
        deltas[key] = {
          p50Ms: round(sb.p50 - sa.p50, 1),
          p50Pct: sa.p50 !== 0 ? round(((sb.p50 - sa.p50) / sa.p50) * 100, 1) : 0,
          meanMs: round(sb.mean - sa.mean, 1),
          meanPct: sa.mean !== 0 ? round(((sb.mean - sa.mean) / sa.mean) * 100, 1) : 0,
        };
      }
    }
    console.log(
      JSON.stringify(
        {
          warm: Boolean(values.warm),
          runsPerVariant: runs,
          variants: variants.map((v, i) => ({
            name: v.name,
            exe: v.exe,
            // False when a --warm warmup failed and this variant fell back to
            // fresh-profile (cold) samples.
            warm: Boolean(v.warmDir),
            runs: v.runs,
            summary: summaries[i],
          })),
          ...(deltas ? { deltas } : {}),
        },
        null,
        2
      )
    );
  } else {
    console.log(renderReport(variants));
  }

  if (variants.some((v) => v.runs.every((r) => r.failed))) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[perf:launch-ab] fatal:", error);
  process.exit(1);
});
