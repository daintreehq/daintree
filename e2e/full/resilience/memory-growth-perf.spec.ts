/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright evaluate runs outside the typed preload */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../../helpers/workflows";
import {
  getGridPanelCount,
  getGridPanelIds,
  getPanelById,
  openTerminal,
} from "../../helpers/panels";
import {
  runTerminalCommand,
  waitForTerminalPty,
  waitForTerminalText,
} from "../../helpers/terminal";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { measureMainMemory, startFrameProbe, stopFrameProbe } from "../../helpers/stress";

const PROJECT_COUNT = Number(process.env.MEM_GROWTH_PROJECTS ?? 2);
const TERMINALS_PER_PROJECT = Number(process.env.MEM_GROWTH_TERMINALS ?? 2);
const WARMUP_CYCLES = Number(process.env.MEM_GROWTH_WARMUPS ?? 3);
const MEASURED_CYCLES = Number(process.env.MEM_GROWTH_CYCLES ?? 10);
const SEED_OUTPUT_LINES = Number(process.env.MEM_GROWTH_SEED_OUTPUT_LINES ?? 5500);
const OUTPUT_LINES = Number(process.env.MEM_GROWTH_OUTPUT_LINES ?? 750);
const SETTLE_MS = Number(process.env.MEM_GROWTH_SETTLE_MS ?? 4_000);
const CHURN_EPHEMERAL_TERMINALS = process.env.MEM_GROWTH_EPHEMERAL !== "0";
const LABEL = process.env.MEM_GROWTH_LABEL ?? "run";
const OUTPUT_PATH =
  process.env.MEM_GROWTH_OUTPUT ??
  path.join(process.cwd(), ".tmp", "perf-results", "memory-growth", `${LABEL}.json`);
const HEAP_SNAPSHOT_DIR = process.env.MEM_GROWTH_HEAP_SNAPSHOT_DIR;
const TEST_TIMEOUT_MS = Number(process.env.MEM_GROWTH_TIMEOUT_MS ?? 1_800_000);

type ProcessClass = "main" | "renderer" | "utility" | "gpu" | "crashpad" | "shell";

interface ProcessRow {
  pid: number;
  ppid: number;
  rssKb: number;
  command: string;
}

interface MemorySample {
  appRssKb: number;
  treeRssKb: number;
  shellRssKb: number;
  appFootprintKb: number | null;
  mainRssKb: number;
  rendererRssKb: number;
  utilityRssKb: number;
  gpuRssKb: number;
  mainFootprintKb: number | null;
  rendererFootprintKb: number | null;
  utilityFootprintKb: number | null;
  gpuFootprintKb: number | null;
  mainHeapUsedKb: number;
  mainExternalKb: number;
  rendererHeapUsedKb: number;
  mainFdCount: number | null;
  ptyHostFdCount: number | null;
  ptyHostPtmxCount: number | null;
  rendererTerminalCount: number;
  rendererWebglDemandCount: number;
  viewCount: number;
  processCount: number;
  utilityByNameKb: Record<string, number>;
}

interface CycleSample {
  cycle: number;
  natural: MemorySample;
  retained: MemorySample;
  workload: WorkloadSample | null;
}

interface WorkloadSample {
  durationMs: number;
  maxFrameGapMs: number;
  p95FrameGapMs: number;
}

interface GrowthMetric {
  baseline: number;
  final: number;
  delta: number;
  peak: number;
  slopePerCycle: number;
  tailSlopePerCycle: number;
  percent: number;
}

function listProcesses(): ProcessRow[] {
  if (process.platform === "win32") return [];
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command: match[4],
    });
  }
  return rows;
}

function collectProcessTree(rootPid: number, rows: ProcessRow[]): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const root = rows.find((row) => row.pid === rootPid);
  const tree = root ? [root] : [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      tree.push(child);
      queue.push(child.pid);
    }
  }
  return tree;
}

function classifyProcess(row: ProcessRow, rootPid: number): ProcessClass {
  if (row.pid === rootPid) return "main";
  if (row.command.includes("--type=renderer")) return "renderer";
  if (row.command.includes("--type=utility")) return "utility";
  if (row.command.includes("--type=gpu-process")) return "gpu";
  if (row.command.includes("crashpad")) return "crashpad";
  if (row.command.includes("--type=")) return "utility";
  return "shell";
}

function measureFootprints(pids: number[]): Map<number, number> {
  const footprints = new Map<number, number>();
  if (process.platform !== "darwin" || pids.length === 0) return footprints;
  const args = [
    "-l",
    "1",
    "-n",
    String(pids.length),
    "-F",
    "-R",
    ...pids.flatMap((pid) => ["-pid", String(pid)]),
    "-stats",
    "pid,mem",
  ];
  try {
    const output = execFileSync("top", args, { encoding: "utf8", timeout: 5_000 });
    for (const match of output.matchAll(/^(\d+)\s+([\d.]+)([KMG])\s*$/gm)) {
      const value = Number(match[2]);
      const kb = match[3] === "G" ? value * 1024 * 1024 : match[3] === "M" ? value * 1024 : value;
      footprints.set(Number(match[1]), Math.round(kb));
    }
  } catch {
    // A helper can exit between the process-table and footprint samples.
  }
  return footprints;
}

function measureFdCounts(pid: number): { total: number; ptmx: number } | null {
  if (process.platform === "linux") {
    try {
      return { total: readdirSync(`/proc/${pid}/fd`).length, ptmx: 0 };
    } catch {
      return null;
    }
  }
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "0-999999"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const rows = output.split("\n").slice(1).filter(Boolean);
    return { total: rows.length, ptmx: rows.filter((row) => row.includes("/dev/ptmx")).length };
  } catch {
    return null;
  }
}

async function forceGc(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const g = globalThis as Record<string, unknown>;
    const mainGc = (typeof g.__daintree_gc === "function" ? g.__daintree_gc : g.gc) as
      | (() => void)
      | undefined;
    mainGc?.();
    mainGc?.();

    const pvm = (g.__daintreeGetPvm as (() => unknown) | undefined)?.() as
      | {
          getAllViews: () => Array<{ view: { webContents: Electron.WebContents } }>;
        }
      | null
      | undefined;
    for (const entry of pvm?.getAllViews() ?? []) {
      const wc = entry.view.webContents;
      if (!wc || wc.isDestroyed()) continue;
      await Promise.race([
        wc
          .executeJavaScript(
            "typeof window.gc === 'function' ? (window.gc(), window.gc(), true) : false",
            true
          )
          .catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function takeRendererHeapSnapshots(
  app: ElectronApplication,
  directory: string,
  label: string
): Promise<void> {
  mkdirSync(directory, { recursive: true });
  await app.evaluate(
    async (_, args) => {
      const g = globalThis as Record<string, unknown>;
      const pvm = (g.__daintreeGetPvm as (() => unknown) | undefined)?.() as
        | {
            getAllViews: () => Array<{ view: { webContents: Electron.WebContents } }>;
          }
        | null
        | undefined;
      for (const entry of pvm?.getAllViews() ?? []) {
        const wc = entry.view.webContents;
        if (!wc || wc.isDestroyed()) continue;
        await wc.takeHeapSnapshot(`${args.directory}/${args.label}-wc-${wc.id}.heapsnapshot`);
      }
    },
    { directory, label }
  );
}

async function takeMemorySample(ctx: AppContext): Promise<MemorySample> {
  const rootPid = ctx.app.process().pid!;
  const tree = collectProcessTree(rootPid, listProcesses());
  const rssByClass: Record<ProcessClass, number> = {
    main: 0,
    renderer: 0,
    utility: 0,
    gpu: 0,
    crashpad: 0,
    shell: 0,
  };
  for (const row of tree) rssByClass[classifyProcess(row, rootPid)] += row.rssKb;

  const appRows = tree.filter((row) => classifyProcess(row, rootPid) !== "shell");
  const footprints = measureFootprints(appRows.map((row) => row.pid));
  const footprintByClass: Record<ProcessClass, number> = {
    main: 0,
    renderer: 0,
    utility: 0,
    gpu: 0,
    crashpad: 0,
    shell: 0,
  };
  for (const row of appRows) {
    footprintByClass[classifyProcess(row, rootPid)] += footprints.get(row.pid) ?? 0;
  }

  const electronMetrics: Array<{
    pid: number;
    type: string;
    name: string | null;
    workingSetKb: number;
  }> = await ctx.app.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: (metric as any).name ?? (metric as any).serviceName ?? null,
      workingSetKb: metric.memory.workingSetSize,
    }))
  );
  const utilityByNameKb: Record<string, number> = {};
  for (const metric of electronMetrics) {
    if (metric.type !== "Utility") continue;
    const name = metric.name ?? "unknown";
    utilityByNameKb[name] = (utilityByNameKb[name] ?? 0) + metric.workingSetKb;
  }
  const ptyHostMetric = electronMetrics.find((metric) => metric.name === "daintree-pty-host");
  const ptyHostFds = ptyHostMetric ? measureFdCounts(ptyHostMetric.pid) : null;
  const mainFds = measureFdCounts(rootPid);

  const whySlow = await ctx.window.evaluate(() => window.electron.system.getWhySlowSnapshot());
  const rendererTerminalCount = whySlow.rendererTerminals.reduce(
    (sum, sample) => sum + sample.terminalCount,
    0
  );
  const rendererWebglDemandCount = whySlow.rendererTerminals.reduce(
    (sum, sample) => sum + sample.wantsWebgl,
    0
  );

  const rendererState = await ctx.app.evaluate(async () => {
    const g = globalThis as Record<string, unknown>;
    const pvm = (g.__daintreeGetPvm as (() => unknown) | undefined)?.() as
      | {
          getAllViews: () => Array<{ view: { webContents: Electron.WebContents } }>;
        }
      | null
      | undefined;
    let heapBytes = 0;
    let viewCount = 0;
    for (const entry of pvm?.getAllViews() ?? []) {
      const wc = entry.view.webContents;
      if (!wc || wc.isDestroyed()) continue;
      viewCount++;
      const heap = await Promise.race([
        wc
          .executeJavaScript("performance.memory?.usedJSHeapSize ?? 0", true)
          .catch(() => 0) as Promise<number>,
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 2_000)),
      ]);
      heapBytes += typeof heap === "number" ? heap : 0;
    }
    return { heapBytes, viewCount };
  });

  const mainMemory = await measureMainMemory(ctx.app);
  const treeRssKb = tree.reduce((sum, row) => sum + row.rssKb, 0);
  const appRssKb = treeRssKb - rssByClass.shell;
  const appFootprintKb =
    footprints.size > 0
      ? footprintByClass.main +
        footprintByClass.renderer +
        footprintByClass.utility +
        footprintByClass.gpu +
        footprintByClass.crashpad
      : null;
  const footprint = (processClass: ProcessClass) =>
    footprints.size > 0 ? footprintByClass[processClass] : null;

  return {
    appRssKb,
    treeRssKb,
    shellRssKb: rssByClass.shell,
    appFootprintKb,
    mainRssKb: rssByClass.main,
    rendererRssKb: rssByClass.renderer,
    utilityRssKb: rssByClass.utility,
    gpuRssKb: rssByClass.gpu,
    mainFootprintKb: footprint("main"),
    rendererFootprintKb: footprint("renderer"),
    utilityFootprintKb: footprint("utility"),
    gpuFootprintKb: footprint("gpu"),
    mainHeapUsedKb: Math.round(mainMemory.heapUsed / 1024),
    mainExternalKb: Math.round(mainMemory.external / 1024),
    rendererHeapUsedKb: Math.round(rendererState.heapBytes / 1024),
    mainFdCount: mainFds?.total ?? null,
    ptyHostFdCount: ptyHostFds?.total ?? null,
    ptyHostPtmxCount: ptyHostFds?.ptmx ?? null,
    rendererTerminalCount,
    rendererWebglDemandCount,
    viewCount: rendererState.viewCount,
    processCount: tree.length,
    utilityByNameKb,
  };
}

function metricValue(sample: MemorySample, key: string): number | null {
  if (key.startsWith("utility:")) return sample.utilityByNameKb[key.slice("utility:".length)] ?? 0;
  const value = sample[key as keyof MemorySample];
  return typeof value === "number" ? value : null;
}

function linearSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index++) {
    numerator += (index - xMean) * (values[index] - yMean);
    denominator += (index - xMean) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function summarizeGrowth(samples: CycleSample[]): Record<string, GrowthMetric> {
  const fixedKeys = [
    "appRssKb",
    "appFootprintKb",
    "mainRssKb",
    "rendererRssKb",
    "utilityRssKb",
    "gpuRssKb",
    "mainFootprintKb",
    "rendererFootprintKb",
    "utilityFootprintKb",
    "gpuFootprintKb",
    "mainHeapUsedKb",
    "mainExternalKb",
    "rendererHeapUsedKb",
    "mainFdCount",
    "ptyHostFdCount",
    "ptyHostPtmxCount",
    "rendererTerminalCount",
    "rendererWebglDemandCount",
  ];
  const utilityKeys = new Set(
    samples.flatMap((sample) =>
      Object.keys(sample.retained.utilityByNameKb).map((name) => `utility:${name}`)
    )
  );
  const result: Record<string, GrowthMetric> = {};
  for (const key of [...fixedKeys, ...utilityKeys]) {
    const retained = samples
      .map((sample) => metricValue(sample.retained, key))
      .filter((value): value is number => value !== null);
    const natural = samples
      .map((sample) => metricValue(sample.natural, key))
      .filter((value): value is number => value !== null);
    if (retained.length !== samples.length || retained.length < 2) continue;
    const baseline = retained[0];
    const final = retained.at(-1)!;
    const peak = Math.max(...natural, ...retained);
    const tail = retained.slice(Math.floor(retained.length / 2));
    result[key] = {
      baseline,
      final,
      delta: final - baseline,
      peak,
      slopePerCycle: linearSlope(retained),
      tailSlopePerCycle: linearSlope(tail),
      percent: baseline > 0 ? ((final - baseline) / baseline) * 100 : 0,
    };
  }
  return result;
}

function summarizeWorkload(samples: CycleSample[]) {
  const workload = samples
    .map((sample) => sample.workload)
    .filter((sample): sample is WorkloadSample => sample !== null);
  const values = (pick: (sample: WorkloadSample) => number) => workload.map(pick);
  const summarize = (items: number[]) => ({
    mean: items.reduce((sum, item) => sum + item, 0) / Math.max(1, items.length),
    max: items.length > 0 ? Math.max(...items) : 0,
  });
  return {
    cycleDurationMs: summarize(values((sample) => sample.durationMs)),
    maxFrameGapMs: summarize(values((sample) => sample.maxFrameGapMs)),
    p95FrameGapMs: summarize(values((sample) => sample.p95FrameGapMs)),
  };
}

async function closePanel(page: Page, panelId: string): Promise<void> {
  const countBefore = await getGridPanelCount(page);
  const panel = getPanelById(page, panelId);
  await panel
    .locator(SEL.panel.close)
    .click({ modifiers: ["Alt"], force: true, timeout: T_MEDIUM });
  await expect.poll(() => getGridPanelCount(page), { timeout: T_LONG }).toBe(countBefore - 1);
}

async function createStableTerminals(page: Page): Promise<string[]> {
  for (let index = 0; index < TERMINALS_PER_PROJECT; index++) {
    await openTerminal(page);
  }
  const ids = await getGridPanelIds(page);
  const terminals: string[] = [];
  for (const id of ids) {
    const panel = getPanelById(page, id);
    try {
      await waitForTerminalPty(page, panel, 15_000);
      terminals.push(id);
    } catch {
      // Non-PTY panels are not part of the stable terminal topology.
    }
  }
  expect(terminals.length).toBeGreaterThanOrEqual(TERMINALS_PER_PROJECT);
  return terminals.slice(-TERMINALS_PER_PROJECT);
}

async function emitOutput(
  page: Page,
  panelId: string,
  cycle: number,
  terminalIndex: number,
  lineCount = OUTPUT_LINES
) {
  const token = `MEMGROWTH_${cycle}_${terminalIndex}_DONE`;
  const panel = getPanelById(page, panelId);
  await runTerminalCommand(
    page,
    panel,
    `awk 'BEGIN{for(i=0;i<${lineCount};i++)printf("cycle ${cycle} terminal ${terminalIndex} line %06d ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\\n",i)}'; printf '${token}\\n'`
  );
  await waitForTerminalText(panel, token, 60_000);
}

const perfDescribe = process.env.RUN_PERF_MEMORY_GROWTH ? test.describe.serial : test.describe.skip;

perfDescribe("Resilience: single-session memory growth", () => {
  test("retained memory plateaus across repeated mixed-use cycles", async () => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const fixtures = createFixtureRepos(PROJECT_COUNT);
    const projectNames = fixtures.map((fixture) => path.basename(fixture.dir));
    let ctx: AppContext | null = null;

    try {
      ctx = await launchApp({ enableWebgl: true });
      ctx.window = await openAndOnboardProject(
        ctx.app,
        ctx.window,
        fixtures[0].dir,
        projectNames[0]
      );
      for (let index = 1; index < fixtures.length; index++) {
        ctx.window = await addAndSwitchToProject(
          ctx.app,
          ctx.window,
          fixtures[index].dir,
          projectNames[index]
        );
      }

      const terminalsByProject = new Map<string, string[]>();
      for (const name of projectNames) {
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, name);
        terminalsByProject.set(name, await createStableTerminals(ctx.window));
      }

      for (const name of projectNames) {
        ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, name);
        const stableIds = terminalsByProject.get(name)!;
        for (let terminalIndex = 0; terminalIndex < stableIds.length; terminalIndex++) {
          await emitOutput(
            ctx.window,
            stableIds[terminalIndex],
            -10_000,
            terminalIndex,
            SEED_OUTPUT_LINES
          );
        }
      }

      const runCycle = async (cycle: number): Promise<WorkloadSample> => {
        const startedAt = performance.now();
        let maxFrameGapMs = 0;
        let p95FrameGapMs = 0;
        for (let projectIndex = 0; projectIndex < projectNames.length; projectIndex++) {
          const name = projectNames[projectIndex];
          ctx!.window = await selectExistingProjectAndRefresh(ctx!.app, ctx!.window, name);
          const stableIds = terminalsByProject.get(name)!;
          await startFrameProbe(ctx!.window);
          for (let terminalIndex = 0; terminalIndex < stableIds.length; terminalIndex++) {
            await emitOutput(ctx!.window, stableIds[terminalIndex], cycle, terminalIndex);
          }
          const frameProbe = await stopFrameProbe(ctx!.window);
          maxFrameGapMs = Math.max(maxFrameGapMs, frameProbe.maxGapMs);
          p95FrameGapMs = Math.max(p95FrameGapMs, frameProbe.p95GapMs);

          if (CHURN_EPHEMERAL_TERMINALS) {
            const idsBefore = await getGridPanelIds(ctx!.window);
            await openTerminal(ctx!.window);
            await expect
              .poll(() => getGridPanelCount(ctx!.window), { timeout: T_LONG })
              .toBe(idsBefore.length + 1);
            const idsAfter = await getGridPanelIds(ctx!.window);
            const ephemeralId = idsAfter.find((id) => !idsBefore.includes(id));
            expect(ephemeralId).toBeTruthy();
            const ephemeralPanel = getPanelById(ctx!.window, ephemeralId!);
            await waitForTerminalPty(ctx!.window, ephemeralPanel, 15_000);
            await runTerminalCommand(
              ctx!.window,
              ephemeralPanel,
              `printf 'EPHEMERAL_${cycle}_DONE\\n'`
            );
            await waitForTerminalText(ephemeralPanel, `EPHEMERAL_${cycle}_DONE`, 15_000);
            await closePanel(ctx!.window, ephemeralId!);
          }

          for (let fileIndex = 0; fileIndex < 3; fileIndex++) {
            writeFileSync(
              path.join(fixtures[projectIndex].dir, `memory-growth-${fileIndex}.txt`),
              `cycle=${cycle} project=${projectIndex} file=${fileIndex}\n`.repeat(200)
            );
          }
        }
        ctx!.window = await selectExistingProjectAndRefresh(ctx!.app, ctx!.window, projectNames[0]);
        return { durationMs: performance.now() - startedAt, maxFrameGapMs, p95FrameGapMs };
      };

      for (let cycle = -WARMUP_CYCLES; cycle < 0; cycle++) await runCycle(cycle);
      await ctx.window.waitForTimeout(SETTLE_MS);

      const samples: CycleSample[] = [];
      const sampleCycle = async (cycle: number, workload: WorkloadSample | null) => {
        const natural = await takeMemorySample(ctx!);
        await forceGc(ctx!.app);
        const retained = await takeMemorySample(ctx!);
        samples.push({ cycle, natural, retained, workload });
        if (HEAP_SNAPSHOT_DIR && (cycle === 0 || cycle === MEASURED_CYCLES)) {
          await takeRendererHeapSnapshots(
            ctx!.app,
            HEAP_SNAPSHOT_DIR,
            cycle === 0 ? "baseline" : "final"
          );
        }
        console.log(
          `[memory-growth] cycle=${cycle} footprint=${((retained.appFootprintKb ?? retained.appRssKb) / 1024).toFixed(1)}MB appRss=${(retained.appRssKb / 1024).toFixed(1)}MB renderer=${(retained.rendererRssKb / 1024).toFixed(1)}MB utility=${(retained.utilityRssKb / 1024).toFixed(1)}MB gpu=${(retained.gpuRssKb / 1024).toFixed(1)}MB rendererHeap=${(retained.rendererHeapUsedKb / 1024).toFixed(1)}MB`
        );
      };

      await sampleCycle(0, null);
      const stablePanelCount = await getGridPanelCount(ctx.window);
      const stableViewCount = samples[0].retained.viewCount;
      for (let cycle = 1; cycle <= MEASURED_CYCLES; cycle++) {
        const workload = await runCycle(cycle);
        await ctx.window.waitForTimeout(SETTLE_MS);
        await sampleCycle(cycle, workload);
        expect(await getGridPanelCount(ctx.window)).toBe(stablePanelCount);
        expect(samples.at(-1)!.retained.viewCount).toBe(stableViewCount);
      }

      const metrics = summarizeGrowth(samples);
      const workload = summarizeWorkload(samples);
      const payload = {
        label: LABEL,
        platform: process.platform,
        createdAt: new Date().toISOString(),
        config: {
          projects: PROJECT_COUNT,
          terminalsPerProject: TERMINALS_PER_PROJECT,
          warmupCycles: WARMUP_CYCLES,
          measuredCycles: MEASURED_CYCLES,
          seedOutputLinesPerTerminal: SEED_OUTPUT_LINES,
          outputLinesPerTerminalPerCycle: OUTPUT_LINES,
          settleMs: SETTLE_MS,
          churnEphemeralTerminals: CHURN_EPHEMERAL_TERMINALS,
        },
        samples,
        metrics,
        workload,
      };
      mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
      writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));

      console.log(`Memory growth results written to ${OUTPUT_PATH}`);
      for (const [name, metric] of Object.entries(metrics)) {
        const isCount = name.endsWith("Count");
        const format = (value: number) =>
          isCount ? value.toFixed(1) : `${(value / 1024).toFixed(1)}MB`;
        const slope = isCount
          ? `${metric.slopePerCycle.toFixed(2)}/cycle`
          : `${(metric.slopePerCycle / 1024).toFixed(2)}MB/cycle`;
        const tailSlope = isCount
          ? `${metric.tailSlopePerCycle.toFixed(2)}/cycle`
          : `${(metric.tailSlopePerCycle / 1024).toFixed(2)}MB/cycle`;
        console.log(
          `[memory-growth] ${name}: baseline=${format(metric.baseline)} final=${format(metric.final)} delta=${format(metric.delta)} slope=${slope} tailSlope=${tailSlope}`
        );
      }
      expect(metrics.appRssKb.baseline).toBeGreaterThan(0);
      if (metrics.ptyHostFdCount) {
        expect(Math.abs(metrics.ptyHostFdCount.delta)).toBeLessThanOrEqual(2);
      }
      expect(metrics.rendererTerminalCount.delta).toBe(0);
      expect(metrics.rendererWebglDemandCount.delta).toBe(0);
    } finally {
      if (ctx?.app) await closeApp(ctx.app);
      for (const fixture of fixtures) fixture.cleanup();
    }
  });
});
