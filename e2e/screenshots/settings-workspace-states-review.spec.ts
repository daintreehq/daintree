/**
 * Settings workspace pages — the states a top-to-bottom sweep never reaches.
 *
 * `settings-pages-review.spec.ts` captures every page as a fresh profile renders it.
 * That hides most of what the Panel grid, Worktree and Portal pages are for: the
 * dependents under a switch that is on, the grid strategy that brings its own row,
 * the path pattern while it is invalid, unsaved and just saved, and a portal with
 * custom links, one being edited, and the custom new-tab URL open. This spec drives
 * each one through the real controls — no store seeding — and captures it.
 *
 *   DAINTREE_SHOT_SETTINGS_STATES=1 DAINTREE_SHOT_DIR=/tmp/out \
 *     npx playwright test --project=screenshots settings-workspace-states-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SETTINGS_STATES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — output directory (never the repo)
 *   DAINTREE_SHOT_THEME            optional theme id (default: the app default)
 *
 * Every state asserts what it is meant to show before it is captured, and the run
 * fails unless every planned file is on disk.
 */

import { test, expect, type Page, type Locator, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";

const ENABLED = !!process.env.DAINTREE_SHOT_SETTINGS_STATES;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
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

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-settings-states-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: "ignore" });
  git("init -b main");
  git('config user.email "test@daintree.dev"');
  git('config user.name "Daintree Test"');
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A");
  git('commit -m "initial commit"');
  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(app: ElectronApplication, size: typeof WIDE): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
}

async function openAt(page: Page, tab: string, subtab?: string): Promise<void> {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
    },
    subtab ? { tab, subtab } : { tab }
  );
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(`.settings-sidebar [role="tab"][data-tab="${tab}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 15_000 }
  );
  if (subtab) {
    const sub = page.locator(`${DIALOG} [role="tablist"] [role="tab"][data-tab="${subtab}"]`);
    await sub.first().click();
    await expect(sub.first()).toHaveAttribute("aria-selected", "true");
  }
  await settle(page, 500);
}

const written: string[] = [];

/** Scroll `anchor` to the top of the page's scrollport, then capture the dialog card. */
async function capture(page: Page, name: string, anchor?: Locator): Promise<void> {
  if (anchor) {
    await anchor.evaluate((el) => el.scrollIntoView({ block: "start" }));
  } else {
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>(".settings-sidebar ~ * *").forEach((el) => {
        if (el.scrollTop > 0) el.scrollTop = 0;
      });
    });
  }
  await settle(page, 250);
  const file = `${name}--${THEME_SLUG}.png`;
  await page
    .locator(CARD)
    .first()
    .screenshot({
      path: path.join(OUTPUT_DIR, file),
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
  written.push(file);
}

function switchIn(page: Page, rowId: string): Locator {
  return page.locator(`${DIALOG} #${rowId} [role="switch"]`);
}

async function setSwitch(page: Page, rowId: string, on: boolean): Promise<void> {
  const sw = switchIn(page, rowId);
  if ((await sw.getAttribute("aria-checked")) !== String(on)) await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", String(on));
}

test("settings workspace states — dependents, strategies, pattern and link editing", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SETTINGS_STATES is required for the settings-states capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SETTINGS_STATES to run the settings-states capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-settingsstatesshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await setWindowSize(ctx.app, WIDE);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await dismissBlockingPalette(page);
    await settle(page, 600);

    // Panel grid — performance with every dependent live.
    await openAt(page, "terminal", "performance");
    await setSwitch(page, "terminal-resource-monitoring", true);
    await setSwitch(page, "terminal-memory-leak-detection", true);
    await expect(page.locator(`${DIALOG} input[type="number"]`).first()).toBeEnabled();
    await capture(page, "terminal.performance.dependents-on");

    // Performance mode on, seen from the scrollback page it caps.
    await setSwitch(page, "terminal-performance-mode", true);
    await capture(page, "terminal.performance.performance-mode");
    await openAt(page, "terminal", "scrollback");
    await capture(page, "terminal.scrollback.performance-mode");
    await openAt(page, "terminal", "performance");
    await setSwitch(page, "terminal-performance-mode", false);
    await setSwitch(page, "terminal-memory-leak-detection", false);
    await setSwitch(page, "terminal-resource-monitoring", false);

    // Panel grid — a fixed strategy brings its count row; the split turned off.
    await openAt(page, "terminal", "layout");
    await page.locator(`${DIALOG} input[type="radio"][value="fixed-columns"]`).check();
    await expect(page.getByText("Number of columns", { exact: true })).toBeVisible();
    const splitSwitch = page.locator(`${DIALOG} #terminal-two-pane-split [role="switch"]`).first();
    await splitSwitch.click();
    await expect(splitSwitch).toHaveAttribute("aria-checked", "false");
    await capture(page, "terminal.layout.fixed-columns-split-off");
    await splitSwitch.click();
    await page.locator(`${DIALOG} input[type="radio"][value="automatic"]`).check();

    // Worktree — invalid, unsaved, saved.
    await openAt(page, "worktree");
    const patternInput = page.locator(`${DIALOG} #path-pattern`);
    await expect(patternInput).not.toHaveValue("", { timeout: 15_000 });
    const stored = await patternInput.inputValue();
    await patternInput.fill("{parent-dir}/{nope}");
    await expect(patternInput).toHaveAttribute("aria-invalid", "true");
    await capture(page, "worktree.pattern-invalid");
    await page.getByRole("button", { name: "Branch only" }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await capture(page, "worktree.pattern-unsaved");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(DIALOG).getByText("Saved", { exact: true })).toBeVisible();
    await capture(page, "worktree.pattern-saved");
    await patternInput.fill(stored);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // Worktree — the always-hidden list refusing a duplicate.
    const hidden = page.locator(`${DIALOG} #file-browser-always-hidden`);
    await hidden.getByRole("textbox").fill(".DS_Store");
    await hidden.getByRole("textbox").press("Enter");
    await expect(hidden.getByText("Already in the list")).toBeVisible();
    await capture(page, "worktree.hidden-duplicate", hidden);
    await hidden.getByRole("textbox").fill("");

    // Toolbar — the move menu, the non-drag route to reordering.
    await openAt(page, "toolbar");
    await page.getByRole("button", { name: "Move Gemini agent" }).click();
    await expect(page.getByRole("menuitem", { name: "Move to right side" })).toBeVisible();
    await capture(page, "toolbar.move-menu");
    await page.keyboard.press("Escape");

    // Portal — populated custom links.
    await openAt(page, "portal");
    const custom = page.locator(`${DIALOG} #portal-custom-links`);
    for (const [name, url] of [
      ["Team docs", "https://docs.helios.dev/handbook/engineering"],
      ["Linear", "https://linear.app/helios/team/DASH/active"],
    ]) {
      await custom.getByRole("textbox").nth(-2).fill(name);
      await custom.getByRole("textbox").last().fill(url);
      await custom.getByRole("button", { name: "Add", exact: true }).click();
      await expect(custom.getByText(name, { exact: true })).toBeVisible();
    }
    await capture(page, "portal.populated");
    await capture(page, "portal.custom-links", custom);

    // Portal — editing one link.
    await custom.getByRole("button", { name: "Edit" }).first().click();
    await expect(page.getByRole("textbox", { name: "Link URL", exact: true })).toBeVisible();
    await capture(page, "portal.editing", custom);
    await custom.getByRole("button", { name: "Cancel", exact: true }).click();

    // Portal — add refused.
    await custom.getByRole("textbox").nth(-2).fill("Broken");
    await custom.getByRole("textbox").last().fill("docs.helios.dev");
    await custom.getByRole("button", { name: "Add", exact: true }).click();
    await expect(custom.locator('[aria-invalid="true"]')).toHaveCount(1);
    await capture(page, "portal.add-error", custom);
    await custom.getByRole("textbox").nth(-2).fill("");
    await custom.getByRole("textbox").last().fill("");

    // Portal — custom new-tab URL.
    await page.locator(`${DIALOG} #portal-default-agent [role="combobox"]`).click();
    await page.getByRole("option", { name: /Custom URL/ }).click();
    await expect(page.getByRole("textbox", { name: "Custom URL" })).toBeVisible();
    await capture(page, "portal.custom-url");
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "states-manifest.json"), JSON.stringify(written, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR));
  const missing = written.filter((f) => !onDisk.has(f));
  console.log(`[settings-states-shots] ${written.length - missing.length}/${written.length} PNGs`);
  expect(missing).toEqual([]);
  expect(written.length).toBe(14);
});
