import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount, getGridPanelIds, getPanelById, openTerminal } from "../helpers/panels";
import { waitForTerminalPty } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import { measureMainMemory, measureRendererMemory } from "../helpers/stress";

const HEAP_CYCLE_COUNT = 20;
const HEAP_THRESHOLD_MB = 20;
const WARMUP_CYCLES = 3;

function toMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

/** Terminals whose PTY is still alive in the pty-host, across all projects. */
async function getLivePtyCount(window: Page): Promise<number> {
  return window.evaluate(async () => {
    const terminals = await globalThis.window.electron.terminal.getAllTerminals();
    return terminals.filter((t) => t.hasPty === true).length;
  });
}

/**
 * Closed terminals the pty-host still has registered. A killed PTY's entry is
 * dropped only once its process has exited, so an empty list is the exit
 * barrier `hasPty` is not: that flag flips at kill time, before the exit.
 */
async function getUnexitedTerminals(
  window: AppContext["window"],
  ids: string[]
): Promise<string[]> {
  return window.evaluate(async (closed) => {
    const terminals = await globalThis.window.electron.terminal.getAllTerminals();
    return terminals.filter((t) => closed.includes(t.id)).map((t) => t.id);
  }, ids);
}

/**
 * Wait until every terminal the churn closed has actually exited. Readings
 * taken while teardown is still in flight measure the teardown, not a leak.
 */
async function waitForPtysToSettle(window: AppContext["window"], expected: number): Promise<void> {
  await expect
    .poll(
      async () => ({
        live: await getLivePtyCount(window),
        unexited: await getUnexitedTerminals(window, closedTerminalIds),
      }),
      { message: "closed terminals never exited", timeout: T_LONG }
    )
    .toEqual({ live: expected, unexited: [] });
}

const closedTerminalIds: string[] = [];

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
  // Close an attached PTY, not a pending spawn, so every cycle takes the same
  // teardown path; spawns past the rate limit queue until then.
  await waitForTerminalPty(window, panel, T_LONG);

  // Use force click to handle the close button being momentarily detached
  // from the DOM during re-renders (common on Windows CI)
  const closeBtn = panel.locator(SEL.panel.close);
  await closeBtn.click({ modifiers: ["Alt"], force: true, timeout: T_MEDIUM });
  await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(idsBefore.length);
  if (newId) closedTerminalIds.push(newId);
}

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Nightly: Memory Leak Detection", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "memory-leaks" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Memory Leak Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("main process heap growth bounded after terminal churn", async () => {
    test.setTimeout(600_000);
    const { app, window } = ctx;

    const idlePtys = await getLivePtyCount(window);

    await test.step("warmup cycles", async () => {
      for (let i = 0; i < WARMUP_CYCLES; i++) {
        await openAndCloseTerminal(window);
      }
      await waitForPtysToSettle(window, idlePtys);
    });

    const baseline = await measureMainMemory(app, { forceGc: true });
    console.log(`[heap] baseline: ${toMB(baseline.heapUsed).toFixed(2)} MB`);

    await test.step(`run ${HEAP_CYCLE_COUNT} open/close cycles`, async () => {
      for (let i = 0; i < HEAP_CYCLE_COUNT; i++) {
        await openAndCloseTerminal(window);
      }
    });

    await waitForPtysToSettle(window, idlePtys);
    const final = await measureMainMemory(app, { forceGc: true });
    const growthMB = toMB(final.heapUsed - baseline.heapUsed);
    console.log(
      `[heap] final: ${toMB(final.heapUsed).toFixed(2)} MB, growth: ${growthMB.toFixed(2)} MB`
    );

    expect(growthMB).toBeLessThan(HEAP_THRESHOLD_MB);
  });
});

// ── xterm WebGL dispose leak (#9540) ──────────────────────
//
// xterm 6.0.0 leaked the whole Terminal object graph on every dispose() because
// WebglRenderer._cursorBlinkStateManager and RenderService._pausedResizeTask were
// never registered as disposables (upstream xterm.js #5818). The fix shipped in
// the 6.1.0 beta line, which Daintree now pins. These regressions guard against
// a reintroduction by exercising the close path and the hibernate path with the
// WebGL renderer actually attached (the WebglRenderer leak only materializes when
// the addon is loaded) and asserting the WebGL "wants" pool returns to baseline
// and the renderer JS heap stays flat across many cycles.
//
// The WebGL renderer needs a real GPU, which the default managed CI runners
// lack (they launch with --disable-gpu). So these run locally by default and
// are skipped on CI — unless DAINTREE_E2E_ENABLE_WEBGL=1 is set, which a
// GPU-equipped runner can use to opt the regression back in as a real gate.
// When skipped, beforeAll early-returns so no Electron is launched.
const RUN_WEBGL_LEAK_TESTS = !process.env.CI || process.env.DAINTREE_E2E_ENABLE_WEBGL === "1";

const WEBGL_CYCLE_COUNT = 20;
// A reintroduced per-dispose Terminal-graph leak retains buffers, render layers
// and the WebGL renderer on every cycle — easily tens of MB across 20 cycles.
// 35MB clears normal V8 / performance.memory noise while still catching a
// multi-MB-per-cycle regression.
const WEBGL_HEAP_THRESHOLD_MB = 35;
const WEBGL_WARMUP_CYCLES = 3;
const WEBGL_AGENT_ID = "claude";

interface WebGLState {
  wantsSize: number;
  active: boolean;
  mode: string;
}

async function getWebGLState(page: Page, panelId: string): Promise<WebGLState | null> {
  return page.evaluate((id) => {
    const fn = (
      window as unknown as {
        __daintreeGetTerminalWebGLState?: (panelId: string) => WebGLState | null;
      }
    ).__daintreeGetTerminalWebGLState;
    return typeof fn === "function" ? fn(id) : null;
  }, panelId);
}

async function promoteToAgent(page: Page, panelId: string): Promise<boolean> {
  return page.evaluate(
    ({ id, agentId }) => {
      const fn = (
        window as unknown as {
          __daintreePromoteTerminalToAgentForE2E?: (panelId: string, agentId: string) => boolean;
        }
      ).__daintreePromoteTerminalToAgentForE2E;
      return typeof fn === "function" ? fn(id, agentId) : false;
    },
    { id: panelId, agentId: WEBGL_AGENT_ID }
  );
}

// Open a terminal, promote it to a WebGL-eligible agent terminal, and wait for
// the WebGL context to actually attach (addon load is async). Returns the new
// panel id.
async function openAgentTerminalWithWebGL(window: AppContext["window"]): Promise<string> {
  const idsBefore = await getGridPanelIds(window);
  await openTerminal(window);
  await expect
    .poll(() => getGridPanelCount(window), { timeout: T_LONG })
    .toBe(idsBefore.length + 1);

  const idsAfter = await getGridPanelIds(window);
  const newId = idsAfter.find((id) => !idsBefore.includes(id));
  expect(newId, "new terminal panel id").toBeTruthy();
  const id = newId as string;

  await expect(getPanelById(window, id)).toBeVisible({ timeout: T_MEDIUM });
  await promoteToAgent(window, id);
  await expect
    .poll(async () => (await getWebGLState(window, id))?.active ?? false, { timeout: T_LONG })
    .toBe(true);
  return id;
}

async function closePanel(window: AppContext["window"], id: string): Promise<void> {
  const idsBefore = await getGridPanelIds(window);
  const panel = getPanelById(window, id);
  const closeBtn = panel.locator(SEL.panel.close);
  await closeBtn.click({ modifiers: ["Alt"], force: true, timeout: T_MEDIUM });
  await expect
    .poll(() => getGridPanelCount(window), { timeout: T_MEDIUM })
    .toBe(idsBefore.length - 1);
}

const WEBGL_GPU_SKIP_REASON =
  "WebGL renderer needs a real GPU; skipped on CI unless DAINTREE_E2E_ENABLE_WEBGL=1";

function skipWithoutGpu(): void {
  test.info().annotations.push({ type: "conditional-skip", description: WEBGL_GPU_SKIP_REASON });
  test.skip(!RUN_WEBGL_LEAK_TESTS, WEBGL_GPU_SKIP_REASON);
}

test.describe.serial("Nightly: xterm WebGL dispose leak (#9540)", () => {
  let webglCtx: AppContext;
  let webglFixtureDir: string;
  let webglFixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    // Don't launch Electron when the suite will skip — saves a wasted
    // ~60-120s GPU-less launch on every managed CI nightly run.
    if (!RUN_WEBGL_LEAK_TESTS) return;
    const { dir, cleanup } = createFixtureRepo({ name: "webgl-leaks" });
    webglFixtureDir = dir;
    webglFixtureCleanup = cleanup;
    webglCtx = await launchApp({ enableWebgl: true });
    webglCtx.window = await openAndOnboardProject(
      webglCtx.app,
      webglCtx.window,
      webglFixtureDir,
      "WebGL Leak Test"
    );
  });

  test.afterAll(async () => {
    if (webglCtx?.app) await closeApp(webglCtx.app);
    webglFixtureCleanup?.();
  });

  test("Terminal graph released after agent terminal close (WebGL)", async () => {
    skipWithoutGpu();
    test.setTimeout(600_000);
    const { window } = webglCtx;
    const idlePtys = await getLivePtyCount(window);

    await test.step("confirm WebGL actually attaches", async () => {
      const id = await openAgentTerminalWithWebGL(window);
      const state = await getWebGLState(window, id);
      expect(state?.mode).toBe("webgl");
      expect(state?.wantsSize).toBeGreaterThan(0);
      await closePanel(window, id);
      await expect
        .poll(async () => (await getWebGLState(window, id))?.wantsSize ?? -1, { timeout: T_MEDIUM })
        .toBe(0);
    });

    await test.step("warmup cycles", async () => {
      for (let i = 0; i < WEBGL_WARMUP_CYCLES; i++) {
        const id = await openAgentTerminalWithWebGL(window);
        await closePanel(window, id);
      }
      await waitForPtysToSettle(window, idlePtys);
    });

    const baseline = await measureRendererMemory(window, { forceGc: true });
    expect(baseline, "performance.memory available in renderer").not.toBeNull();
    console.log(`[webgl-close] baseline: ${toMB(baseline!.usedJSHeapSize).toFixed(2)} MB`);

    await test.step(`run ${WEBGL_CYCLE_COUNT} open/promote/close cycles`, async () => {
      for (let i = 0; i < WEBGL_CYCLE_COUNT; i++) {
        const id = await openAgentTerminalWithWebGL(window);
        await closePanel(window, id);
        // pool wants must return to baseline every cycle — a retained Terminal
        // graph would leave a stale "wants" entry behind.
        await expect
          .poll(async () => (await getWebGLState(window, id))?.wantsSize ?? -1, {
            timeout: T_MEDIUM,
          })
          .toBe(0);
      }
    });

    await waitForPtysToSettle(window, idlePtys);
    const final = await measureRendererMemory(window, { forceGc: true });
    const growthMB = toMB(final!.usedJSHeapSize - baseline!.usedJSHeapSize);
    console.log(
      `[webgl-close] final: ${toMB(final!.usedJSHeapSize).toFixed(2)} MB, growth: ${growthMB.toFixed(2)} MB`
    );

    expect(growthMB).toBeLessThan(WEBGL_HEAP_THRESHOLD_MB);
  });
});
