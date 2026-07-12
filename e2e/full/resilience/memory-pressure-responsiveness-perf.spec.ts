/* eslint-disable @typescript-eslint/no-explicit-any -- perf instrumentation crosses Playwright's process boundary */
import { expect, test } from "@playwright/test";
import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeApp, launchApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelIds, getPanelById, openTerminal } from "../../helpers/panels";
import {
  runTerminalCommand,
  waitForTerminalPty,
  waitForTerminalText,
} from "../../helpers/terminal";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_OUTPUT = path.join(
  REPO_ROOT,
  ".tmp",
  "perf-results",
  "memory-pressure-responsiveness.json"
);
const TERMINAL_COUNT = Number(process.env.PERF_MEMORY_PRESSURE_TERMINALS ?? 5);
const SCROLLBACK_LINES = Number(process.env.PERF_MEMORY_PRESSURE_SCROLLBACK_LINES ?? 1500);
const SAMPLE_MS = Number(process.env.PERF_MEMORY_PRESSURE_SAMPLE_MS ?? 12_000);
const POLL_INTERVAL_MS = Number(process.env.PERF_MEMORY_PRESSURE_POLL_INTERVAL_MS ?? 1000);
const AVAILABLE_MEMORY_MB = Number(process.env.PERF_MEMORY_PRESSURE_AVAILABLE_MB ?? 512);
const OUTPUT_PATH = path.resolve(
  REPO_ROOT,
  process.env.PERF_MEMORY_PRESSURE_OUTPUT?.trim() || DEFAULT_OUTPUT
);
const LABEL = process.env.PERF_MEMORY_PRESSURE_LABEL ?? "run";

interface ResponsivenessMetrics {
  frameGapP95Ms: number;
  maximumFrameGapMs: number;
  timerGapP95Ms: number;
  maximumTimerGapMs: number;
  longAnimationFrameCount: number;
  maximumLongAnimationFrameMs: number;
  reclaimCount: number;
  rendererWorkingSetKb: number;
  rendererJsHeapKb: number;
}

function percentile(values: number[], percent: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

async function startResponsivenessProbe(ctx: AppContext): Promise<void> {
  await ctx.window.evaluate(() => {
    const state = {
      frameGaps: [] as number[],
      timerGaps: [] as number[],
      longAnimationFrames: [] as number[],
      lastFrameAt: performance.now(),
      lastTimerAt: performance.now(),
      frameRequestId: 0,
      timerId: 0,
      observer: null as PerformanceObserver | null,
    };
    const frameTick = (now: number) => {
      state.frameGaps.push(now - state.lastFrameAt);
      state.lastFrameAt = now;
      state.frameRequestId = requestAnimationFrame(frameTick);
    };
    state.frameRequestId = requestAnimationFrame(frameTick);
    state.timerId = window.setInterval(() => {
      const now = performance.now();
      state.timerGaps.push(now - state.lastTimerAt);
      state.lastTimerAt = now;
    }, 50);
    try {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longAnimationFrames.push(entry.duration);
      });
      state.observer.observe({ type: "long-animation-frame", buffered: false });
    } catch {
      state.observer = null;
    }
    (window as any).__memoryPressureResponsivenessProbe = state;
  });
}

async function stopResponsivenessProbe(
  ctx: AppContext
): Promise<Omit<ResponsivenessMetrics, "rendererWorkingSetKb" | "rendererJsHeapKb">> {
  return await ctx.window.evaluate(() => {
    const state = (window as any).__memoryPressureResponsivenessProbe as {
      frameGaps: number[];
      timerGaps: number[];
      longAnimationFrames: number[];
      frameRequestId: number;
      timerId: number;
      observer: PerformanceObserver | null;
    };
    cancelAnimationFrame(state.frameRequestId);
    clearInterval(state.timerId);
    state.observer?.disconnect();
    delete (window as any).__memoryPressureResponsivenessProbe;
    const p95 = (values: number[]) => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    };
    const reclaimCount = performance.getEntriesByName("daintree-e2e-reclaim-memory").length;
    return {
      frameGapP95Ms: p95(state.frameGaps),
      maximumFrameGapMs: Math.max(0, ...state.frameGaps),
      timerGapP95Ms: p95(state.timerGaps),
      maximumTimerGapMs: Math.max(0, ...state.timerGaps),
      longAnimationFrameCount: state.longAnimationFrames.length,
      maximumLongAnimationFrameMs: Math.max(0, ...state.longAnimationFrames),
      reclaimCount,
    };
  });
}

async function sampleRendererMemory(
  ctx: AppContext
): Promise<{ workingSetKb: number; jsHeapKb: number }> {
  return await ctx.app.evaluate(async ({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const views = (win?.contentView?.children ?? []) as Electron.WebContentsView[];
    for (let index = views.length - 1; index >= 0; index--) {
      const wc = views[index]?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const isProjectView = await wc
        .executeJavaScript("!!window.__DAINTREE_INITIAL_PROJECT__", true)
        .catch(() => false);
      if (!isProjectView) continue;
      const pid = wc.getOSProcessId();
      const metric = app.getAppMetrics().find((item) => item.pid === pid);
      const jsHeapBytes = await wc
        .executeJavaScript("performance.memory?.usedJSHeapSize ?? 0", true)
        .catch(() => 0);
      return {
        workingSetKb: metric?.memory.workingSetSize ?? 0,
        jsHeapKb: Math.round(Number(jsHeapBytes) / 1024),
      };
    }
    return { workingSetKb: 0, jsHeapKb: 0 };
  });
}

function persistResult(metrics: ResponsivenessMetrics): void {
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    label: LABEL,
    config: {
      terminalCount: TERMINAL_COUNT,
      scrollbackLines: SCROLLBACK_LINES,
      sampleMs: SAMPLE_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      availableMemoryMb: AVAILABLE_MEMORY_MB,
    },
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    metrics,
  };
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const temporaryPath = `${OUTPUT_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`);
  try {
    renameSync(temporaryPath, OUTPUT_PATH);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    try {
      unlinkSync(OUTPUT_PATH);
    } catch {
      // First write has no destination to remove.
    }
    renameSync(temporaryPath, OUTPUT_PATH);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  console.log("──────── memory-pressure responsiveness results ────────");
  console.table(metrics);
  console.log(`results written to ${OUTPUT_PATH}`);
  console.log("─────────────────────────────────────────────────────────");
}

const perfDescribe = process.env.RUN_PERF_MEMORY_PRESSURE
  ? test.describe.serial
  : test.describe.skip;

perfDescribe("Resilience: memory-pressure responsiveness benchmark", () => {
  test("busy renderer remains responsive across sustained pressure polls", async () => {
    test.setTimeout(180_000);
    const fixture = createFixtureRepo({ name: "memory-pressure-responsiveness" });
    let ctx: AppContext | null = null;
    try {
      ctx = await launchApp({
        enableWebgl: process.env.CI !== "true",
        env: {
          DAINTREE_E2E_FAULT_MODE: "1",
          DAINTREE_E2E_SYSTEM_AVAILABLE_MEMORY_MB: String(AVAILABLE_MEMORY_MB),
          DAINTREE_E2E_APP_METRICS_POLL_INTERVAL_MS: String(POLL_INTERVAL_MS),
        },
      });
      ctx.window = await openAndOnboardProject(
        ctx.app,
        ctx.window,
        fixture.dir,
        "Memory pressure responsiveness"
      );
      for (let index = 0; index < TERMINAL_COUNT; index++) {
        await openTerminal(ctx.window);
        await ctx.window.waitForTimeout(150);
      }
      const panels = [];
      for (const panelId of await getGridPanelIds(ctx.window)) {
        const panel = getPanelById(ctx.window, panelId);
        try {
          await waitForTerminalPty(ctx.window, panel, 15_000);
          panels.push(panel);
        } catch {
          // Ignore non-terminal panels in the grid.
        }
      }
      expect(panels.length).toBeGreaterThanOrEqual(TERMINAL_COUNT);

      for (const [index, panel] of panels.slice(0, TERMINAL_COUNT).entries()) {
        await runTerminalCommand(
          ctx.window,
          panel,
          `awk 'BEGIN{for(i=0;i<${SCROLLBACK_LINES};i++)printf("pressure-${index} %06d abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\\n",i)}'; printf 'PRESSURE_READY_${index}\\n'`
        );
        await waitForTerminalText(panel, `PRESSURE_READY_${index}`, 30_000);
        await runTerminalCommand(
          ctx.window,
          panel,
          `node -e 'let i=0;setInterval(()=>console.log("pressure-stream-${index} "+i++),100)'`
        );
        await waitForTerminalText(panel, `pressure-stream-${index} 0`, 15_000);
      }

      await ctx.window.evaluate(() => performance.clearMarks("daintree-e2e-reclaim-memory"));
      await startResponsivenessProbe(ctx);
      await ctx.window.waitForTimeout(SAMPLE_MS);
      const responsiveness = await stopResponsivenessProbe(ctx);
      const memory = await sampleRendererMemory(ctx);
      const metrics: ResponsivenessMetrics = {
        ...responsiveness,
        rendererWorkingSetKb: memory.workingSetKb,
        rendererJsHeapKb: memory.jsHeapKb,
      };
      expect(metrics.maximumFrameGapMs).toBeGreaterThan(0);
      expect(metrics.rendererWorkingSetKb).toBeGreaterThan(0);
      persistResult(metrics);
    } finally {
      if (ctx) await closeApp(ctx.app);
      fixture.cleanup();
    }
  });
});
