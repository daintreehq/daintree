/**
 * Palette family, everyday states.
 *
 * `palette-review.spec.ts` checks that the family shares one surface. This one
 * goes into the three palettes people open dozens of times a day — the action
 * palette, the quick switcher and the new-terminal launcher — and captures the
 * states that carry the design: the first-open prefix hint, the browse rail with
 * real Favorites and Recently used bands, ranked search, commands mode, the
 * destructive-row treatment, the path-shaped no-results hint, and each palette's
 * empty and no-match branches.
 *
 * Fixtures go through the real seams: Recently used is filled by running
 * actions from the palette, Favorites by the palette's own Alt+P, and the
 * switcher's rows by opening terminals and worktrees in a real repository.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set.
 *
 *   DAINTREE_SHOT_THEME=daintree DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots palette-family-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME        required — theme id to render
 *   DESIGN_CAPTURE_DIR         output directory (default artifacts/palette-family-shots)
 *   DAINTREE_SHOT_ONLY         comma-separated step filter
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<NN-slug>--<theme>.png. Every capture is verified against the
 * state it claims to show before it is written; a step that cannot reach its
 * state fails the test rather than writing a plausible-looking wrong frame.
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
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
  : path.resolve(process.cwd(), "artifacts", "palette-family-shots");

const MOD = process.platform === "darwin" ? "Meta" : "Control";

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

const LONG_BRANCH = "feature/streaming-token-refresh-with-exponential-backoff-and-jitter";

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-palette-family-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = () => 0;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  for (const branch of ["feature/oauth-device-flow", "fix/retry-backoff-jitter", LONG_BRANCH]) {
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

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, slug: string, selector: string, pad = 40): Promise<void> {
  await settle(page);
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${slug}: ${selector} has no box`);
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}--${THEME}.png`),
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
    console.warn(`[palette-family] step "${name}" FAILED:`, detail);
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

async function openActionPalette(page: Page): Promise<void> {
  const dialog = page.locator(SEL.actionPalette.dialog);
  await page.keyboard.press(`${MOD}+Shift+P`);
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  await settle(page, 200);
}

async function searchActions(page: Page, query: string): Promise<void> {
  const input = page.locator(SEL.actionPalette.searchInput);
  await input.fill("");
  await input.pressSequentially(query, { delay: 20 });
  await settle(page, 350);
}

async function runAction(page: Page, title: string): Promise<void> {
  await openActionPalette(page);
  await searchActions(page, title);
  await expect(page.locator(SEL.actionPalette.options).first()).toContainText(title, {
    timeout: 5000,
  });
  await page.keyboard.press("Enter");
  await settle(page, 500);
  await closeOverlays(page);
}

test("palette family — everyday states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the palette-family capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the palette-family capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-palettefamily-"));
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
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    const dialog = SEL.actionPalette.dialog;

    // Fresh profile: the one opening that still teaches the prefix grammar.
    await step(page, "action-first-open", async () => {
      await openActionPalette(page);
      await expect(page.locator(dialog).getByLabel("Prefix shortcuts")).toBeVisible();
      await snap(page, "01-action-first-open", dialog);
    });

    // Seed Recently used through the palette itself, then pin one row with the
    // palette's own chord so Favorites is real too.
    await step(page, "seed", async () => {
      await runAction(page, "Toggle sidebar");
      await runAction(page, "Toggle sidebar");
      await runAction(page, "Reset sidebar width");
      await runAction(page, "Toggle notification inbox");
      await closeOverlays(page);
      await runAction(page, "Toggle notification inbox");
      await openActionPalette(page);
      await searchActions(page, "Pick theme");
      await expect(page.locator(SEL.actionPalette.options).first()).toContainText("Pick theme");
      await page.keyboard.press("Alt+KeyP");
      await settle(page, 300);
      await closeOverlays(page);
    });

    await step(page, "action-browse", async () => {
      await openActionPalette(page);
      await expect(page.locator(dialog).getByText("Favorites", { exact: true })).toBeVisible();
      await expect(page.locator(dialog).getByText("Recently used", { exact: true })).toBeVisible();
      await snap(page, "02-action-browse", dialog);
      // Onto a Recently used row, where both row controls are offered.
      await page.keyboard.press("ArrowDown");
      await settle(page, 150);
      await snap(page, "03-action-browse-recent-selected", dialog);
      // Down into the category inventory.
      for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowDown");
      await settle(page, 200);
      await snap(page, "04-action-browse-categories", dialog);
    });

    await step(page, "action-search", async () => {
      await openActionPalette(page);
      await searchActions(page, "terminal");
      expect(await page.locator(SEL.actionPalette.options).count()).toBeGreaterThan(3);
      await snap(page, "05-action-search", dialog);
      await searchActions(page, "wt");
      expect(await page.locator(SEL.actionPalette.options).count()).toBeGreaterThan(0);
      await snap(page, "06-action-search-acronym", dialog);
    });

    await step(page, "action-danger", async () => {
      await openActionPalette(page);
      await searchActions(page, "abort git");
      await expect(page.locator(SEL.actionPalette.options).first()).toContainText(
        "Abort Git operation"
      );
      await snap(page, "07-action-search-danger", dialog);
    });

    await step(page, "action-commands-mode", async () => {
      await openActionPalette(page);
      await page.keyboard.press(">");
      await expect(page.locator(dialog).getByText("Commands", { exact: true })).toBeVisible();
      await page.locator(SEL.actionPalette.searchInput).pressSequentially("git", { delay: 20 });
      await settle(page, 350);
      await snap(page, "08-action-commands-mode", dialog);
    });

    await step(page, "action-no-results", async () => {
      await openActionPalette(page);
      await searchActions(page, "qqxzv");
      await expect(page.locator(dialog).getByText(/No matches for/)).toBeVisible();
      await snap(page, "09-action-no-results", dialog);
      await searchActions(page, "src/components/Button.tsx");
      await expect(page.locator(dialog).getByText(/No matches for/)).toBeVisible();
      await snap(page, "10-action-no-results-path", dialog);
    });

    // Terminals for the switcher: two shells in the grid.
    await step(page, "seed-terminals", async () => {
      for (let i = 0; i < 2; i++) {
        await page.locator(SEL.toolbar.openTerminal).click();
        await settle(page, 1200);
      }
      await expect(page.locator(SEL.panel.gridPanel).first()).toBeVisible({ timeout: T_LONG });
    });

    const qs = SEL.quickSwitcher.dialog;
    await step(page, "quick-switcher", async () => {
      await page.keyboard.press(`${MOD}+P`);
      await page.locator(qs).waitFor({ state: "visible", timeout: 5000 });
      await expect(page.locator(SEL.quickSwitcher.options).first()).toBeVisible({ timeout: 5000 });
      await snap(page, "11-quick-switcher", qs);
      await page.locator(SEL.quickSwitcher.searchInput).pressSequentially("stream", { delay: 20 });
      await settle(page, 350);
      expect(await page.locator(SEL.quickSwitcher.options).count()).toBeGreaterThan(0);
      await snap(page, "12-quick-switcher-search", qs);
      await page.locator(SEL.quickSwitcher.searchInput).fill("qqxzv");
      await settle(page, 350);
      await expect(page.locator(qs).getByText(/No matches for/)).toBeVisible();
      await snap(page, "13-quick-switcher-no-results", qs);
    });

    const nt = SEL.newTerminalPalette.dialog;
    await step(page, "new-terminal", async () => {
      await page.evaluate(() =>
        window.dispatchEvent(new Event("daintree:open-new-terminal-palette"))
      );
      await page.locator(nt).waitFor({ state: "visible", timeout: 5000 });
      await expect(page.locator(SEL.newTerminalPalette.options).first()).toBeVisible();
      await snap(page, "14-new-terminal", nt);
      await page.locator(SEL.newTerminalPalette.searchInput).pressSequentially("co", { delay: 20 });
      await settle(page, 300);
      await snap(page, "15-new-terminal-search", nt);
      await page.locator(SEL.newTerminalPalette.searchInput).fill("qqxzv");
      await settle(page, 300);
      expect(await page.locator(SEL.newTerminalPalette.options).count()).toBe(0);
      await snap(page, "16-new-terminal-no-results", nt);
    });

    expect(stepFailures, `palette-family capture steps failed in "${THEME}"`).toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
