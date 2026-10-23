import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

interface Phase {
  footprint: { rendererMedianKb: number | null; gpuMedianKb: number | null };
  vmmap: { dirtyByBucketKb?: Record<string, number> };
  v8: { jsHeapUsedSize: number | null };
  blink: { nodes: number | null; jsEventListeners: number | null };
  memoryInfra: { providers?: Record<string, { sizeKb: number }> };
}

interface Result {
  label: string;
  config: Record<string, unknown>;
  phases: { empty: Phase; cached: Phase; afterSession: Phase };
}

function load(target: string): Result[] {
  const files = statSync(target).isDirectory()
    ? readdirSync(target)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(target, name))
    : [target];
  return files.map((file) => JSON.parse(readFileSync(file, "utf8")) as Result);
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error(
    "usage: npm run perf empty-view-memory-compare -- <before.json|dir> <after.json|dir>"
  );
  process.exit(1);
}

const before = load(beforePath);
const after = load(afterPath);
if (before.length === 0 || after.length === 0) {
  console.error("Each side needs at least one result file.");
  process.exit(1);
}
const configs = new Set([...before, ...after].map((result) => JSON.stringify(result.config)));
if (configs.size > 1) {
  console.error("Cannot compare runs with different settings:");
  for (const config of configs) console.error(`  ${config}`);
  process.exit(2);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Pick = (phase: Phase) => number | null | undefined;

type PhaseKey = keyof Result["phases"];

// Region and provider rows under 1 MB on both sides are noise in a table read
// for where a view's memory goes.
const MIN_ROW_KB = 1024;

function row(
  label: string,
  phaseKey: PhaseKey,
  pick: Pick,
  unit: "mb" | "n",
  { always = true }: { always?: boolean } = {}
): string | null {
  const values = (results: Result[]) =>
    median(
      results
        .map((result) => pick(result.phases[phaseKey]))
        .filter((value): value is number => typeof value === "number")
    );
  const b = values(before);
  const a = values(after);
  if (!always && (b ?? 0) < MIN_ROW_KB && (a ?? 0) < MIN_ROW_KB) return null;
  const fmt = (value: number | null) =>
    value === null ? "—" : unit === "mb" ? `${(value / 1024).toFixed(1)} MB` : value.toFixed(0);
  const delta =
    a === null || b === null
      ? "—"
      : `${a - b >= 0 ? "+" : ""}${unit === "mb" ? `${((a - b) / 1024).toFixed(1)} MB` : (a - b).toFixed(0)}`;
  return `| ${label} | ${fmt(b)} | ${fmt(a)} | ${delta} |`;
}

const bucketKeys = new Set<string>();
const providerKeys = new Set<string>();
for (const result of [...before, ...after]) {
  for (const phase of Object.values(result.phases)) {
    Object.keys(phase.vmmap.dirtyByBucketKb ?? {}).forEach((key) => bucketKeys.add(key));
    Object.keys(phase.memoryInfra.providers ?? {}).forEach((key) => providerKeys.add(key));
  }
}

console.log(`before: ${before.length} run(s) from ${beforePath}`);
console.log(`after:  ${after.length} run(s) from ${afterPath}\n`);
for (const phaseKey of ["empty", "cached", "afterSession"] as const) {
  console.log(`### ${phaseKey}\n`);
  console.log("| Metric (median) | Before | After | Delta |");
  console.log("| --- | ---: | ---: | ---: |");
  console.log(row("Renderer footprint", phaseKey, (p) => p.footprint.rendererMedianKb, "mb"));
  console.log(row("GPU process footprint", phaseKey, (p) => p.footprint.gpuMedianKb, "mb"));
  console.log(
    row("JS heap used", phaseKey, (p) => (p.v8.jsHeapUsedSize ?? NaN) / 1024 || null, "mb")
  );
  console.log(row("DOM nodes", phaseKey, (p) => p.blink.nodes, "n"));
  console.log(row("JS event listeners", phaseKey, (p) => p.blink.jsEventListeners, "n"));
  const optional = [
    ...[...bucketKeys].sort().map((key) =>
      row(`vmmap dirty: ${key}`, phaseKey, (p) => p.vmmap.dirtyByBucketKb?.[key], "mb", {
        always: false,
      })
    ),
    ...[...providerKeys].sort().map((key) =>
      row(`MemoryInfra: ${key}`, phaseKey, (p) => p.memoryInfra.providers?.[key]?.sizeKb, "mb", {
        always: false,
      })
    ),
  ];
  for (const line of optional) if (line) console.log(line);
  console.log("");
}
