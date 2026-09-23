/**
 * Terminal "New output below" pill visual-review harness.
 *
 * The pill only exists while a pane is scrolled back and output has landed
 * below it, which in the real app lasts until the next wheel tick. This drives
 * `terminal-scroll-pill-preview.html` instead: the real `TerminalScrollIndicator`
 * over a real xterm holding a scrolled-back build log, beside the real worktree
 * sidebar `ScrollIndicator`, which shares the `ScrollPill` chrome and so has to be
 * judged in the same pass.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_SCROLLPILL=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots terminal-scroll-pill-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SCROLLPILL   required — enables the capture
 *   DAINTREE_SHOT_DIR          required — absolute output dir. No default: an
 *                              in-repo fallback would put PNGs into someone's tree.
 *   DAINTREE_SHOT_THEMES       themes that get the full state set (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<state>-<theme>.png, <dir>/zoom-<theme>.png (every built-in
 * theme), <dir>/<state>-forced-colors.png
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_SCROLLPILL;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const SCALE = Number(process.env.DAINTREE_SCREENSHOT_SCALE ?? "2");

const FULL_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ALL_THEMES = [
  "daintree",
  "arashiyama",
  "fiordland",
  "galapagos",
  "highlands",
  "movile",
  "namib",
  "redwoods",
  "atacama",
  "bali",
  "bondi",
  "hokkaido",
  "serengeti",
  "svalbard",
  "table-mountain",
];

/** Mirrors the fixture lists in the preview entry, which runs under Vite aliases this loader lacks. */
const TERMINAL_STATES = [
  "rest",
  "shell",
  "fleet",
  "bright",
  "narrow",
  "fleet-narrow",
  "hover",
  "focus",
] as const;
const SIDEBAR_STATES = ["sidebar-below", "sidebar-above"] as const;

/** Margin of pane kept around the pill in the zoom crop. */
const ZOOM_MARGIN = 72;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute path");
  }
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 820, height: 1200 });
  await page.goto(`${server!.baseURL}/terminal-scroll-pill-preview.html?theme=${theme}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  // Every xterm has to have written and scrolled back before anything is judged:
  // a pill over an empty viewport says nothing about occlusion.
  await expect(page.locator('[data-xterm-host][data-ready="true"]')).toHaveCount(
    TERMINAL_STATES.length,
    { timeout: 15_000 }
  );
  for (const state of TERMINAL_STATES) {
    await expect(
      page.locator(`[data-shot="${state}"] .xterm-rows`),
      `${state}: xterm painted no text`
    ).toContainText(/tests/);
  }
  await page.mouse.move(815, 5);
  await page.waitForTimeout(250);
}

function pill(page: Page, state: string) {
  // The ScrollPill button in either host, whatever its copy says.
  return page.locator(`[data-shot="${state}"] button.rounded-full.pointer-events-auto`).first();
}

async function snapPane(page: Page, state: string, file: string): Promise<string> {
  const pane = page.locator(`[data-shot="${state}"] [data-preview-pane]`);
  await expect(pill(page, state), `${state}: pill not rendered`).toBeVisible();
  const box = await pane.boundingBox();
  if (!box || box.width < 100 || box.height < 100) {
    throw new Error(`${state}: pane has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await pane.screenshot({ path: out });
  return out;
}

async function snapZoom(page: Page, state: string, file: string): Promise<string> {
  const pane = await page.locator(`[data-shot="${state}"] [data-preview-pane]`).boundingBox();
  const p = await pill(page, state).boundingBox();
  if (!pane || !p || p.width < 16 || p.height < 12) {
    throw new Error(`${state}: no real pill box (${JSON.stringify(p)}) — refusing to write`);
  }
  const x = Math.max(pane.x, p.x - ZOOM_MARGIN * 2);
  const y = Math.max(pane.y, p.y - ZOOM_MARGIN);
  const right = pane.x + pane.width;
  const bottom = pane.y + pane.height;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

async function holdState(page: Page, state: string): Promise<void> {
  const target = pill(page, state);
  if (state === "hover") {
    await target.hover();
    await page.waitForTimeout(250);
  }
  if (state === "focus") {
    await page.keyboard.press("Shift");
    await target.focus();
    const visible = await target.evaluate((el) => el.matches(":focus-visible"));
    if (!visible) throw new Error("focus: pill did not take :focus-visible");
    await page.waitForTimeout(200);
  }
}

async function releaseState(page: Page, state: string): Promise<void> {
  if (state === "hover") {
    await page.mouse.move(815, 5);
    await page.waitForTimeout(250);
  }
  if (state === "focus") await pill(page, state).blur();
}

test("Terminal scroll pill — states and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SCROLLPILL is required for the scroll-pill capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SCROLLPILL=1 to run the capture");

  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const written: string[] = [];

  for (const theme of FULL_THEMES) {
    await open(page, theme);
    for (const state of [...TERMINAL_STATES, ...SIDEBAR_STATES]) {
      await holdState(page, state);
      written.push(await snapPane(page, state, `${state}-${theme}.png`));
      if (state === "hover" || state === "focus") {
        written.push(await snapZoom(page, state, `${state}-zoom-${theme}.png`));
      }
      await releaseState(page, state);
    }
  }

  for (const theme of ALL_THEMES) {
    await open(page, theme);
    written.push(await snapZoom(page, "rest", `zoom-${theme}.png`));
  }

  // Forced colors drops box-shadow and background colours; the pill's edge has
  // to survive on its border alone.
  await page.emulateMedia({ forcedColors: "active" });
  await open(page, FULL_THEMES[0]!);
  for (const state of ["rest", "sidebar-below"] as const) {
    written.push(await snapPane(page, state, `${state}-forced-colors.png`));
  }
  await page.emulateMedia({ forcedColors: "none" });

  expect(pageErrors, "page threw while rendering").toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[terminal-scroll-pill-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
  await context.close();
});
