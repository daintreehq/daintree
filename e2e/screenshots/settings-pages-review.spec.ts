/**
 * Settings pages visual-review harness — every tab, every subtab, top to bottom.
 *
 * The other settings harnesses look at one question each (scope orientation, the
 * General pane's agent roster). This one exists for the question that spans all of
 * them: do the settings pages share one layout language — how sections are headed,
 * how rows are grouped, where the control sits, how a dependent setting reads — or
 * does each page improvise its own. That can only be judged by laying every page side
 * by side, so the harness walks the whole dialog rather than a curated state list.
 *
 * Everything is discovered from the shipping DOM, not hardcoded:
 *   - tabs come from the sidebar's `[role="tab"][data-tab]` items in each scope, so a
 *     new tab is captured the day it lands;
 *   - subtabs come from the `[role="tablist"]` inside the active tab panel, clicked in
 *     order the way a user would;
 *   - each page is captured in viewport-sized slices down the real scrollport, so a
 *     long page is seen in full instead of only its first screen.
 * Navigation is the `daintree:open-settings-tab` deep link the toolbar and recovery
 * banners use, which also selects the scope.
 *
 *   DAINTREE_SHOT_SETTINGS_PAGES=1 npx playwright test --project=screenshots settings-pages-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SETTINGS_PAGES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR             required — output directory (never the repo)
 *   DAINTREE_SHOT_THEME           optional theme id (default: the app default)
 *   DAINTREE_SHOT_ONLY            comma-separated tab-id filter (e.g. `general,project:general`)
 *   DAINTREE_SHOT_SWEEP           first slice of each page only (theme sweep)
 *   DAINTREE_SHOT_MAX_SLICES      slice cap per page (default 6)
 *
 * A manifest.json beside the PNGs lists every file written with its tab, subtab and
 * slice, and the run fails unless the files on disk match it.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";

const ENABLED = !!process.env.DAINTREE_SHOT_SETTINGS_PAGES;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const SWEEP_ONLY = !!process.env.DAINTREE_SHOT_SWEEP;
const MAX_SLICES = Number(process.env.DAINTREE_SHOT_MAX_SLICES ?? "6");
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
// AppDialog puts role="dialog" on the full-viewport scrim; the card is its child.
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CLOSE = '[aria-label="Close settings"]';
const navItem = (tab: string) => `.settings-sidebar [role="tab"][data-tab="${tab}"]`;

const PROJECT_NAME = "Helios Dashboard";
const WIDE = { width: 1680, height: 1050 };

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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-settings-pages-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "package.json"), '{"name":"helios","scripts":{"dev":"vite"}}\n');
  writeFileSync(path.join(dir, "src", "index.ts"), "export const version = 1;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
}

async function openSettingsAt(page: Page, target: { tab: string; subtab?: string }) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
  }, target);
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(navItem(target.tab))).toHaveAttribute("aria-selected", "true", {
    timeout: 15_000,
  });
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .locator(CLOSE)
    .click()
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

/** Tab ids in sidebar order for the scope the dialog is currently showing. */
async function listNavTabs(page: Page): Promise<string[]> {
  return page
    .locator(`${DIALOG} .settings-sidebar [role="tab"][data-tab]`)
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tab ?? ""));
}

/** Subtab ids inside the active panel, or [] when the page has none. */
async function listSubtabs(page: Page, tab: string): Promise<string[]> {
  return page
    .locator(
      `${DIALOG} [role="tabpanel"]#settings-panel-${cssEscape(tab)} [role="tablist"] [role="tab"][data-tab]`
    )
    .evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => (el as HTMLElement).dataset.tab ?? "")
    );
}

function cssEscape(id: string): string {
  return id.replace(/:/g, "\\:");
}

/**
 * The element that actually scrolls the active page: the nearest overflowing ancestor
 * of the visible tab panel. Tagged so the slice loop can address it by selector.
 */
async function tagScroller(
  page: Page,
  tab: string
): Promise<{ scrollHeight: number; clientHeight: number }> {
  return page.evaluate((panelId) => {
    document
      .querySelectorAll("[data-shot-scroller]")
      .forEach((el) => el.removeAttribute("data-shot-scroller"));
    const panel = document.getElementById(panelId);
    if (!panel) throw new Error(`no panel #${panelId}`);
    let el: HTMLElement | null = panel.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
      el = el.parentElement;
    }
    if (!el) throw new Error("no scroll container above the tab panel");
    el.setAttribute("data-shot-scroller", "");
    el.scrollTop = 0;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, `settings-panel-${tab}`);
}

interface ManifestEntry {
  file: string;
  tab: string;
  subtab: string | null;
  slice: number;
  slices: number;
}

const failures: string[] = [];
const manifest: ManifestEntry[] = [];

async function capturePage(page: Page, tab: string, subtab: string | null): Promise<void> {
  const { scrollHeight, clientHeight } = await tagScroller(page, tab);
  await settle(page, 250);
  const step = Math.max(200, Math.floor(clientHeight * 0.85));
  const total = SWEEP_ONLY
    ? 1
    : Math.min(MAX_SLICES, Math.max(1, Math.ceil((scrollHeight - clientHeight) / step) + 1));
  const base = `${tab.replace(":", "_")}${subtab ? `.${subtab}` : ""}`;

  for (let i = 0; i < total; i++) {
    await page.evaluate((top) => {
      const el = document.querySelector<HTMLElement>("[data-shot-scroller]");
      if (el) el.scrollTop = top;
    }, i * step);
    await settle(page, 200);
    const file = `${base}--p${i + 1}--${THEME_SLUG}.png`;
    await page
      .locator(CARD)
      .first()
      .screenshot({
        path: path.join(OUTPUT_DIR, file),
        type: "png",
        animations: "disabled",
        caret: "hide",
      });
    manifest.push({ file, tab, subtab, slice: i + 1, slices: total });
  }
}

test("settings pages review — every tab and subtab, sliced top to bottom", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SETTINGS_PAGES is required for the settings-pages capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SETTINGS_PAGES to run the settings-pages capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-settingspagesshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await setWindowSize(ctx.app, WIDE);

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await dismissBlockingPalette(page);
    await settle(page, 600);

    const tabs: string[] = [];
    for (const seed of ["general", "project:general"]) {
      await openSettingsAt(page, { tab: seed });
      await settle(page, 400);
      tabs.push(...(await listNavTabs(page)));
    }
    const planned = [...new Set(tabs)].filter((t) => ONLY.length === 0 || ONLY.includes(t));
    if (planned.length === 0) throw new Error("discovered no settings tabs");

    for (const tab of planned) {
      try {
        await openSettingsAt(page, { tab });
        await settle(page, 900);
        const subtabs = await listSubtabs(page, tab);
        if (subtabs.length === 0) {
          await capturePage(page, tab, null);
        } else {
          for (const sub of subtabs) {
            await page
              .locator(
                `${DIALOG} #settings-panel-${cssEscape(tab)} [role="tablist"] [role="tab"][data-tab="${sub}"]`
              )
              .first()
              .click();
            await settle(page, 700);
            await capturePage(page, tab, sub);
          }
        }
      } catch (error) {
        failures.push(`${tab}: ${String(error).slice(0, 400)}`);
      }
    }
    await closeSettings(page);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  console.log(
    `[settings-pages-shots] ${manifest.length - missing.length}/${manifest.length} PNGs → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`settings-pages capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBeGreaterThan(0);
});
