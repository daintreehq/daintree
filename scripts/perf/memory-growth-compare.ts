import { readFileSync } from "node:fs";

interface GrowthMetric {
  baseline: number;
  final: number;
  delta: number;
  peak: number;
  slopePerCycle: number;
}

interface Summary {
  mean: number;
  max: number;
}

interface GrowthResult {
  label: string;
  config: Record<string, unknown>;
  metrics: Record<string, GrowthMetric>;
  workload: {
    cycleDurationMs: Summary;
    maxFrameGapMs: Summary;
    p95FrameGapMs: Summary;
  };
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: npm run perf memory-growth-compare -- <before.json> <after.json>");
  process.exit(1);
}

const before = JSON.parse(readFileSync(beforePath, "utf8")) as GrowthResult;
const after = JSON.parse(readFileSync(afterPath, "utf8")) as GrowthResult;
const normalizedConfig = (config: Record<string, unknown>): Record<string, unknown> => ({
  ...config,
  churnEphemeralTerminals: config.churnEphemeralTerminals ?? true,
});
const beforeConfig = normalizedConfig(before.config);
const afterConfig = normalizedConfig(after.config);
const configKeys = new Set([...Object.keys(beforeConfig), ...Object.keys(afterConfig)]);
const mismatches = [...configKeys].filter(
  (key) => JSON.stringify(beforeConfig[key]) !== JSON.stringify(afterConfig[key])
);
if (mismatches.length > 0) {
  console.error(`Cannot compare runs with different settings: ${mismatches.join(", ")}`);
  process.exit(2);
}

interface Row {
  label: string;
  before: number;
  after: number;
  unit: "mb" | "mb-cycle" | "count" | "count-cycle" | "ms";
  capImprovement?: boolean;
}

const metric = (name: string) => {
  const beforeMetric = before.metrics[name];
  const afterMetric = after.metrics[name];
  if (!beforeMetric || !afterMetric) throw new Error(`Missing comparison metric: ${name}`);
  return { before: beforeMetric, after: afterMetric };
};

const appRss = metric("appRssKb");
const rendererRss = metric("rendererRssKb");
const rendererHeap = metric("rendererHeapUsedKb");
const ptyFds = metric("ptyHostFdCount");
const rows: Row[] = [
  {
    label: "Final app RSS",
    before: appRss.before.final,
    after: appRss.after.final,
    unit: "mb",
  },
  {
    label: "Peak app RSS",
    before: appRss.before.peak,
    after: appRss.after.peak,
    unit: "mb",
  },
  {
    label: "App retained RSS growth",
    before: appRss.before.delta,
    after: appRss.after.delta,
    unit: "mb",
    capImprovement: true,
  },
  {
    label: "App RSS growth rate",
    before: appRss.before.slopePerCycle,
    after: appRss.after.slopePerCycle,
    unit: "mb-cycle",
    capImprovement: true,
  },
  {
    label: "Final renderer RSS",
    before: rendererRss.before.final,
    after: rendererRss.after.final,
    unit: "mb",
  },
  {
    label: "Renderer retained RSS growth",
    before: rendererRss.before.delta,
    after: rendererRss.after.delta,
    unit: "mb",
    capImprovement: true,
  },
  {
    label: "Final renderer heap",
    before: rendererHeap.before.final,
    after: rendererHeap.after.final,
    unit: "mb",
  },
  {
    label: "Renderer heap growth rate",
    before: rendererHeap.before.slopePerCycle,
    after: rendererHeap.after.slopePerCycle,
    unit: "mb-cycle",
    capImprovement: true,
  },
  {
    label: "Final PTY-host descriptors",
    before: ptyFds.before.final,
    after: ptyFds.after.final,
    unit: "count",
  },
  {
    label: "PTY-host descriptor growth",
    before: ptyFds.before.delta,
    after: ptyFds.after.delta,
    unit: "count",
    capImprovement: true,
  },
  {
    label: "PTY-host descriptor growth rate",
    before: ptyFds.before.slopePerCycle,
    after: ptyFds.after.slopePerCycle,
    unit: "count-cycle",
    capImprovement: true,
  },
  {
    label: "Mixed-use cycle duration",
    before: before.workload.cycleDurationMs.mean,
    after: after.workload.cycleDurationMs.mean,
    unit: "ms",
  },
  {
    label: "Worst renderer frame gap",
    before: before.workload.maxFrameGapMs.max,
    after: after.workload.maxFrameGapMs.max,
    unit: "ms",
  },
];

const format = (value: number, unit: Row["unit"]): string => {
  if (unit === "mb") return `${(value / 1024).toFixed(1)} MB`;
  if (unit === "mb-cycle") return `${(value / 1024).toFixed(2)} MB/cycle`;
  if (unit === "count") return value.toFixed(0);
  if (unit === "count-cycle") return `${value.toFixed(2)}/cycle`;
  return `${value.toFixed(1)} ms`;
};

const improvement = (row: Row): string => {
  if (row.before <= 0) return "n/a";
  const percent = ((row.before - row.after) / row.before) * 100;
  const reported = row.capImprovement ? Math.min(100, percent) : percent;
  return `${reported >= 0 ? "+" : ""}${reported.toFixed(1)}%`;
};

console.log(`\n## Long-session memory growth: ${before.label} vs ${after.label}\n`);
console.log(`| Metric | ${before.label} | ${after.label} | Improvement |`);
console.log("|---|---:|---:|---:|");
for (const row of rows) {
  console.log(
    `| ${row.label} | ${format(row.before, row.unit)} | ${format(row.after, row.unit)} | ${improvement(row)} |`
  );
}
console.log("");
