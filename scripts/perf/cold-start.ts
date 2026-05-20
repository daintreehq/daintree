import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findPackagedExecutable, launchPackagedAndMeasure } from "./lib/packagedLaunch";
import { round } from "./lib/stats";
import {
  aggregate,
  CLS_WARN_THRESHOLD,
  LOAF_SOURCE_P95_WARN_MS,
  LOAF_SOURCE_TOTAL_WARN_MS,
  OS_TO_APP_BOOT_WARN_MS,
  type Aggregate,
  type MarkRecord,
  type RunData,
} from "./lib/coldStartAggregate";

// p95 from a tiny sample interpolates between rank n-2 and rank n-1, which is
// effectively the maximum. With n=5 the rank is 3.8 (80% of max + 20% of #4):
// statistically meaningless. Suppress the p95 cell in the text report until we
// have enough samples for the interpolation to land between non-extreme ranks.
// The raw value is still emitted in --json output for machine consumers.
const MIN_SAMPLES_FOR_P95 = 20;

function formatP95(stats: { runs: number; p95Ms: number }): string {
  return stats.runs < MIN_SAMPLES_FOR_P95 ? "n/a (<20 runs)" : formatMs(stats.p95Ms);
}

interface JsonOutput {
  runs: Array<{
    index: number;
    durationMs: number;
    notes?: string;
    failed?: boolean;
    error?: string;
    degraded?: boolean;
  }>;
  failedRuns: number;
  degradedRuns: number;
  successfulRuns: number;
  aggregates: Aggregate;
}

function parseNdjson(ndjsonPath: string): MarkRecord[] {
  if (!fs.existsSync(ndjsonPath)) return [];
  const contents = fs.readFileSync(ndjsonPath, "utf-8").trim();
  if (!contents) return [];
  const records: MarkRecord[] = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as MarkRecord);
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatTable(rows: Array<Record<string, string>>, columns: string[]): string {
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => (r[col] ?? "").length))
  );

  const header = columns.map((col, i) => padRight(col, widths[i])).join("  ");
  const divider = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((row) => columns.map((col, i) => padRight(row[col] ?? "", widths[i])).join("  "))
    .join("\n");

  return `${header}\n${divider}\n${body}`;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function renderTextReport(
  runs: RunData[],
  agg: Aggregate,
  successful: number,
  failed: number
): string {
  const lines: string[] = [];

  const degraded = runs.filter((r) => r.degraded && !r.failed).length;
  const degradedNote = degraded > 0 ? `, ${degraded} degraded` : "";
  lines.push(
    `Cold-start perf — ${runs.length} run${runs.length === 1 ? "" : "s"} (${successful} ok${degradedNote}, ${failed} failed)`
  );
  if (degraded > 0) {
    lines.push(
      `  Degraded runs used wall-clock fallback and are excluded from mark/phase aggregates.`
    );
  }
  lines.push("");

  const runRows = runs.map((run) => ({
    run: String(run.index + 1),
    status: run.failed ? "FAIL" : run.degraded ? "degraded" : "ok",
    durationMs: run.failed ? "—" : formatMs(run.durationMs),
    notes: run.error ?? run.notes ?? "",
  }));
  lines.push("Per-run results");
  lines.push(formatTable(runRows, ["run", "status", "durationMs", "notes"]));
  lines.push("");

  const phaseRows = Object.entries(agg.phaseDurations)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, stats]) => ({
      phase: label,
      runs: String(stats.runs),
      p50: formatMs(stats.p50Ms),
      p95: formatP95(stats),
      mean: formatMs(stats.meanMs),
      stdDev: formatMs(stats.stdDevMs),
    }));

  if (phaseRows.length > 0) {
    lines.push("Key phase durations (ms between paired marks)");
    lines.push(formatTable(phaseRows, ["phase", "runs", "p50", "p95", "mean", "stdDev"]));
    lines.push("");
  }

  const markRows = Object.entries(agg.marks)
    .sort(([, a], [, b]) => a.p50Ms - b.p50Ms)
    .map(([name, stats]) => ({
      mark: name,
      runs: String(stats.runs),
      p50: formatMs(stats.p50Ms),
      p95: formatP95(stats),
      mean: formatMs(stats.meanMs),
    }));

  if (markRows.length > 0) {
    lines.push("Marks (elapsed ms since app_boot_t0)");
    lines.push(formatTable(markRows, ["mark", "runs", "p50", "p95", "mean"]));
    lines.push("");
  }

  const ipcRows = Object.entries(agg.ipc)
    .sort(([, a], [, b]) => b.p95Ms - a.p95Ms)
    .map(([channel, stats]) => ({
      channel,
      samples: String(stats.samples),
      p50: formatMs(stats.p50Ms),
      p95: formatP95(stats),
      mean: formatMs(stats.meanMs),
      errors: stats.errorCount > 0 ? String(stats.errorCount) : "",
    }));

  if (ipcRows.length > 0) {
    lines.push("IPC round-trip per channel (ms)");
    lines.push(formatTable(ipcRows, ["channel", "samples", "p50", "p95", "mean", "errors"]));
    lines.push("");
  } else {
    lines.push("IPC round-trip per channel: no samples captured");
    lines.push("");
  }

  // Sort by total blocking time so the loudest sources rise to the top of
  // the table and the warn-only signal is immediately visible.
  const loafRows = Object.entries(agg.loaf)
    .sort(([, a], [, b]) => b.totalBlockingMs - a.totalBlockingMs)
    .map(([sourceURL, stats]) => ({
      source: sourceURL,
      frames: String(stats.frames),
      p50: formatMs(stats.p50BlockingMs),
      p95: stats.frames < MIN_SAMPLES_FOR_P95 ? "n/a (<20 frames)" : formatMs(stats.p95BlockingMs),
      total: formatMs(stats.totalBlockingMs),
      warn:
        stats.p95BlockingMs > LOAF_SOURCE_P95_WARN_MS ||
        stats.totalBlockingMs > LOAF_SOURCE_TOTAL_WARN_MS
          ? "⚠"
          : "",
    }));

  if (loafRows.length > 0) {
    lines.push(
      `Long-animation-frame blocking by source (warn p95 > ${LOAF_SOURCE_P95_WARN_MS}ms or total > ${LOAF_SOURCE_TOTAL_WARN_MS}ms — warn-only)`
    );
    lines.push(formatTable(loafRows, ["source", "frames", "p50", "p95", "total", "warn"]));
    lines.push("");
    for (const [sourceURL, stats] of Object.entries(agg.loaf)) {
      if (stats.p95BlockingMs > LOAF_SOURCE_P95_WARN_MS) {
        console.warn(
          `::warning::LoAF p95 blocking ${stats.p95BlockingMs}ms for ${sourceURL} (warn-only threshold: ${LOAF_SOURCE_P95_WARN_MS}ms)`
        );
      }
      if (stats.totalBlockingMs > LOAF_SOURCE_TOTAL_WARN_MS) {
        console.warn(
          `::warning::LoAF total blocking ${stats.totalBlockingMs}ms for ${sourceURL} (warn-only threshold: ${LOAF_SOURCE_TOTAL_WARN_MS}ms)`
        );
      }
    }
  }

  if (agg.cls) {
    const exceeds = agg.cls.p95 > CLS_WARN_THRESHOLD;
    lines.push(`Cumulative layout shift (warn p95 > ${CLS_WARN_THRESHOLD} — warn-only)`);
    lines.push(
      formatTable(
        [
          {
            metric: "cls",
            runs: String(agg.cls.runs),
            p50: agg.cls.p50.toFixed(4),
            p95: agg.cls.p95.toFixed(4),
            mean: agg.cls.mean.toFixed(4),
            max: agg.cls.max.toFixed(4),
            warn: exceeds ? "⚠" : "",
          },
        ],
        ["metric", "runs", "p50", "p95", "mean", "max", "warn"]
      )
    );
    lines.push("");
    if (exceeds) {
      console.warn(
        `::warning::CLS p95 ${agg.cls.p95.toFixed(4)} exceeds warn-only threshold ${CLS_WARN_THRESHOLD}`
      );
    }
  }

  if (agg.osToAppBoot) {
    const platform = process.platform;
    const warnMs = OS_TO_APP_BOOT_WARN_MS[platform];
    const exceeds = warnMs !== undefined && agg.osToAppBoot.p95Ms > warnMs;
    const warnLabel = warnMs !== undefined ? `warn p95 > ${warnMs}ms` : "no warn threshold";
    const osBootRunsCount = agg.osToAppBoot.runs;
    lines.push(`OS-to-app-boot wall-clock — ${platform} (${warnLabel}, warn-only)`);
    lines.push(
      formatTable(
        [
          {
            metric: "os_to_app_boot",
            runs: String(osBootRunsCount),
            p50: formatMs(agg.osToAppBoot.p50Ms),
            p95:
              osBootRunsCount < MIN_SAMPLES_FOR_P95
                ? "n/a (<20 runs)"
                : formatMs(agg.osToAppBoot.p95Ms),
            mean: formatMs(agg.osToAppBoot.meanMs),
            max: formatMs(agg.osToAppBoot.maxMs),
            warn: exceeds ? "⚠" : "",
          },
        ],
        ["metric", "runs", "p50", "p95", "mean", "max", "warn"]
      )
    );
    lines.push("");
    if (exceeds) {
      console.warn(
        `::warning::os_to_app_boot_ms p95 ${agg.osToAppBoot.p95Ms}ms exceeds warn-only threshold ${warnMs}ms on ${platform}`
      );
    }
  }

  if (agg.eventLoopLag) {
    const lagSamples = agg.eventLoopLag.samples;
    lines.push(
      "Event-loop lag (samples emitted only when lag ≥ 100ms after the 5s startup-suppression window)"
    );
    lines.push(
      formatTable(
        [
          {
            metric: "event_loop_lag",
            samples: String(lagSamples),
            p50: formatMs(agg.eventLoopLag.p50Ms),
            p95:
              lagSamples < MIN_SAMPLES_FOR_P95
                ? "n/a (<20 samples)"
                : formatMs(agg.eventLoopLag.p95Ms),
            mean: formatMs(agg.eventLoopLag.meanMs),
            max: formatMs(agg.eventLoopLag.maxMs),
            total: formatMs(agg.eventLoopLag.totalAccumulatedMs),
          },
        ],
        ["metric", "samples", "p50", "p95", "mean", "max", "total"]
      )
    );
    lines.push("");
  } else {
    lines.push("Event-loop lag: no samples captured (no stalls ≥ 100ms past startup window)");
    lines.push("");
  }

  return lines.join("\n");
}

function buildJsonOutput(runs: RunData[], agg: Aggregate): JsonOutput {
  const successful = runs.filter((r) => !r.failed).length;
  const degraded = runs.filter((r) => r.degraded && !r.failed).length;
  return {
    runs: runs.map((r) => ({
      index: r.index,
      durationMs: r.failed ? -1 : round(r.durationMs),
      notes: r.notes,
      failed: r.failed,
      error: r.error,
      degraded: r.degraded,
    })),
    failedRuns: runs.length - successful,
    degradedRuns: degraded,
    successfulRuns: successful,
    aggregates: agg,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", short: "n", default: "5" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: npm run perf:cold-start -- [--runs N] [--json]

Launch the packaged Daintree binary N times from a fresh profile dir,
collect perf marks + IPC samples, and print aggregated p50/p95.

Options:
  -n, --runs N    Number of launches (default 5)
      --json      Emit structured JSON instead of the text table
  -h, --help      Show this message

Requires a packaged binary under release/. Build one first with:
  npm run package         # or: npm run package:local (macOS, unsigned)
`);
    return;
  }

  const rawRuns = Number(values.runs ?? "5");
  if (!Number.isInteger(rawRuns) || rawRuns < 1) {
    console.error(`Invalid --runs value: ${values.runs}. Expected a positive integer.`);
    process.exit(1);
  }
  const runs = rawRuns;
  const asJson = Boolean(values.json);

  const projectRoot = process.cwd();
  const executablePath = findPackagedExecutable(projectRoot);
  if (!executablePath) {
    console.error(
      "No packaged Daintree binary found under release/. Build one first: npm run package (or npm run package:local on macOS)."
    );
    process.exit(1);
  }

  // Ensure full IPC capture for this manual run. The default 10% sample rate
  // would leave sparse per-channel stats; override to 1.0 unless the caller
  // already set something explicitly.
  if (!process.env.DAINTREE_PERF_IPC_SAMPLE_RATE) {
    process.env.DAINTREE_PERF_IPC_SAMPLE_RATE = "1";
  }

  if (!asJson) {
    console.error(`Launching packaged binary at ${path.relative(projectRoot, executablePath)}`);
    console.error(`Runs: ${runs}`);
  }

  const results: RunData[] = [];

  for (let i = 0; i < runs; i += 1) {
    if (!asJson) {
      console.error(`[run ${i + 1}/${runs}] starting...`);
    }

    try {
      const result = await launchPackagedAndMeasure(executablePath, i, { projectRoot });
      const marks = parseNdjson(result.ndjsonPath);
      // Only true-degraded runs (wall-clock fallback) are excluded from
      // mark/phase aggregates. A run that fell back from FI → RR still has
      // valid marks; its `notes` is set but `degraded` is false.
      results.push({
        index: i,
        durationMs: result.durationMs,
        notes: result.notes,
        marks,
        degraded: Boolean(result.degraded),
      });

      if (!asJson) {
        const suffix = result.notes ? ` (${result.notes})` : "";
        console.error(`[run ${i + 1}/${runs}] ${formatMs(result.durationMs)}${suffix}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        index: i,
        durationMs: -1,
        marks: [],
        failed: true,
        error: message,
      });
      if (!asJson) {
        console.error(`[run ${i + 1}/${runs}] FAILED: ${message}`);
      }
    }
  }

  const successfulRuns = results.filter((r) => !r.failed).length;
  const failedRuns = results.length - successfulRuns;
  const agg = aggregate(results);

  if (asJson) {
    console.log(JSON.stringify(buildJsonOutput(results, agg), null, 2));
  } else {
    console.error("");
    console.log(renderTextReport(results, agg, successfulRuns, failedRuns));
  }

  if (successfulRuns === 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[perf:cold-start] fatal error:", error);
  process.exit(1);
});
