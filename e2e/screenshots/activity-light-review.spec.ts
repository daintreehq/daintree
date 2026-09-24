/**
 * Activity light + agent-state indicator visual-review harness.
 *
 * The activity light's meaning is its age — solid for five minutes, a fade over
 * the next five, then a hollow ring — and a live session only ever shows the one
 * point on that curve the worktree happens to be at. This drives the preview
 * entry (`activity-light-preview.html`), which mounts the REAL `ActivityLight`,
 * `WorktreeActivityChip` and `AgentStatusIndicator` at fixed ages and states
 * against the real theme tokens and `index.css`.
 *
 *   DAINTREE_SHOT_ACTIVITY_LIGHT=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots activity-light-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ACTIVITY_LIGHT  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR            output dir (default artifacts/activity-light-shots)
 *   DAINTREE_SHOT_THEMES          comma-separated themes (default daintree,namib,svalbard,atacama)
 *
 * Never writes a PNG it has not verified: every frame asserts its target has a
 * real box and the state it claims to show, and the test counts the files itself
 * at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_ACTIVITY_LIGHT;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "activity-light-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,namib,svalbard,atacama")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const SECTIONS = ["rows", "dots", "pips", "badges"] as const;

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string): Promise<Locator> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 900, height: 900 });
  const url = `${baseURL}/activity-light-preview.html?theme=${theme}`;
  const shell = page.locator("[data-preview-shell]");
  // The first load after a dependency change can answer 504 "Outdated Optimize
  // Dep" while Vite re-optimises; one reload after it settles is enough.
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(shell).toBeAttached({ timeout: attempt === 0 ? 15_000 : 30_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`theme "${theme}" rendered no shell`, { cause: error });
    }
  }
  await page.addStyleTag({ content: POLISH_CSS });
  await page.evaluate(() => document.fonts.ready);
  // Every age renders a chip; a missing one means the fixture timestamps were
  // rejected and the frame would show an empty column.
  await expect(shell.locator('[data-shot="rows"] [aria-label="Last activity"]')).toHaveCount(7);
  await expect(shell.locator('[data-activity-active="true"]').first()).toBeVisible();
  await expect(shell.locator('[data-activity-active="false"]').first()).toBeVisible();
  return shell;
}

async function snap(page: Page, target: Locator, file: string, extra?: Locator): Promise<string> {
  const a = await target.boundingBox();
  if (!a || a.width < 8 || a.height < 8) throw new Error(`${file}: target has no real box`);
  let box = a;
  if (extra) {
    const b = await extra.boundingBox();
    if (!b || b.width < 8 || b.height < 8) throw new Error(`${file}: overlay has no real box`);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    box = {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
  }
  const pad = 8;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  return out;
}

test("Activity light — ages, pips and themes", async ({ page, browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ACTIVITY_LIGHT is required for the activity light capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ACTIVITY_LIGHT=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  let expected = 0;

  for (const [i, theme] of THEMES.entries()) {
    const shell = await open(page, theme);
    expected++;
    written.push(await snap(page, shell, `board-${theme}.png`));
    for (const section of SECTIONS) {
      expected++;
      written.push(
        await snap(page, shell.locator(`[data-shot="${section}"]`), `${section}-${theme}.png`)
      );
    }

    // The hover card carries the third host of the light ("Last active" footer).
    if (i < 2) {
      expected++;
      const chip = shell.locator('[data-age="fade-mid"] [aria-label="Last activity"]');
      await chip.hover();
      const card = page.locator('[role="tooltip"], [data-radix-popper-content-wrapper]').last();
      await expect(page.getByText(/Last active/).last()).toBeVisible({ timeout: 5_000 });
      written.push(await snap(page, chip, `hover-fade-mid-${theme}.png`, card));
      await page.mouse.move(0, 0);
    }
  }

  // Windows high contrast: backgrounds are forced to Canvas, so the solid dot
  // and the pips survive only through the forced-colors rules in index.css.
  const forcedContext = await browser.newContext({
    deviceScaleFactor: 2,
    forcedColors: "active",
    colorScheme: "dark",
  });
  const forced = await forcedContext.newPage();
  forced.on("pageerror", (e) => pageErrors.push(e.message));
  const forcedShell = await open(forced, THEMES[0] ?? "daintree");
  expected++;
  written.push(await snap(forced, forcedShell, `board-forced-colors.png`));
  await forcedContext.close();

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  const missing = written.filter((f) => !onDisk.includes(path.basename(f)));
  expect(pageErrors, "page errors during capture").toEqual([]);
  expect(missing, "frames reported written but absent").toEqual([]);
  expect(onDisk.length, "png count").toBe(expected);
});
