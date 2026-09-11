/**
 * Pane header window controls hold still while status changes (#12374).
 *
 * Status used to render after the close button, so every pill that came or
 * went slid close and maximize sideways under the pointer. jsdom cannot see
 * that, so this measures the built app: every transition must leave both
 * controls at the same coordinates and size, never change the terminal grid,
 * and a click on the original close coordinate must still close the pane.
 *
 * Flow holds and submit status are delivered over their production IPC
 * channels from the main process, so the renderer path under test is the one
 * that ships.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getGridPanelCount,
  getGridPanelIds,
  getPanelById,
  openSettings,
  openTerminal,
  selectSettingsScope,
} from "../../helpers/panels";
import {
  getTerminalDimensions,
  runTerminalCommand,
  waitForTerminalText,
} from "../../helpers/terminal";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM, T_SETTLE, T_SHORT } from "../../helpers/timeouts";

type Box = { x: number; y: number; width: number; height: number };
type Controls = { close: Box; maximize: Box };
type Grid = { cols: number; rows: number };
type FlowStatus = "running" | "paused-backpressure" | "paused-resource-governor";
type SubmitState = "slow" | "settled";

const STATUS_SLOT = '[data-testid="panel-header-status"]';
const STATUS_GLYPH = `${STATUS_SLOT} [role="status"]`;
const HEADER_CONTENT = '[data-testid="panel-header-content"]';
const HEADER = "[data-pane-chrome]";
const SUBPIXEL_TOLERANCE = 0.5;
const LONG_TITLE = `unbroken-${"x".repeat(180)}-title`;
// The grid's column floor is 380px; go below it so the title, metadata and
// status all compete for space.
const NARROW_PANE_WIDTH = "360px";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
let panelId = "";

async function waitForFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

async function sendFlowStatus(id: string, status: FlowStatus): Promise<void> {
  await ctx.app.evaluate(
    ({ webContents }, payload) => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send("terminal:status", payload);
      }
    },
    { id, status, timestamp: Date.now() }
  );
}

async function sendSubmitStatus(id: string, state: SubmitState): Promise<void> {
  await ctx.app.evaluate(
    ({ webContents }, payload) => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send("events:push", { name: "terminal:submit-status", payload });
      }
    },
    { id, state }
  );
}

async function setWindowSize(width: number, height: number): Promise<void> {
  await ctx.app.evaluate(
    ({ BrowserWindow }, size) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setSize(size.width, size.height);
      }
    },
    { width, height }
  );
}

async function boxOf(locator: Locator, label: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${label} has no layout`);
  return box;
}

async function measureControls(panel: Locator): Promise<Controls> {
  return {
    close: await boxOf(panel.locator(SEL.panel.close).first(), "Close"),
    maximize: await boxOf(panel.locator(SEL.panel.maximize).first(), "Maximize"),
  };
}

/** Two matching reads a beat apart, so a fit still in flight can't set the baseline. */
async function waitForSettledGrid(page: Page, panel: Locator): Promise<Grid> {
  const deadline = Date.now() + T_LONG;
  let previous = await getTerminalDimensions(panel);
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    await waitForFrames(page);
    const current = await getTerminalDimensions(panel);
    if (current && previous && current.cols === previous.cols && current.rows === previous.rows) {
      return current;
    }
    previous = current;
  }
  throw new Error("Terminal grid did not settle");
}

function expectSameBox(actual: Box, expected: Box, label: string): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${label}: ${key}`).toBeLessThanOrEqual(
      SUBPIXEL_TOLERANCE
    );
  }
}

async function expectControlsUnmoved(
  page: Page,
  panel: Locator,
  baseline: Controls,
  label: string
): Promise<void> {
  await waitForFrames(page);
  const now = await measureControls(panel);
  expectSameBox(now.close, baseline.close, `close after ${label}`);
  expectSameBox(now.maximize, baseline.maximize, `maximize after ${label}`);
  // A bounding box ignores clipping and stacking, so also prove the pointer
  // still lands on close at its original centre.
  const hit = await page.evaluate(
    ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="panel-close"]'),
    {
      x: baseline.close.x + baseline.close.width / 2,
      y: baseline.close.y + baseline.close.height / 2,
    }
  );
  expect(hit, `close is under its original centre after ${label}`).toBe(true);
}

interface StatusStep {
  label: string;
  apply: (id: string) => Promise<void>;
  glyph: RegExp | null;
}

// Covers a slow prompt and a backpressure pause arriving in both orders, each
// clearing under the other, and the memory pause.
const STATUS_STEPS: StatusStep[] = [
  {
    label: "a backpressure pause",
    apply: (id) => sendFlowStatus(id, "paused-backpressure"),
    glyph: /^Output paused$/,
  },
  {
    label: "a slow prompt joining the pause",
    apply: (id) => sendSubmitStatus(id, "slow"),
    glyph: /^Output paused, prompt still sending$/,
  },
  {
    label: "the pause clearing under a slow prompt",
    apply: (id) => sendFlowStatus(id, "running"),
    glyph: /^Prompt still sending$/,
  },
  {
    label: "a pause joining the slow prompt",
    apply: (id) => sendFlowStatus(id, "paused-backpressure"),
    glyph: /^Output paused, prompt still sending$/,
  },
  {
    label: "the prompt settling under the pause",
    apply: (id) => sendSubmitStatus(id, "settled"),
    glyph: /^Output paused$/,
  },
  {
    label: "a memory-pressure pause",
    apply: (id) => sendFlowStatus(id, "paused-resource-governor"),
    glyph: /memory pressure/,
  },
  {
    label: "every status clearing",
    apply: (id) => sendFlowStatus(id, "running"),
    glyph: null,
  },
];

async function runStatusSteps(page: Page, panel: Locator, statusTargetId: string): Promise<void> {
  const grid = await waitForSettledGrid(page, panel);
  const baseline = await measureControls(panel);
  const slot = await boxOf(panel.locator(STATUS_SLOT), "Status slot");

  for (const step of STATUS_STEPS) {
    await step.apply(statusTargetId);
    const glyph = panel.locator(STATUS_GLYPH);
    if (step.glyph) {
      await expect(glyph, step.label).toHaveAttribute("aria-label", step.glyph, {
        timeout: T_MEDIUM,
      });
    } else {
      await expect(glyph, step.label).toHaveCount(0, { timeout: T_MEDIUM });
    }
    await expectControlsUnmoved(page, panel, baseline, step.label);
    expectSameBox(
      await boxOf(panel.locator(STATUS_SLOT), "Status slot"),
      slot,
      `status slot after ${step.label}`
    );
    expect(await getTerminalDimensions(panel), `terminal grid after ${step.label}`).toEqual(grid);
  }
}

async function openReadyTerminal(page: Page, marker: string): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await openTerminal(page);
  await expect
    .poll(async () => (await getGridPanelIds(page)).some((id) => !before.has(id)), {
      timeout: T_LONG,
      intervals: [100, 250, 500],
    })
    .toBe(true);
  const id = (await getGridPanelIds(page)).find((candidate) => !before.has(candidate));
  if (!id) throw new Error("New terminal panel did not appear");
  const panel = getPanelById(page, id);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await runTerminalCommand(page, panel, `echo ${marker}`);
  await waitForTerminalText(panel, marker, T_LONG);
  await page.waitForTimeout(T_SETTLE);
  return id;
}

test.describe.serial("Pane header: window controls hold still while status changes", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({ name: "pane-header-controls" });
    fixtureCleanup = fixture.cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixture.dir,
      "Pane Header Controls"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("flow holds and a slow prompt, in either order, leave close and maximize in place", async () => {
    const page = ctx.window;
    panelId = await openReadyTerminal(page, "HEADER_CONTROLS_READY");
    await runStatusSteps(page, getPanelById(page, panelId), panelId);
  });

  test("the CPU and memory readout arriving, sparkline included, leaves the controls in place", async () => {
    const page = ctx.window;
    const panel = getPanelById(page, panelId);
    const grid = await waitForSettledGrid(page, panel);
    const baseline = await measureControls(panel);

    await openSettings(page);
    await selectSettingsScope(page, "Global");
    await page.locator(`${SEL.settings.navSidebar} button`, { hasText: "Panel Grid" }).click();
    await page
      .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Performance" })
      .click();
    await page.locator('[aria-label="Resource Monitoring Toggle"]').click();
    await page.keyboard.press("Escape");
    await expect(page.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

    // The sparkline only mounts from the second sample. Wait on its svg: an
    // idle shell's flat CPU history draws a zero-height polyline that
    // Playwright would report as invisible.
    await expect(panel.locator(`${HEADER_CONTENT} svg:has(polyline)`)).toBeVisible({
      timeout: T_LONG * 2,
    });
    await expectControlsUnmoved(page, panel, baseline, "the resource readout and sparkline");
    expect(await getTerminalDimensions(panel)).toEqual(grid);
  });

  test("a long title in a narrow pane keeps the controls on screen and in place", async () => {
    const page = ctx.window;
    const panel = getPanelById(page, panelId);

    await page.evaluate(
      async ({ terminalId, name }) => {
        const dispatch = window.__daintreeDispatchAction;
        if (typeof dispatch !== "function") throw new Error("Action dispatch hook not available");
        await dispatch("terminal.rename", { terminalId, name }, { source: "test" });
      },
      { terminalId: panelId, name: LONG_TITLE }
    );
    await expect(panel.locator(HEADER)).toContainText(LONG_TITLE, { timeout: T_MEDIUM });

    // The window's minimum width stops a real window from getting this narrow,
    // so cap the pane's own box as well.
    await setWindowSize(640, 720);
    await panel.evaluate((el, width) => {
      el.style.maxWidth = width;
    }, NARROW_PANE_WIDTH);
    await page.waitForTimeout(T_SETTLE);
    await waitForFrames(page);

    const header = await boxOf(panel.locator(HEADER), "Header");
    const controls = await measureControls(panel);
    expect(controls.close.x + controls.close.width).toBeLessThanOrEqual(header.x + header.width);
    expect(controls.maximize.x).toBeGreaterThanOrEqual(header.x);

    // Resource monitoring is still on from the previous test, so the readout
    // keeps changing width underneath these transitions too.
    await runStatusSteps(page, panel, panelId);
  });

  test("clicking where close sat before a status change still closes the pane", async () => {
    const page = ctx.window;
    const panel = getPanelById(page, panelId);
    const { close } = await measureControls(panel);
    const countBefore = await getGridPanelCount(page);

    await sendFlowStatus(panelId, "paused-backpressure");
    await sendSubmitStatus(panelId, "slow");
    await expect(panel.locator(STATUS_GLYPH)).toHaveAttribute(
      "aria-label",
      /prompt still sending/i,
      { timeout: T_MEDIUM }
    );
    await waitForFrames(page);

    await page.mouse.click(close.x + close.width / 2, close.y + close.height / 2);
    await expect.poll(() => getGridPanelCount(page), { timeout: T_LONG }).toBe(countBefore - 1);
  });

  test("status on the active tab of a tab group leaves the controls in place", async () => {
    const page = ctx.window;
    await setWindowSize(1280, 800);
    const id = await openReadyTerminal(page, "HEADER_TAB_GROUP_READY");

    await getPanelById(page, id)
      .locator(SEL.panel.duplicate)
      .first()
      .click({ force: true, timeout: T_MEDIUM });
    const group = page
      .locator(SEL.panel.gridPanel)
      .filter({ has: page.locator(SEL.panel.tabList) })
      .first();
    await expect(group.locator(SEL.panel.tab)).toHaveCount(2, { timeout: T_MEDIUM });

    const activeId = await group.getAttribute("data-panel-id");
    if (!activeId) throw new Error("Tab group has no active panel id");
    // A duplicate's tab appears before its terminal has attached and fitted;
    // prove the active tab is live before its grid becomes the baseline.
    await runTerminalCommand(page, group, "echo HEADER_TAB_ACTIVE_READY");
    await waitForTerminalText(group, "HEADER_TAB_ACTIVE_READY", T_LONG);

    await runStatusSteps(page, group, activeId);
  });
});
