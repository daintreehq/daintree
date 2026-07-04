/* eslint-disable @typescript-eslint/no-explicit-any */
// Nightly: persistent-worker governance memory bounds.
//
// PR #10920 moved CPU-heavy work into persistent workers (analysis pool, DB
// maintenance, copytree, plugin workers). Persistent pools that never restart
// can become silent memory holders, so this suite churns the worker-facing
// paths — repeated plugin enable/disable (full unload/reload cascade),
// repeated copytree generation (multi-MB result buffers through the
// workspace-host worker), and terminal open/close (analysis-session
// create/free in the worker pool) — and asserts main-process memory stays
// bounded. The per-subsystem release/fence behavior is unit-tested; this is
// the end-to-end backstop that the composition doesn't leak.
import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../helpers/launch";
import { getGridPanelCount, getGridPanelIds, getPanelById, openTerminal } from "../helpers/panels";
import { launchWithSamplePlugin, waitForSamplePluginReady } from "../helpers/plugins";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import { measureMainMemory } from "../helpers/stress";

const WARMUP_CYCLES = 2;
const CHURN_CYCLES = 10;
// Each cycle runs a full plugin unload/reload cascade, a copytree generation,
// and a terminal open/close. Retained result buffers or leaked analysis
// sessions compound per cycle, so a real leak clears these caps easily; the
// caps themselves absorb normal V8/GC noise.
const HEAP_THRESHOLD_MB = 25;
const EXTERNAL_THRESHOLD_MB = 15;
// The governed workers mostly live OUTSIDE main (pty-host analysis threads,
// workspace-host copytree thread, plugin utility processes), so also bound the
// summed utility-process working set. Generous — utility RSS is noisy across
// GC/renderer churn — but a per-cycle leak in any worker compounds well past it.
const UTILITY_RSS_THRESHOLD_MB = 200;
const SAMPLE_PLUGIN_ID = "daintree.hello";

function toMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

/** Summed working-set of every Utility process (pty-host, workspace hosts, plugin workers), in bytes. */
async function measureUtilityMemory(app: AppContext["app"]): Promise<number> {
  return app.evaluate(({ app: electronApp }) => {
    return electronApp
      .getAppMetrics()
      .filter((m) => m.type === "Utility")
      .reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0);
  });
}

async function getActiveWorktreeId(window: AppContext["window"]): Promise<string> {
  const res: any = await window.evaluate(() =>
    (window as any).__daintreeDispatchAction("actions.getContext")
  );
  return res?.result?.activeWorktreeId ?? "";
}

async function openAndCloseTerminal(window: AppContext["window"]): Promise<void> {
  const idsBefore = await getGridPanelIds(window);
  await openTerminal(window);
  await expect
    .poll(() => getGridPanelCount(window), { timeout: T_LONG })
    .toBe(idsBefore.length + 1);

  const idsAfter = await getGridPanelIds(window);
  const newId = idsAfter.find((id) => !idsBefore.includes(id));
  const panel = newId ? getPanelById(window, newId) : window.locator(SEL.panel.gridPanel).last();
  await expect(panel).toBeVisible({ timeout: T_MEDIUM });
  const closeBtn = panel.locator(SEL.panel.close);
  await closeBtn.click({ modifiers: ["Alt"], force: true, timeout: T_MEDIUM });
  await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(idsBefore.length);
}

async function togglePluginOffOn(window: AppContext["window"]): Promise<void> {
  await window.evaluate(
    (id: string) => (window as any).electron.plugin.setEnabled(id, false),
    SAMPLE_PLUGIN_ID
  );
  await window.evaluate(
    (id: string) => (window as any).electron.plugin.setEnabled(id, true),
    SAMPLE_PLUGIN_ID
  );
  // Re-enable re-registers contributions and re-activates — gate each cycle on
  // the plugin actually being back so cycles don't overlap half-done toggles.
  await waitForSamplePluginReady(window);
}

async function generateContext(window: AppContext["window"], worktreeId: string): Promise<void> {
  const result: any = await window.evaluate(
    async (id: string) => (window as any).electron.copyTree.generate(id),
    worktreeId
  );
  expect(result?.error).toBeFalsy();
  expect(result?.content?.length).toBeGreaterThan(0);
}

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Nightly: Worker governance memory bounds", () => {
  test.beforeAll(async () => {
    const launched = await launchWithSamplePlugin("worker-governance-memory");
    ctx = launched.ctx;
    fixtureCleanup = launched.cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("main memory bounded across plugin/copytree/analysis worker churn", async () => {
    test.setTimeout(900_000);
    const { app, window } = ctx;

    await expect
      .poll(async () => getActiveWorktreeId(window), {
        timeout: T_LONG,
        message: "Active worktree ID should be available",
      })
      .toBeTruthy();
    const worktreeId = await getActiveWorktreeId(window);

    await test.step("warmup cycles", async () => {
      for (let i = 0; i < WARMUP_CYCLES; i++) {
        await togglePluginOffOn(window);
        await generateContext(window, worktreeId);
        await openAndCloseTerminal(window);
        await window.waitForTimeout(500);
      }
      await window.waitForTimeout(2000);
    });

    const baseline = await measureMainMemory(app, { forceGc: true });
    const baselineUtility = await measureUtilityMemory(app);
    console.log(
      `[governance] baseline heap: ${toMB(baseline.heapUsed).toFixed(2)} MB, external: ${toMB(baseline.external).toFixed(2)} MB, utility RSS: ${toMB(baselineUtility).toFixed(2)} MB`
    );

    await test.step(`run ${CHURN_CYCLES} plugin/copytree/terminal churn cycles`, async () => {
      for (let i = 0; i < CHURN_CYCLES; i++) {
        await togglePluginOffOn(window);
        await generateContext(window, worktreeId);
        await openAndCloseTerminal(window);
        await window.waitForTimeout(300);
      }
    });

    await window.waitForTimeout(3000);
    const final = await measureMainMemory(app, { forceGc: true });
    const finalUtility = await measureUtilityMemory(app);
    const heapGrowthMB = toMB(final.heapUsed - baseline.heapUsed);
    const externalGrowthMB = toMB(final.external - baseline.external);
    const utilityGrowthMB = toMB(finalUtility - baselineUtility);
    console.log(
      `[governance] final heap: ${toMB(final.heapUsed).toFixed(2)} MB (growth ${heapGrowthMB.toFixed(2)} MB), ` +
        `external: ${toMB(final.external).toFixed(2)} MB (growth ${externalGrowthMB.toFixed(2)} MB), ` +
        `utility RSS: ${toMB(finalUtility).toFixed(2)} MB (growth ${utilityGrowthMB.toFixed(2)} MB)`
    );

    expect(heapGrowthMB).toBeLessThan(HEAP_THRESHOLD_MB);
    expect(externalGrowthMB).toBeLessThan(EXTERNAL_THRESHOLD_MB);
    expect(utilityGrowthMB).toBeLessThan(UTILITY_RSS_THRESHOLD_MB);
  });
});
