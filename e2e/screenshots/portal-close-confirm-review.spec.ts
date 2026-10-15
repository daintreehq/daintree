/**
 * Portal bulk-close confirm visual-review harness.
 *
 * "Close all", "Close others" and "Close to the right" on three or more portal
 * tabs stage a snapshot in `portalPendingCloseStore` and raise a destructive
 * confirm that lists every tab about to close. This drives the preview entry
 * (`portal-close-preview.html`), which seeds that store from a fixture and mounts
 * the real dialog host: two tabs, a long list that scrolls, long titles, long
 * URLs, an untitled and a blank tab, and a clipped row disclosed by hover and by
 * keyboard focus.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_PORTAL_CLOSE is set.
 *
 *   DAINTREE_SHOT_PORTAL_CLOSE=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots portal-close-confirm-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PORTAL_CLOSE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES        themes for the per-state captures (default daintree,bondi)
 *   DAINTREE_SHOT_SWEEP         "0" skips the all-themes sweep of many-tabs
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  CLOSE_CONFIRM_FIXTURE_NAMES,
  getCloseConfirmFixture,
  type CloseConfirmFixtureName,
} from "../../src/components/Portal/__preview__/closeConfirmFixtures";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PORTAL_CLOSE;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

/** The dialog card inside the scrim. */
const CARD = '[role="dialog"] > [tabindex="-1"], [role="alertdialog"] > [tabindex="-1"]';
const PAD = 24;

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

async function open(page: Page, name: CloseConfirmFixtureName, theme: string): Promise<void> {
  await page.setViewportSize({ width: 760, height: getCloseConfirmFixture(name).height ?? 900 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[portal-close-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/portal-close-preview.html?theme=${theme}&fixture=${name}`;
  const card = page.locator(CARD).first();
  try {
    await page.goto(url);
    await expect(card).toBeVisible({ timeout: 60_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(card).toBeVisible({ timeout: 60_000 });
  }
  // A Tailwind utility on the card proves the stylesheet landed, not just markup.
  await expect(card).toHaveCSS("border-top-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/**
 * Hover or keyboard-focus the first row. A row that offers no disclosure is still
 * photographed in that state: the capture shows what the pointer or the keyboard
 * actually gets, and the log says which.
 */
async function drive(page: Page, name: CloseConfirmFixtureName): Promise<void> {
  const spec = getCloseConfirmFixture(name);
  const card = page.locator(CARD).first();
  const firstRow = card.getByRole("listitem").first();
  if (spec.drive === "hover-row") {
    const box = await firstRow.boundingBox();
    if (!box) throw new Error("first row has no box");
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
  } else if (spec.drive === "focus-row") {
    // Shift+Tab backwards from the initial focus (Cancel) into the body.
    let landed = false;
    for (let i = 0; i < 8 && !landed; i++) {
      await page.keyboard.press("Shift+Tab");
      landed = await firstRow.evaluate(
        (row) => row === document.activeElement || row.contains(document.activeElement)
      );
    }
    if (!landed) {
      const listFocus = await card
        .getByRole("list")
        .first()
        .evaluate((list) => list.contains(document.activeElement));
      console.warn(
        `[portal-close-shots] ${name}: keyboard never reached the first row (list holds focus: ${listFocus})`
      );
    }
  }
  if (spec.drive) {
    const tooltip = page.getByRole("tooltip");
    const shown = await tooltip
      .first()
      .waitFor({ state: "visible", timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    console.log(`[portal-close-shots] ${name}: disclosure ${shown ? "shown" : "none"}`);
  }
  await page.waitForTimeout(150);
}

/**
 * What each fixture is supposed to show, checked before its PNG is written: a
 * store that failed to seed would otherwise photograph some other dialog.
 */
async function expectFixtureState(page: Page, name: CloseConfirmFixtureName): Promise<void> {
  const spec = getCloseConfirmFixture(name);
  const card = page.locator(CARD).first();
  const title =
    spec.kind === "closeAll"
      ? /Close all portal tabs/
      : spec.kind === "closeOthers"
        ? /Close other portal tabs/
        : /Close tabs to the right/;
  await expect(card.getByRole("heading").first()).toHaveText(title);
  await expect(card.getByRole("listitem")).toHaveCount(spec.tabs.length);
  await expect(card.locator('[data-confirm-role="confirm"]')).toHaveText(
    new RegExp(`Close ${spec.tabs.length} portal tabs`)
  );
  const firstTitled = spec.tabs.find((t) => t.title);
  if (firstTitled) {
    await expect(card.getByText(firstTitled.title, { exact: false }).first()).toBeAttached();
  }
}

async function shoot(page: Page, file: string): Promise<string> {
  const box = await page.locator(CARD).first().boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: dialog has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const viewport = page.viewportSize()!;
  let x = Math.max(0, box.x - PAD);
  let y = Math.max(0, box.y - PAD);
  let right = Math.min(viewport.width, box.x + box.width + PAD);
  let bottom = Math.min(viewport.height, box.y + box.height + PAD);
  for (const tooltip of await page.getByRole("tooltip").all()) {
    const t = await tooltip.boundingBox();
    if (!t) continue;
    x = Math.max(0, Math.min(x, t.x - PAD));
    y = Math.max(0, Math.min(y, t.y - PAD));
    right = Math.min(viewport.width, Math.max(right, t.x + t.width + PAD));
    bottom = Math.min(viewport.height, Math.max(bottom, t.y + t.height + PAD));
  }
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

test("Portal bulk-close confirm — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PORTAL_CLOSE is required for the capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PORTAL_CLOSE=1 to run the capture");
  test.setTimeout(20 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const written: string[] = [];
  for (const theme of THEMES) {
    for (const name of CLOSE_CONFIRM_FIXTURE_NAMES) {
      await open(page, name, theme);
      await expectFixtureState(page, name);
      await drive(page, name);
      written.push(await shoot(page, `${name}--${theme}.png`));
    }
  }

  if (SWEEP) {
    for (const sweepTheme of ALL_THEMES) {
      await open(page, "long-urls", sweepTheme);
      await expectFixtureState(page, "long-urls");
      written.push(await shoot(page, `sweep--long-urls--${sweepTheme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * CLOSE_CONFIRM_FIXTURE_NAMES.length);
  console.log(`[portal-close-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
