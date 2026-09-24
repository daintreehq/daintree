/**
 * Dev preview destructive-confirm visual-review harness.
 *
 * "Restart and clear cache" and "Reinstall dependencies" open one dialog whose
 * body is a preview of what gets deleted, filled by two bridge reads that land at
 * different times: directory metadata first, then a size walk that can take
 * seconds on a large node_modules. This drives the preview entry
 * (`dev-preview-destructive-preview.html`), which answers both reads from a
 * fixture — resolved, hanging, or rejected — so every loading and failure state
 * is on screen without a project on disk.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_DEVPREVIEW_CONFIRM is set.
 *
 *   DAINTREE_SHOT_DEVPREVIEW_CONFIRM=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots dev-preview-destructive-confirm-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DEVPREVIEW_CONFIRM  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR                 required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES              themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP               "0" skips the all-themes sweep of cache-populated
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  DESTRUCTIVE_FIXTURES,
  DESTRUCTIVE_FIXTURE_NAMES,
  type DestructiveConfirmFixture,
  type DestructiveFixtureName,
} from "../../src/components/DevPreview/__preview__/destructiveConfirmFixtures";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DEVPREVIEW_CONFIRM;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

/** The dialog card inside the scrim. */
const CARD = '[role="dialog"] > [tabindex="-1"], [role="alertdialog"] > [tabindex="-1"]';
const PAD = 24;

// Skeletons pulse from opacity 0 behind a gate; with animations frozen they would
// photograph as nothing, so pin them at their visible resting state.
const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  .animate-pulse-delayed, .animate-pulse-immediate { animation: none !important; opacity: 1 !important; }
`;

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

async function open(page: Page, name: DestructiveFixtureName, theme: string): Promise<void> {
  await page.setViewportSize({ width: 760, height: 820 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[destructive-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/dev-preview-destructive-preview.html?theme=${theme}&fixture=${name}`;
  const card = page.locator(CARD).first();
  try {
    await page.goto(url);
    await expect(card).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(card).toBeVisible({ timeout: 30_000 });
  }
  // A Tailwind utility on the card proves the stylesheet landed, not just markup.
  await expect(card).toHaveCSS("border-top-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  // Past the 200ms skeleton gate, so a hanging read shows its skeleton.
  await page.waitForTimeout(350);
}

async function drive(page: Page, name: DestructiveFixtureName): Promise<void> {
  const spec: DestructiveConfirmFixture = DESTRUCTIVE_FIXTURES[name];
  if (spec.drive === "tab-to-confirm") {
    const confirm = page.locator('[data-confirm-role="confirm"]');
    await expect(confirm).toBeEnabled();
    for (
      let i = 0;
      i < 8 && !(await confirm.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press("Tab");
    }
    await expect(confirm).toBeFocused();
  }
  await page.waitForTimeout(100);
}

/**
 * What each fixture is supposed to show, checked before its PNG is written: a
 * shim that failed to answer would otherwise photograph the loading state under
 * every name.
 */
async function expectFixtureState(page: Page, name: DestructiveFixtureName): Promise<void> {
  const spec: DestructiveConfirmFixture = DESTRUCTIVE_FIXTURES[name];
  const confirm = page.locator('[data-confirm-role="confirm"]');
  const card = page.locator(CARD).first();
  if (spec.meta === "error") {
    await expect(card.getByText(/ENOENT/)).toBeVisible();
    await expect(confirm).toBeDisabled();
    return;
  }
  if (spec.meta === "hang") {
    await expect(confirm).toBeDisabled();
    return;
  }
  if (spec.confirming) {
    await expect(page.locator('[data-confirm-role="cancel"]')).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  } else {
    await expect(confirm).toBeEnabled();
  }
  const cwdTail = spec.meta.cwd.split("/").pop()!;
  if (spec.tier === "reinstallAndRestart") {
    await expect(card.getByText(new RegExp(cwdTail)).first()).toBeVisible();
  } else {
    const present = spec.meta.cacheDirs.find((d) => d.age !== null);
    if (present) {
      await expect(card.getByText(present.relPath, { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.getByTestId("dev-preview-destructive-cache-none")).toBeVisible();
    }
  }
}

async function shoot(page: Page, file: string): Promise<string> {
  const box = await page.locator(CARD).first().boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: dialog has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const viewport = page.viewportSize()!;
  if (box.y + box.height > viewport.height - 4) {
    throw new Error(
      `${file}: dialog runs past the page (${box.y + box.height}) — refusing to write`
    );
  }
  const x = Math.max(0, box.x - PAD);
  const y = Math.max(0, box.y - PAD);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + PAD * 2),
      height: Math.min(viewport.height - y, box.height + PAD * 2),
    },
  });
  return out;
}

test("Dev preview destructive confirm — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DEVPREVIEW_CONFIRM is required for the capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DEVPREVIEW_CONFIRM=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const written: string[] = [];
  for (const theme of THEMES) {
    for (const name of DESTRUCTIVE_FIXTURE_NAMES) {
      await open(page, name, theme);
      await drive(page, name);
      await expectFixtureState(page, name);
      written.push(await shoot(page, `${name}--${theme}.png`));
    }
  }

  if (SWEEP) {
    for (const sweepTheme of ALL_THEMES) {
      await open(page, "cache-populated", sweepTheme);
      await expectFixtureState(page, "cache-populated");
      written.push(await shoot(page, `sweep--cache-populated--${sweepTheme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * DESTRUCTIVE_FIXTURE_NAMES.length);
  console.log(`[destructive-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
