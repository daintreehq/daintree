/**
 * Log entry row visual-review harness — one row of the Logs tab, in every
 * shape and interaction state it has.
 *
 * Drives the Diagnostics preview entry (`diagnostics-preview.html`) on the
 * `logs-rows` fixture: one row of each shape (debug, info with context, no
 * source, a message long enough to wrap, a collapsed burst, an expanded
 * error), fed through the real logs store into the real `LogEntry`.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_LOG_ENTRY=1 npx playwright test --project=screenshots log-entry-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_LOG_ENTRY  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR       output directory (default artifacts/log-entry-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output:
 *   rows-<theme>.png              every row shape at rest, in each theme
 *   rows-hover-<first>.png        the pointer resting on a row with context
 *   rows-focus-row-<first>.png    keyboard focus on a row's disclosure
 *   rows-focus-copy-<first>.png   keyboard focus on that row's copy button
 *   rows-copied-<first>.png       just after a copy
 *   populated-<first>.png         the full log at the default 256px dock
 *
 * Never writes a PNG it has not verified: each state asserts its own marker,
 * and the test counts the files on disk rather than trusting its exit code.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_LOG_ENTRY;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "log-entry-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const WIDTH = 960;
const ROWS_HEIGHT = 440;
const DOCK_HEIGHT = 256;
const ATTACH_TIMEOUT_MS = 30_000;

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

/** Wait out Vite's optimizer: it force-reloads the first page that finds a new dependency. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/diagnostics-preview.html?fixture=logs-rows`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_000);
    const docks = await page.locator(".diagnostics-dock").count();
    if (navigations === before && docks === 1) break;
  }
  await page.close();
}

async function open(
  context: BrowserContext,
  fixture: string,
  theme: string,
  height: number,
  marker: RegExp
): Promise<Page> {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: WIDTH, height: height * 2 + 40 });
  await page.goto(
    `${server!.baseURL}/diagnostics-preview.html?fixture=${fixture}&theme=${theme}&height=${height}&width=${WIDTH}`
  );
  await expect(page.locator(".diagnostics-dock").first()).toBeAttached({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await expect(page.getByText(marker).first(), `${fixture}: marker never rendered`).toBeVisible({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  if (errors.length > 0) throw new Error(`${fixture} ${theme}: page threw: ${errors.join(" | ")}`);
  return page;
}

async function shoot(page: Page, height: number, file: string): Promise<string> {
  const dock = page.locator(".diagnostics-dock").first();
  const box = await dock.boundingBox();
  if (!box || Math.abs(box.height - height) > 2) {
    throw new Error(`${file}: dock is ${box?.height}px tall, expected ${height} — refusing`);
  }
  return snap(dock, file);
}

const EXPANDED_MARKER = /terminal prompts disabled/;
const WRAP_ROW = /Backpressure: paused term-9c1e/;

test("log entry row — every shape, every interaction state", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_LOG_ENTRY is required for the log entry capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_LOG_ENTRY=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];
  const [first] = THEMES;

  for (const theme of THEMES) {
    const page = await open(context, "logs-rows", theme, ROWS_HEIGHT, EXPANDED_MARKER);
    written.push(await shoot(page, ROWS_HEIGHT, `rows-${theme}.png`));
    await page.close();
  }

  {
    const page = await open(context, "logs-rows", first!, ROWS_HEIGHT, EXPANDED_MARKER);
    const row = page.getByText(WRAP_ROW).first();
    await row.hover();
    await page.waitForTimeout(250);
    written.push(await shoot(page, ROWS_HEIGHT, `rows-hover-${first}.png`));
    await page.close();
  }

  {
    const page = await open(context, "logs-rows", first!, ROWS_HEIGHT, EXPANDED_MARKER);
    const disclosure = page.getByRole("button", { name: WRAP_ROW });
    await disclosure.focus();
    // Focus through the keyboard path so :focus-visible matches.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(disclosure).toBeFocused();
    await page.waitForTimeout(250);
    written.push(await shoot(page, ROWS_HEIGHT, `rows-focus-row-${first}.png`));

    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    if (!focused || !/copy/i.test(focused)) {
      throw new Error(`Tab from the disclosure landed on "${focused}", not the copy button`);
    }
    await page.waitForTimeout(700);
    written.push(await shoot(page, ROWS_HEIGHT, `rows-focus-copy-${first}.png`));

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    written.push(await shoot(page, ROWS_HEIGHT, `rows-copied-${first}.png`));
    await page.close();
  }

  {
    const page = await open(context, "logs-populated", first!, DOCK_HEIGHT, /ResizeObserver loop/);
    written.push(await shoot(page, DOCK_HEIGHT, `populated-${first}.png`));
    await page.close();
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length + 5);
  console.log(`[log-entry-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
