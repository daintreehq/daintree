/**
 * Dialog primary-action visual-review harness.
 *
 * #11963 made the high-contrast neutral button (`variant="contrast"` — the theme's own
 * body-text colour as the fill) the standard dialog primary action, replacing the accent
 * fill. That reads differently in every theme, and the failure mode is a fill that
 * disappears into the panel behind it, so the change is judged on rendered pixels.
 *
 * Captures one state per code path the change touches:
 *
 *   preset      `AppDialog.Footer primaryAction` — the central `getPrimaryVariant()`
 *               resolver. Every non-destructive `ConfirmDialog` in the app renders its
 *               primary through this same function, so this shot is what all 70-odd of
 *               them look like.
 *   editor      a footer that hand-writes its buttons, converted by hand.
 *   import      a second hand-written footer, on a smaller dialog.
 *   destructive `ConfirmDialog variant="destructive"` — must still be destructive-red,
 *               not the contrast fill. This is the shot that proves the precedence.
 *   discard     a nested destructive confirm stacked over an open dialog.
 *
 * Opt-in only, like worktree-dialog-review: skips itself unless DAINTREE_SHOT_CONFIRM is
 * set, so the marketing screenshots workflow never executes it.
 *
 *   DAINTREE_SHOT_CONFIRM=1 npx playwright test --project=screenshots confirm-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CONFIRM  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME    optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG      optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (see step names above)
 *
 * Output: artifacts/confirm-dialog-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { navigateToAgentSettings } from "../helpers/presets";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_CONFIRM;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "confirm-dialog-shots");

/** The dialog card, so the shot is the surface plus its footer rather than the app. */
const DIALOG = '[role="dialog"], [role="alertdialog"]';

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

const SEEDED_RECIPE = {
  id: "recipe-review",
  name: "Claude + Codex pair",
  terminals: [
    { type: "claude", title: "Claude", env: {}, initialPrompt: "" },
    { type: "codex", title: "Codex", env: {}, initialPrompt: "" },
  ],
  createdAt: 1775381905486,
  showInEmptyState: true,
};

/** Minimal repo carrying one saved recipe, so the delete/edit paths have a target. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-confirm-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");

  mkdirSync(path.join(dir, ".daintree", "recipes"), { recursive: true });
  writeFileSync(
    path.join(dir, ".daintree", "recipes", `${SEEDED_RECIPE.id}.json`),
    JSON.stringify(SEEDED_RECIPE, null, 2)
  );

  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  git("checkout develop", dir);

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

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/**
 * Every built-in theme. Switching themes in place crashes the project view under this
 * harness (same constraint as worktree-dialog-review), so the sweep boots once per theme:
 *
 *   for t in <these ids>; do
 *     DAINTREE_SHOT_CONFIRM=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     npx playwright test --project=screenshots confirm-dialog-review
 *   done
 */
export const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    console.warn(`[confirm-shots] step "${name}" skipped:`, String(error).slice(0, 300));
  }
}

async function escapeAll(page: Page, times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 150);
  }
}

/** Project settings -> Recipes, where the recipe dialogs live. */
async function openRecipesTab(page: Page): Promise<void> {
  await dismissBlockingPalette(page);
  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  await page
    .locator(SEL.projectSwitcher.palette)
    .waitFor({ state: "visible", timeout: 6000 })
    .catch(() => {});
  await page.locator(SEL.projectSwitcher.projectSettings).click();
  await page
    .locator(SEL.projectSettings.heading)
    .waitFor({ state: "visible", timeout: 8000 })
    .catch(() => {});
  await page.locator(SEL.projectSettings.recipesTab).click();
  await settle(page, 500);
}

async function closeProjectSettings(page: Page): Promise<void> {
  await page
    .locator(SEL.projectSettings.closeButton)
    .click()
    .catch(() => {});
  await settle(page, 300);
}

test("dialog primary-action review — contrast CTA and destructive precedence", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CONFIRM is required for the dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_CONFIRM to run the dialog capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-confirmshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    // 1. The central resolver. Whatever this footer paints is what every
    //    non-destructive ConfirmDialog in the app paints.
    await step("preset", async () => {
      await navigateToAgentSettings(page, "claude");
      await page
        .locator(SEL.preset.section)
        .locator(SEL.preset.addButton)
        .click({ force: true, noWaitAfter: true });
      await page
        .locator('[data-testid="add-preset-dialog"]')
        .waitFor({ state: "visible", timeout: 6000 });
      await snap(page, "10-primary-action-resolver", '[data-testid="add-preset-dialog"]');
      await snap(page, "11-primary-action-in-window");
      await escapeAll(page);
      await page
        .locator(SEL.settings.closeButton)
        .click()
        .catch(() => {});
      await settle(page, 400);
    });

    await step("editor", async () => {
      await openRecipesTab(page);
      await page.locator(SEL.projectSettings.addRecipeButton).click();
      await settle(page, 600);
      await snap(page, "20-handwritten-footer-editor", DIALOG);
    });

    // 2. Nested destructive confirm stacked over the editor: two dialog surfaces,
    //    and the confirm must still read as destructive.
    await step("discard", async () => {
      await page
        .locator(SEL.recipeEditor.nameInput)
        .fill("Review sweep")
        .catch(() => {});
      await settle(page, 250);
      await page.locator(SEL.recipeEditor.cancelButton).first().click();
      await page
        .getByRole("alertdialog")
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
      await snap(page, "30-nested-destructive-confirm");
      await escapeAll(page);
    });

    await step("import", async () => {
      await escapeAll(page);
      await openRecipesTab(page);
      await page.getByRole("button", { name: "Import recipe" }).click();
      await settle(page, 500);
      await snap(page, "40-handwritten-footer-import", DIALOG);
      await escapeAll(page);
    });

    // 3. The precedence check the issue calls out: destructive must not become contrast.
    await step("destructive", async () => {
      await openRecipesTab(page);
      await page
        .locator(SEL.projectSettings.deleteRecipeButton(SEEDED_RECIPE.name))
        .click({ force: true });
      await page
        .getByRole("alertdialog")
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
      await snap(page, "50-destructive-confirm", DIALOG);
      await snap(page, "51-destructive-in-window");
      await escapeAll(page);
      await closeProjectSettings(page);
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
