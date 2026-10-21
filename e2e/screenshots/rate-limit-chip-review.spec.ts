/**
 * Pane header rate-limit chip — visual-review harness.
 *
 * The chip appears on a pane whose agent printed a rate-limit banner, and only for
 * a while afterwards, so it is never on screen when anyone goes looking for it.
 * This drives the panel header's preview entry (`panel-header-preview.html`) with
 * the `rate-limited` fixtures, which mount the real `ContentPanel` with the
 * observation store seeded, and photographs the header row and the open tooltip.
 *
 *   DAINTREE_SHOT_RATE_LIMIT_CHIP=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots rate-limit-chip-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RATE_LIMIT_CHIP  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR             required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES           comma-separated themes (default daintree,bondi,namib,svalbard)
 *
 * Never writes a PNG it has not verified, and counts the files on disk at the end.
 * Page errors are not fatal: the shimmed bridge behind the panel-header preview
 * throws from unrelated header slots, as it does under `panel-header-review`.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_RATE_LIMIT_CHIP;
const OUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const FIXTURES = ["rate-limited", "rate-limited-narrow"] as const;

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) throw new Error("DESIGN_CAPTURE_DIR must be an absolute path");
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, fixture: string, theme: string): Promise<Locator> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 760, height: 520 });
  await page.goto(`${baseURL}/panel-header-preview.html?theme=${theme}&fixture=${fixture}`);
  const pane = page.locator(`[data-preview-pane="${fixture}"]`);
  await expect(pane).toBeAttached({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  const chip = pane.getByTestId("terminal-rate-limit-badge");
  await expect(chip).toBeVisible({ timeout: 10_000 });
  return pane;
}

async function shoot(page: Page, targets: Locator[], file: string): Promise<string> {
  const boxes = [];
  for (const t of targets) {
    const box = await t.boundingBox();
    if (!box || box.width < 8 || box.height < 8) {
      throw new Error(`${file}: target has no real box — refusing to write`);
    }
    boxes.push(box);
  }
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 8);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 8);
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + 8;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 8;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

test("Rate-limit chip — header row and tooltip", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RATE_LIMIT_CHIP is required for the rate-limit chip capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_RATE_LIMIT_CHIP=1 to run the capture");
  test.setTimeout(5 * 60_000);

  const written: string[] = [];

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      const pane = await open(page, fixture, theme);
      written.push(await shoot(page, [pane], `${fixture}--${theme}.png`));

      await pane.getByTestId("terminal-rate-limit-badge").hover();
      const tip = page.locator("[data-radix-popper-content-wrapper]").last();
      await expect(tip).toContainText(/\S/, { timeout: 5_000 });
      // Let the tooltip's entry motion settle before the frame is taken.
      await page.waitForTimeout(250);
      written.push(await shoot(page, [pane, tip], `${fixture}-tooltip--${theme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.sort()).toEqual(written.map((f) => path.basename(f)).sort());
  expect(onDisk).toHaveLength(THEMES.length * FIXTURES.length * 2);
});
