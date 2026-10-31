// Node-level benchmark for AgentModelCatalogService's models.dev catalog load.
//   npm run perf model-catalog -- [--runs 9] [--catalog <models-catalog.json>]
//     [--oracle-out <file> | --oracle <file>]
//
// Drives the real service through its public API only, so the same script times
// any implementation. Reports, as medians:
//   - stale day: fetch, parse, validate and persist (until the write settles)
//   - warm start from the cache the service itself persisted (steady state)
//   - warm start from a full legacy cache, the shape older builds write
//   - retained heap after a forced GC while the service holds its catalog
// "busy" is event-loop active time from performance.eventLoopUtilization(): the
// synchronous Main-thread work, excluding time spent waiting on I/O.
//
// The oracle resolves every built-in agent on the cold, stale, warm and
// offline-stale paths. `--oracle-out` records it (run on the implementation
// being replaced); `--oracle` compares against that record and exits 1 on a
// mismatch.
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import { AgentModelCatalogService } from "../../electron/services/AgentModelCatalogService.js";
import {
  PROVIDER_TO_AGENT_ID,
  getEffectiveAgentConfig,
} from "../../shared/config/agentRegistry.js";
import { BUILT_IN_AGENT_IDS } from "../../shared/config/agentIds.js";
import { armBystanderProbe } from "./lib/bystander.js";
import { MODEL_CATALOG_CLASS } from "./config/benchmarkClasses.js";

type Deps = NonNullable<ConstructorParameters<typeof AgentModelCatalogService>[0]>;
type Resolved = Awaited<ReturnType<AgentModelCatalogService["getResolvedModels"]>>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const oracleOut = arg("--oracle-out");
const oracleIn = arg("--oracle");
if (oracleOut && oracleIn) {
  console.error("--oracle-out and --oracle are exclusive: record on one tree, compare on another");
  process.exit(2);
}

const runsArg = Number(arg("--runs"));
const RUNS = Number.isInteger(runsArg) && runsArg > 0 ? runsArg : 9;
const WARMUP = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error(
    "run through `npm run perf model-catalog`, or node --expose-gc --import tsx <this file>"
  );
  process.exit(2);
}
function fullGc(): void {
  for (let i = 0; i < 3; i++) gc!();
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(15672);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const date = () =>
  `20${int(23, 26)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`;

const FAMILIES = ["claude", "gpt", "gemini", "qwen", "mistral", "llama", "deepseek", "grok", "glm"];
const WORDS = [
  "Balanced",
  "Fast",
  "Frontier",
  "Compact",
  "Reasoning",
  "Coding",
  "Vision",
  "Long-context",
];

type Kind = "chat" | "embedding" | "image" | "no-tools" | "bare" | "odd-context";

/** A models.dev entry with the same field set and value shapes as the live API. */
function entry(id: string, name: string, kind: Kind = "chat"): Record<string, unknown> {
  const context = pick([32_768, 128_000, 200_000, 262_144, 1_000_000, 1_048_576]);
  const base: Record<string, unknown> = {
    id,
    name,
    description: `${pick(WORDS)} ${pick(WORDS).toLowerCase()} model for coding, analysis, agent workflows and cost control`,
    family: `${pick(FAMILIES)}-${pick(["pro", "flash", "mini", "large", "coder"])}`,
    attachment: rand() < 0.6,
    reasoning: rand() < 0.5,
    reasoning_options: [{ type: "budget_tokens", min: 1024, max: pick([32_000, 64_000]) }],
    tool_call: true,
    structured_output: rand() < 0.5,
    temperature: true,
    knowledge: date().slice(0, 7),
    release_date: date(),
    last_updated: date(),
    modalities: { input: ["text", "image"], output: ["text"] },
    open_weights: rand() < 0.3,
    limit: { context, output: pick([8_192, 32_000, 64_000, 128_000]) },
    cost: {
      input: Number((rand() * 15).toFixed(2)),
      output: Number((rand() * 60).toFixed(2)),
      cache_read: Number((rand() * 1.5).toFixed(2)),
      cache_write: Number((rand() * 4).toFixed(2)),
    },
  };
  switch (kind) {
    case "embedding":
      return { ...base, tool_call: false, modalities: { input: ["text"], output: ["embedding"] } };
    case "image":
      return { ...base, modalities: { input: ["text"], output: ["image"] } };
    case "no-tools":
      return { ...base, tool_call: false };
    case "bare":
      return { id, name, limit: { context } };
    case "odd-context":
      return { ...base, limit: { context: pick([null, "unlimited", -1]) } };
    default:
      return base;
  }
}

/**
 * Mapped providers. Each carries its agent's bundled IDs, all but the first and
 * in reverse, so merges see overlaps, a bundled-only ID, and a remote order that
 * differs from the curated one. A planted chat model owns the context maximum,
 * and a planted image model with a larger window must not.
 */
function mappedProvider(key: string, count: number): Record<string, unknown> {
  const agentId = PROVIDER_TO_AGENT_ID[key]!;
  const bundled = getEffectiveAgentConfig(agentId)?.models ?? [];
  const models: Record<string, unknown> = {};
  for (const m of bundled.slice(1).reverse()) models[m.id] = entry(m.id, `${m.name} (models.dev)`);
  models[`${key}-widest`] = {
    ...entry(`${key}-widest`, "Widest Chat"),
    limit: { context: 2_000_000 },
  };
  models[`${key}-image-wider`] = {
    ...entry(`${key}-image-wider`, "Wider Image", "image"),
    limit: { context: 9_000_000 },
  };
  const kinds: Kind[] = [
    "chat",
    "chat",
    "chat",
    "chat",
    "embedding",
    "image",
    "no-tools",
    "bare",
    "odd-context",
  ];
  for (let i = 0; Object.keys(models).length < count; i++) {
    const id = `${key}-model-${i}-${int(1, 9)}`;
    models[id] = entry(id, `${key[0]!.toUpperCase()}${key.slice(1)} Model ${i}`, pick(kinds));
  }
  return {
    id: key,
    env: [`${key.toUpperCase()}_API_KEY`],
    npm: `@ai-sdk/${key}`,
    name: key,
    doc: `https://docs.example/${key}`,
    models,
  };
}

function syntheticCatalog(): Record<string, unknown> {
  const catalog: Record<string, unknown> = {};
  const mappedCounts: Record<string, number> = {
    anthropic: 25,
    openai: 51,
    google: 40,
    alibaba: 50,
    mistral: 27,
  };
  for (const key of Object.keys(PROVIDER_TO_AGENT_ID)) {
    catalog[key] = mappedProvider(key, mappedCounts[key] ?? 30);
  }
  // ~8,700 more models across 230 aggregator-style providers, skewed like the live catalog.
  for (let p = 0; p < 230; p++) {
    const key = `provider-${p}`;
    const models: Record<string, unknown> = {};
    const count = Math.max(1, Math.round(-Math.log(1 - rand() * 0.999) * 37));
    for (let i = 0; i < count; i++) {
      const id = `${pick(FAMILIES)}/${pick(FAMILIES)}-${int(1, 9)}.${int(0, 9)}-${i}`;
      models[id] = {
        ...entry(id, `${pick(WORDS)} ${i}`, rand() < 0.1 ? "embedding" : "chat"),
        provider: { npm: "@ai-sdk/openai-compatible", api: `https://${key}.example/v1` },
      };
    }
    catalog[key] = {
      id: key,
      env: [`${key.toUpperCase()}_KEY`],
      npm: "@ai-sdk/openai-compatible",
      api: `https://${key}.example/v1`,
      name: key,
      doc: `https://${key}.example/docs`,
      models,
    };
  }
  return catalog;
}

/**
 * A supplied catalog: a profile's `models-catalog.json` or a bare models.dev
 * payload. A cache an implementation already cut down would time a workload a
 * fraction of the size the readings claim, so it is refused.
 */
function suppliedCatalog(file: string): object {
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  if ("providers" in parsed) {
    throw new Error(`${file} is a cut-down cache; pass a full models.dev payload or legacy cache`);
  }
  const catalog = "raw" in parsed && "fetchedAt" in parsed ? parsed.raw : parsed;
  if (!catalog || typeof catalog !== "object") throw new Error(`${file} holds no catalog object`);
  if (Buffer.byteLength(JSON.stringify(catalog)) < 1024 * 1024) {
    throw new Error(`${file} is under 1 MB, not a full models.dev catalog`);
  }
  return catalog;
}

const catalogPath = arg("--catalog");
const raw: object = catalogPath ? suppliedCatalog(catalogPath) : syntheticCatalog();
const rawText = JSON.stringify(raw);
const fixtureHash = createHash("sha256").update(rawText).digest("hex").slice(0, 16);
const providerCount = Object.keys(raw).length;
const modelCount = Object.values(raw as Record<string, { models?: object }>).reduce(
  (n, p) => n + Object.keys(p?.models ?? {}).length,
  0
);
const legacyFile = (fetchedAt: number) => `{"fetchedAt":${fetchedAt},"raw":${rawText}}`;

const dir = mkdtempSync(path.join(tmpdir(), "model-catalog-bench-"));
const cachePath = path.join(dir, "models-catalog.json");

// Wraps the module the service writes through, so a run can await the
// fire-and-forget persist (which only starts after getCatalog() resolves)
// instead of polling the file, which would put the observer on the timed thread.
const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
const realWriteFile = fsp.writeFile;
let writeWaiters: Array<(error?: unknown) => void> = [];
fsp.writeFile = ((...args: Parameters<typeof realWriteFile>) => {
  const p = realWriteFile(...args);
  if (args[0] === cachePath) {
    const waiters = writeWaiters;
    writeWaiters = [];
    p.then(
      () => waiters.forEach((settle) => settle()),
      (error: unknown) => waiters.forEach((settle) => settle(error))
    );
  }
  return p;
}) as typeof realWriteFile;
syncBuiltinESMExports();
/** Resolves once the next write of the cache file has landed. */
function nextWrite(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no cache write observed within 10s")), 10_000);
    writeWaiters.push((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

let fetches = 0;
const onlineFetch: Deps["fetchImpl"] = async () => {
  fetches++;
  // `json()` parses on the caller's thread, as `net.fetch`'s Response does.
  const res = {
    ok: true,
    status: 200,
    json: async () => JSON.parse(rawText) as unknown,
    text: async () => rawText,
  };
  return res;
};
const offlineFetch: Deps["fetchImpl"] = async () => {
  fetches++;
  throw new Error("offline");
};
const codexCli: Deps["execFileImpl"] = (async () => ({
  stdout: JSON.stringify({
    models: [
      {
        slug: "gpt-bench-sol",
        display_name: "GPT-Bench-Sol",
        visibility: "list",
        priority: 1,
        max_context_window: 400_000,
      },
      { slug: "gpt-bench-luna", display_name: "GPT-Bench-Luna", visibility: "list", priority: 2 },
    ],
  }),
  stderr: "",
})) as unknown as Deps["execFileImpl"];

// An absolute command keeps the Codex CLI lookup from needing `codex` installed.
const service = (fetchImpl: Deps["fetchImpl"]) =>
  new AgentModelCatalogService({
    cachePath,
    fetchImpl,
    execFileImpl: codexCli,
    codexCommand: process.execPath,
  });

/** Fails the run when a sample did not do the work it claims to time. */
function expectFetches(expected: number, label: string): void {
  if (fetches !== expected)
    throw new Error(`${label}: expected ${expected} fetch(es), saw ${fetches}`);
  fetches = 0;
}

interface Sample {
  wallMs: number;
  busyMs: number;
  longestStallMs: number;
}

async function timed(fn: () => Promise<unknown>): Promise<Sample> {
  // Setup garbage (fixture strings, the previous sample's catalog) is collected
  // here, so a collection inside the window belongs to the workload.
  fullGc();
  const probe = await armBystanderProbe({ cadenceMs: 4 });
  const elu0 = performance.eventLoopUtilization();
  const t0 = performance.now();
  await fn();
  const wallMs = performance.now() - t0;
  const busyMs = performance.eventLoopUtilization(elu0).active;
  const reading = probe.stop();
  if (reading.probeMisses > 0) throw new Error("bystander probe never armed");
  return { wallMs, busyMs, longestStallMs: reading.longestStallMs };
}

async function staleDay(previousCache: string): Promise<Sample> {
  writeFileSync(cachePath, withFetchedAt(previousCache, Date.now() - 2 * DAY_MS));
  const svc = service(onlineFetch);
  const persisted = nextWrite();
  const sample = await timed(async () => {
    if (!(await svc.getCatalog())) throw new Error("stale day: catalog failed to load");
    await persisted;
  });
  expectFetches(1, "stale day");
  return sample;
}

async function warmStart(fileText: string): Promise<Sample> {
  writeFileSync(cachePath, fileText);
  const svc = service(offlineFetch);
  const sample = await timed(async () => {
    if (!(await svc.getCatalog())) throw new Error("warm start: catalog failed to load");
  });
  expectFetches(0, "warm start");
  return sample;
}

async function retainedHeap(fileText: string): Promise<number> {
  writeFileSync(cachePath, fileText);
  fullGc();
  const before = process.memoryUsage().heapUsed;
  const svc = service(offlineFetch);
  await svc.getCatalog();
  fullGc();
  const after = process.memoryUsage().heapUsed;
  // Keeps the service, and the catalog it caches, reachable across the second GC.
  if (!(await svc.getCatalog())) throw new Error("retained heap: catalog failed to load");
  expectFetches(0, "retained heap");
  return after - before;
}

function withFetchedAt(fileText: string, fetchedAt: number): string {
  return JSON.stringify({ ...(JSON.parse(fileText) as object), fetchedAt });
}

const legacyText = legacyFile(Date.now());

/** The cache file exactly as this implementation persists it on a stale-day refresh. */
async function persistedCacheText(): Promise<string> {
  await staleDay(legacyText);
  return withFetchedAt(readFileSync(cachePath, "utf-8"), Date.now());
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const summarize = (samples: Sample[]) => ({
  wallMs: median(samples.map((s) => s.wallMs)),
  busyMs: median(samples.map((s) => s.busyMs)),
  longestStallMs: median(samples.map((s) => s.longestStallMs)),
  busyMinMs: Math.min(...samples.map((s) => s.busyMs)),
  busyMaxMs: Math.max(...samples.map((s) => s.busyMs)),
});

async function repeat<T>(fn: () => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < RUNS + WARMUP; i++) {
    const v = await fn();
    if (i >= WARMUP) out.push(v);
  }
  return out;
}

async function resolveAll(fetchImpl: Deps["fetchImpl"]): Promise<Record<string, Resolved>> {
  const out: Record<string, Resolved> = {};
  const svc = service(fetchImpl);
  for (const id of BUILT_IN_AGENT_IDS) out[id] = await svc.getResolvedModels(id);
  return out;
}

async function oraclePaths(
  persistedText: string
): Promise<Record<string, Record<string, Resolved>>> {
  rmSync(cachePath, { force: true });
  let persisted = nextWrite();
  const cold = await resolveAll(onlineFetch);
  await persisted;
  expectFetches(1, "oracle cold");

  writeFileSync(cachePath, withFetchedAt(legacyText, Date.now() - 2 * DAY_MS));
  persisted = nextWrite();
  const staleLegacy = await resolveAll(onlineFetch);
  await persisted;
  expectFetches(1, "oracle stale legacy");

  writeFileSync(cachePath, withFetchedAt(persistedText, Date.now() - 2 * DAY_MS));
  persisted = nextWrite();
  const stalePersisted = await resolveAll(onlineFetch);
  await persisted;
  expectFetches(1, "oracle stale persisted");

  writeFileSync(cachePath, persistedText);
  const warmPersisted = await resolveAll(offlineFetch);
  expectFetches(0, "oracle warm persisted");

  writeFileSync(cachePath, legacyText);
  const warmLegacy = await resolveAll(offlineFetch);
  expectFetches(0, "oracle warm legacy");

  // Offline with only stale data on disk: served as-is rather than dropped.
  writeFileSync(cachePath, withFetchedAt(persistedText, Date.now() - 2 * DAY_MS));
  const offlineStale = await resolveAll(offlineFetch);
  fetches = 0;

  return { cold, staleLegacy, stalePersisted, warmPersisted, warmLegacy, offlineStale };
}

const persistedText = await persistedCacheText();

const staleFromLegacy = summarize(await repeat(() => staleDay(legacyText)));
const staleSteady = summarize(await repeat(() => staleDay(persistedText)));
const warm = summarize(await repeat(() => warmStart(persistedText)));
const warmLegacy = summarize(await repeat(() => warmStart(legacyText)));
const heap = median(await repeat(() => retainedHeap(persistedText)));
const heapLegacy = median(await repeat(() => retainedHeap(legacyText)));

const paths = await oraclePaths(persistedText);
const failures: string[] = [];
for (const [name, resolved] of Object.entries(paths)) {
  if (!isDeepStrictEqual(resolved, paths.cold))
    failures.push(`${name} path disagrees with the cold path`);
}
// Codex resolves from its CLI stub, so its non-bundled source says nothing
// about the catalog.
const catalogAgents = [...new Set(Object.values(PROVIDER_TO_AGENT_ID))].filter(
  (id) => id !== "codex"
);
const remoteAgents = catalogAgents.filter((id) => paths.cold[id]?.source !== "bundled");
if (remoteAgents.length === 0) failures.push("no agent resolved from the catalog");
if (!catalogPath && remoteAgents.length !== catalogAgents.length) {
  failures.push(
    `synthetic fixture left ${catalogAgents.filter((id) => !remoteAgents.includes(id)).join(", ")} on bundled`
  );
}

if (oracleOut) {
  writeFileSync(oracleOut, JSON.stringify({ fixtureHash, resolved: paths.cold }, null, 2));
}
if (oracleIn) {
  const recorded = JSON.parse(readFileSync(oracleIn, "utf-8")) as {
    fixtureHash: string;
    resolved: Record<string, Resolved>;
  };
  if (recorded.fixtureHash !== fixtureHash) {
    failures.push(`oracle was recorded on fixture ${recorded.fixtureHash}, not ${fixtureHash}`);
  } else {
    for (const id of new Set([...Object.keys(recorded.resolved), ...Object.keys(paths.cold)])) {
      if (!isDeepStrictEqual(recorded.resolved[id], paths.cold[id])) {
        failures.push(`${id}: resolved output differs from the recorded oracle`);
      }
    }
  }
}

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);
const fmt = (label: string, s: ReturnType<typeof summarize>) =>
  `${label.padEnd(40)} wall ${s.wallMs.toFixed(2).padStart(7)} ms   busy ${s.busyMs.toFixed(2).padStart(7)} ms ` +
  `(${s.busyMinMs.toFixed(2)}-${s.busyMaxMs.toFixed(2)})   longest stall ${s.longestStallMs.toFixed(2).padStart(7)} ms`;
console.log(
  `node ${process.version} ${process.platform}/${process.arch}, ${cpus()[0]?.model ?? "unknown cpu"}; ` +
    `${RUNS} runs (+${WARMUP} warmup), medians with busy range`
);
console.log(
  `fixture ${fixtureHash}: ${providerCount} providers, ${modelCount} models, ${mb(Buffer.byteLength(rawText))} MB; ` +
    `persisted cache ${mb(Buffer.byteLength(persistedText))} MB`
);
console.log(fmt("stale day: from a full legacy cache", staleFromLegacy));
console.log(fmt("stale day: from its own persisted cache", staleSteady));
console.log(fmt("warm start: its own persisted cache", warm));
console.log(fmt("warm start: full legacy cache", warmLegacy));
console.log(`${"retained heap: its own persisted cache".padEnd(40)} ${mb(heap)} MB`);
console.log(`${"retained heap: full legacy cache".padEnd(40)} ${mb(heapLegacy)} MB`);
console.log(
  `oracle (${BUILT_IN_AGENT_IDS.length} agents; from the catalog: ${remoteAgents.join(", ")}): ` +
    (failures.length === 0 ? "ok" : failures.join("; "))
);
console.log(
  `RESULT ${JSON.stringify({ classification: MODEL_CATALOG_CLASS, fixtureHash, providerCount, modelCount, persistedBytes: Buffer.byteLength(persistedText), staleFromLegacy, staleSteady, warm, warmLegacy, heapBytes: heap, heapLegacyBytes: heapLegacy, oracle: failures })}`
);

rmSync(dir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
