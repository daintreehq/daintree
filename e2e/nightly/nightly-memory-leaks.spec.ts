import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import { measureMainMemory } from "../helpers/stress";

const HEAP_CYCLE_COUNT = 20;
const HEAP_THRESHOLD_MB = 20;
const SAB_CYCLE_COUNT = 10;
const SAB_THRESHOLD_MB = 10;
const WARMUP_CYCLES = 3;
const ERROR_INJECT_COUNT = 100;
const MAX_ERRORS = 50;

function toMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

async function openAndCloseTerminal(window: AppContext["window"]): Promise<void> {
  const countBefore = await getGridPanelCount(window);
  await window.locator(SEL.toolbar.openTerminal).click();
  await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

  const panel = getFirstGridPanel(window);
  await expect(panel).toBeVisible({ timeout: T_MEDIUM });

  const closeBtn = panel.locator(SEL.panel.close);
  await closeBtn.click({ modifiers: ["Alt"] });
  await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(countBefore);
}

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Nightly: Memory Leak Detection", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "memory-leaks" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Memory Leak Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("main process heap growth bounded after terminal churn", async () => {
    test.setTimeout(600_000);
    const { app, window } = ctx;

    await test.step("warmup cycles", async () => {
      for (let i = 0; i < WARMUP_CYCLES; i++) {
        await openAndCloseTerminal(window);
        await window.waitForTimeout(500);
      }
      await window.waitForTimeout(2000);
    });

    const baseline = await measureMainMemory(app, { forceGc: true });
    console.log(`[heap] baseline: ${toMB(baseline.heapUsed).toFixed(2)} MB`);

    await test.step(`run ${HEAP_CYCLE_COUNT} open/close cycles`, async () => {
      for (let i = 0; i < HEAP_CYCLE_COUNT; i++) {
        await openAndCloseTerminal(window);
        await window.waitForTimeout(500);
      }
    });

    await window.waitForTimeout(3000);
    const final = await measureMainMemory(app, { forceGc: true });
    const growthMB = toMB(final.heapUsed - baseline.heapUsed);
    console.log(
      `[heap] final: ${toMB(final.heapUsed).toFixed(2)} MB, growth: ${growthMB.toFixed(2)} MB`
    );

    expect(growthMB).toBeLessThan(HEAP_THRESHOLD_MB);
  });

  test("external memory growth bounded after terminal churn (SAB cleanup)", async () => {
    test.setTimeout(600_000);
    const { app, window } = ctx;

    const baseline = await measureMainMemory(app, { forceGc: true });
    console.log(
      `[sab] baseline external: ${toMB(baseline.external).toFixed(2)} MB, arrayBuffers: ${toMB(baseline.arrayBuffers).toFixed(2)} MB`
    );

    await test.step(`run ${SAB_CYCLE_COUNT} open/close cycles`, async () => {
      for (let i = 0; i < SAB_CYCLE_COUNT; i++) {
        await openAndCloseTerminal(window);
        await window.waitForTimeout(500);
      }
    });

    await window.waitForTimeout(3000);
    const final = await measureMainMemory(app, { forceGc: true });
    const externalGrowthMB = toMB(final.external - baseline.external);
    const arrayBuffersGrowthMB = toMB(final.arrayBuffers - baseline.arrayBuffers);
    console.log(
      `[sab] final external: ${toMB(final.external).toFixed(2)} MB (growth: ${externalGrowthMB.toFixed(2)} MB), arrayBuffers: ${toMB(final.arrayBuffers).toFixed(2)} MB (growth: ${arrayBuffersGrowthMB.toFixed(2)} MB)`
    );

    expect(externalGrowthMB).toBeLessThan(SAB_THRESHOLD_MB);
  });

  test("error store bounded at MAX_ERRORS after mass injection", async () => {
    const { window } = ctx;

    await test.step(`inject ${ERROR_INJECT_COUNT} errors`, async () => {
      for (let i = 0; i < ERROR_INJECT_COUNT; i++) {
        await window.evaluate((idx) => {
          window.__CANOPY_E2E_ADD_ERROR__?.(`Stress error ${idx}`);
        }, i);
      }
    });

    await test.step("verify error store is bounded", async () => {
      const errors = await window.evaluate(() => window.__CANOPY_E2E_ERROR_STORE__?.() ?? []);
      console.log(`[errors] store size after ${ERROR_INJECT_COUNT} injections: ${errors.length}`);
      expect(errors.length).toBeLessThanOrEqual(MAX_ERRORS);
      expect(errors.length).toBeGreaterThan(0);
    });

    await test.step("clear all and verify empty", async () => {
      await window.evaluate(() => window.__CANOPY_E2E_CLEAR_ERRORS__?.());
      const errors = await window.evaluate(() => window.__CANOPY_E2E_ERROR_STORE__?.() ?? []);
      expect(errors.length).toBe(0);
    });
  });
});
