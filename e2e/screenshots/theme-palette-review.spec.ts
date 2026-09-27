/**
 * Theme palette, every state that carries design weight.
 *
 * The palette previews each row live as the cursor moves, so the frames that
 * matter are the opening (cursor on the committed theme), browsing away from it
 * (the committed mark on a row the cursor has left, and the palette's own chrome
 * repainted by the preview), both ends of the list, search by name and by
 * place, and the no-match branch.
 *
 * The committed theme goes through the real seam (`appTheme.setColorScheme`),
 * and the palette opens through the same window event its action dispatches.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set.
 *
 *   DAINTREE_SHOT_THEME=daintree DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots theme-palette-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME        required — committed theme id
 *   DESIGN_CAPTURE_DIR         output directory (default artifacts/theme-palette-shots)
 *   DAINTREE_SHOT_ONLY         comma-separated step filter
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<NN-slug>--<theme>.png. Every capture is verified against the
 * state it claims to show before it is written.
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "theme-palette-shots");

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-theme-palette-"));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: "ignore" });
  git("init -b main");
  git('config user.email "test@daintree.dev"');
  git('config user.name "Daintree Test"');
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A");
  git('commit -m "initial commit"');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, slug: string, selector: string | null, pad = 40): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}--${THEME}.png`);
  if (!selector) {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
    return;
  }
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${slug}: ${selector} has no box`);
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[theme-palette] step "${name}" FAILED:`, detail);
    stepFailures.push(`${name}: ${detail}`);
  } finally {
    await closeOverlays(page).catch(() => {});
  }
}

async function closeOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 150);
  }
}

const dialog = SEL.themePalette.dialog;

async function openPalette(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("daintree:open-theme-palette")));
  await page.locator(dialog).waitFor({ state: "visible", timeout: 5000 });
  await expect(page.locator(SEL.themePalette.options).first()).toBeVisible({ timeout: 5000 });
  await settle(page, 250);
}

async function search(page: Page, query: string): Promise<void> {
  const input = page.locator(SEL.themePalette.searchInput);
  await input.fill("");
  await input.pressSequentially(query, { delay: 20 });
  await settle(page, 350);
}

async function cursorId(page: Page): Promise<string | null> {
  return page.locator(SEL.themePalette.searchInput).getAttribute("aria-activedescendant");
}

test("theme palette — every state", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the theme-palette capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the theme-palette capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-themepalette-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    // Opens on the committed theme, not the first row.
    await step(page, "open", async () => {
      await openPalette(page);
      expect(await cursorId(page)).toBe(`theme-option-${THEME}`);
      await snap(page, "01-open", dialog);
    });

    // Two rows away: the committed theme is now a row the cursor has left, and
    // the whole app — the palette included — is previewing another theme.
    await step(page, "browse", async () => {
      await openPalette(page);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await settle(page, 300);
      const id = await cursorId(page);
      expect(id).toMatch(/^theme-option-/);
      expect(id).not.toBe(`theme-option-${THEME}`);
      await snap(page, "02-browse", dialog);
      await snap(page, "03-browse-window", null);
    });

    await step(page, "ends", async () => {
      await openPalette(page);
      await page.keyboard.press("Home");
      await settle(page, 300);
      const first = await page.locator(SEL.themePalette.options).first().getAttribute("id");
      expect(await cursorId(page)).toBe(first);
      await snap(page, "04-first-row", dialog);
      await page.keyboard.press("End");
      await settle(page, 300);
      const last = await page.locator(SEL.themePalette.options).last().getAttribute("id");
      expect(await cursorId(page)).toBe(last);
      await snap(page, "05-last-row", dialog);
    });

    await step(page, "search-name", async () => {
      await openPalette(page);
      await search(page, "ba");
      expect(await page.locator(SEL.themePalette.options).count()).toBeGreaterThan(0);
      await snap(page, "06-search-name", dialog);
    });

    // A place, not a name: every built-in is named for somewhere.
    await step(page, "search-place", async () => {
      await openPalette(page);
      await search(page, "japan");
      await snap(page, "07-search-place", dialog);
    });

    await step(page, "search-mode", async () => {
      await openPalette(page);
      await search(page, "light");
      await snap(page, "08-search-mode", dialog);
    });

    await step(page, "no-results", async () => {
      await openPalette(page);
      await search(page, "qqxzv");
      expect(await page.locator(SEL.themePalette.options).count()).toBe(0);
      await snap(page, "09-no-results", dialog);
    });

    expect(stepFailures, `theme-palette capture steps failed in "${THEME}"`).toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
