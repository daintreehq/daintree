/**
 * Panel grid scrollbar visual-review harness.
 *
 * Drives `grid-scrollbar-preview.html`: the real `GridScrollbar` beside a grid
 * laid out like `#panel-grid` in scroll mode, full of panes holding real
 * xterms, so the bar is judged against the pane scrollbars it sits next to.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_GRIDSCROLLBAR=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots grid-scrollbar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_GRIDSCROLLBAR  required — enables the capture
 *   DAINTREE_SHOT_DIR            required — absolute output dir. No default: an
 *                                in-repo fallback would put PNGs into someone's tree.
 *   DAINTREE_SHOT_THEMES         themes that get the full state set (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE    device scale factor (default 2)
 *
 * Output: <dir>/<state>-<theme>.png, <dir>/<state>-zoom-<theme>.png for the
 * pointer states, <dir>/zoom-<theme>.png (every built-in theme),
 * <dir>/<state>-forced-colors.png
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_GRIDSCROLLBAR;
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

/** Mirrors `FIXTURES` in the preview entry, which runs under Vite aliases this loader lacks. */
const FIXTURES = [
  "top",
  "middle",
  "bottom",
  "hover",
  "drag",
  "track-hover",
  "barely",
  "fleet",
  "single-column",
  "fit",
] as const;
type Fixture = (typeof FIXTURES)[number];

/** Width of the right-edge strip kept in a zoom crop: the gutter plus the pane scrollbar beside it. */
const ZOOM_WIDTH = 150;

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

const thumb = (page: Page) => page.locator('[data-preview-frame] [role="scrollbar"]');
const frame = (page: Page) => page.locator("[data-preview-frame]");

async function open(page: Page, theme: string, fixture: Fixture): Promise<void> {
  await page.goto(
    `${server!.baseURL}/grid-scrollbar-preview.html?theme=${theme}&fixture=${fixture}`
  );
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  const panes = page.locator("[data-xterm-host]");
  const count = await panes.count();
  if (count === 0) throw new Error(`${fixture}: no panes rendered`);
  await expect(page.locator('[data-xterm-host][data-ready="true"]')).toHaveCount(count, {
    timeout: 20_000,
  });

  const scroll = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-preview-shell]")!;
    const grid = document.querySelector<HTMLElement>("[data-preview-grid]")!;
    const fraction = Number(shell.dataset.fixtureScroll ?? "0");
    const max = grid.scrollHeight - grid.clientHeight;
    grid.scrollTop = Math.round(max * fraction);
    return { max, top: grid.scrollTop };
  });

  if (fixture === "fit") {
    await page.waitForTimeout(150);
    await expect(thumb(page), "fit: a bar rendered for a grid that does not scroll").toHaveCount(0);
  } else {
    if (scroll.max <= 1) throw new Error(`${fixture}: grid does not overflow (${scroll.max})`);
    await expect(thumb(page), `${fixture}: no thumb rendered`).toBeVisible();
    // The thumb position is written in a rAF after the scroll event.
    await page.waitForTimeout(150);
    await verifyThumbPosition(page, fixture, scroll);
  }
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
}

/** The thumb must sit where the scroll position says, or the frame is a lie. */
async function verifyThumbPosition(
  page: Page,
  fixture: string,
  scroll: { max: number; top: number }
): Promise<void> {
  const geo = await thumb(page).evaluate((el) => {
    const track = el.parentElement!.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    return { trackTop: track.top, trackBottom: track.bottom, top: t.top, bottom: t.bottom };
  });
  const travel = geo.trackBottom - geo.trackTop - (geo.bottom - geo.top);
  const expected = geo.trackTop + (scroll.top / scroll.max) * travel;
  if (Math.abs(geo.top - expected) > 2) {
    throw new Error(
      `${fixture}: thumb at ${geo.top}, expected ${expected} for scrollTop ${scroll.top}/${scroll.max}`
    );
  }
}

async function snapFrame(page: Page, file: string): Promise<string> {
  const box = await frame(page).boundingBox();
  if (!box || box.width < 200 || box.height < 200) {
    throw new Error(`${file}: frame has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await frame(page).screenshot({ path: out });
  return out;
}

async function snapZoom(page: Page, file: string): Promise<string> {
  const box = await frame(page).boundingBox();
  if (!box) throw new Error(`${file}: no frame box — refusing to write`);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: { x: box.x + box.width - ZOOM_WIDTH, y: box.y, width: ZOOM_WIDTH, height: box.height },
  });
  return out;
}

async function thumbCenter(page: Page): Promise<{ x: number; y: number }> {
  const b = await thumb(page).boundingBox();
  if (!b || b.height < 8) throw new Error(`no real thumb box (${JSON.stringify(b)})`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function holdState(page: Page, fixture: Fixture): Promise<void> {
  if (fixture === "hover") {
    const c = await thumbCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(250);
  }
  if (fixture === "drag") {
    const c = await thumbCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x, c.y + 30, { steps: 4 });
    await page.waitForTimeout(250);
  }
  if (fixture === "track-hover") {
    const t = await thumb(page).boundingBox();
    const f = await frame(page).boundingBox();
    if (!t || !f) throw new Error("track-hover: no thumb/frame box");
    // Empty track below the thumb.
    await page.mouse.move(t.x + t.width / 2, Math.min(f.y + f.height - 30, t.y + t.height + 60));
    await page.waitForTimeout(250);
  }
}

async function releaseState(page: Page, fixture: Fixture): Promise<void> {
  if (fixture === "drag") await page.mouse.up();
  await page.mouse.move(2, 2);
}

test("Grid scrollbar — states and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_GRIDSCROLLBAR is required for the grid scrollbar capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_GRIDSCROLLBAR=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const page = await context.newPage();
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1340, height: 740 });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const written: string[] = [];

  for (const theme of FULL_THEMES) {
    for (const fixture of FIXTURES) {
      await open(page, theme, fixture);
      await holdState(page, fixture);
      written.push(await snapFrame(page, `${fixture}-${theme}.png`));
      if (fixture === "hover" || fixture === "drag" || fixture === "track-hover") {
        written.push(await snapZoom(page, `${fixture}-zoom-${theme}.png`));
      }
      await releaseState(page, fixture);
    }
  }

  for (const theme of ALL_THEMES) {
    await open(page, theme, "middle");
    written.push(await snapZoom(page, `zoom-${theme}.png`));
  }

  // Forced colors replaces background colours; the thumb has to survive it.
  await page.emulateMedia({ forcedColors: "active" });
  for (const fixture of ["middle", "hover"] as const) {
    await open(page, FULL_THEMES[0]!, fixture);
    await holdState(page, fixture);
    written.push(await snapFrame(page, `${fixture}-forced-colors.png`));
    written.push(await snapZoom(page, `${fixture}-zoom-forced-colors.png`));
    await releaseState(page, fixture);
  }
  await page.emulateMedia({ forcedColors: "none" });

  expect(pageErrors, "page threw while rendering").toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[grid-scrollbar-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
  await context.close();
});
