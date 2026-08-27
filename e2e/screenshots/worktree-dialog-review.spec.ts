/**
 * New-worktree dialog visual-review harness.
 *
 * Boots a small fixture repo with a few branches and recipes, opens the create
 * dialog, and writes PNGs of every state that carries design weight (rest,
 * existing-branch mode, open branch picker, linked issue, validation error) so
 * the dialog redesign can be judged against real rendered pixels.
 *
 * Opt-in only, like theme-review: skips itself unless DAINTREE_SHOT_DIALOG is
 * set, so the marketing screenshots workflow never executes it.
 *
 *   DAINTREE_SHOT_DIALOG=1 npx playwright test --project=screenshots worktree-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DIALOG  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME   optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG     optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY    comma-separated step filter (see step names below)
 *
 * Output: artifacts/dialog-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, type Page } from "@playwright/test";
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

const ENABLED = !!process.env.DAINTREE_SHOT_DIALOG;
/** The testid sits on the backdrop; the panel is its first child. */
const PANEL = `${SEL.worktree.newDialog} > div`;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "dialog-shots");

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

const RECIPES = [
  {
    id: "recipe-pair",
    name: "Claude + Codex pair",
    terminals: [
      { type: "claude", title: "Claude", env: {}, initialPrompt: "" },
      { type: "codex", title: "Codex", env: {}, initialPrompt: "" },
    ],
    createdAt: 1775381905486,
    showInEmptyState: true,
  },
  {
    id: "recipe-work",
    name: "Work the issue",
    terminals: [{ type: "claude", title: "Work", env: {}, initialPrompt: "/work {{number}}" }],
    createdAt: 1775381905487,
    showInEmptyState: false,
  },
];

/** Repo with a realistic branch list and a couple of saved recipes. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-dialog-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = (): number => 0;\n");

  mkdirSync(path.join(dir, ".daintree", "recipes"), { recursive: true });
  for (const recipe of RECIPES) {
    writeFileSync(
      path.join(dir, ".daintree", "recipes", `${recipe.id}.json`),
      JSON.stringify(recipe, null, 2)
    );
  }

  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  for (const branch of [
    "feature/streaming-uploads",
    "fix/retry-backoff-jitter",
    "chore/bump-electron",
    "release/v0.22.0",
  ]) {
    git(`branch ${branch}`, dir);
  }
  git("checkout develop", dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/**
 * Every built-in theme. Switching themes in place crashes the project view
 * under this harness, so the cross-theme sweep boots once per theme:
 *
 *   for t in <these ids>; do
 *     DAINTREE_SHOT_DIALOG=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     DAINTREE_SHOT_ONLY=populated npx playwright test --project=screenshots \
 *     worktree-dialog-review
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
    console.warn(`[dialog-shots] step "${name}" skipped:`, String(error).slice(0, 300));
  }
}

/** Open the create dialog from a clean workbench, routing past the quick-create palette. */
async function openDialog(page: Page): Promise<void> {
  await page.locator(SEL.worktree.newWorktreeButton).click();
  const palette = page.locator(SEL.worktree.quickCreatePalette);
  if (await palette.isVisible({ timeout: 3000 }).catch(() => false)) {
    const customize = page.locator(SEL.worktree.quickCreateCustomize);
    if (await customize.isVisible({ timeout: 2000 }).catch(() => false)) {
      await customize.click();
    }
  }
  await page
    .locator(SEL.worktree.newDialog)
    .waitFor({ state: "visible", timeout: 6000 })
    .catch(() => {});
  await settle(page, 600);
}

async function closeDialog(page: Page): Promise<void> {
  const dialog = page.locator(SEL.worktree.newDialog);
  // Scoped to the dialog: two other "Discard" buttons live in settings.
  const discard = dialog.getByRole("button", { name: "Discard", exact: true });

  for (let i = 0; i < 4; i++) {
    if (!(await dialog.isVisible().catch(() => false))) return;
    // A dialog with edits answers Escape with "Discard unsaved changes?" rather
    // than closing, which otherwise strands every later step behind it. Clear
    // that prompt before pressing Escape again — a second Escape cancels the
    // prompt instead, and the loop would chase its own tail.
    if (await discard.isVisible({ timeout: 500 }).catch(() => false)) {
      await discard.click().catch(() => {});
      await settle(page, 300);
      continue;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 300);
  }

  // Silence here would hand every later step a dialog it did not open.
  await dialog.waitFor({ state: "hidden", timeout: 2000 });
}

test("new-worktree dialog review — rest and interactive states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DIALOG is required for the dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_DIALOG to run the dialog capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-dialogshot-"));
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
    await settle(page, 2500);
    await dismissBlockingPalette(page);

    // 1. Rest state — the shot the whole redesign is judged on.
    await step("rest", async () => {
      await openDialog(page);
      await snap(page, "10-rest", PANEL);
      await snap(page, "11-rest-in-window");
      await closeDialog(page);
    });

    // 2. Populated — the real working state, and the only one that renders the
    // footer's base -> branch preview.
    await step("populated", async () => {
      await openDialog(page);
      const input = page.locator(SEL.worktree.branchNameInput);
      await input.click().catch(() => {});
      await input.fill("feature/streaming-uploads-v2").catch(() => {});
      await page
        .locator("h3", { hasText: "Destination" })
        .first()
        .click()
        .catch(() => {});
      await settle(page, 900);
      await snap(page, "15-populated", PANEL);
      await closeDialog(page);
    });

    // 2b. Long branch name — the footer echo has to crop rather than push the
    // action buttons out of the dialog.
    await step("long-branch", async () => {
      await openDialog(page);
      const input = page.locator(SEL.worktree.branchNameInput);
      await input.click().catch(() => {});
      await input.fill("feature/issue-12015-roll-redacted-payload-foo-bar-car").catch(() => {});
      await page
        .locator("h3", { hasText: "Destination" })
        .first()
        .click()
        .catch(() => {});
      await settle(page, 900);
      await snap(page, "16-long-branch", PANEL);
      await closeDialog(page);
    });

    // 3. Existing-branch mode — the other half of the branch control.
    await step("existing", async () => {
      await openDialog(page);
      await page
        .locator(`${SEL.worktree.branchModeGroup} [role="radio"]`)
        .last()
        .click()
        .catch(() => {});
      await settle(page, 400);
      await snap(page, "20-existing-branch", PANEL);
      await closeDialog(page);
    });

    // 3. Base-branch picker open — popover surface against the dialog surface.
    await step("picker", async () => {
      await openDialog(page);
      await page
        .locator(SEL.worktree.baseBranchTrigger)
        .click()
        .catch(() => {});
      await settle(page, 500);
      await snap(page, "30-base-branch-picker");
      await closeDialog(page);
    });

    // 4. Validation error — the error surface in context.
    await step("error", async () => {
      await openDialog(page);
      const input = page.locator(SEL.worktree.branchNameInput);
      await input.click().catch(() => {});
      await input.fill("").catch(() => {});
      await settle(page, 300);
      await page
        .locator(SEL.worktree.createButton)
        .click()
        .catch(() => {});
      await settle(page, 800);
      await snap(page, "40-validation-error", PANEL);
      await closeDialog(page);
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
