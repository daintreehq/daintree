import { readFileSync } from "node:fs";
import type { MemorySample, RotationResult, TimingKey } from "../../e2e/helpers/switchRotation";

/**
 * Compare two project-switch rotation results, or (with --marginal) price one
 * extra cached view by comparing a higher cap against a lower one.
 */

const USAGE = [
  "usage:",
  "  npm run perf project-switch-rotation-compare -- <before.json> <after.json>",
  "  npm run perf project-switch-rotation-compare -- --marginal <capHigher.json> <capLower.json>",
].join("\n");

const args = process.argv.slice(2);
const marginal = args.includes("--marginal");
const files = args.filter((a) => a !== "--marginal");
if (files.length !== 2) {
  console.error(USAGE);
  process.exit(1);
}
const [leftPath, rightPath] = files as [string, string];

const load = (file: string): RotationResult => JSON.parse(readFileSync(file, "utf8"));
const left = load(leftPath);
const right = load(rightPath);

// Seed only changes sample order; label lives outside config.
const IGNORED_CONFIG_KEYS = new Set(["seed"]);
const configMismatches = (): string[] => {
  const keys = new Set([...Object.keys(left.config), ...Object.keys(right.config)]);
  return [...keys].filter(
    (key) =>
      !IGNORED_CONFIG_KEYS.has(key) &&
      JSON.stringify((left.config as unknown as Record<string, unknown>)[key]) !==
        JSON.stringify((right.config as unknown as Record<string, unknown>)[key])
  );
};

const mismatches = configMismatches();
if (marginal) {
  if (mismatches.length !== 1 || mismatches[0] !== "cap") {
    console.error(
      `--marginal needs two runs that differ only in cap; these differ in: ${mismatches.join(", ") || "nothing"}`
    );
    process.exit(2);
  }
  if (left.config.cap <= right.config.cap) {
    console.error(
      `--marginal expects <capHigher.json> first (got cap ${left.config.cap} then ${right.config.cap})`
    );
    process.exit(2);
  }
} else if (mismatches.length > 0) {
  console.error(`Cannot compare runs with different settings: ${mismatches.join(", ")}`);
  process.exit(2);
}

type Unit = "ms" | "mb" | "count";

interface Row {
  label: string;
  before: number | null | undefined;
  after: number | null | undefined;
  unit: Unit;
  /** Lower is better (latency, memory) unless flagged. */
  higherIsBetter?: boolean;
}

const fmt = (value: number | null | undefined, unit: Unit): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (unit === "mb") return `${(value / 1024).toFixed(1)} MB`;
  if (unit === "count") return value.toFixed(0);
  return `${value.toFixed(0)} ms`;
};

const delta = (row: Row): string => {
  const { before, after } = row;
  if (
    before === null ||
    before === undefined ||
    after === null ||
    after === undefined ||
    !Number.isFinite(before) ||
    !Number.isFinite(after) ||
    before === 0
  ) {
    return "n/a";
  }
  const percent = ((after - before) / Math.abs(before)) * 100;
  const improvement = row.higherIsBetter ? percent : -percent;
  return `${improvement >= 0 ? "+" : ""}${improvement.toFixed(1)}%`;
};

const printTable = (title: string, rows: Row[], leftLabel: string, rightLabel: string): void => {
  console.log(`\n### ${title}\n`);
  console.log(`| Metric | ${leftLabel} | ${rightLabel} | Improvement |`);
  console.log("|---|---:|---:|---:|");
  for (const row of rows) {
    console.log(
      `| ${row.label} | ${fmt(row.before, row.unit)} | ${fmt(row.after, row.unit)} | ${delta(row)} |`
    );
  }
};

const stat = (
  bucket: { timings: Partial<Record<TimingKey, { p50: number; p95: number }>> } | undefined,
  key: TimingKey,
  which: "p50" | "p95"
): number | undefined => bucket?.timings[key]?.[which] ?? undefined;

const latencyRows = (
  a: RotationResult,
  b: RotationResult,
  pick: (
    r: RotationResult
  ) => Record<string, { timings: Partial<Record<TimingKey, { p50: number; p95: number }>> }>,
  prefix: string
): Row[] => {
  const keys = [...new Set([...Object.keys(pick(a)), ...Object.keys(pick(b))])].sort();
  const rows: Row[] = [];
  for (const key of keys) {
    for (const metric of ["intentToNoncePaintedMs", "intentToRevealedMs"] as const) {
      const short = metric === "intentToNoncePaintedMs" ? "nonce painted" : "revealed";
      for (const which of ["p50", "p95"] as const) {
        rows.push({
          label: `${prefix} ${key} ${short} ${which}`,
          before: stat(pick(a)[key], metric, which),
          after: stat(pick(b)[key], metric, which),
          unit: "ms",
        });
      }
    }
  }
  return rows;
};

const viewRss = (sample: MemorySample | null, projectId: string | null): number | undefined => {
  if (!sample) return undefined;
  const hit = sample.views.find((v) => v.projectId === projectId);
  return hit?.workingSetKb;
};

const memoryRows = (a: RotationResult, b: RotationResult): Row[] => {
  const rows: Row[] = [];
  for (const checkpoint of ["hot", "postPurge"] as const) {
    const sa = a.memory.checkpoints[checkpoint];
    const sb = b.memory.checkpoints[checkpoint];
    rows.push(
      {
        label: `${checkpoint} total footprint`,
        before: sa?.totalKb,
        after: sb?.totalKb,
        unit: "mb",
      },
      {
        label: `${checkpoint} renderers`,
        before: sa?.rendererTotalKb,
        after: sb?.rendererTotalKb,
        unit: "mb",
      },
      { label: `${checkpoint} GPU`, before: sa?.gpuKb, after: sb?.gpuKb, unit: "mb" },
      {
        label: `${checkpoint} PTY descendants`,
        before: sa?.ptyDescendantsKb,
        after: sb?.ptyDescendantsKb,
        unit: "mb",
      },
      {
        label: `${checkpoint} cached views`,
        before: sa?.views.length,
        after: sb?.views.length,
        unit: "count",
      }
    );
    // Project ids are per-run temp dirs, so per-view rows pair by position in the fixture.
    const projectIds = [...new Set(sa?.views.map((v) => v.projectId) ?? [])];
    const otherIds = [...new Set(sb?.views.map((v) => v.projectId) ?? [])];
    const n = Math.max(projectIds.length, otherIds.length);
    for (let i = 0; i < n; i++) {
      rows.push({
        label: `${checkpoint} view ${i} renderer RSS`,
        before: viewRss(sa, projectIds[i] ?? null),
        after: viewRss(sb, otherIds[i] ?? null),
        unit: "mb",
      });
    }
  }
  return rows;
};

const apparatusLine = (r: RotationResult): string =>
  Object.entries(r.apparatus)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

if (!marginal) {
  console.log(
    `\n## Project switch rotation: ${left.label} vs ${right.label} (cap ${left.config.cap})`
  );
  console.log(`\n${left.label}: ${apparatusLine(left)}\n${right.label}: ${apparatusLine(right)}`);
  printTable(
    "Per depth",
    latencyRows(left, right, (r) => r.byDepth as never, "depth"),
    left.label,
    right.label
  );
  printTable(
    "Per cache class",
    latencyRows(left, right, (r) => r.byCache as never, ""),
    left.label,
    right.label
  );
  printTable(
    "Weighted and rapid",
    [
      {
        label: "weighted nonce painted p50",
        before: stat(left.weighted, "intentToNoncePaintedMs", "p50"),
        after: stat(right.weighted, "intentToNoncePaintedMs", "p50"),
        unit: "ms",
      },
      {
        label: "weighted nonce painted p95",
        before: stat(left.weighted, "intentToNoncePaintedMs", "p95"),
        after: stat(right.weighted, "intentToNoncePaintedMs", "p95"),
        unit: "ms",
      },
      {
        label: "weighted revealed p50",
        before: stat(left.weighted, "intentToRevealedMs", "p50"),
        after: stat(right.weighted, "intentToRevealedMs", "p50"),
        unit: "ms",
      },
      {
        label: "weighted revealed p95",
        before: stat(left.weighted, "intentToRevealedMs", "p95"),
        after: stat(right.weighted, "intentToRevealedMs", "p95"),
        unit: "ms",
      },
      {
        label: "rapid max settle",
        before: left.rapid.maxSettleMs,
        after: right.rapid.maxSettleMs,
        unit: "ms",
      },
      {
        label: "rapid max queue delay",
        before: left.rapid.maxQueueDelayMs,
        after: right.rapid.maxQueueDelayMs,
        unit: "ms",
      },
    ],
    left.label,
    right.label
  );
  printTable("Memory", memoryRows(left, right), left.label, right.label);
  console.log("");
  process.exit(0);
}

const capDelta = left.config.cap - right.config.cap;
console.log(
  `\n## Marginal cost of a cached view: cap ${left.config.cap} (${left.label}) vs cap ${right.config.cap} (${right.label})`
);
console.log(`\n${left.label}: ${apparatusLine(left)}\n${right.label}: ${apparatusLine(right)}`);
console.log(`\n### Footprint per extra cached view (÷${capDelta})\n`);
console.log("| Checkpoint | Higher cap | Lower cap | Per view |");
console.log("|---|---:|---:|---:|");
for (const checkpoint of ["hot", "postPurge"] as const) {
  const hi = left.memory.checkpoints[checkpoint];
  const lo = right.memory.checkpoints[checkpoint];
  const rowsFor: Array<[string, number | undefined, number | undefined]> = [
    [`${checkpoint} total`, hi?.totalKb, lo?.totalKb],
    [`${checkpoint} renderers`, hi?.rendererTotalKb, lo?.rendererTotalKb],
    [`${checkpoint} GPU`, hi?.gpuKb, lo?.gpuKb],
  ];
  for (const [label, a, b] of rowsFor) {
    const per =
      a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b)
        ? (a - b) / capDelta
        : undefined;
    console.log(`| ${label} | ${fmt(a, "mb")} | ${fmt(b, "mb")} | ${fmt(per, "mb")} |`);
  }
}
printTable(
  "Latency per depth (higher cap vs lower cap; positive = higher cap faster)",
  latencyRows(right, left, (r) => r.byDepth as never, "depth"),
  right.label,
  left.label
);
printTable(
  "Weighted",
  [
    {
      label: "weighted nonce painted p50",
      before: stat(right.weighted, "intentToNoncePaintedMs", "p50"),
      after: stat(left.weighted, "intentToNoncePaintedMs", "p50"),
      unit: "ms",
    },
    {
      label: "weighted nonce painted p95",
      before: stat(right.weighted, "intentToNoncePaintedMs", "p95"),
      after: stat(left.weighted, "intentToNoncePaintedMs", "p95"),
      unit: "ms",
    },
  ],
  right.label,
  left.label
);
console.log("");
process.exit(0);
