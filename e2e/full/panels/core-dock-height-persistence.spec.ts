import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getDockPanelCount, getFirstGridPanel, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const PERSISTED_HEIGHT = 420;

async function setDockedPopoverHeight(page: Page, height: number): Promise<void> {
  await page.evaluate(async (h) => {
    const app = (
      window as unknown as {
        electron?: { app?: { setState?: (s: { dockedPopoverHeight: number }) => Promise<void> } };
      }
    ).electron?.app;
    await app?.setState?.({ dockedPopoverHeight: h });
  }, height);
}

async function getDockedPopoverHeight(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const app = (
      window as unknown as {
        electron?: { app?: { getState?: () => Promise<{ dockedPopoverHeight?: number }> } };
      }
    ).electron?.app;
    const state = await app?.getState?.();
    return state?.dockedPopoverHeight ?? null;
  });
}

test.describe.serial("Persistence: Dock popover height across restart", () => {
  let userDataDir: string;
  let fixtureDir: string;
  let fixtureCleanup: () => void;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-dock-height-"));
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({ name: "dock-height" }));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    fixtureCleanup?.();
  });

  test("docked popover height survives an app restart", async () => {
    // The dock popover height is persisted through `appClient.setState` →
    // electron-store (dockStore.setPopoverHeight) and rehydrated on the next
    // launch via AppLayout. There is no UI resize gesture wired to it yet, so
    // this exercises the persistence pipeline directly via the app-state IPC.

    // Session 1: dock a panel, persist a custom popover height, then close.
    ctx = await launchApp({ userDataDir });
    let { window: w1 } = ctx;
    const { app: app1 } = ctx;

    w1 = await openAndOnboardProject(app1, w1, fixtureDir, "Dock Height");

    await openTerminal(w1);
    const firstGridPanel = getFirstGridPanel(w1);
    await firstGridPanel.hover();
    await firstGridPanel.locator(SEL.panel.minimize).click();
    await expect.poll(() => getDockPanelCount(w1), { timeout: T_MEDIUM }).toBe(1);

    // Out-of-range values are rejected by the handler's validation (300–2000),
    // so the state stays unset before a valid value is written.
    await setDockedPopoverHeight(w1, 299);
    await setDockedPopoverHeight(w1, 2001);
    expect(await getDockedPopoverHeight(w1)).toBeNull();

    await setDockedPopoverHeight(w1, PERSISTED_HEIGHT);
    await expect
      .poll(() => getDockedPopoverHeight(w1), { timeout: T_MEDIUM })
      .toBe(PERSISTED_HEIGHT);

    const pid1 = app1.process().pid!;
    await closeApp(app1);
    await waitForProcessExit(pid1);
    ctx = null;

    // Session 2: relaunch with the same userDataDir and confirm the value
    // round-tripped through electron-store.
    ctx = await launchApp({ userDataDir });
    const { window: w2 } = ctx;

    await expect(w2.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText("dock-height", {
      timeout: T_LONG,
    });

    await expect.poll(() => getDockedPopoverHeight(w2), { timeout: T_LONG }).toBe(PERSISTED_HEIGHT);
  });
});

test.describe.serial("UI: Dock popover drag resize", () => {
  let userDataDir: string;
  let fixtureDir: string;
  let fixtureCleanup: () => void;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-dock-resize-"));
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({ name: "dock-resize" }));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    fixtureCleanup?.();
  });

  test("dragging the top-edge handle grows the popover and persists the height", async () => {
    ctx = await launchApp({ userDataDir });
    let { window: w } = ctx;
    const { app } = ctx;

    w = await openAndOnboardProject(app, w, fixtureDir, "Dock Resize");

    // Dock a terminal, then open its popover.
    await openTerminal(w);
    const firstGridPanel = getFirstGridPanel(w);
    await firstGridPanel.hover();
    await firstGridPanel.locator(SEL.panel.minimize).click();
    await expect.poll(() => getDockPanelCount(w), { timeout: T_MEDIUM }).toBe(1);

    await w.locator("[data-dock-item]").first().click();

    const handle = w.locator(SEL.panel.dockPopoverResizeHandle);
    await handle.waitFor({ state: "visible", timeout: T_MEDIUM });

    // offsetParent of the absolutely-positioned handle is the popover container,
    // so its height tracks the rendered popover height.
    const heightOf = () =>
      handle.evaluate(
        (el) => (el.offsetParent as HTMLElement | null)?.getBoundingClientRect().height ?? 0
      );

    const before = await heightOf();
    expect(before).toBeGreaterThan(0);

    // Drag the handle upward — the dock is at the bottom so up means taller.
    const box = await handle.boundingBox();
    if (!box) throw new Error("resize handle has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await w.mouse.move(cx, cy);
    await w.mouse.down();
    await w.mouse.move(cx, cy - 120, { steps: 12 });
    await w.mouse.up();

    await expect.poll(heightOf, { timeout: T_MEDIUM }).toBeGreaterThan(before + 40);

    // The committed height is persisted through the same IPC pipeline.
    await expect.poll(() => getDockedPopoverHeight(w), { timeout: T_MEDIUM }).toBeGreaterThan(500);
  });
});
