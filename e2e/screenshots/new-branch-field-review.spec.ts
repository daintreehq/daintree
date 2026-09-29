/**
 * New-worktree dialog, branch-name and path fields — visual-review harness.
 *
 * Captures the states the fields' keyboard contract lives in: the prefix
 * suggestion list at rest, arrowed, and after a keystroke shrinks it; the
 * fields holding a path-like name (spellcheck); and a failed Create from the
 * button and from Cmd/Ctrl+Enter. Beside each PNG it writes a JSON sidecar with
 * where focus is and whether the combobox's active descendant resolves, since
 * neither is reliably visible at a glance.
 *
 * Opt-in only; skips itself unless DAINTREE_SHOT_NEW_BRANCH is set. Switching
 * themes in place crashes the project view under the harness, so one boot per
 * theme:
 *
 *   DAINTREE_SHOT_NEW_BRANCH=1 DESIGN_CAPTURE_DIR=/abs/dir DAINTREE_SHOT_THEME=bondi \
 *     npx playwright test --project=screenshots new-branch-field-review
 *
 * Every step throws on failure rather than skipping, and every PNG is checked
 * for existence after it is written, so a green run means every state exists.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_NEW_BRANCH;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEME = process.env.DAINTREE_SHOT_THEME ?? "daintree";
const PANEL = `${SEL.worktree.newDialog} > div`;
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-newbranch-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
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

async function probe(page: Page) {
  return page.evaluate(() => {
    const input = document.getElementById("new-branch") as HTMLInputElement | null;
    const active = input?.getAttribute("aria-activedescendant") ?? null;
    const focused = document.activeElement as HTMLElement | null;
    return {
      focusedId: focused?.id || focused?.getAttribute("data-testid") || focused?.tagName || null,
      branchValue: input?.value ?? null,
      listOpen: input?.getAttribute("aria-expanded") === "true",
      options: Array.from(document.querySelectorAll('#prefix-list [role="option"]')).map(
        (o) => o.textContent
      ),
      activeDescendant: active,
      activeDescendantResolves: active ? !!document.getElementById(active) : null,
      branchSpellcheck: input?.spellcheck ?? null,
      pathSpellcheck:
        (document.getElementById("worktree-path") as HTMLInputElement | null)?.spellcheck ?? null,
    };
  });
}

async function snap(page: Page, slug: string, full = false): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}-${THEME}.png`);
  if (full) {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  } else {
    await page.locator(PANEL).first().screenshot({ path: file, type: "png" });
  }
  writeFileSync(
    path.join(OUTPUT_DIR, `${slug}-${THEME}.json`),
    JSON.stringify(await probe(page), null, 2)
  );
  if (!existsSync(file) || statSync(file).size === 0) throw new Error(`no capture for ${slug}`);
}

async function openDialog(page: Page): Promise<void> {
  await page.locator(SEL.worktree.newWorktreeButton).click();
  const palette = page.locator(SEL.worktree.quickCreatePalette);
  if (await palette.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.locator(SEL.worktree.quickCreateCustomize).click();
  }
  await page.locator(SEL.worktree.newDialog).waitFor({ state: "visible", timeout: 6000 });
  await page.locator(SEL.worktree.branchNameInput).waitFor({ state: "visible", timeout: 6000 });
  await settle(page, 600);
}

async function closeDialog(page: Page): Promise<void> {
  const dialog = page.locator(SEL.worktree.newDialog);
  const discard = page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes", exact: true });
  for (let i = 0; i < 5; i++) {
    if (!(await dialog.isVisible().catch(() => false))) return;
    if (await discard.isVisible({ timeout: 500 }).catch(() => false)) {
      await discard.click();
      await settle(page, 300);
      continue;
    }
    await page.keyboard.press("Escape");
    await settle(page, 300);
  }
  await dialog.waitFor({ state: "hidden", timeout: 2000 });
}

async function typeBranch(page: Page, text: string): Promise<void> {
  const input = page.locator(SEL.worktree.branchNameInput);
  await input.click();
  await input.fill("");
  await page.keyboard.type(text, { delay: 60 });
  await settle(page, 300);
}

test("new-worktree dialog — branch and path field keyboard states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_NEW_BRANCH is required for the field capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_NEW_BRANCH to run the capture");
  if (!OUTPUT_DIR) throw new Error("DESIGN_CAPTURE_DIR is required");
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-newbranchshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: "2",
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await dismissBlockingPalette(page);
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    // Prefix list: open, arrowed to the second row, then shrunk by a keystroke.
    await openDialog(page);
    await typeBranch(page, "d");
    await expect(page.locator('#prefix-list [role="option"]')).toHaveCount(2);
    await snap(page, "10-prefix-open", true);
    await page.keyboard.press("ArrowDown");
    await snap(page, "11-prefix-arrowed", true);
    await page.keyboard.type("o");
    await expect(page.locator('#prefix-list [role="option"]')).toHaveCount(1);
    await snap(page, "12-prefix-shrunk", true);
    await page.keyboard.press("Tab");
    await snap(page, "13-prefix-shrunk-tab", true);
    await closeDialog(page);

    // Spellcheck: a path-like name Chromium's dictionary rejects.
    await openDialog(page);
    await typeBranch(page, "feature/add-usr-authn-refactr");
    const pathInput = page.locator("#worktree-path");
    await pathInput.click();
    await pathInput.press("End");
    await page.keyboard.type("-wrkspce", { delay: 40 });
    await page.locator("h3", { hasText: "Destination" }).first().click();
    await settle(page, 1500);
    await snap(page, "20-spellcheck");
    await closeDialog(page);

    // Failed Create from the button: an empty name.
    await openDialog(page);
    await page.locator(SEL.worktree.branchNameInput).fill("");
    await page.locator("#worktree-path").click();
    await page.locator(SEL.worktree.createButton).click();
    await settle(page, 500);
    await snap(page, "30-failed-create-name");
    await closeDialog(page);

    // Failed Create from the keyboard: a valid name, an emptied path, focus
    // left on the name field. A name with a slash never opens the prefix list,
    // so no Escape is needed (one would reach the dialog and close it).
    await openDialog(page);
    await typeBranch(page, "feature/streaming-uploads");
    await page.locator("#worktree-path").fill("");
    await page.locator(SEL.worktree.branchNameInput).click();
    await page.keyboard.press(`${MOD}+Enter`);
    await settle(page, 500);
    await snap(page, "31-failed-create-path");
    await closeDialog(page);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
