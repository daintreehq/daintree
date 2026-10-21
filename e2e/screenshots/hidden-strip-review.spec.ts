/**
 * File browser "N dotfiles hidden" strip — visual-review harness.
 *
 * Drives `hidden-strip-preview.html`, which mounts the REAL strip at the bottom
 * of a stand-in tree column at the sidebar's minimum and default widths, beside
 * the image viewer's footer as the reference for a text action in a pane status
 * footer. Captures rest, hover and keyboard focus on the Show button.
 *
 *   DAINTREE_SHOT_HIDDEN_STRIP=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots hidden-strip-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HIDDEN_STRIP  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          output directory (default artifacts/hidden-strip-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified, and counts the files itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_HIDDEN_STRIP;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "hidden-strip-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const SHOTS = [
  "min-one",
  "default-many",
  "default-hover",
  "default-focus",
  "reference-image-footer",
];

test.use({ deviceScaleFactor: 2 });

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

async function open(page: Page, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1400, height: 400 });
  await page.goto(`${baseURL}/hidden-strip-preview.html?theme=${theme}`);
  await expect(page.locator('[data-shot="reference-image-footer"]')).toBeAttached({
    timeout: 30_000,
  });
  await expect(page.getByTestId("file-browser-hidden-strip")).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
}

test.describe("hidden strip review", () => {
  for (const theme of THEMES) {
    test(`hidden strip — ${theme}`, async ({ page }) => {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "DAINTREE_SHOT_HIDDEN_STRIP is required for the hidden strip capture",
      });
      test.skip(!ENABLED, "set DAINTREE_SHOT_HIDDEN_STRIP=1 to capture");
      await open(page, theme);
      const snap = makeSnap(OUT_DIR);
      const shot = (name: string) => page.locator(`[data-shot="${name}"]`);
      const showIn = (name: string) => shot(name).getByRole("button", { name: "Show dotfiles" });

      await snap(shot("min-one"), `${theme}--min-one.png`);
      await snap(shot("default-many"), `${theme}--default-many.png`);

      await showIn("default-hover").hover();
      await snap(shot("default-hover"), `${theme}--default-hover.png`);
      await page.mouse.move(0, 0);

      // A key press first so Chromium treats the programmatic focus as keyboard
      // focus and `:focus-visible` matches.
      await page.keyboard.press("Shift");
      await showIn("default-focus").focus();
      const focused = await showIn("default-focus").evaluate((el) => el.matches(":focus-visible"));
      if (!focused) throw new Error("Show button is not :focus-visible — refusing to write");
      await snap(shot("default-focus"), `${theme}--default-focus.png`);
      await page.locator("body").evaluate(() => (document.activeElement as HTMLElement)?.blur());

      await snap(shot("reference-image-footer"), `${theme}--reference-image-footer.png`);
    });
  }

  test.afterAll(() => {
    if (!ENABLED) return;
    const files = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    const expected = THEMES.length * SHOTS.length;
    if (files.length !== expected) {
      throw new Error(`expected ${expected} PNGs in ${OUT_DIR}, found ${files.length}`);
    }
  });
});
