/**
 * PDF loading frame visual-review harness.
 *
 * The frame covers the `daintree-pdf://` admission probe, which a warm disk
 * answers inside the skeleton's own 400ms gate, so in the real app it is
 * almost never on screen long enough to judge — and never at a chosen pane
 * size. This drives `pdf-loading-preview.html`, which renders the real
 * `FilePdfPreview` with the probe parked, under the file panel's toolbar, at
 * the pane sizes where the frame's proportions are under pressure.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_PDFLOADING=1 npx playwright test --project=screenshots pdf-loading-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PDFLOADING  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/pdf-loading-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default: daintree,bondi)
 *
 * Captures run under reduced motion so the bone holds its peak opacity rather
 * than wherever the pulse happened to be. The long-wait hint is reached on
 * Playwright's clock, not by waiting eight real seconds.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PDFLOADING;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "pdf-loading-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Pane body sizes, below the toolbar, with what each one is here to prove. */
const SIZES = [
  { name: "tall", width: 900, height: 640, what: "a typical file panel" },
  { name: "short", width: 900, height: 160, what: "a pane split down to a strip" },
  { name: "squat", width: 900, height: 96, what: "the shortest body a split leaves" },
  { name: "narrow", width: 360, height: 560, what: "a narrow column" },
] as const;

/** Past the hint's 8s first threshold. */
const HINT_AT_MS = 9_000;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook. The
  // test body carries the skip; this hook simply does no work when unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(
  page: Page,
  theme: string,
  size: (typeof SIZES)[number],
  hint: boolean
): Promise<Locator> {
  await page.setViewportSize({ width: size.width + 40, height: size.height + 120 });
  await page.clock.install();
  await page.goto(
    `${server!.baseURL}/pdf-loading-preview.html?theme=${theme}&width=${size.width}&height=${size.height}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached();
  // The preview must be in its loading branch: a settled probe renders a frame
  // or nothing, and either is a picture of the wrong state.
  await expect(shell.getByRole("status", { name: "Loading PDF" })).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  if (hint) {
    await page.clock.fastForward(HINT_AT_MS);
    await expect(shell.locator("[aria-hidden=true]", { hasText: "Still working…" })).toBeVisible();
  }
  // The bone's reveal is a CSS animation behind the 400ms anti-flicker gate,
  // which the fake clock does not move.
  await page.waitForTimeout(700);
  const bone = shell.locator("[data-skeleton-bone]").first();
  const opacity = await bone.evaluate((el) => getComputedStyle(el).opacity);
  if (opacity !== "1") throw new Error(`bone still gated (opacity ${opacity})`);
  return shell;
}

test("PDF loading frame — pane sizes, long wait, themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PDFLOADING is required for the PDF loading capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PDFLOADING=1 to run the capture");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubViteHmrClient(page);
  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const size of SIZES) {
      const shell = await open(page, theme, size, false);
      written.push(await snap(shell, `${size.name}-${theme}.png`));
    }
    for (const size of SIZES.filter((s) => s.name === "tall" || s.name === "short")) {
      const shell = await open(page, theme, size, true);
      written.push(await snap(shell, `${size.name}-hint-${theme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * (SIZES.length + 2));
  console.log(`[pdf-loading-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
