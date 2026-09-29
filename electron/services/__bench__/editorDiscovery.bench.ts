import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, bench, describe, vi } from "vitest";
import { mockExecaChildren } from "../__tests__/helpers/editorChild.js";

// Editor discovery against a synthetic 30-directory PATH of real temp dirs, a
// few holding editor binaries (one a directory, one not executable). Measures
// what Settings → Editor (`discover`) and an open-in-editor whose configured
// editor is missing (the KNOWN_EDITORS fallback loop) cost the main thread.
//
//   npx vitest bench --run electron/services/__bench__/editorDiscovery.bench.ts
//
// POSIX hosts only: the fixture builds a POSIX PATH. Besides the timed benches
// it prints, once per run, the fs calls made, the longest main-thread block,
// and a synthetic-latency variant where every probe under three of the PATH
// dirs costs 2 ms (busy-wait for sync calls, a timer for async ones — the same
// latency, charged to whichever side pays). It models a slow mount's latency,
// not its occupancy of libuv's fs threads.

const execaMock = vi.hoisted(() => ({ execa: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock.execa }));
vi.mock("electron", () => ({ shell: { openPath: vi.fn(async () => "") } }));

const PATH_DIRS = 30;
const SLOW_DIRS = new Set([3, 14, 26]);
const SLOW_MS = 2;

const originalPlatform = process.platform;
const originalEnv = {
  PATH: process.env.PATH,
  VISUAL: process.env.VISUAL,
  EDITOR: process.env.EDITOR,
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-discovery-bench-"));
const dirs = Array.from({ length: PATH_DIRS }, (_, i) => {
  const dir = path.join(root, `bin${String(i).padStart(2, "0")}`);
  fs.mkdirSync(dir);
  return dir;
});
function writeBinary(dir: number, name: string, mode = 0o755) {
  const file = path.join(dirs[dir], name);
  fs.writeFileSync(file, "#!/bin/sh\n");
  fs.chmodSync(file, mode);
}
fs.mkdirSync(path.join(dirs[7], "zed"));
writeBinary(18, "idea", 0o644);
writeBinary(24, "rider");
writeBinary(29, "subl");

afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const slowPrefixes = [...SLOW_DIRS].map((i) => dirs[i] + path.sep);
const isSlow = (p: unknown) => typeof p === "string" && slowPrefixes.some((s) => p.startsWith(s));
let slowMode = false;
let syncCalls = 0;
let asyncCalls = 0;

const realStatSync = fs.statSync.bind(fs);
const realAccessSync = fs.accessSync.bind(fs);
const realStat = fs.promises.stat.bind(fs.promises);
const realAccess = fs.promises.access.bind(fs.promises);
function busyWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end);
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
  syncCalls++;
  if (slowMode && isSlow(p)) busyWait(SLOW_MS);
  return realStatSync(p, o);
}) as typeof fs.statSync);
vi.spyOn(fs, "accessSync").mockImplementation((p: fs.PathLike, m?: number) => {
  syncCalls++;
  if (slowMode && isSlow(p)) busyWait(SLOW_MS);
  return realAccessSync(p, m);
});
vi.spyOn(fs.promises, "stat").mockImplementation((async (p: fs.PathLike, o?: fs.StatOptions) => {
  asyncCalls++;
  if (slowMode && isSlow(p)) await delay(SLOW_MS);
  return realStat(p, o);
}) as typeof fs.promises.stat);
vi.spyOn(fs.promises, "access").mockImplementation(async (p: fs.PathLike, m?: number) => {
  asyncCalls++;
  if (slowMode && isSlow(p)) await delay(SLOW_MS);
  return realAccess(p, m);
});

// Linux keeps the run off the real /Applications bundles; on macOS every
// editor also probes ~2 app-bundle dirs (WebStorm: 22), which only adds work.
Object.defineProperty(process, "platform", { value: "linux" });
process.env.PATH = dirs.join(path.delimiter);
delete process.env.VISUAL;
delete process.env.EDITOR;
mockExecaChildren(execaMock.execa, ["spawned"]);

const { discover, openFile } = await import("../EditorService.js");

// Longest gap between event-loop turns while `run` is in flight — the time the
// main thread could not service IPC, input, or timers.
async function measure(run: () => unknown) {
  syncCalls = 0;
  asyncCalls = 0;
  let maxGap = 0;
  let last = performance.now();
  let ticking = true;
  const tick = () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    if (ticking) setImmediate(tick);
  };
  setImmediate(tick);
  const start = performance.now();
  const pending = run();
  const syncMs = performance.now() - start;
  const result = await pending;
  const wallMs = performance.now() - start;
  // Let any probe still in flight finish inside this sample, not the next.
  for (let seen = -1; seen !== syncCalls + asyncCalls;) {
    seen = syncCalls + asyncCalls;
    await new Promise((r) => setTimeout(r, SLOW_MS * 3));
  }
  ticking = false;
  maxGap = Math.max(maxGap, syncMs, performance.now() - last);
  return { result, syncMs, wallMs, maxBlockMs: maxGap, syncCalls, asyncCalls };
}

const runDiscover = () => discover();
const runFallback = () => openFile("/abs/project/src/app.ts", 12, 3, { id: "cursor" });

const REPEATS = 15;
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
async function report(label: string, run: () => unknown) {
  await measure(run); // warm-up
  const samples = [];
  for (let i = 0; i < REPEATS; i++) samples.push(await measure(run));
  const row = {
    scenario: label,
    syncFsCalls: samples[0].syncCalls,
    asyncFsCalls: samples[0].asyncCalls,
    medianMaxBlockMs: +median(samples.map((s) => s.maxBlockMs)).toFixed(3),
    medianWallMs: +median(samples.map((s) => s.wallMs)).toFixed(3),
  };
  return row;
}

const rows = [];
rows.push(await report("discover()", runDiscover));
rows.push(await report("openFile fallback", runFallback));
slowMode = true;
rows.push(await report("discover() slow mount", runDiscover));
rows.push(await report("openFile fallback slow mount", runFallback));
slowMode = false;
const sample = (await measure(runDiscover)).result as Array<{
  id: string;
  executablePath?: string;
}>;
const found = sample
  .filter((e) => e.executablePath)
  .map((e) => `${e.id}=${path.basename(e.executablePath!)}`);
const launched = path.basename(execaMock.execa.mock.lastCall?.[0] ?? "none");
if (found.join(",") !== "webstorm=rider,sublime=subl" || launched !== "rider") {
  throw new Error(`Unexpected discovery result: ${found.join(",")} / ${launched}`);
}
// Straight to the fd: bench mode swallows console output.
fs.writeSync(
  1,
  [
    "",
    `[editorDiscovery] found: ${found.join(", ")}`,
    `[editorDiscovery] fallback launched: ${launched}`,
    ...rows.map((r) => `[editorDiscovery] ${JSON.stringify(r)}`),
    "",
  ].join("\n")
);

describe("editor discovery (30-dir PATH)", () => {
  bench("discover()", async () => {
    await runDiscover();
  });
  bench("openFile, configured editor missing → fallback loop", async () => {
    await runFallback();
  });
});
