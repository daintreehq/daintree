import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

test.describe.serial("Core: Sidecar Panel", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
    }
  });

  test("opens via toolbar toggle", async () => {
    const { window } = ctx;

    const toggle = window.locator(SEL.toolbar.sidecarToggle);
    await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
    await toggle.click();

    await expect(window.locator(SEL.sidecar.region)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("shows launchpad content", async () => {
    const { window } = ctx;

    await expect(window.locator(SEL.sidecar.launchpadHeading)).toBeVisible({ timeout: T_SHORT });
  });

  test("closes via toolbar toggle", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.sidecarToggle).click();
    await expect(window.locator(SEL.sidecar.region)).toBeHidden({ timeout: T_SHORT });
  });

  test("resizes via keyboard", async () => {
    const { window } = ctx;

    // Re-open sidecar
    await window.locator(SEL.toolbar.sidecarToggle).click();
    await expect(window.locator(SEL.sidecar.region)).toBeVisible({ timeout: T_MEDIUM });

    const handle = window.locator(SEL.sidecar.resizeHandle);
    await handle.focus();

    const before = Number(await handle.getAttribute("aria-valuenow"));
    expect(before).toBeGreaterThan(0);

    // ArrowLeft increases width (handle is on left edge of right-side panel)
    for (let i = 0; i < 5; i++) {
      await window.keyboard.press("ArrowLeft");
    }

    await expect
      .poll(async () => Number(await handle.getAttribute("aria-valuenow")), { timeout: T_SHORT })
      .toBeGreaterThan(before);

    // Close sidecar for clean state
    await window.locator(SEL.toolbar.sidecarToggle).click();
    await expect(window.locator(SEL.sidecar.region)).toBeHidden({ timeout: T_SHORT });
  });
});

test.describe.serial("Sidecar: Width persistence across restart", () => {
  let userDataDir: string;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-sidecar-persist-"));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test("resized width survives app restart", async () => {
    // Session 1: Launch, open sidecar, resize, record width, close
    ctx = await launchApp({ userDataDir });
    const { window: w1 } = ctx;

    const toggle1 = w1.locator(SEL.toolbar.sidecarToggle);
    await expect(toggle1).toBeVisible({ timeout: T_MEDIUM });
    await toggle1.click();
    await expect(w1.locator(SEL.sidecar.region)).toBeVisible({ timeout: T_MEDIUM });

    const handle1 = w1.locator(SEL.sidecar.resizeHandle);
    await handle1.focus();

    // Increase width by pressing ArrowLeft multiple times
    for (let i = 0; i < 5; i++) {
      await w1.keyboard.press("ArrowLeft");
    }

    await expect
      .poll(async () => Number(await handle1.getAttribute("aria-valuenow")), { timeout: T_SHORT })
      .toBeGreaterThan(480);

    const savedWidth = Number(await handle1.getAttribute("aria-valuenow"));

    // Allow Zustand persist to flush
    await w1.waitForTimeout(T_SETTLE);

    const pid = ctx.app.process().pid!;
    await closeApp(ctx.app);
    await waitForProcessExit(pid);
    ctx = null;

    // Session 2: Relaunch with same userDataDir, open sidecar, verify width
    ctx = await launchApp({ userDataDir });
    const { window: w2 } = ctx;

    const toggle2 = w2.locator(SEL.toolbar.sidecarToggle);
    await expect(toggle2).toBeVisible({ timeout: T_MEDIUM });
    await toggle2.click();
    await expect(w2.locator(SEL.sidecar.region)).toBeVisible({ timeout: T_MEDIUM });

    const handle2 = w2.locator(SEL.sidecar.resizeHandle);
    await expect
      .poll(async () => Number(await handle2.getAttribute("aria-valuenow")), { timeout: T_MEDIUM })
      .toBe(savedWidth);
  });
});
