/**
 * Assistant panel resize-handle visual-review harness.
 *
 * The handle is a few pixels wide and its design lives in states a pointer or the
 * keyboard puts it in, so this drives `help-panel-resize-preview.html` (the real
 * `HelpPanelResizeHandle` inside an aside carrying the panel's own clipping) with a
 * real mouse and real keys rather than booting Electron.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_ASSISTANTRESIZE=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots assistant-resize-handle-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ASSISTANTRESIZE  required: any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR             an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES           theme sweep (default daintree,bondi,namib,svalbard)
 *
 * Output, per theme: `close-<rest|hover|focus|drag>--<theme>.png`, a crop around the
 * handle. Never writes a PNG it has not verified, and counts the files itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_ASSISTANTRESIZE;
const OUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const STATES = ["rest", "hover", "focus", "drag"] as const;
type State = (typeof STATES)[number];

const SEPARATOR = '[role="separator"]';
const START_WIDTH = 460;
const DEFAULT_WIDTH = 380;
const CLOSE_HALF_WIDTH = 80;
const CLOSE_HEIGHT = 260;
const DRAG_DX = -60;

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
    throw new Error("DESIGN_CAPTURE_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function openScene(page: Page, theme: string): Promise<void> {
  await page.setViewportSize({ width: 940, height: 460 });
  const url = `${server!.baseURL}/help-panel-resize-preview.html?theme=${theme}&width=${START_WIDTH}`;
  const scene = page.locator("[data-preview-scene]");
  try {
    await page.goto(url);
    await expect(scene).toBeAttached({ timeout: 30_000 });
  } catch {
    // The first load of a cold dev server can be reloaded by the dep optimiser.
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(scene).toBeAttached({ timeout: 30_000 });
  }
  await expect(page.locator(SEPARATOR)).toHaveCount(1);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
}

async function handleCentre(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator(SEPARATOR).boundingBox();
  if (!box || box.width < 2) throw new Error("handle has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function valueNow(page: Page): Promise<number> {
  return Number(await page.locator(SEPARATOR).getAttribute("aria-valuenow"));
}

async function enter(page: Page, state: State): Promise<void> {
  const separator = page.locator(SEPARATOR);
  const { x, y } = await handleCentre(page);
  if (state === "hover") {
    // Just inside the panel: the half of the target outside it is clipped by the aside.
    await page.mouse.move(x + 2, y);
    await page.waitForTimeout(600);
    const cursor = await separator.evaluate((el) => getComputedStyle(el).cursor);
    if (cursor !== "col-resize") throw new Error(`hover: cursor is ${cursor}`);
    if (!(await separator.evaluate((el) => el.matches(":hover")))) {
      throw new Error("hover: handle is not hovered — refusing to write");
    }
  } else if (state === "focus") {
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press("Tab");
      if (await separator.evaluate((el) => el === document.activeElement)) break;
    }
    if (!(await separator.evaluate((el) => el.matches(":focus-visible")))) {
      throw new Error("focus: keyboard focus never reached the handle");
    }
    const outline = await separator.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    if (outline.style === "none" || !(outline.width >= 1)) {
      throw new Error(`focus: handle paints no outline (${JSON.stringify(outline)})`);
    }
  } else if (state === "drag") {
    const before = await valueNow(page);
    await page.mouse.move(x + 2, y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(x + 2 + (DRAG_DX * step) / 6, y);
    }
    await page.waitForTimeout(250);
    const after = await valueNow(page);
    if (!(after > before)) throw new Error(`drag: width did not grow (${before} → ${after})`);
  }
}

async function snapClose(page: Page, file: string): Promise<string> {
  const { x, y } = await handleCentre(page);
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

test("assistant resize handle — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ASSISTANTRESIZE is required for the resize-handle capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ASSISTANTRESIZE=1 to run the capture");
  test.setTimeout(300_000);

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      await openScene(page, theme);
      await enter(page, state);
      written.push(await snapClose(page, `close-${state}--${theme}.png`));
      if (state === "drag") await page.mouse.up();
    }
  }

  // Double-click lands back on the default width.
  await openScene(page, THEMES[0]!);
  expect(await valueNow(page)).toBe(START_WIDTH);
  const { x, y } = await handleCentre(page);
  await page.mouse.dblclick(x + 2, y);
  await expect(page.locator(SEPARATOR)).toHaveAttribute("aria-valuenow", String(DEFAULT_WIDTH));

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length);
  console.log(`[assistant-resize-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
