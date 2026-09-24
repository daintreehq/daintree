/**
 * Search field family, across every built-in theme.
 *
 * The app has four search fields people meet constantly — the Worktrees
 * sidebar's rail, the Settings dialog's nav search, and the palette header
 * input shared by the project switcher and the launcher. They are meant to be
 * one control in different places, so the only useful review lays them side by
 * side, at rest, focused and holding a query, in every theme at once.
 *
 * One launch, one pass: the theme is switched through the real app-theme IPC
 * (`setAppTheme`), and each field is reached the way a user reaches it — the
 * rail by clicking into it, Settings through its own deep link, the switcher
 * and the launcher through their toolbar triggers.
 *
 *   DAINTREE_SHOT_SEARCH_INPUTS=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots search-inputs-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SEARCH_INPUTS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES         comma-separated theme ids (default: all built-ins)
 *   DAINTREE_SCREENSHOT_SCALE    device scale factor (default 2)
 *   DAINTREE_SHOT_SEARCH_EXTRA   also capture the settings-page consumers (the
 *                                terminal colour-scheme filter, the shortcuts search)
 *
 * Output: <dir>/<state>--<theme>.png. Each frame is checked against the state
 * it claims to show (focus owner, typed value, surface visible) after the
 * settle and before it is written, and the run fails if any frame is missing.
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_SEARCH_INPUTS;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const ALL_THEMES = [
  "daintree",
  "bondi",
  "table-mountain",
  "arashiyama",
  "fiordland",
  "galapagos",
  "highlands",
  "namib",
  "redwoods",
  "atacama",
  "bali",
  "hokkaido",
  "serengeti",
  "svalbard",
  "movile",
];
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "").split(",").filter(Boolean);
const RUN_THEMES = THEMES.length > 0 ? THEMES : ALL_THEMES;

const EXTRA = !!process.env.DAINTREE_SHOT_SEARCH_EXTRA;
const EXTRA_STATES = [
  "canvas-launcher-rest",
  "scheme-search-focus",
  "shortcuts-search-focus",
] as const;

const CORE_STATES = [
  "sidebar-rest",
  "sidebar-focus",
  "sidebar-query",
  "settings-rest",
  "settings-query",
  "switcher-focus",
  "launcher-focus",
] as const;
const STATES: readonly string[] = EXTRA ? [...CORE_STATES, ...EXTRA_STATES] : CORE_STATES;

// Transitions off so a frame never lands mid-fade; the caret stays hidden so
// its blink phase cannot make two captures of the same state differ.
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

const SIDEBAR_INPUT = '[aria-label="Search worktrees"]';
const SIDEBAR_BAR = ".worktree-filter-bar";
const SETTINGS_DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const SETTINGS_INPUT = SEL.settings.searchInput;
const SWITCHER = SEL.projectSwitcher.palette;
const SWITCHER_INPUT = '[aria-label="Search workspaces"]';
const LAUNCHER = '[role="dialog"][aria-label="Launch"]';
const LAUNCHER_INPUT = '[aria-label="Search agents, panels, and recipes"]';
const LAUNCHER_TRIGGERS = [
  '[data-toolbar-button-id="launcher"] button',
  '[aria-label="Open launcher"]',
];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-search-inputs-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  for (const branch of ["feature/oauth-device-flow", "fix/retry-backoff-jitter"]) {
    const wtDir = path.join(wtRoot, branch.replace(/[/]/g, "-"));
    git(`branch ${branch}`, dir);
    git(`worktree add ${JSON.stringify(wtDir)} ${branch}`, dir);
  }
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

/** Throws unless focus is on the element the frame claims is focused. */
async function expectFocused(page: Page, selector: string, focused: boolean): Promise<void> {
  const has = await page
    .locator(selector)
    .first()
    .evaluate((el) => el === document.activeElement);
  if (has !== focused) {
    throw new Error(`${selector} should ${focused ? "" : "not "}hold focus at capture time`);
  }
}

async function snap(
  page: Page,
  state: string,
  theme: string,
  anchor: string,
  opts: { padX?: number; padTop?: number; height?: number } = {}
): Promise<void> {
  await settle(page);
  const box = await page.locator(anchor).first().boundingBox();
  if (!box) throw new Error(`${state}: ${anchor} has no box`);
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const padX = opts.padX ?? 20;
  const padTop = opts.padTop ?? 20;
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padTop);
  const height = opts.height ?? box.height + padTop * 2;
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${state}--${theme}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + padX * 2, viewport.width - x),
      height: Math.min(height, viewport.height - y),
    },
  });
}

async function escapeAll(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 120);
  }
}

async function captureTheme(page: Page, theme: string): Promise<void> {
  await setAppTheme(page, theme);
  await page.addStyleTag({ content: POLISH_CSS });
  await dismissBlockingPalette(page);
  await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 800);

  // Sidebar rail. Park focus on the body first so "rest" is honestly unfocused.
  const sidebarInput = page.locator(SIDEBAR_INPUT);
  await sidebarInput.waitFor({ state: "visible", timeout: T_LONG });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expectFocused(page, SIDEBAR_INPUT, false);
  await snap(page, "sidebar-rest", theme, SIDEBAR_BAR, { padX: 0, padTop: 44 });

  await sidebarInput.focus();
  await expectFocused(page, SIDEBAR_INPUT, true);
  await snap(page, "sidebar-focus", theme, SIDEBAR_BAR, { padX: 0, padTop: 44 });

  await sidebarInput.pressSequentially("oauth", { delay: 15 });
  await expect(sidebarInput).toHaveValue("oauth");
  await expect(page.locator(`${SIDEBAR_BAR} [aria-label="Clear search"]`)).toBeVisible();
  await expectFocused(page, SIDEBAR_INPUT, true);
  await snap(page, "sidebar-query", theme, SIDEBAR_BAR, { padX: 0, padTop: 44 });
  await sidebarInput.fill("");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  if (EXTRA) {
    // The canvas home's palette entry is a button drawn as a search field.
    const entry = page.getByRole("button", { name: /Search agents & panels/ }).first();
    await entry.waitFor({ state: "visible", timeout: T_LONG });
    await entry.evaluate((el) => el.setAttribute("data-shot-anchor", "canvas"));
    await snap(page, "canvas-launcher-rest", theme, '[data-shot-anchor="canvas"]', {
      padX: 24,
      padTop: 24,
    });
  }

  // Settings nav search.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "general" } })
    )
  );
  await page.locator(SETTINGS_DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  const settingsInput = page.locator(SETTINGS_INPUT);
  await settingsInput.waitFor({ state: "visible", timeout: 10_000 });
  await settle(page, 400);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expectFocused(page, SETTINGS_INPUT, false);
  await snap(page, "settings-rest", theme, ".settings-sidebar", {
    padX: 0,
    padTop: 0,
    height: 240,
  });
  await settingsInput.focus();
  await settingsInput.pressSequentially("theme", { delay: 15 });
  await expect(settingsInput).toHaveValue("theme");
  await expectFocused(page, SETTINGS_INPUT, true);
  await snap(page, "settings-query", theme, ".settings-sidebar", {
    padX: 0,
    padTop: 0,
    height: 240,
  });
  await settingsInput.fill("");
  await page.locator(SEL.settings.closeButton).click();
  await page.locator(SETTINGS_DIALOG).waitFor({ state: "hidden", timeout: 8000 });
  await settle(page, 300);

  // Project switcher — the palette autofocuses its input on open.
  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  await page.locator(SWITCHER).waitFor({ state: "visible", timeout: 8000 });
  await settle(page, 400);
  await expectFocused(page, SWITCHER_INPUT, true);
  await snap(page, "switcher-focus", theme, SWITCHER, { padX: 16, padTop: 16, height: 200 });
  await escapeAll(page);
  await page.locator(SWITCHER).waitFor({ state: "hidden", timeout: 8000 });

  // Launcher.
  let opened = false;
  for (const trigger of LAUNCHER_TRIGGERS) {
    const el = page.locator(trigger).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      opened = await page
        .locator(LAUNCHER)
        .waitFor({ state: "visible", timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (opened) break;
    }
  }
  if (!opened) throw new Error("launcher did not open from any trigger");
  await settle(page, 600);
  await expectFocused(page, LAUNCHER_INPUT, true);
  await snap(page, "launcher-focus", theme, LAUNCHER, { padX: 16, padTop: 16, height: 200 });
  await escapeAll(page);

  if (EXTRA) await captureSettingsConsumers(page, theme);
}

/** A settings-page search, focused with a query, cropped to the row it sits in. */
async function captureSettingsSearch(
  page: Page,
  theme: string,
  state: string,
  target: { tab: string; subtab?: string },
  inputSelector: string,
  query: string
): Promise<void> {
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail })),
    target
  );
  await page.locator(SETTINGS_DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  const input = page.locator(inputSelector).first();
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.scrollIntoViewIfNeeded();
  await input.focus();
  await input.pressSequentially(query, { delay: 15 });
  await expect(input).toHaveValue(query);
  await expectFocused(page, inputSelector, true);
  const row = input.locator("xpath=ancestor::div[contains(@class,'flex')][1]/..");
  await row.evaluate((el) => el.setAttribute("data-shot-anchor", "1"));
  await snap(page, state, theme, '[data-shot-anchor="1"]', { padX: 12, padTop: 12 });
  await row.evaluate((el) => el.removeAttribute("data-shot-anchor"));
  await input.fill("");
}

async function captureSettingsConsumers(page: Page, theme: string): Promise<void> {
  await captureSettingsSearch(
    page,
    theme,
    "scheme-search-focus",
    { tab: "terminalAppearance", subtab: "terminal" },
    '[aria-label="Filter color schemes"]',
    "dark"
  );
  await captureSettingsSearch(
    page,
    theme,
    "shortcuts-search-focus",
    { tab: "keyboard" },
    '[aria-label="Search shortcuts"]',
    "term"
  );
  await page.locator(SEL.settings.closeButton).click();
  await page.locator(SETTINGS_DIALOG).waitFor({ state: "hidden", timeout: 8000 });
}

test("search field family — every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SEARCH_INPUTS is required for the search-inputs capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SEARCH_INPUTS=1 to run the search-inputs capture");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-searchinputs-"));
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 900 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await dismissBlockingPalette(page);

    for (const theme of RUN_THEMES) {
      try {
        await captureTheme(page, theme);
      } catch (error) {
        failures.push(`${theme}: ${String(error).split("\n")[0]}`);
        await escapeAll(page);
      }
    }

    const written = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
    const missing = RUN_THEMES.flatMap((t) =>
      STATES.map((s) => `${s}--${t}.png`).filter((f) => !written.has(f))
    );
    expect(failures, "theme passes failed").toEqual([]);
    expect(missing, "frames missing from the output directory").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
