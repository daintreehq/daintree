/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright evaluate runs outside the typed preload */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../helpers/workflows";
import { getGridPanelCount, getGridPanelIds, getPanelById, openTerminal } from "../helpers/panels";
import { runTerminalCommand, waitForTerminalPty, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import { parseHeapSnapshot } from "../helpers/heapSnapshot";
import {
  bucketVmmapRegions,
  median,
  parseTopFootprints,
  parseVmmapSummary,
  summarizeHeapSnapshot,
  summarizeMemoryInfra,
} from "../helpers/emptyProjectViewMemory";

// Footprint of one project view's renderer, attributed by category, at three
// points: freshly opened with no terminals, cached behind another project
// while its terminals hold output, and in front again after a session with its
// terminals closed. Each
// reading is that renderer's own pid, never a class total, and GPU-process
// footprint is reported beside it rather than added: it is shared by every
// view and swings by hundreds of MB between identical runs (#10981).

const LABEL = process.env.EMPTY_VIEW_LABEL ?? "run";
const OUTPUT_DIR =
  process.env.EMPTY_VIEW_OUTPUT_DIR ??
  path.join(process.cwd(), ".tmp", "perf-results", "empty-project-view");
const SETTLE_MS = Number(process.env.EMPTY_VIEW_SETTLE_MS ?? 15_000);
const FOOTPRINT_READINGS = Number(process.env.EMPTY_VIEW_READINGS ?? 5);
const TERMINALS = Number(process.env.EMPTY_VIEW_TERMINALS ?? 2);
const OUTPUT_LINES = Number(process.env.EMPTY_VIEW_OUTPUT_LINES ?? 5_500);
// Detailed MemoryInfra dumps are cheap; heap snapshots are not, and they
// leave the renderer larger afterwards, so they are a diagnostic mode.
const MEMORY_INFRA = process.env.EMPTY_VIEW_MEMORY_INFRA !== "0";
const HEAP_SNAPSHOTS = process.env.EMPTY_VIEW_HEAP_SNAPSHOTS === "1";
const WINDOW_SIZE = { width: 1600, height: 1000 };

interface TargetView {
  projectId: string;
  webContentsId: number;
  pid: number;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

function listAppTree(rootPid: number): ProcessRow[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  const tree = rows.filter((row) => row.pid === rootPid);
  for (let i = 0; i < tree.length; i++) {
    for (const row of rows) if (row.ppid === tree[i].pid) tree.push(row);
  }
  return tree;
}

function readFootprints(pids: number[]): Map<number, number> {
  const output = execFileSync(
    "top",
    [
      "-l",
      "1",
      "-n",
      String(pids.length),
      "-F",
      "-R",
      ...pids.flatMap((pid) => ["-pid", String(pid)]),
      "-stats",
      "pid,mem",
    ],
    { encoding: "utf8", timeout: 10_000 }
  );
  return parseTopFootprints(output);
}

async function viewInventory(app: ElectronApplication) {
  return app.evaluate(() => {
    const pvm = (globalThis as any).__daintreeGetPvm?.();
    return {
      views: (pvm?.getViewInventory?.() ?? []) as Array<{
        projectId: string;
        webContentsId: number;
        state: string;
        pid: number | null;
        guestPids: number[];
      }>,
      activeProjectId: (pvm?.getCacheConfig?.().activeProjectId ?? null) as string | null,
    };
  });
}

async function resolveView(app: ElectronApplication, projectId?: string) {
  const { views, activeProjectId } = await viewInventory(app);
  const pids = views.map((view) => view.pid).filter((pid): pid is number => pid !== null);
  expect(new Set(pids).size, "every project view must have its own renderer").toBe(views.length);
  const view = views.find((entry) => entry.projectId === (projectId ?? activeProjectId));
  expect(view?.pid, "project view has a renderer pid").toBeTruthy();
  return {
    target: { projectId: view!.projectId, webContentsId: view!.webContentsId, pid: view!.pid! },
    state: view!.state,
    viewCount: views.length,
  };
}

/** Runs CDP commands on one view's webContents, attaching only if nobody else has. */
async function withDebugger(
  app: ElectronApplication,
  webContentsId: number,
  commands: Array<[key: string, method: string, params?: Record<string, unknown>]>
): Promise<Record<string, unknown>> {
  return app.evaluate(
    async ({ webContents }, args) => {
      const wc = webContents.fromId(args.webContentsId);
      if (!wc || wc.isDestroyed()) throw new Error("target view is gone");
      const owned = !wc.debugger.isAttached();
      if (owned) wc.debugger.attach("1.3");
      const results: Record<string, unknown> = {};
      try {
        for (const [key, method, params] of args.commands) {
          try {
            results[key] = await Promise.race([
              wc.debugger.sendCommand(method, params ?? {}),
              new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
            ]);
          } catch (error) {
            results[key] = { error: String(error) };
          }
        }
      } finally {
        if (owned && wc.debugger.isAttached()) wc.debugger.detach();
      }
      return results;
    },
    { webContentsId, commands }
  );
}

async function collectGarbage(app: ElectronApplication, target: TargetView): Promise<void> {
  // HeapProfiler.collectGarbage is the one reclaim command that is safe on a
  // hidden or throttled view in Electron 42; the purge commands crash it.
  const result = await withDebugger(app, target.webContentsId, [
    ["gc1", "HeapProfiler.collectGarbage"],
    ["gc2", "HeapProfiler.collectGarbage"],
  ]);
  expect((result.gc2 as { error?: string } | undefined)?.error).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

async function captureMemoryInfra(app: ElectronApplication, file: string): Promise<unknown> {
  await app.evaluate(async ({ contentTracing }) => {
    await contentTracing.startRecording({
      included_categories: ["disabled-by-default-memory-infra"],
      excluded_categories: ["*"],
      memory_dump_config: {
        triggers: [{ mode: "detailed", periodic_interval_ms: 1_000 }],
      },
    } as Electron.TraceConfig);
  });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await app.evaluate(async ({ contentTracing }, out) => contentTracing.stopRecording(out), file);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(file, { force: true });
  }
}

async function samplePhase(
  ctx: AppContext,
  target: TargetView,
  phase: "empty" | "cached" | "after-session",
  artifactDir: string
) {
  const rootPid = ctx.app.process().pid!;
  const current = await resolveView(ctx.app, target.projectId);
  expect(current.target.pid, "target view kept its renderer").toBe(target.pid);
  expect(current.target.webContentsId).toBe(target.webContentsId);
  expect(current.state).toBe(phase === "cached" ? "cached" : "active");

  await collectGarbage(ctx.app, target);

  const tree = listAppTree(rootPid);
  const gpuPids = tree
    .filter((row) => row.command.includes("--type=gpu-process"))
    .map((r) => r.pid);
  const rendererPids = tree
    .filter((row) => row.command.includes("--type=renderer"))
    .map((row) => row.pid);
  const readings: Array<{ rendererKb: number | null; gpuKb: number; allRenderersKb: number }> = [];
  for (let i = 0; i < FOOTPRINT_READINGS; i++) {
    const footprints = readFootprints([...new Set([target.pid, ...gpuPids, ...rendererPids])]);
    readings.push({
      rendererKb: footprints.get(target.pid) ?? null,
      gpuKb: gpuPids.reduce((sum, pid) => sum + (footprints.get(pid) ?? 0), 0),
      allRenderersKb: rendererPids.reduce((sum, pid) => sum + (footprints.get(pid) ?? 0), 0),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const rendererReadings = readings
    .map((r) => r.rendererKb)
    .filter((kb): kb is number => kb !== null);
  expect(rendererReadings.length, "footprint readings for the target renderer").toBe(
    FOOTPRINT_READINGS
  );

  let vmmapRaw: string | null = null;
  let vmmapError: string | null = null;
  try {
    vmmapRaw = execFileSync("vmmap", ["-summary", String(target.pid)], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(path.join(artifactDir, `${phase}-vmmap.txt`), vmmapRaw);
  } catch (error) {
    vmmapError = String(error).slice(0, 500);
  }
  const vmmap = vmmapRaw ? parseVmmapSummary(vmmapRaw) : null;

  const cdp = await withDebugger(ctx.app, target.webContentsId, [
    ["performanceEnable", "Performance.enable"],
    ["performance", "Performance.getMetrics"],
    ["performanceDisable", "Performance.disable"],
    ["domCounters", "Memory.getDOMCounters"],
    ["heapUsage", "Runtime.getHeapUsage"],
    [
      "visibility",
      "Runtime.evaluate",
      { expression: "document.visibilityState", returnByValue: true },
    ],
  ]);
  const metrics = Object.fromEntries(
    ((cdp.performance as { metrics?: Array<{ name: string; value: number }> })?.metrics ?? []).map(
      (metric) => [metric.name, metric.value]
    )
  );

  let memoryInfra: ReturnType<typeof summarizeMemoryInfra> = null;
  let memoryInfraError: string | null = null;
  if (MEMORY_INFRA) {
    try {
      const trace = await captureMemoryInfra(
        ctx.app,
        path.join(os.tmpdir(), `daintree-empty-view-${process.pid}-${phase}.json`)
      );
      memoryInfra = summarizeMemoryInfra(trace, target.pid, { maxDepth: 3, minKb: 256 });
      if (!memoryInfra) memoryInfraError = "no dump for the target pid";
    } catch (error) {
      memoryInfraError = String(error).slice(0, 500);
    }
  }

  let heapSnapshot: ReturnType<typeof summarizeHeapSnapshot> | null = null;
  if (HEAP_SNAPSHOTS) {
    const file = path.join(artifactDir, `${phase}.heapsnapshot`);
    await ctx.app.evaluate(
      async ({ webContents }, args) => {
        await webContents.fromId(args.id)!.takeHeapSnapshot(args.file);
      },
      { id: target.webContentsId, file }
    );
    heapSnapshot = summarizeHeapSnapshot(parseHeapSnapshot(file), 40);
  }

  const sample = {
    phase,
    target,
    viewState: current.state,
    viewCount: current.viewCount,
    footprint: {
      rendererMedianKb: median(rendererReadings),
      rendererRangeKb: [Math.min(...rendererReadings), Math.max(...rendererReadings)],
      gpuMedianKb: median(readings.map((r) => r.gpuKb)),
      allRenderersMedianKb: median(readings.map((r) => r.allRenderersKb)),
      readings,
    },
    vmmap: vmmap
      ? {
          physicalFootprintKb: vmmap.physicalFootprintKb,
          physicalFootprintPeakKb: vmmap.physicalFootprintPeakKb,
          dirtyByBucketKb: bucketVmmapRegions(vmmap.regions),
          regions: vmmap.regions,
        }
      : { error: vmmapError },
    v8: {
      heapUsage: cdp.heapUsage,
      jsHeapUsedSize: metrics.JSHeapUsedSize ?? null,
      jsHeapTotalSize: metrics.JSHeapTotalSize ?? null,
    },
    blink: {
      // Chromium only releases tile memory for a page it knows is hidden.
      visibilityState:
        (cdp.visibility as { result?: { value?: string } } | undefined)?.result?.value ?? null,
      domCounters: cdp.domCounters,
      nodes: metrics.Nodes ?? null,
      documents: metrics.Documents ?? null,
      frames: metrics.Frames ?? null,
      jsEventListeners: metrics.JSEventListeners ?? null,
      layoutObjects: metrics.LayoutObjects ?? null,
    },
    memoryInfra: memoryInfra ?? { error: memoryInfraError ?? "disabled" },
    heapSnapshot,
  };
  console.log(
    `[empty-view] ${phase}: renderer=${((sample.footprint.rendererMedianKb ?? 0) / 1024).toFixed(1)}MB gpu=${((sample.footprint.gpuMedianKb ?? 0) / 1024).toFixed(1)}MB jsHeap=${((Number(metrics.JSHeapUsedSize) || 0) / 1048576).toFixed(1)}MB nodes=${metrics.Nodes ?? "?"}`
  );
  return sample;
}

async function emitOutput(page: Page, panelId: string, index: number): Promise<void> {
  const token = `EMPTYVIEW_${index}_DONE`;
  const panel = getPanelById(page, panelId);
  await runTerminalCommand(
    page,
    panel,
    `awk 'BEGIN{for(i=0;i<${OUTPUT_LINES};i++)printf("terminal ${index} line %06d ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\\n",i)}'; printf '${token}\\n'`
  );
  await waitForTerminalText(panel, token, 60_000);
}

async function removePanel(page: Page, panelId: string): Promise<void> {
  const countBefore = await getGridPanelCount(page);
  // Alt-close skips the 20s trash, so the terminal is really gone before GC.
  await getPanelById(page, panelId)
    .locator(SEL.panel.close)
    .click({ modifiers: ["Alt"], force: true, timeout: T_MEDIUM });
  await expect.poll(() => getGridPanelCount(page), { timeout: T_LONG }).toBe(countBefore - 1);
}

function gitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const perfDescribe =
  process.env.RUN_PERF_EMPTY_VIEW && process.platform === "darwin"
    ? test.describe.serial
    : test.describe.skip;

perfDescribe("Perf: empty project view memory", () => {
  test("attributes one project view's footprint before and after a session", async () => {
    test.setTimeout(900_000);
    const fixtures = createFixtureRepos(2);
    const names = fixtures.map((fixture) => path.basename(fixture.dir));
    const runId = `${LABEL}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const artifactDir = path.join(OUTPUT_DIR, runId);
    mkdirSync(artifactDir, { recursive: true });
    let ctx: AppContext | null = null;

    try {
      ctx = await launchApp({ enableWebgl: true, headed: true, windowSize: WINDOW_SIZE });
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtures[0].dir, names[0]);
      await ctx.app.evaluate(() => {
        const pvm = (globalThis as any).__daintreeGetPvm?.();
        if (pvm) pvm.maxCachedViews = Math.max(pvm.maxCachedViews, 2);
      });
      expect(await getGridPanelCount(ctx.window)).toBe(0);

      const { target } = await resolveView(ctx.app);
      await ctx.window.waitForTimeout(SETTLE_MS);
      const empty = await samplePhase(ctx, target, "empty", artifactDir);

      const before = new Set(await getGridPanelIds(ctx.window));
      for (let i = 0; i < TERMINALS; i++) await openTerminal(ctx.window);
      await expect
        .poll(() => getGridPanelCount(ctx!.window), { timeout: T_LONG })
        .toBe(before.size + TERMINALS);
      const terminalIds = (await getGridPanelIds(ctx.window)).filter((id) => !before.has(id));
      for (const [index, id] of terminalIds.entries()) {
        await waitForTerminalPty(ctx.window, getPanelById(ctx.window, id), 15_000);
        await emitOutput(ctx.window, id, index);
      }

      ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixtures[1].dir, names[1]);
      await ctx.window.waitForTimeout(SETTLE_MS);
      const cached = await samplePhase(ctx, target, "cached", artifactDir);
      ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, names[0]);
      for (const id of terminalIds) await removePanel(ctx.window, id);
      expect(await getGridPanelCount(ctx.window)).toBe(before.size);

      await ctx.window.waitForTimeout(SETTLE_MS);
      const afterSession = await samplePhase(ctx, target, "after-session", artifactDir);

      const versions = await ctx.app.evaluate(() => ({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        v8: process.versions.v8,
      }));
      const payload = {
        schema: 1,
        label: LABEL,
        createdAt: new Date().toISOString(),
        gitHead: gitHead(),
        versions,
        machine: { platform: process.platform, release: os.release(), cpus: os.cpus()[0]?.model },
        config: {
          settleMs: SETTLE_MS,
          footprintReadings: FOOTPRINT_READINGS,
          terminals: TERMINALS,
          outputLinesPerTerminal: OUTPUT_LINES,
          memoryInfra: MEMORY_INFRA,
          heapSnapshots: HEAP_SNAPSHOTS,
          windowSize: WINDOW_SIZE,
          webgl: true,
        },
        phases: { empty, cached, afterSession },
      };
      const outFile = path.join(OUTPUT_DIR, `${runId}.json`);
      writeFileSync(outFile, JSON.stringify(payload, null, 2));
      console.log(`[empty-view] results written to ${outFile}`);
    } finally {
      if (ctx?.app) await closeApp(ctx.app);
      for (const fixture of fixtures) fixture.cleanup();
    }
  });
});
