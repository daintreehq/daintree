/**
 * HTML preview fallback visual-review harness.
 *
 * `HtmlViewer` falls back to an empty state when a read returns no preview URL
 * (a file at a volume root, or one that resolved outside the folder being
 * browsed). Staging that in the running app means placing a file where the
 * preview refuses to mint a token, so this drives the component's own preview
 * entry (`html-preview-fallback-preview.html`) instead: the real `HtmlViewer`
 * and the real file viewer toolbar above it, against the real theme tokens.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_HTMLFALLBACK=1 DAINTREE_SHOT_DIR=/tmp/out \
 *     ./node_modules/.bin/playwright test --project=screenshots html-preview-fallback-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HTMLFALLBACK  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           output directory (default artifacts/html-preview-fallback-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated theme sweep (default: every built-in theme)
 *
 * Never writes a PNG it has not verified: `snap()` refuses a target without a
 * real box, and the test counts the files itself rather than trusting its exit.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_HTMLFALLBACK;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ??
    path.join(process.cwd(), "artifacts", "html-preview-fallback-shots")
);

const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ??
  "daintree,arashiyama,atacama,bali,bondi,fiordland,galapagos,highlands,hokkaido,movile,namib,redwoods,serengeti,svalbard,table-mountain"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** A typical file panel, a narrow column where the mode control folds, and a short cell. */
const SIZES = {
  panel: { width: 900, height: 560 },
  narrow: { width: 380, height: 560 },
  short: { width: 900, height: 240 },
} as const;

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string, size: keyof typeof SIZES) {
  const { width, height } = SIZES[size];
  await page.setViewportSize({ width: width + 40, height: height + 40 });
  await page.goto(
    `${server!.baseURL}/html-preview-fallback-preview.html?theme=${theme}&width=${width}&height=${height}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached();
  // The fallback is the subject; a frame here would mean the null URL never reached it.
  await expect(page.getByTestId("html-preview-frame")).toHaveCount(0);
  await expect(page.getByTestId("html-preview-unavailable")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  return shell;
}

test("HTML preview fallback — sizes, focus, switch and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HTMLFALLBACK is required for the HTML fallback capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_HTMLFALLBACK=1 to run the capture");

  await stubViteHmrClient(page);
  const written: string[] = [];
  const theme = THEMES[0]!;

  for (const size of Object.keys(SIZES) as Array<keyof typeof SIZES>) {
    const shell = await open(page, theme, size);
    written.push(await snap(shell, `${size}-${theme}.png`));
  }

  // The recovery control, when the body offers one: reached from the keyboard,
  // then activated, so the capture shows where focus lands once the view swaps.
  const shell = await open(page, theme, "panel");
  const action = page.locator("[data-preview-body] button").first();
  if ((await action.count()) > 0) {
    await action.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(action).toBeFocused();
    written.push(await snap(shell, `focus-${theme}.png`));

    await page.keyboard.press("Enter");
    await expect(shell).toHaveAttribute("data-mode", "source");
    await expect(page.locator("[data-preview-source]")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Source" })).toBeFocused();
    await page.waitForTimeout(150);
    written.push(await snap(shell, `switched-keyboard-${theme}.png`));

    const again = await open(page, theme, "panel");
    await page.locator("[data-preview-body] button").first().click();
    await expect(again).toHaveAttribute("data-mode", "source");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    written.push(await snap(again, `switched-pointer-${theme}.png`));
  } else {
    console.log("[html-preview-fallback-shots] no in-body recovery control — focus states skipped");
  }

  for (const sweep of THEMES.slice(1)) {
    const swept = await open(page, sweep, "panel");
    written.push(await snap(swept, `panel-${sweep}.png`));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(Object.keys(SIZES).length + THEMES.length - 1);
  console.log(`[html-preview-fallback-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
