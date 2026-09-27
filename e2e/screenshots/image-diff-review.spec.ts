/**
 * Image diff viewer visual-review harness.
 *
 * The viewer's states need a repo holding an image that is modified, resized,
 * added, deleted, over the size cap and unreadable, and three of them only
 * exist after a click on the mode toggle. So this drives the component's own
 * preview entry (`image-diff-preview.html`) rather than booting Electron: the
 * real `ImageDiffViewer`, the real theme tokens, the real `index.css`, with its
 * one IPC read answered from canvas-drawn fixtures.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_IMAGEDIFF=1 npx playwright test --project=screenshots image-diff-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_IMAGEDIFF  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        output directory (default artifacts/image-diff-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: `snap()` asserts a real box, each
 * state asserts its own marker before capture, and the test counts the files.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_IMAGEDIFF;

const DEFAULT_WIDTH = 900;
const NARROW_WIDTH = 440;
const HEIGHT = 560;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "image-diff-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  // The skip annotation lives in the test body; `test.info()` is unavailable here.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // `strictPort: false` beats the project's own `strictPort: true`, so a running
  // app on 5173 doesn't kill the harness.
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out, animations: "disabled" });
  return out;
}

async function open(page: Page, fixture: string, theme: string, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(
    `${baseURL}/image-diff-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  return shell;
}

/** Wait until every on-screen image has decoded, so no frame is half-painted. */
async function imagesSettled(page: Page, expected: number): Promise<void> {
  const imgs = page.locator("[data-preview-shell] img");
  await expect(imgs).toHaveCount(expected);
  await expect
    .poll(() =>
      imgs.evaluateAll((els) => els.every((el) => (el as HTMLImageElement).naturalWidth > 0))
    )
    .toBe(true);
  // One more frame for the mode toggle's thumb to land.
  await page.waitForTimeout(250);
}

async function selectMode(page: Page, label: string): Promise<void> {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test("image diff viewer — modes, states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_IMAGEDIFF is required for the image-diff capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_IMAGEDIFF=1 to run the capture");

  const written: string[] = [];

  for (const theme of THEMES) {
    // Modified: the three compare modes.
    let shell = await open(page, "modified", theme, DEFAULT_WIDTH);
    await imagesSettled(page, 2);
    written.push(await snap(shell, `two-up-${theme}.png`));

    await selectMode(page, "Swipe");
    await expect(page.getByRole("slider", { name: /divider/i })).toBeVisible();
    await imagesSettled(page, 2);
    written.push(await snap(shell, `swipe-${theme}.png`));

    // Keyboard focus on the divider, moved off centre.
    await page.getByRole("slider", { name: /divider/i }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    written.push(await snap(shell, `swipe-focused-${theme}.png`));

    await selectMode(page, "Onion skin");
    await imagesSettled(page, 2);
    written.push(await snap(shell, `onion-${theme}.png`));

    // A pale image: the case where a light divider or chip disappears.
    shell = await open(page, "light", theme, DEFAULT_WIDTH);
    await imagesSettled(page, 2);
    await selectMode(page, "Swipe");
    await imagesSettled(page, 2);
    written.push(await snap(shell, `swipe-light-${theme}.png`));

    shell = await open(page, "resized", theme, DEFAULT_WIDTH);
    await imagesSettled(page, 2);
    written.push(await snap(shell, `two-up-resized-${theme}.png`));

    shell = await open(page, "added", theme, DEFAULT_WIDTH);
    await imagesSettled(page, 1);
    written.push(await snap(shell, `added-${theme}.png`));

    shell = await open(page, "deleted", theme, DEFAULT_WIDTH);
    await imagesSettled(page, 1);
    written.push(await snap(shell, `deleted-${theme}.png`));

    shell = await open(page, "too-large", theme, DEFAULT_WIDTH);
    await imagesSettled(page, 1);
    written.push(await snap(shell, `too-large-${theme}.png`));

    shell = await open(page, "read-error", theme, DEFAULT_WIDTH);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    written.push(await snap(shell, `read-error-${theme}.png`));

    shell = await open(page, "failed", theme, DEFAULT_WIDTH);
    await expect(page.getByText("Couldn't load image versions")).toBeVisible();
    written.push(await snap(shell, `failed-${theme}.png`));

    shell = await open(page, "loading", theme, DEFAULT_WIDTH);
    await expect(
      page
        .locator("[data-preview-shell] [aria-busy='true'], [data-preview-shell] [role='status']")
        .first()
    ).toBeAttached();
    // Past the skeleton onset gate and into a steady pulse.
    await page.waitForTimeout(700);
    written.push(await snap(shell, `loading-${theme}.png`));
  }

  // Width is a layout question, so the narrow cases run in the first theme only.
  {
    const theme = THEMES[0]!;
    let shell = await open(page, "modified", theme, NARROW_WIDTH);
    await imagesSettled(page, 2);
    written.push(await snap(shell, `two-up-${theme}-narrow.png`));
    await selectMode(page, "Onion skin");
    await imagesSettled(page, 2);
    written.push(await snap(shell, `onion-${theme}-narrow.png`));
    shell = await open(page, "too-large", theme, NARROW_WIDTH);
    await imagesSettled(page, 1);
    written.push(await snap(shell, `too-large-${theme}-narrow.png`));
    // The longest facts line — a resize plus a byte delta — at the narrowest width.
    shell = await open(page, "resized", theme, NARROW_WIDTH);
    await imagesSettled(page, 2);
    written.push(await snap(shell, `two-up-resized-${theme}-narrow.png`));
    // Divider pinned to an end, where a centred handle would be clipped.
    await selectMode(page, "Swipe");
    await imagesSettled(page, 2);
    await page.getByRole("slider", { name: /divider/i }).focus();
    await page.keyboard.press("End");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    written.push(await snap(shell, `swipe-end-${theme}-narrow.png`));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 12 + 5);
  console.log(`[image-diff-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
