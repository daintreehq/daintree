/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openTerminal, getGridPanelIds, getPanelById } from "../../helpers/panels";
import {
  runTerminalCommand,
  waitForTerminalText,
  waitForTerminalPty,
} from "../../helpers/terminal";
import { measureMainMemory } from "../../helpers/stress";

// Kitchen-sink memory benchmark. Unlike the nightly leak specs (which assert
// growth deltas across churn cycles), this harness measures the absolute
// memory footprint of a heavy but realistic session, repeated over N full app
// lifecycles so runs are comparable across branches with mean/p95 statistics.
//
// Each iteration walks four phases:
//   1. seed    — several projects, several terminals each, a burst of real
//                scrollback per terminal, then an endless fixed-rate output
//                stream started in EVERY terminal (all projects at once)
//   2. storm   — dirty every repo (git status work in all workspace hosts) and
//                round-robin project switches while all terminals stream
//   3. active  — samples taken while all terminals in all projects stream
//                (metrics prefixed `active.`)
//   4. idle    — Ctrl-C everything, settle, then steady-state samples of the
//                retained footprint (unprefixed metrics)
//
// Three measurement sources per sample, all cross-checkable:
//   - `ps` RSS over the full process tree (command-line ground truth; on
//     macOS RSS double-counts shared memory across Chromium processes, but
//     it is comparable across arms of an A/B run)
//   - `footprint` phys_footprint per process (macOS-only; the metric Activity
//     Monitor's "Memory" column is based on, no shared-page double count)
//   - `app.getAppMetrics()` workingSetSize, attributed per process type and
//     per utility-process service name (renderer vs pty-host vs workspace…)
//
// Shell processes spawned inside terminals (zsh + dotfiles) are real memory
// but not app-optimizable, so they are reported separately and excluded from
// the headline "app" metrics.
const PROJECT_COUNT = Number(process.env.MEM_BENCH_PROJECTS ?? 4);
const TERMINALS_PER_PROJECT = Number(process.env.MEM_BENCH_TERMINALS ?? 3);
const ITERATIONS = Number(process.env.MEM_BENCH_ITERATIONS ?? 5);
const SCROLLBACK_LINES = Number(process.env.MEM_BENCH_SCROLLBACK_LINES ?? 4000);
const SETTLE_MS = Number(process.env.MEM_BENCH_SETTLE_MS ?? 12_000);
// Long enough sustained painting (all terminals streaming) for the GPU
// process's tile/SharedImage caches to reach their budget-limited steady
// state — short bursts sample Chromium's cache mid-growth and understate
// what an hours-long real session retains.
const ACTIVE_SETTLE_MS = Number(process.env.MEM_BENCH_ACTIVE_SETTLE_MS ?? 60_000);
const SAMPLES_PER_ITERATION = Number(process.env.MEM_BENCH_SAMPLES ?? 3);
const SAMPLE_GAP_MS = Number(process.env.MEM_BENCH_SAMPLE_GAP_MS ?? 2_000);
const LABEL = process.env.MEM_BENCH_LABEL ?? "run";
const OUT_DIR = path.join(process.cwd(), ".tmp", "perf-results", "memory-bench");
const TEST_TIMEOUT_MS =
  180_000 +
  ACTIVE_SETTLE_MS +
  SETTLE_MS +
  Math.max(0, SAMPLES_PER_ITERATION - 1) * SAMPLE_GAP_MS * 2;

type ProcessClass = "main" | "renderer" | "utility" | "gpu" | "crashpad" | "shell";

interface PsProc {
  pid: number;
  ppid: number;
  rssKb: number;
  command: string;
}

interface MemorySample {
  treeTotalRssKb: number;
  appRssKb: number;
  shellRssKb: number;
  rssByClass: Record<ProcessClass, number>;
  appFootprintKb: number | null;
  footprintByClass: Record<ProcessClass, number>;
  metricsWorkingSetKb: Record<string, number>;
  utilityByNameKb: Record<string, number>;
  mainHeapUsedKb: number;
  mainExternalKb: number;
  rendererJsHeapKb: number;
  viewCount: number;
  processCount: number;
}

interface IterationResult {
  iteration: number;
  terminalCount: number;
  samples: MemorySample[];
  activeSamples: MemorySample[];
  means: Record<string, number>;
}

function listProcesses(): PsProc[] {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const procs: PsProc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), command: m[4] });
  }
  return procs;
}

function collectTree(rootPid: number, procs: PsProc[]): PsProc[] {
  const byParent = new Map<number, PsProc[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const tree: PsProc[] = [];
  const root = procs.find((p) => p.pid === rootPid);
  if (root) tree.push(root);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      tree.push(child);
      queue.push(child.pid);
    }
  }
  return tree;
}

function classify(proc: PsProc, rootPid: number): ProcessClass {
  if (proc.pid === rootPid) return "main";
  const cmd = proc.command;
  if (cmd.includes("--type=renderer")) return "renderer";
  if (cmd.includes("--type=utility")) return "utility";
  if (cmd.includes("--type=gpu-process")) return "gpu";
  if (cmd.includes("crashpad")) return "crashpad";
  if (cmd.includes("--type=")) return "utility";
  return "shell";
}

/**
 * Per-pid phys_footprint via macOS `footprint`. One invocation per pid —
 * multi-pid output interleaves sections ambiguously, and a single-process
 * report pairs unambiguously. Empty map off-macOS; missing pids are skipped.
 */
function measureFootprintByPid(pids: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (process.platform !== "darwin" || pids.length === 0) return result;
  for (const pid of pids) {
    try {
      const out = execFileSync("footprint", ["-p", String(pid)], {
        encoding: "utf8",
        timeout: 10_000,
      });
      const phys = out.match(/phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
      if (!phys) continue;
      const value = Number(phys[1]);
      const kb = phys[2] === "GB" ? value * 1024 * 1024 : phys[2] === "MB" ? value * 1024 : value;
      result.set(pid, Math.round(kb));
    } catch {
      // Process may have exited between the ps snapshot and this call.
    }
  }
  return result;
}

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1));
}

/** Linear-interpolation percentile, same method as scripts/perf/lib/stats.ts. */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function takeSample(ctx: AppContext): Promise<MemorySample> {
  const rootPid = ctx.app.process().pid!;
  const tree = collectTree(rootPid, listProcesses());

  const rssByClass: Record<ProcessClass, number> = {
    main: 0,
    renderer: 0,
    utility: 0,
    gpu: 0,
    crashpad: 0,
    shell: 0,
  };
  for (const proc of tree) {
    rssByClass[classify(proc, rootPid)] += proc.rssKb;
  }
  const treeTotalRssKb = tree.reduce((acc, p) => acc + p.rssKb, 0);
  const shellRssKb = rssByClass.shell;

  const footprintByPid = measureFootprintByPid(tree.map((p) => p.pid));
  const footprintByClass: Record<ProcessClass, number> = {
    main: 0,
    renderer: 0,
    utility: 0,
    gpu: 0,
    crashpad: 0,
    shell: 0,
  };
  for (const proc of tree) {
    footprintByClass[classify(proc, rootPid)] += footprintByPid.get(proc.pid) ?? 0;
  }
  const appFootprintKb =
    footprintByPid.size === 0
      ? null
      : footprintByClass.main +
        footprintByClass.renderer +
        footprintByClass.utility +
        footprintByClass.gpu +
        footprintByClass.crashpad;

  const metrics: Array<{ pid: number; type: string; name: string | null; workingSetKb: number }> =
    await ctx.app.evaluate(async ({ app }) =>
      app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        name: (m as any).name ?? (m as any).serviceName ?? null,
        workingSetKb: m.memory.workingSetSize,
      }))
    );
  const metricsWorkingSetKb: Record<string, number> = {};
  const utilityByNameKb: Record<string, number> = {};
  for (const m of metrics) {
    metricsWorkingSetKb[m.type] = (metricsWorkingSetKb[m.type] ?? 0) + m.workingSetKb;
    if (m.type === "Utility") {
      const key = m.name ?? "unknown";
      utilityByNameKb[key] = (utilityByNameKb[key] ?? 0) + m.workingSetKb;
    }
  }

  // JS heap of every live project view (active + cached), summed. Cached
  // views are detached from contentView.children, so enumerate through the
  // ProjectViewManager e2e seam. Throttled/frozen cached views may never
  // answer executeJavaScript, so each probe races a short timeout instead of
  // stalling the whole sample.
  const viewInfo: { count: number; heaps: number[] } = await ctx.app.evaluate(async () => {
    const g = globalThis as unknown as { __daintreeGetPvm?: () => unknown };
    const pvm = g.__daintreeGetPvm?.() as
      | {
          getAllViews: () => Array<{
            view: { webContents: Electron.WebContents };
            projectId: string;
            state: string;
          }>;
        }
      | null
      | undefined;
    if (!pvm) return { count: 0, heaps: [] };
    let count = 0;
    const heaps: number[] = [];
    for (const entry of pvm.getAllViews()) {
      const wc = entry.view?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      count++;
      const probe = wc
        .executeJavaScript("performance.memory ? performance.memory.usedJSHeapSize : 0", true)
        .catch(() => 0) as Promise<number>;
      const heap = await Promise.race([
        probe,
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 2_000)),
      ]);
      if (typeof heap === "number" && heap > 0) heaps.push(heap);
    }
    return { count, heaps };
  });
  const viewHeaps = viewInfo.heaps;

  const mainMem = await measureMainMemory(ctx.app);

  return {
    treeTotalRssKb,
    appRssKb: treeTotalRssKb - shellRssKb,
    shellRssKb,
    rssByClass,
    appFootprintKb,
    footprintByClass,
    metricsWorkingSetKb,
    utilityByNameKb,
    mainHeapUsedKb: Math.round(mainMem.heapUsed / 1024),
    mainExternalKb: Math.round(mainMem.external / 1024),
    rendererJsHeapKb: Math.round(viewHeaps.reduce((a, b) => a + b, 0) / 1024),
    viewCount: viewInfo.count,
    processCount: tree.length,
  };
}

function sampleMeans(samples: MemorySample[]): Record<string, number> {
  const pick = (fn: (s: MemorySample) => number | null) => {
    const vals = samples.map(fn).filter((v): v is number => typeof v === "number" && v > 0);
    return Math.round(mean(vals));
  };
  const means: Record<string, number> = {
    treeTotalRssKb: pick((s) => s.treeTotalRssKb),
    appRssKb: pick((s) => s.appRssKb),
    shellRssKb: pick((s) => s.shellRssKb),
    appFootprintKb: pick((s) => s.appFootprintKb),
    mainRssKb: pick((s) => s.rssByClass.main),
    rendererRssKb: pick((s) => s.rssByClass.renderer),
    utilityRssKb: pick((s) => s.rssByClass.utility),
    gpuRssKb: pick((s) => s.rssByClass.gpu),
    mainFootprintKb: pick((s) => s.footprintByClass.main),
    rendererFootprintKb: pick((s) => s.footprintByClass.renderer),
    utilityFootprintKb: pick((s) => s.footprintByClass.utility),
    mainHeapUsedKb: pick((s) => s.mainHeapUsedKb),
    rendererJsHeapKb: pick((s) => s.rendererJsHeapKb),
  };
  const utilityNames = new Set(samples.flatMap((s) => Object.keys(s.utilityByNameKb)));
  for (const name of utilityNames) {
    means[`utility:${name}Kb`] = pick((s) => s.utilityByNameKb[name] ?? null);
  }
  return means;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const iterationResults: IterationResult[] = [];

// Opt-in only — a measurement harness for local A/B runs, not a CI gate.
//   RUN_PERF_MEMORY=1 MEM_BENCH_LABEL=baseline npx playwright test \
//     --project=full-resilience e2e/full/resilience/memory-kitchen-sink.spec.ts
const perfDescribe = process.env.RUN_PERF_MEMORY ? test.describe.serial : test.describe.skip;

perfDescribe("Resilience: kitchen-sink memory benchmark", () => {
  let cleanups: Array<() => void> = [];
  let repos: string[] = [];

  test.beforeAll(() => {
    const fixtures = createFixtureRepos(PROJECT_COUNT);
    cleanups = fixtures.map((f) => f.cleanup);
    repos = fixtures.map((f) => f.dir);
  });

  test.afterAll(() => {
    for (const c of cleanups) c();
    if (iterationResults.length === 0) return;

    const metricKeys = Object.keys(iterationResults[0].means);
    const aggregates: Record<
      string,
      { meanKb: number; stdDevKb: number; minKb: number; maxKb: number; p95Kb: number }
    > = {};
    for (const key of metricKeys) {
      const vals = iterationResults.map((r) => r.means[key]).filter((v) => v > 0);
      if (vals.length === 0) continue;
      aggregates[key] = {
        meanKb: Math.round(mean(vals)),
        stdDevKb: Math.round(stdDev(vals)),
        minKb: Math.round(Math.min(...vals)),
        maxKb: Math.round(Math.max(...vals)),
        p95Kb: Math.round(percentile(vals, 95)),
      };
    }

    mkdirSync(OUT_DIR, { recursive: true });
    const payload = {
      label: LABEL,
      platform: process.platform,
      createdAt: new Date().toISOString(),
      config: {
        projects: PROJECT_COUNT,
        terminalsPerProject: TERMINALS_PER_PROJECT,
        iterations: ITERATIONS,
        scrollbackLines: SCROLLBACK_LINES,
        settleMs: SETTLE_MS,
        activeSettleMs: ACTIVE_SETTLE_MS,
        samplesPerIteration: SAMPLES_PER_ITERATION,
        sampleGapMs: SAMPLE_GAP_MS,
      },
      iterations: iterationResults,
      aggregates,
    };
    const outPath = path.join(OUT_DIR, `${LABEL}.json`);
    writeFileSync(outPath, JSON.stringify(payload, null, 2));

    const fmt = (kb: number) => `${(kb / 1024).toFixed(1)} MB`;
    console.log(`──────── memory kitchen-sink results (${LABEL}) ────────`);
    console.log(
      `projects=${PROJECT_COUNT} terminals/project=${TERMINALS_PER_PROJECT} scrollback=${SCROLLBACK_LINES} iterations=${iterationResults.length}/${ITERATIONS}`
    );
    for (const [key, agg] of Object.entries(aggregates)) {
      console.log(
        `${key}: mean=${fmt(agg.meanKb)} ±${fmt(agg.stdDevKb)} min=${fmt(agg.minKb)} max=${fmt(agg.maxKb)} p95=${fmt(agg.p95Kb)}`
      );
    }
    console.log(`results written to ${outPath}`);
    console.log("─────────────────────────────────────────────────────────");
  });

  for (let iter = 0; iter < ITERATIONS; iter++) {
    test(`iteration ${iter + 1} of ${ITERATIONS}`, async () => {
      test.slow();
      test.setTimeout(TEST_TIMEOUT_MS);

      // GPU on (separate GPU process, hardware compositing, WebGL terminal
      // renderer) — the production configuration. The default e2e launch path
      // disables the GPU and falls back to software compositing, which shifts
      // compositor buffers into the main process and misattributes exactly the
      // memory this benchmark exists to measure.
      const ctx = await launchApp({ enableWebgl: true });
      try {
        ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repos[0]);
        for (let i = 1; i < repos.length; i++) {
          await ctx.window.evaluate((p) => (window as any).electron.project.add(p), repos[i]);
        }
        await ctx.window.waitForTimeout(1500);

        const projects: Array<{ id: string; path: string }> = await ctx.window.evaluate(() =>
          (window as any).electron.project.getAll()
        );
        expect(projects.length).toBeGreaterThanOrEqual(PROJECT_COUNT);

        const getAttachedProjectId = async (): Promise<string | null> =>
          ctx.app.evaluate(async ({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) return null;
            const views = (win.contentView?.children ?? []) as Electron.WebContentsView[];
            for (let i = views.length - 1; i >= 0; i--) {
              const wc = views[i]?.webContents;
              if (!wc || wc.isDestroyed()) continue;
              const id = await wc
                .executeJavaScript("window.__DAINTREE_INITIAL_PROJECT__?.id ?? null", true)
                .catch(() => null);
              if (typeof id === "string" && id.length > 0) return id;
            }
            return null;
          });

        const switchProject = async (targetId: string): Promise<void> => {
          if ((await getAttachedProjectId()) === targetId) return;
          await ctx.app.evaluate(async ({ BrowserWindow }, id) => {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) return;
            const views = (win.contentView?.children ?? []) as Electron.WebContentsView[];
            for (let i = views.length - 1; i >= 0; i--) {
              const wc = views[i]?.webContents;
              if (!wc || wc.isDestroyed()) continue;
              const isProjectView = await wc
                .executeJavaScript("!!(window.electron && window.electron.project)", true)
                .catch(() => false);
              if (!isProjectView) continue;
              await wc
                .executeJavaScript(`window.electron.project.switch(${JSON.stringify(id)})`, true)
                .catch(() => null);
              return;
            }
          }, targetId);
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            if ((await getAttachedProjectId()) === targetId) break;
            await sleep(100);
          }
          await sleep(400);
        };

        // ── Phase 1: seed every project with terminals + scrollback, then
        // start a background stream in each terminal so output keeps flowing
        // in every project simultaneously (the "agents running everywhere"
        // state this app is built for).
        let terminalCount = 0;
        const panelsByProject = new Map<string, string[]>();
        for (const proj of projects) {
          await switchProject(proj.id);
          const page = await getActiveAppWindow(ctx.app, 60_000, { requireProject: true });
          for (let t = 0; t < TERMINALS_PER_PROJECT; t++) {
            await openTerminal(page);
            await page.waitForTimeout(400);
          }
          const panelIds = await getGridPanelIds(page);
          const seededPanels: string[] = [];
          for (const panelId of panelIds) {
            const panel = getPanelById(page, panelId);
            try {
              await waitForTerminalPty(page, panel, 15_000);
            } catch {
              continue; // not a terminal panel
            }
            // The DONE token is assembled by printf so the command echo line
            // can never satisfy the wait.
            await runTerminalCommand(
              page,
              panel,
              `awk 'BEGIN{for(i=0;i<${SCROLLBACK_LINES};i++)printf("memline %06d ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 %06d\\n",i,i)}'; printf 'MEMBENCH_%s\\n' DONE`
            );
            await waitForTerminalText(panel, "MEMBENCH_DONE", 60_000);
            // Endless fixed-rate emitter (~4 lines/s) until the Ctrl-C in the
            // stop phase. The %06d output can't be matched by the echo line.
            await runTerminalCommand(
              page,
              panel,
              `i=0; while :; do printf 'bgstream %06d abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\\n' $i; i=$((i+1)); sleep 0.25; done`
            );
            await waitForTerminalText(panel, "bgstream 0000", 15_000);
            seededPanels.push(panelId);
          }
          expect(seededPanels.length).toBeGreaterThanOrEqual(TERMINALS_PER_PROJECT);
          panelsByProject.set(proj.id, seededPanels);
          terminalCount += seededPanels.length;
        }

        // ── Phase 2: dirty every repo so all workspace-hosts carry real git
        // status work, then a switching storm while all terminals stream.
        for (const repo of repos) {
          for (let f = 0; f < 3; f++) {
            writeFileSync(
              path.join(repo, `churn-${f}.txt`),
              `memory bench churn ${iter}-${f}\n`.repeat(200)
            );
          }
        }
        for (let pass = 0; pass < 2; pass++) {
          for (const proj of projects) {
            await switchProject(proj.id);
            await sleep(1_000);
          }
        }
        await switchProject(projects[0].id);

        // ── Phase 3: sample under load — all terminals in all projects are
        // still streaming while we measure.
        await sleep(ACTIVE_SETTLE_MS);
        const activeSamples: MemorySample[] = [];
        for (let s = 0; s < SAMPLES_PER_ITERATION; s++) {
          if (s > 0) await sleep(SAMPLE_GAP_MS);
          activeSamples.push(await takeSample(ctx));
        }

        // ── Phase 4: Ctrl-C every stream, then measure the retained idle
        // footprint (what stays resident once the burst of work is over).
        for (const proj of projects) {
          await switchProject(proj.id);
          const page = await getActiveAppWindow(ctx.app, 60_000, { requireProject: true });
          for (const panelId of panelsByProject.get(proj.id) ?? []) {
            await page.evaluate(
              (id) => (window as any).electron.terminal.write(id, "\u0003"),
              panelId
            );
            await sleep(100);
          }
        }
        await switchProject(projects[0].id);

        // Steady-state settle: let deferred work (persist flushes, git polls,
        // LRU bookkeeping) finish before sampling. No forced GC — we want the
        // realistic idle footprint, not the theoretical minimum.
        await sleep(SETTLE_MS);

        const samples: MemorySample[] = [];
        for (let s = 0; s < SAMPLES_PER_ITERATION; s++) {
          if (s > 0) await sleep(SAMPLE_GAP_MS);
          samples.push(await takeSample(ctx));
        }

        for (const sample of [...activeSamples, ...samples]) {
          expect(sample.treeTotalRssKb).toBeGreaterThan(0);
          expect(sample.viewCount).toBeGreaterThanOrEqual(1);
        }

        const means: Record<string, number> = { ...sampleMeans(samples) };
        for (const [key, value] of Object.entries(sampleMeans(activeSamples))) {
          means[`active.${key}`] = value;
        }

        iterationResults.push({
          iteration: iter + 1,
          terminalCount,
          samples,
          activeSamples,
          means,
        });
      } finally {
        await closeApp(ctx.app);
      }
    });
  }
});
