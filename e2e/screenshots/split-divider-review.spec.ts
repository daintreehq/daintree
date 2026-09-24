/**
 * Two-pane split divider visual-review harness.
 *
 * The divider is six pixels wide and most of what decides its design is a state
 * the pointer or the keyboard puts it in: resting between two busy panes, under
 * the pointer, focused from the keyboard, mid-drag. None of those can be asked of
 * a fixture, so this drives the panel header's preview entry at a split scene —
 * the real `TwoPaneSplitDivider` between two real `ContentPanel` frames, in the
 * track layout `ContentGridDefault` uses in split mode — and puts it in each state
 * with a real mouse and real keys.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_SPLIT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots split-divider-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SPLIT   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR     required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES  theme sweep (default daintree,bondi,namib,svalbard — two dark, two light)
 *
 * Output, per theme:
 *   scene-<scene>--<theme>.png         each split scene at rest
 *   close-<state>--<theme>.png         a crop around the divider: rest, hover, focus, drag
 *   scene-split-agent-browser--<theme>--drag.png   the whole scene mid-drag
 *   scene-split-agent-browser--<theme>--menu.png   the divider's context menu open
 * and once:
 *   close-focus--<theme>--forced-colors.png  keyboard focus under forced colours
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";
import { GRID_SCENES, type GridSceneName } from "../../src/components/Panel/__preview__/gridScenes";

const ENABLED = !!process.env.DAINTREE_SHOT_SPLIT;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const SCENES = ["split-agent-browser", "split-two-agents"] as const satisfies GridSceneName[];
const CLOSE_STATES = ["rest", "hover", "focus", "drag"] as const;
type CloseState = (typeof CLOSE_STATES)[number];

const SEPARATOR = '[role="separator"]';
const HEADER = "[data-pane-chrome]";
/** Half-width of the close-up around the divider, and its height. */
const CLOSE_HALF_WIDTH = 90;
const CLOSE_HEIGHT = 300;
const DRAG_DX = 120;

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

// 2x: the grip is a one-pixel line, and at 1x the details this exists to judge round away.
test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function openScene(page: Page, name: GridSceneName, theme: string): Promise<Locator> {
  const def = GRID_SCENES[name];
  await page.setViewportSize({ width: def.width + 40, height: def.height + 40 });
  const url = `${server!.baseURL}/panel-header-preview.html?theme=${theme}&scene=${name}`;
  const grid = page.locator(`[data-preview-grid="${name}"]`);
  try {
    await page.goto(url);
    await expect(grid).toBeAttached({ timeout: 30_000 });
  } catch {
    // The first load of a cold dev server can be reloaded by the dep optimiser.
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(grid).toBeAttached({ timeout: 30_000 });
  }
  const headers = grid.locator(HEADER);
  await expect(headers).toHaveCount(def.panes.length, { timeout: 10_000 });
  await expect(headers.first()).toHaveCSS("display", "flex");
  const separator = grid.locator(SEPARATOR);
  await expect(separator).toHaveCount(1);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  // The divider must sit between the two panes, not collapsed into one of them.
  const [a, s, b] = await Promise.all([
    headers.nth(0).boundingBox(),
    separator.boundingBox(),
    headers.nth(1).boundingBox(),
  ]);
  if (!a || !s || !b || s.width < 2 || s.x < a.x + a.width - 1 || s.x + s.width > b.x + 1) {
    throw new Error(`${name}/${theme}: divider is not between the panes — refusing to write`);
  }
  return grid;
}

async function separatorCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator(SEPARATOR).boundingBox();
  if (!box) throw new Error("divider has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function snapScene(grid: Locator, file: string): Promise<string> {
  const box = await grid.boundingBox();
  if (!box || box.width < 100 || box.height < 100) throw new Error(`${file}: no grid box`);
  const out = path.join(OUT_DIR, file);
  await grid.screenshot({ path: out });
  return out;
}

async function snapClose(page: Page, file: string): Promise<string> {
  const { x, y } = await separatorCentre(page);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: x - CLOSE_HALF_WIDTH,
      y: y - CLOSE_HEIGHT / 2,
      width: CLOSE_HALF_WIDTH * 2,
      height: CLOSE_HEIGHT,
    },
  });
  return out;
}

async function valueNow(page: Page): Promise<number> {
  return Number(await page.locator(SEPARATOR).getAttribute("aria-valuenow"));
}

/** Put the divider into `state`, proving it got there. Leaves a drag held. */
async function enter(page: Page, state: CloseState): Promise<void> {
  const separator = page.locator(SEPARATOR);
  const { x, y } = await separatorCentre(page);
  if (state === "hover") {
    await page.mouse.move(x, y);
    await page.waitForTimeout(600);
    const cursor = await separator.evaluate((el) => getComputedStyle(el).cursor);
    if (cursor !== "col-resize") throw new Error(`hover: cursor is ${cursor}`);
    const hovered = await separator.evaluate((el) => el.matches(":hover"));
    if (!hovered) throw new Error("hover: divider is not hovered — refusing to write");
  } else if (state === "focus") {
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      if (await separator.evaluate((el) => el === document.activeElement)) break;
    }
    const focused = await separator.evaluate((el) => el.matches(":focus-visible"));
    if (!focused) throw new Error("focus: keyboard focus never reached the divider");
    // A focus state with no painted indicator is exactly the defect worth catching,
    // so it fails the run instead of producing a plausible picture.
    const outline = await separator.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    if (outline.style === "none" || !(outline.width >= 1)) {
      throw new Error(`focus: divider paints no outline (${JSON.stringify(outline)})`);
    }
    await page.waitForTimeout(200);
  } else if (state === "drag") {
    const before = await valueNow(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(x + (DRAG_DX * step) / 6, y);
    }
    await page.waitForTimeout(250);
    const after = await valueNow(page);
    if (!(after > before)) throw new Error(`drag: ratio did not move (${before} → ${after})`);
  }
}

test("two-pane split divider — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SPLIT is required for the split-divider capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SPLIT=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const scene of SCENES) {
      const grid = await openScene(page, scene, theme);
      written.push(await snapScene(grid, `scene-${scene}--${theme}.png`));
    }
    {
      // The click-only path: the divider's own context menu.
      const grid = await openScene(page, "split-agent-browser", theme);
      const { x, y } = await separatorCentre(page);
      await page.mouse.click(x, y, { button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible({ timeout: 10_000 });
      await expect(menu.getByRole("menuitem")).toHaveCount(4);
      await page.waitForTimeout(200);
      written.push(await snapScene(grid, `scene-split-agent-browser--${theme}--menu.png`));
      await page.keyboard.press("Escape");
    }
    for (const state of CLOSE_STATES) {
      const grid = await openScene(page, "split-agent-browser", theme);
      await enter(page, state);
      written.push(await snapClose(page, `close-${state}--${theme}.png`));
      if (state === "drag") {
        written.push(await snapScene(grid, `scene-split-agent-browser--${theme}--drag.png`));
        await page.mouse.up();
      }
    }
  }

  {
    const theme = THEMES[0]!;
    await page.emulateMedia({ forcedColors: "active" });
    await openScene(page, "split-agent-browser", theme);
    await enter(page, "focus");
    written.push(await snapClose(page, `close-focus--${theme}--forced-colors.png`));
    await page.emulateMedia({ forcedColors: "none" });
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * (SCENES.length + CLOSE_STATES.length + 2) + 1);
  console.log(`[split-divider-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
