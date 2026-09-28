/**
 * Search match highlighting in the worktree palette and the keyboard shortcuts tab.
 *
 * Both lists filter on a plain substring and mark the matched run in each row,
 * the way the action, quick switcher and settings searches do. The states that
 * carry the design are a query that hits the highlighted (Enter) row and a
 * resting row at once, a match that lands in the branch rather than the name,
 * and the shortcuts tab's own search across bound and fixed rows.
 *
 *   DAINTREE_SHOT_SEARCH_MATCH=1 DESIGN_CAPTURE_DIR=/tmp/out \
 *     npx playwright test --project=screenshots search-match-highlight-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SEARCH_MATCH  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES        comma-separated theme ids (default `daintree,bondi`)
 *
 * Every state asserts its precondition before it is written, and the run fails
 * unless the files on disk match the manifest.
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

const ENABLED = !!process.env.DAINTREE_SHOT_SEARCH_MATCH;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi").split(",").filter(Boolean);

const PALETTE = '[aria-label="Worktree palette"]';
const SETTINGS_DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const SETTINGS_CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const KEYBOARD_PANEL = "#settings-panel-keyboard";
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

const BRANCHES = [
  "feature/oauth-device-flow",
  "fix/retry-backoff-jitter",
  "feature/streaming-token-refresh-with-exponential-backoff-and-jitter",
];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-search-match-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  for (const branch of BRANCHES) {
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

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
}

const manifest: { file: string; state: string; theme: string }[] = [];
const failures: string[] = [];

async function shoot(page: Page, selector: string, state: string, theme: string, pad = 0) {
  await page.mouse.move(2, 2);
  await settle(page, 250);
  const file = `${state}--${theme}.png`;
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${state}: ${selector} has no box`);
  const viewport = page.viewportSize() ?? WIDE;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, file),
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
  manifest.push({ file, state, theme });
}

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).slice(0, 400)}`);
    await dismissBlockingPalette(page).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function openWorktreePalette(page: Page): Promise<void> {
  const palette = page.locator(PALETTE);
  if (!(await palette.isVisible().catch(() => false))) {
    const result = await page.evaluate(
      () =>
        window.__daintreeDispatchAction?.("worktree.openPalette", undefined, { source: "user" }) ??
        Promise.resolve({ ok: false })
    );
    if (!(result as { ok: boolean }).ok) throw new Error("worktree.openPalette did not dispatch");
  }
  await palette.waitFor({ state: "visible", timeout: 5000 });
  await settle(page, 200);
}

async function searchPalette(page: Page, query: string, expected: number): Promise<void> {
  const input = page
    .locator(PALETTE)
    .getByRole("combobox")
    .or(page.locator(PALETTE).getByRole("textbox"));
  await input.first().fill(query);
  await settle(page, 400);
  await expect(page.locator(`${PALETTE} [role="option"]`)).toHaveCount(expected, {
    timeout: 5000,
  });
}

async function captureWorktreePalette(page: Page, theme: string): Promise<void> {
  await step(page, "worktree-name-and-branch", async () => {
    await openWorktreePalette(page);
    await searchPalette(page, "oauth", 1);
    await shoot(page, PALETTE, "wt-01-match-name-and-branch", theme, 24);
  });

  await step(page, "worktree-selected-and-resting", async () => {
    await openWorktreePalette(page);
    await searchPalette(page, "jitter", 2);
    await shoot(page, PALETTE, "wt-02-match-selected-and-resting", theme, 24);
    await page.keyboard.press("ArrowDown");
    await settle(page, 200);
    await shoot(page, PALETTE, "wt-03-match-cursor-moved", theme, 24);
  });

  await page.keyboard.press("Escape").catch(() => {});
  await settle(page, 300);
}

async function captureKeyboard(page: Page, theme: string): Promise<void> {
  const panel = page.locator(KEYBOARD_PANEL);
  const rows = panel.locator('[data-testid="shortcut-row"]');
  const search = panel.getByRole("textbox", { name: "Search shortcuts" });

  await step(page, "keyboard-search", async () => {
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("daintree:open-settings-tab", { detail: { tab: "keyboard" } })
      );
    });
    await page.locator(SETTINGS_DIALOG).waitFor({ state: "visible", timeout: 20_000 });
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await settle(page, 500);

    await search.fill("worktree");
    await settle(page, 300);
    expect(await rows.count()).toBeGreaterThan(0);
    await shoot(page, SETTINGS_CARD, "kb-01-search-label-match", theme);

    await search.fill("reorder");
    await settle(page, 300);
    await expect(panel.getByText("Reorder worktree").first()).toBeVisible();
    await shoot(page, SETTINGS_CARD, "kb-02-search-fixed-rows", theme);

    await search.fill("");
    await settle(page, 200);
  });

  await page
    .locator('[aria-label="Close settings"]')
    .click()
    .catch(() => {});
  await page
    .locator(SETTINGS_DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

test("search match highlighting — worktree palette and shortcuts search", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SEARCH_MATCH is required for the search match capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SEARCH_MATCH to run the search match capture");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR is required — captures never go in the repo");
  test.setTimeout(10 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-searchmatch-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await setWindowSize(ctx.app, WIDE);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");

    for (const theme of THEMES) {
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS });
      await dismissBlockingPalette(page);
      await settle(page, 800);
      await captureWorktreePalette(page, theme);
      await captureKeyboard(page, theme);
    }
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  console.log(
    `[search-match-shots] ${manifest.length - missing.length}/${manifest.length} PNGs → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`search match capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBe(THEMES.length * 5);
});
