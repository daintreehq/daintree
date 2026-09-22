/**
 * Quick state filter bar visual-review harness.
 *
 * Drives the component's own preview entry (`quick-state-filter-preview.html`)
 * rather than booting Electron: the real `QuickStateFilterBar` and
 * `QuickStateArmButton`, the real theme tokens, the real `index.css`, in the
 * sidebar's column. The bar is 28px of 12px glyphs, so it is captured at 3x —
 * at 1x the spinner's arc, the check and the hollow ring are a few pixels each
 * and no judgement about their weight survives.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_QUICK_STATE=1 npx playwright test --project=screenshots quick-state-filter-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_QUICK_STATE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/quick-state-filter-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Infinite animations are frozen at their first frame for every capture, so
 * the spinner photographs at its resting geometry and two runs of the same tree
 * produce the same bytes.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_QUICK_STATE;

/** Canonical sidebar width, and `MIN_SIDEBAR_WIDTH` — the floor the resizer stops at. */
const DEFAULT_WIDTH = 320;
const NARROW_WIDTH = 200;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "quick-state-filter-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry, which runs under Vite's aliases and can't be imported here. */
const FIXTURES = [
  "default",
  "working-active",
  "waiting-active",
  "finished-active",
  "idle",
  "mixed",
  "busy",
  "no-counts",
] as const;

test.use({ deviceScaleFactor: 3 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, fixture: string, theme: string, width = DEFAULT_WIDTH) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: width + 40, height: 320 });
  await page.goto(
    `${baseURL}/quick-state-filter-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await expect(page.getByRole("toolbar", { name: "Quick state filter" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
}

/**
 * Never write a frame that has not been verified: a real box, and a bar that
 * actually carries its four segments plus the arm button.
 */
async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const buttons = target
    .page()
    .getByRole("toolbar", { name: "Quick state filter" })
    .getByRole("button");
  await expect(buttons).toHaveCount(5);
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out, animations: "disabled" });
  return out;
}

const bar = (page: Page) => page.locator("[data-filter-region]");
const shell = (page: Page) => page.locator("[data-preview-shell]");

test("Quick state filter — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_QUICK_STATE is required for the quick-state-filter capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_QUICK_STATE=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      await open(page, fixture, theme);
      written.push(await snap(bar(page), `${fixture}-${theme}.png`));
    }
    // In context once per theme: the bar against the rows it separates.
    await open(page, "default", theme);
    written.push(await snap(shell(page), `context-${theme}.png`));
  }

  // Interaction states, default theme only — affordance questions, not palette ones.
  {
    const theme = THEMES[0]!;

    await open(page, "default", theme);
    await page.getByRole("button", { name: /^Attention/ }).hover();
    await page.waitForTimeout(250);
    written.push(await snap(bar(page), `hover-segment-${theme}.png`));

    // Keyboard focus on a status segment, reached the way a keyboard user does.
    await open(page, "default", theme);
    await page.getByRole("button", { name: /^All/ }).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
    written.push(await snap(bar(page), `focus-segment-${theme}.png`));

    // The tooltip is where each status segment's name lives.
    await open(page, "default", theme);
    await page.getByRole("button", { name: /^Working/ }).hover();
    await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 3000 });
    written.push(await snap(shell(page), `tooltip-${theme}.png`));

    await open(page, "default", theme);
    await page.getByRole("button", { name: /^Arm/ }).hover();
    await page.waitForTimeout(250);
    written.push(await snap(bar(page), `hover-arm-${theme}.png`));
  }

  // The narrowest column the resizer allows.
  {
    const theme = THEMES[0]!;
    for (const fixture of ["default", "busy"] as const) {
      await open(page, fixture, theme, NARROW_WIDTH);
      written.push(await snap(bar(page), `${fixture}-${theme}-narrow.png`));
    }
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[quick-state-filter-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
