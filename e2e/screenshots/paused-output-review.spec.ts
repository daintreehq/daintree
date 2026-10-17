/**
 * Pane status slot tooltip visual-review harness — held output, a slow submit,
 * and both at once.
 *
 * A backpressure hold lasts only as long as the pane takes to drain, so nobody
 * sees its tooltip on purpose. This drives `paused-output-preview.html`: the
 * real `ContentPanel` per fixture with the flow and submit status passed the
 * way `TerminalPane` passes them, and the held-duration gauge seeded into the
 * real panel store.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_PAUSED_OUTPUT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots paused-output-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PAUSED_OUTPUT  required — enables the capture
 *   DAINTREE_SHOT_DIR            required — absolute output dir outside the repo. No
 *                                default: an in-repo fallback puts PNGs into a tree.
 *   DAINTREE_SHOT_THEMES         themes that get the full state set (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE    device scale factor (default 2)
 *
 * Output: tip--<state>--<theme>.png (header plus open tooltip), focus--paused--<theme>.png
 * (the keyboard-opened tooltip with its ring), and sweep--paused--<theme>.png for every
 * built-in theme.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";
import {
  FIXTURES,
  FIXTURE_NAMES,
  type FixtureName,
} from "../../src/components/Terminal/__preview__/pausedOutputFixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_PAUSED_OUTPUT;
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

/** What the formatted gauge reads for each fixture that has one. */
const EXPECTED_DURATION: Partial<Record<FixtureName, string>> = {
  paused: "12s",
  "paused-long": "1h 2m",
  "paused-sending": "12s",
};

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute path");
  }
  const repoRoot = realpathSync(process.cwd());
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

function glyph(page: Page, name: FixtureName) {
  return page.locator(`[data-shot="${name}"] [data-pane-chrome] [role="status"]`).first();
}

function header(page: Page, name: FixtureName) {
  return page.locator(`[data-shot="${name}"] [data-pane-chrome]`).first();
}

function tooltip(page: Page) {
  return page.locator("[data-radix-popper-content-wrapper]").first();
}

async function open(page: Page, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 560, height: 1200 });
  await page.goto(`${server!.baseURL}/paused-output-preview.html?theme=${theme}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  for (const name of FIXTURE_NAMES) {
    await expect(glyph(page, name), `${name}: no status glyph rendered`).toBeVisible();
  }
  await page.mouse.move(555, 1195);
  await page.waitForTimeout(250);
}

/** Proves the tooltip on screen is this fixture's before writing anything. */
async function proveTooltip(page: Page, name: FixtureName): Promise<void> {
  const tip = tooltip(page);
  await expect(tip, `${name}: tooltip never opened`).toBeVisible({ timeout: 3_000 });
  const f = FIXTURES[name];
  const duration = EXPECTED_DURATION[name];
  if (duration) await expect(tip, `${name}: no held duration`).toContainText(duration);
  else await expect(tip, `${name}: a duration rendered with no gauge`).not.toContainText(/\d+s\b/);
  if ("submitStatus" in f) await expect(tip, `${name}: no sending section`).toContainText(/send/i);
  else
    await expect(tip, `${name}: a sending section with no slow submit`).not.toContainText(/send/i);
  // Settle the 150ms entry motion before the frame is taken.
  await page.waitForTimeout(250);
}

async function snapTooltip(page: Page, name: FixtureName, file: string): Promise<string> {
  await proveTooltip(page, name);
  const h = await header(page, name).boundingBox();
  const t = await tooltip(page).boundingBox();
  if (!h || !t || t.width < 40 || t.height < 16) {
    throw new Error(`${name}: tooltip has no real box (${JSON.stringify(t)}) — refusing to write`);
  }
  const x = Math.min(h.x, t.x) - 8;
  const right = Math.max(h.x + h.width, t.x + t.width) + 8;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: { x, y: h.y - 8, width: right - x, height: t.y + t.height - h.y + 20 },
  });
  return out;
}

async function dismissTooltip(page: Page): Promise<void> {
  await page.mouse.move(555, 1195);
  await page.keyboard.press("Escape");
  await expect(tooltip(page), "tooltip stayed open into the next capture").toBeHidden();
  await page.waitForTimeout(200);
}

test("Pane status slot tooltip — states and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PAUSED_OUTPUT is required for the paused-output capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PAUSED_OUTPUT=1 to run the capture");

  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
  const written: string[] = [];

  for (const theme of FULL_THEMES) {
    await open(page, theme);
    for (const name of FIXTURE_NAMES) {
      await glyph(page, name).hover();
      written.push(await snapTooltip(page, name, `tip--${name}--${theme}.png`));
      await dismissTooltip(page);
    }

    const target = glyph(page, "paused");
    await page.keyboard.press("Shift");
    await target.focus();
    const ringed = await target.evaluate((el) => el.matches(":focus-visible"));
    if (!ringed) throw new Error("paused: glyph did not take :focus-visible — refusing to write");
    written.push(await snapTooltip(page, "paused", `focus--paused--${theme}.png`));
    await target.blur();
    await dismissTooltip(page);
  }

  for (const theme of ALL_THEMES) {
    await open(page, theme);
    await glyph(page, "paused").hover();
    written.push(await snapTooltip(page, "paused", `sweep--paused--${theme}.png`));
    await dismissTooltip(page);
  }

  await context.close();

  expect(pageErrors, "the preview threw").toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  const expected = FULL_THEMES.length * (FIXTURE_NAMES.length + 1) + ALL_THEMES.length;
  expect(written).toHaveLength(expected);
  expect(onDisk.sort()).toEqual(written.map((f) => path.basename(f)).sort());
});
