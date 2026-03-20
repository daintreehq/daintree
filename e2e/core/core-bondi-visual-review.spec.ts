import { test } from "@playwright/test";
import path from "path";
import { mkdirSync } from "fs";
import { launchApp, closeApp } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";

const OUT = "/tmp/bondi-screenshots";
mkdirSync(OUT, { recursive: true });

async function switchTheme(page: import("@playwright/test").Page, themeId: string) {
  await page.evaluate(async (id) => {
    await window.electron.appTheme.setColorScheme(id);
  }, themeId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[aria-label="Open settings"]').waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    (id) => document.documentElement.getAttribute("data-theme") === id,
    themeId,
    { timeout: 10_000 }
  );
  await page.waitForTimeout(800);
}

async function shot(
  page: import("@playwright/test").Page,
  selector: string,
  filename: string,
  padding = 0
) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 8_000 });
  const box = await locator.boundingBox();
  if (!box) return;
  await page.screenshot({
    path: path.join(OUT, filename),
    clip: {
      x: Math.max(0, box.x - padding),
      y: Math.max(0, box.y - padding),
      width: box.width + padding * 2,
      height: box.height + padding * 2,
    },
  });
}

test("capture Bondi — sidebar, terminal, full app", async () => {
  const repoDir = await createFixtureRepo({
    name: "bondi-review",
    withFeatureBranch: true,
    withUncommittedChanges: true,
  });

  const ctx = await launchApp();
  const { app, window: page } = ctx;

  try {
    await openAndOnboardProject(app, page, repoDir, "Bondi Review");
    await page.locator('aside[aria-label="Sidebar"]').waitFor({ state: "visible" });
    await page.waitForTimeout(1500);

    // --- DAINTREE reference ---
    await switchTheme(page, "daintree");
    await page.screenshot({ path: path.join(OUT, "daintree-full-app.png") });
    await shot(page, 'aside[aria-label="Sidebar"]', "daintree-sidebar.png");
    await page.locator('[aria-label="Open Terminal"]').click();
    await page.locator(".xterm-screen").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, "daintree-with-terminal.png") });

    // --- BONDI ---
    await switchTheme(page, "bondi");
    await page.screenshot({ path: path.join(OUT, "bondi-full-app.png") });
    await shot(page, 'aside[aria-label="Sidebar"]', "bondi-sidebar.png");
    await shot(page, '[role="toolbar"]', "bondi-toolbar.png");
    await shot(page, "main", "bondi-canvas.png");

    // Terminal may have been restored from previous Daintree session, or open fresh
    const xtermVisible = await page.locator(".xterm-screen").first().isVisible();
    if (!xtermVisible) {
      await page.locator('[aria-label="Open Terminal"]').click();
      await page.locator(".xterm-screen").waitFor({ state: "visible", timeout: 10_000 });
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, "bondi-with-terminal.png") });
    await shot(page, ".xterm-screen", "bondi-terminal-bg.png", 4);
  } finally {
    await closeApp(app);
  }
});
