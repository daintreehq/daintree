/**
 * Clear-logs confirmation visual-review harness.
 *
 * Drives `clear-logs-confirm-preview.html`, which holds the real
 * `ClearLogsConfirmDialog` open, and captures it per theme plus an all-themes
 * sweep.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_CLEAR_LOGS is set.
 *
 *   DAINTREE_SHOT_CLEAR_LOGS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots clear-logs-confirm-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CLEAR_LOGS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES      themes for the focused captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP       "0" skips the all-themes sweep
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_CLEAR_LOGS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

const CARD = '[role="dialog"] > [tabindex="-1"], [role="alertdialog"] > [tabindex="-1"]';
const PAD = 24;

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string): Promise<void> {
  await page.setViewportSize({ width: 640, height: 480 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[clear-logs-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/clear-logs-confirm-preview.html?theme=${theme}`;
  const card = page.locator(CARD).first();
  try {
    await page.goto(url);
    await expect(card).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(card).toBeVisible({ timeout: 30_000 });
  }
  // A Tailwind utility on the card proves the stylesheet landed, not just markup.
  await expect(card).toHaveCSS("border-top-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

/**
 * The body is the subject, so prove the dialog announces it: the description
 * node the alertdialog points at must hold the copy that is on screen.
 */
async function expectBody(page: Page): Promise<void> {
  const dialog = page.locator('[role="alertdialog"]').first();
  await expect(dialog.getByText("Clear logs?")).toBeVisible();
  const describedBy = await dialog.getAttribute("aria-describedby");
  if (!describedBy) throw new Error("alertdialog has no aria-describedby — refusing to write");
  const description = page.locator(`[id="${describedBy}"]`);
  await expect(description).toContainText(/log view/);
  await expect(description).toContainText(/on disk/);
}

async function shoot(page: Page, file: string): Promise<string> {
  const box = await page.locator(CARD).first().boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: dialog has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const viewport = page.viewportSize()!;
  const x = Math.max(0, box.x - PAD);
  const y = Math.max(0, box.y - PAD);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + PAD * 2),
      height: Math.min(viewport.height - y, box.height + PAD * 2),
    },
  });
  return out;
}

test("Clear logs confirm — themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CLEAR_LOGS is required for the capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_CLEAR_LOGS=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const written: string[] = [];
  for (const theme of THEMES) {
    await open(page, theme);
    await expectBody(page);
    written.push(await shoot(page, `rest--${theme}.png`));
  }

  if (SWEEP) {
    for (const theme of ALL_THEMES) {
      await open(page, theme);
      await expectBody(page);
      written.push(await shoot(page, `sweep--${theme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[clear-logs-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
