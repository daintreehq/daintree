/**
 * Terminal resource badge visual-review harness.
 *
 * The badge — CPU sparkline plus "12% · 180M" at the telemetry end of every pane
 * header — only appears with monitoring switched on, and its colour is decided by
 * a hysteresis that needs several consecutive polls over a threshold. Nobody sees
 * the amber or red band on purpose. This drives `terminal-resource-preview.html`:
 * the real `ContentPanel` per fixture, with each fixture's samples replayed through
 * the real resource store, so the header earns its severity the way it does live.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_RESOURCE=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots terminal-resource-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RESOURCE     required — enables the capture
 *   DAINTREE_SHOT_DIR          required — absolute output dir outside the repo. No
 *                              default: an in-repo fallback puts PNGs into a tree.
 *   DAINTREE_SHOT_THEMES       themes that get the full state set (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 3 — the line is 1.5px)
 *
 * Output: <state>--<theme>.png (the pane header), zoom--<state>--<theme>.png (the
 * badge alone), tooltip--<theme>.png, sheet--<theme>.png, sweep--<theme>.png for
 * every built-in theme, and forced-colors--<state>.png.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";
import {
  FIXTURE_NAMES,
  TOOLTIP_FIXTURE,
  type FixtureName,
} from "../../src/components/Terminal/__preview__/resourceBadgeFixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_RESOURCE;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const SCALE = Number(process.env.DAINTREE_SCREENSHOT_SCALE ?? "3");
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

/**
 * The band each fixture has to have earned by the end of its replay. A capture
 * whose badge is still muted after a sustained 380% is a replay that never ran,
 * and the picture would be of a state that does not exist.
 */
const EXPECTED_SEVERITY: Partial<Record<FixtureName, "muted" | "amber" | "red">> = {
  idle: "muted",
  working: "muted",
  warm: "amber",
  hot: "red",
  "memory-heavy": "red",
  cooled: "muted",
  "just-started": "muted",
};

/** Header crop: the pane's own chrome, plus a sliver of body so its edge reads. */
const HEADER_BODY_SLIVER = 10;
const ZOOM_MARGIN = 14;

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

function badge(page: Page, name: FixtureName) {
  return page.locator(`[data-shot="${name}"] [data-testid="terminal-resource-badge"]`);
}

function header(page: Page, name: FixtureName) {
  return page.locator(`[data-shot="${name}"] [data-pane-chrome]`).first();
}

async function open(page: Page, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 640, height: 1400 });
  await page.goto(`${server!.baseURL}/terminal-resource-preview.html?theme=${theme}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await expect(page.locator('[data-preview-shell][data-replayed="true"]')).toBeAttached({
    timeout: 15_000,
  });
  await page.evaluate(() => document.fonts.ready);
  for (const name of FIXTURE_NAMES) {
    await expect(badge(page, name), `${name}: no resource badge rendered`).toBeAttached();
    await expect(
      badge(page, name).locator("svg polyline, svg path").first(),
      `${name}: badge has no sparkline`
    ).toBeAttached();
    const expected = EXPECTED_SEVERITY[name];
    if (expected) {
      await expect(badge(page, name), `${name}: severity never settled`).toHaveAttribute(
        "data-severity",
        expected
      );
    }
  }
  // Park the pointer outside every pane so no header is in its hover state.
  await page.mouse.move(635, 1395);
  await page.waitForTimeout(250);
}

async function snapHeader(page: Page, name: FixtureName, file: string): Promise<string> {
  const box = await header(page, name).boundingBox();
  if (!box || box.width < 200 || box.height < 16) {
    throw new Error(`${name}: header has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: box.x - 8,
      y: box.y - 8,
      width: box.width + 16,
      height: box.height + 8 + HEADER_BODY_SLIVER,
    },
  });
  return out;
}

async function snapZoom(page: Page, name: FixtureName, file: string): Promise<string> {
  const b = await badge(page, name).boundingBox();
  const h = await header(page, name).boundingBox();
  if (!b || !h || b.width < 24 || b.height < 8) {
    throw new Error(`${name}: badge has no real box (${JSON.stringify(b)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  const x = b.x - ZOOM_MARGIN;
  await page.screenshot({
    path: out,
    clip: { x, y: h.y, width: b.width + ZOOM_MARGIN * 2, height: h.height },
  });
  return out;
}

test("Terminal resource badge — states and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RESOURCE is required for the resource-badge capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_RESOURCE=1 to run the capture");

  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const written: string[] = [];

  for (const theme of FULL_THEMES) {
    await open(page, theme);
    for (const name of FIXTURE_NAMES) {
      written.push(await snapHeader(page, name, `${name}--${theme}.png`));
      // A pane too narrow to hold the badge clips it by design; the header crop
      // is the picture there, and a zoom of a clipped box would be of nothing.
      const b = await badge(page, name).boundingBox();
      const region = await page
        .locator(`[data-shot="${name}"] [data-testid="panel-header-content"]`)
        .boundingBox();
      const fullyShown = !!b && !!region && b.x + b.width <= region.x + region.width + 0.5;
      if (fullyShown) written.push(await snapZoom(page, name, `zoom--${name}--${theme}.png`));
    }

    // The per-process breakdown, opened by a real pointer.
    await badge(page, TOOLTIP_FIXTURE).hover();
    const tip = page.locator("[data-radix-popper-content-wrapper]").first();
    await expect(tip, "tooltip never opened").toBeVisible({ timeout: 3_000 });
    await expect(tip).toContainText(/cargo/);
    await page.waitForTimeout(250);
    {
      const h = (await header(page, TOOLTIP_FIXTURE).boundingBox())!;
      const t = (await tip.boundingBox())!;
      const x = Math.min(h.x, t.x) - 8;
      const right = Math.max(h.x + h.width, t.x + t.width) + 8;
      const out = path.join(OUT_DIR, `tooltip--${theme}.png`);
      await page.screenshot({
        path: out,
        clip: { x, y: h.y - 8, width: right - x, height: t.y + t.height - h.y + 16 },
      });
      written.push(out);
    }
    await page.mouse.move(635, 1395);
    await page.keyboard.press("Escape");
    await expect(tip, "tooltip stayed open into the contact sheet").toBeHidden();
    await page.waitForTimeout(200);

    const shell = page.locator("[data-preview-shell]");
    const out = path.join(OUT_DIR, `sheet--${theme}.png`);
    await shell.screenshot({ path: out });
    written.push(out);
  }

  // Every theme: the three bands side by side, which is where a status colour
  // collapses into the header on one palette and not another.
  for (const theme of ALL_THEMES) {
    await open(page, theme);
    const first = (await header(page, "idle").boundingBox())!;
    const last = (await header(page, "memory-heavy").boundingBox())!;
    const out = path.join(OUT_DIR, `sweep--${theme}.png`);
    await page.screenshot({
      path: out,
      clip: {
        x: first.x + first.width - 360,
        y: first.y - 4,
        width: 368,
        height: last.y + last.height - first.y + 8,
      },
    });
    written.push(out);
  }

  // Forced colours swaps every token for a system colour; the band has to survive
  // on something other than hue.
  await page.emulateMedia({ forcedColors: "active" });
  await open(page, FULL_THEMES[0]!);
  for (const name of ["idle", "warm", "hot"] as const) {
    written.push(await snapZoom(page, name, `forced-colors--${name}.png`));
  }
  await page.emulateMedia({ forcedColors: "none" });

  expect(pageErrors, "page threw while rendering").toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[terminal-resource-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
  await context.close();
});
