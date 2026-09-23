/**
 * Project pill visual-review harness.
 *
 * The titlebar's workspace switcher trigger (`ToolbarProjectPill`) is on screen
 * in every window all day, and most of its states — a branch that has not bound
 * yet, a folder without git, a scratch workspace, nothing open, a long name that
 * has to give way to a long branch — are ones nobody looks at on purpose. This
 * captures each of them, tightly cropped with a margin of the toolbar around it,
 * and sweeps the resting state through every built-in theme into one sheet.
 *
 * Served by Vite from `project-pill-preview.html`, not Electron: the pill is a
 * presentational component, and every state is derived through the same
 * resolvers the toolbar calls.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_PILL=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots project-pill-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PILL     required — enables the capture
 *   DAINTREE_SHOT_DIR      required — absolute output dir. No default: an in-repo
 *                          fallback would put PNGs into someone's tree.
 *   DAINTREE_SHOT_THEMES   themes that get the full state set (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 3 — the pill is small)
 *
 * Output: <dir>/<state>-<theme>.png, <dir>/theme-sweep.png
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PILL;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const SCALE = Number(process.env.DAINTREE_SCREENSHOT_SCALE ?? "3");

const FULL_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Every built-in theme, for the resting-state sweep. */
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
const STATES = [
  "rest",
  "feature-branch",
  "long-branch",
  "long-name",
  "long-both",
  "branch-pending",
  "detached",
  "no-git",
  "scratch",
  "none",
  "hover",
  "open",
  "focus",
  "tooltip",
  "narrow",
] as const;

/** Horizontal margin of toolbar kept either side of the pill in each crop. */
const MARGIN_X = 90;

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
  await page.setViewportSize({ width: 1180, height: 1700 });
  await page.goto(`${server!.baseURL}/project-pill-preview.html?theme=${theme}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1170, 5);
  await page.waitForTimeout(200);
}

/** Crop one state's row: the strip's full height, the pill plus a margin of toolbar. */
async function snapState(page: Page, state: string, file: string): Promise<string> {
  const row = page.locator(`[data-shot="${state}"]`);
  const strip = row.locator("[data-preview-strip]");
  const pill = row.locator('[data-testid="project-switcher-trigger"]');
  await expect(pill, `${state}: pill not rendered`).toBeVisible();
  const s = await strip.boundingBox();
  const p = await pill.boundingBox();
  if (!s || !p || p.width < 16 || p.height < 16) {
    throw new Error(`${state}: no real box (${JSON.stringify({ s, p })}) — refusing to write`);
  }
  let x = Math.max(s.x, p.x - MARGIN_X);
  let right = Math.min(s.x + s.width, p.x + p.width + MARGIN_X);
  let bottom = s.y + s.height;
  if (state === "tooltip") {
    // Portaled to the body, so it is measured on its own and folded into the crop.
    const tip = await page.locator("[data-radix-popper-content-wrapper]").first().boundingBox();
    if (!tip) throw new Error("tooltip: content not rendered — refusing to write");
    x = Math.min(x, tip.x - 12);
    right = Math.max(right, tip.x + tip.width + 12);
    bottom = Math.max(bottom, tip.y + tip.height + 12);
  }
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y: s.y, width: right - x, height: bottom - s.y } });
  return out;
}

test("Project pill — states and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PILL is required for the project-pill capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PILL=1 to run the capture");

  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const written: string[] = [];

  for (const theme of FULL_THEMES) {
    await open(page, theme);
    for (const state of STATES) {
      const pill = page.locator(`[data-shot="${state}"] [data-testid="project-switcher-trigger"]`);
      if (state === "hover") {
        await pill.hover();
        await page.waitForTimeout(250);
      }
      if (state === "focus") {
        await pill.focus();
        const visible = await pill.evaluate((el) => el.matches(":focus-visible"));
        if (!visible) throw new Error("focus: pill did not take :focus-visible");
        await page.waitForTimeout(200);
      }
      written.push(await snapState(page, state, `${state}-${theme}.png`));
      if (state === "hover") {
        await page.mouse.move(1170, 5);
        await page.waitForTimeout(250);
      }
      if (state === "focus") {
        await pill.blur();
      }
    }
  }

  // The resting state in every theme, composed into one sheet so theme-specific
  // collapse is visible at a glance.
  const sweepDir = path.join(OUT_DIR, ".sweep");
  mkdirSync(sweepDir, { recursive: true });
  const sweep: { theme: string; file: string }[] = [];
  for (const theme of ALL_THEMES) {
    await open(page, theme);
    const file = path.join(sweepDir, `${theme}.png`);
    await page
      .locator('[data-shot="feature-branch"] [data-preview-strip]')
      .screenshot({ path: file });
    sweep.push({ theme, file });
  }
  const sheet = await context.newPage();
  await sheet.setViewportSize({ width: 1180, height: 400 });
  const rows = sweep
    .map(
      ({ theme, file }) =>
        `<div style="display:flex;align-items:center;gap:12px"><code style="width:110px;font:12px monospace;color:#999">${theme}</code><img src="data:image/png;base64,${readFileSync(file).toString("base64")}" style="width:1100px;display:block"/></div>`
    )
    .join("");
  await sheet.setContent(
    `<body style="margin:0;background:#777;padding:8px"><div id="sheet" style="display:flex;flex-direction:column;gap:6px;width:1236px">${rows}</div></body>`
  );
  const sweepOut = path.join(OUT_DIR, "theme-sweep.png");
  await sheet.locator("#sheet").screenshot({ path: sweepOut });
  written.push(sweepOut);
  rmSync(sweepDir, { recursive: true, force: true });

  await context.close();
  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(FULL_THEMES.length * STATES.length + 1);
  console.log(`[project-pill-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
