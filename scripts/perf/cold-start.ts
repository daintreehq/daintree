import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findPackagedExecutable, launchPackagedAndMeasure } from "./lib/packagedLaunch";
import { mean, percentile, round, stdDev } from "./lib/stats";
import { PERF_MARKS } from "../../shared/perf/marks";

interface MarkRecord {
  mark: string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

interface RunData {
  index: number;
  durationMs: number;
  notes?: string;
  marks: MarkRecord[];
  failed?: boolean;
  error?: string;
  degraded?: boolean;
}

interface MarkStats {
  runs: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  stdDevMs: number;
}

interface IpcChannelStats extends MarkStats {
  samples: number;
  errorCount: number;
}

interface Aggregate {
  marks: Record<string, MarkStats>;
  phaseDurations: Record<string, MarkStats>;
  ipc: Record<string, IpcChannelStats>;
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

const PHASE_PAIRS: Array<[string, string, string]> = [
  [PERF_MARKS.APP_BOOT_START, PERF_MARKS.RENDERER_READY, "boot → renderer_ready"],
  [PERF_MARKS.APP_BOOT_START, PERF_MARKS.RENDERER_FIRST_INTERACTIVE, "boot → first_interactive"],
  [PERF_MARKS.SERVICE_INIT_START, PERF_MARKS.SERVICE_INIT_COMPLETE, "service_init"],
  [PERF_MARKS.HYDRATE_START, PERF_MARKS.HYDRATE_COMPLETE, "hydrate"],
  [
    PERF_MARKS.HYDRATE_RESTORE_PANELS_START,
    PERF_MARKS.HYDRATE_RESTORE_PANELS_END,
    "hydrate_restore_panels",
  ],
];

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

function statsFor(values: number[]): MarkStats {
  return {
    runs: values.length,
    p50Ms: round(percentile(values, 50)),
    p95Ms: round(percentile(values, 95)),
    meanMs: round(mean(values)),
    stdDevMs: round(stdDev(values)),
  };
}

function aggregate(runs: RunData[]): Aggregate {
  // Degraded runs (wall-clock fallback — RENDERER_READY mark never arrived)
  // still produce useful IPC samples but must be excluded from mark/phase
  // aggregates to avoid contaminating p50/p95 with incomplete timelines.
  const successful = runs.filter((r) => !r.failed);
  const withMarks = successful.filter((r) => !r.degraded);

  const markElapsed = new Map<string, number[]>();
  const phaseElapsed = new Map<string, number[]>();
  const ipcByChannel = new Map<string, { durations: number[]; errors: number }>();

  for (const run of successful) {
    for (const record of run.marks) {
      if (record.mark !== "ipc_request_sample") continue;
      const channel = typeof record.meta?.channel === "string" ? record.meta.channel : "unknown";
      const durationMs =
        typeof record.meta?.durationMs === "number" ? record.meta.durationMs : null;
      if (durationMs === null) continue;
      const errored = Boolean(record.meta?.errored);
      const bucket = ipcByChannel.get(channel) ?? { durations: [], errors: 0 };
      bucket.durations.push(durationMs);
      if (errored) bucket.errors += 1;
      ipcByChannel.set(channel, bucket);
    }
  }

  for (const run of withMarks) {
    const firstByMark = new Map<string, MarkRecord>();
    for (const record of run.marks) {
      if (record.mark === "ipc_request_sample") continue;
      if (!firstByMark.has(record.mark)) {
        firstByMark.set(record.mark, record);
        const list = markElapsed.get(record.mark) ?? [];
        list.push(record.elapsedMs);
        markElapsed.set(record.mark, list);
      }
    }

    for (const [fromMark, toMark, label] of PHASE_PAIRS) {
      const from = firstByMark.get(fromMark);
      const to = firstByMark.get(toMark);
      if (!from || !to) continue;
      const delta = to.elapsedMs - from.elapsedMs;
      if (delta < 0) {
        console.error(
          `[cold-start] skipping negative phase delta for ${label} in run ${run.index + 1} (${delta.toFixed(1)}ms)`
        );
        continue;
      }
      const list = phaseElapsed.get(label) ?? [];
      list.push(delta);
      phaseElapsed.set(label, list);
    }
  }

  const marks: Record<string, MarkStats> = {};
  for (const [name, values] of markElapsed) {
    marks[name] = statsFor(values);
  }

  const phaseDurations: Record<string, MarkStats> = {};
  for (const [label, values] of phaseElapsed) {
    phaseDurations[label] = statsFor(values);
  }

  const ipc: Record<string, IpcChannelStats> = {};
  for (const [channel, bucket] of ipcByChannel) {
    ipc[channel] = {
      ...statsFor(bucket.durations),
      samples: bucket.durations.length,
      errorCount: bucket.errors,
    };
  }

  return { marks, phaseDurations, ipc };
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
      p95: formatMs(stats.p95Ms),
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
      p95: formatMs(stats.p95Ms),
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
      p95: formatMs(stats.p95Ms),
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
      const degraded = Boolean(result.notes);
      results.push({
        index: i,
        durationMs: result.durationMs,
        notes: result.notes,
        marks,
        degraded,
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
