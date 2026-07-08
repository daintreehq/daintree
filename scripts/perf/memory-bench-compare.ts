// Compare two memory kitchen-sink benchmark result files and print a
// before/after markdown table with percentage deltas.
//
//   npx tsx scripts/perf/memory-bench-compare.ts \
//     .tmp/perf-results/memory-bench/baseline.json \
//     .tmp/perf-results/memory-bench/optimized.json
import { readFileSync } from "node:fs";

interface Aggregate {
  meanKb: number;
  stdDevKb: number;
  minKb: number;
  maxKb: number;
  p95Kb: number;
}

interface BenchResult {
  label: string;
  config: Record<string, number>;
  aggregates: Record<string, Aggregate>;
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: tsx scripts/perf/memory-bench-compare.ts <before.json> <after.json>");
  process.exit(1);
}

const before = JSON.parse(readFileSync(beforePath, "utf8")) as BenchResult;
const after = JSON.parse(readFileSync(afterPath, "utf8")) as BenchResult;

const configMismatch = Object.keys(before.config).filter(
  (k) => before.config[k] !== after.config[k]
);
if (configMismatch.length > 0) {
  console.warn(
    `WARNING: config mismatch on ${configMismatch.join(", ")} — comparison may be invalid`
  );
}

const mb = (kb: number) => (kb / 1024).toFixed(1);
const delta = (b: number, a: number) => {
  if (b <= 0) return "n/a";
  const pct = ((a - b) / b) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
};

const keys = Object.keys(before.aggregates).filter((k) => after.aggregates[k]);

console.log(`\n## Memory benchmark: ${before.label} vs ${after.label}\n`);
console.log(
  `| Metric | ${before.label} mean (MB) | ${after.label} mean (MB) | Δ mean | ${before.label} p95 (MB) | ${after.label} p95 (MB) | Δ p95 |`
);
console.log("|---|---|---|---|---|---|---|");
for (const key of keys) {
  const b = before.aggregates[key];
  const a = after.aggregates[key];
  console.log(
    `| ${key.replace(/Kb$/, "")} | ${mb(b.meanKb)} ±${mb(b.stdDevKb)} | ${mb(a.meanKb)} ±${mb(a.stdDevKb)} | ${delta(b.meanKb, a.meanKb)} | ${mb(b.p95Kb)} | ${mb(a.p95Kb)} | ${delta(b.p95Kb, a.p95Kb)} |`
  );
}
console.log("");
