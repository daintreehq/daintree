/**
 * Theme visual-review harness.
 *
 * Boots a rich multi-worktree fixture, switches to the requested theme, and
 * writes PNGs of the workbench plus secondary chrome (tooltips, menus,
 * dialogs, hover states, diff view, settings, terminal) so theme work can be
 * judged against real rendered pixels instead of token values. Built for the
 * light-theme redesign series (#9711); any theme pass should start here.
 *
 * Opt-in only: the spec skips itself unless DAINTREE_SHOT_THEME is set, so
 * the marketing screenshots workflow (which runs the whole `screenshots`
 * project) never executes it.
 *
 *   DAINTREE_SHOT_THEME=bondi npx playwright test --project=screenshots theme-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. bondi, daintree)
 *   DAINTREE_SHOT_TAG    optional suffix to keep multiple rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (see step names below)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: artifacts/theme-shots/<theme>/<NN-slug>[-tag].png (gitignored).
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

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "theme-shots", THEME || "unset");

// Freeze animations and hide carets so captures are deterministic.
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

/** Repo with a main worktree + several feature worktrees in varied states. */
function createRichRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-theme-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    'export function main(): number {\n  // entry point\n  const greeting = "hello";\n  console.log(greeting);\n  return 0;\n}\n'
  );
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  // Dirty main worktree: a modified file + a new file → diff view content.
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    'export function main(): number {\n  // entry point with retries\n  const greeting = "hello again";\n  const retries = 3;\n  console.log(greeting, retries);\n  return retries;\n}\n'
  );
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n\n- redesign pass\n");

  const features = [
    { branch: "feature/oauth-device-flow", dirty: true, commits: 2 },
    { branch: "feature/streaming-tokens", dirty: false, commits: 1 },
    { branch: "fix/retry-backoff-jitter", dirty: true, commits: 3 },
    { branch: "chore/bump-electron-41", dirty: false, commits: 1 },
  ];
  for (const f of features) {
    const slug = f.branch.replace(/[/]/g, "-");
    const wtDir = path.join(wtRoot, slug);
    git(`branch ${f.branch}`, dir);
    git(`worktree add ${JSON.stringify(wtDir)} ${f.branch}`, dir);
    for (let i = 0; i < f.commits; i++) {
      writeFileSync(path.join(wtDir, `change-${i}.md`), `change ${i} on ${f.branch}\n`);
      git("add -A", wtDir);
      git(`commit -m "work ${i} on ${slug}"`, wtDir);
    }
    if (f.dirty) {
      writeFileSync(path.join(wtDir, "wip.txt"), "in progress\n");
      writeFileSync(path.join(wtDir, "src", "index.ts"), `// ${slug}\nexport const x = 1;\n`);
    }
  }

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 600): Promise<void> {
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

/** Run a capture step; failures are logged, not fatal — later shots still run. */
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    console.warn(`[theme-shots] step "${name}" skipped:`, String(error).slice(0, 200));
  }
}

test("theme review — chrome, overlays, states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the theme-review capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the theme-review capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRichRepo();
  // Own userData dir with a prefix that does NOT contain "daintree-e2e":
  // launchApp's pre-launch hygiene pkills `node_modules/electron.*daintree-e2e`,
  // so concurrent capture sessions (parallel theme worktrees on one machine)
  // would SIGKILL each other's freshly-launching app mid-poll. A distinct
  // prefix keeps this spec out of that blast radius. launchApp skips
  // auto-cleanup for caller-provided dirs, so remove it in the finally.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-themeshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      // GPU + crashpad mitigations: local macOS Electron screenshot runs hit
      // recurring crashpad/GPU-process FATALs without these.
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id)
        await window.electron.project.update(cur.id, { emoji: "☀️", name: "Helios Dashboard" });
    });
    await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 3000);
    await dismissBlockingPalette(page);

    // 1. Baseline workbench.
    await step("workbench", () => snap(page, "10-workbench"));

    // 2. Tooltip on a toolbar control.
    await step("tooltip", async () => {
      await page.locator(SEL.toolbar.toggleSidebar).hover();
      await page.waitForTimeout(1200);
      await snap(page, "11-tooltip-toolbar");
      await page.mouse.move(800, 600);
    });

    // 3. Hover state on an idle worktree card.
    await step("card-hover", async () => {
      await page.locator('[data-worktree-branch="fix/retry-backoff-jitter"]').first().hover();
      await page.waitForTimeout(400);
      await snap(page, "12-sidebar-card-hover", SEL.sidebar.aside);
      await page.mouse.move(800, 600);
    });

    // 4. Worktree card context menu.
    await step("context-menu", async () => {
      await page.locator(SEL.worktree.mainCard).click({ button: "right" });
      await page.locator('[role="menu"]').waitFor({ state: "visible", timeout: 4000 });
      await settle(page, 400);
      await snap(page, "13-context-menu");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 5. Sidebar search active (typed query).
    await step("search-active", async () => {
      const search = page.locator(SEL.worktree.searchInput);
      await search.click();
      await search.fill("retry");
      await settle(page, 600);
      await snap(page, "14-sidebar-search", SEL.sidebar.aside);
      await page
        .locator(SEL.worktree.searchClear)
        .click()
        .catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 300);
    });

    // 5b. Worktree filter/sort popover.
    await step("filter-popover", async () => {
      await page.locator(SEL.worktree.filterButton).click();
      await page.locator(SEL.worktree.filterPopover).waitFor({ state: "visible", timeout: 4000 });
      await settle(page, 400);
      await snap(page, "24-filter-popover");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 5c. Project switcher palette.
    await step("project-switcher", async () => {
      await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
      await settle(page, 600);
      await snap(page, "25-project-switcher");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 6. Action palette.
    await step("action-palette", async () => {
      await page.keyboard.press("Shift");
      await page.keyboard.press("Shift");
      const dialog = page.locator(SEL.actionPalette.dialog);
      if (!(await dialog.isVisible({ timeout: 2500 }).catch(() => false))) {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
      }
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      await page.locator(SEL.actionPalette.searchInput).fill("theme");
      await settle(page, 600);
      await snap(page, "17-action-palette");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 7. Notifications popover.
    await step("notifications", async () => {
      await page.locator(SEL.notifications.bellButton).click();
      await settle(page, 600);
      await snap(page, "18-notifications");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 8. Review hub / diff view for the dirty main worktree.
    await step("review-hub", async () => {
      await page.locator(SEL.worktree.mainCard).hover();
      await settle(page, 300);
      const btn = page.locator(SEL.worktree.reviewHubButton).first();
      await btn.waitFor({ state: "visible", timeout: 4000 });
      await btn.click();
      await page.locator(SEL.reviewHub.container).waitFor({ state: "visible", timeout: 15_000 });
      await settle(page, 1500);
      await snap(page, "19-review-hub");
      const diffBtn = page.locator(SEL.reviewHub.fileDiffButton("src/index.ts"));
      if (await diffBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        await diffBtn.click();
        await settle(page, 1200);
        await snap(page, "20-diff-view");
      }
      // The diff layers above the review rather than replacing it (#11243),
      // so unwind the stack top-down before moving on to the next step.
      await page
        .locator(SEL.reviewHub.diffDialogClose)
        .click()
        .catch(() => {});
      await settle(page, 300);
      await page
        .locator(SEL.reviewHub.close)
        .click()
        .catch(() => {});
      await settle(page, 300);
    });

    // 9. Settings dialog (toolbar button first, shortcut fallback).
    await step("settings", async () => {
      const openSettings = page.locator(SEL.toolbar.openSettings);
      if (await openSettings.isVisible({ timeout: 2500 }).catch(() => false)) {
        await openSettings.click();
      } else {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      }
      await page.locator(SEL.settings.heading).waitFor({ state: "visible", timeout: 8000 });
      await settle(page, 1200);
      await snap(page, "21-settings");
      // Appearance tab — theme preview cards are a major theme surface.
      const appearanceNav = page.getByRole("tab", { name: "Appearance" }).first();
      if (await appearanceNav.isVisible({ timeout: 2500 }).catch(() => false)) {
        await appearanceNav.click();
        await settle(page, 1200);
        await snap(page, "26-settings-appearance");
      }
      // Typed settings search — input field + result highlighting.
      const settingsSearch = page.locator(SEL.settings.searchInput);
      if (await settingsSearch.isVisible({ timeout: 2000 }).catch(() => false)) {
        await settingsSearch.click();
        await settingsSearch.fill("theme");
        await settle(page, 800);
        await snap(page, "27-settings-search");
        await settingsSearch.clear().catch(() => {});
      }
      await page
        .locator(SEL.settings.closeButton)
        .click()
        .catch(() => {});
      await settle(page, 300);
    });

    // 10. Terminal panel + dock chip.
    await step("terminal-and-dock", async () => {
      const openTerminal = page.locator(SEL.toolbar.openTerminal);
      await openTerminal.waitFor({ state: "visible", timeout: 5000 });
      await openTerminal.click();
      await page
        .locator(SEL.panel.gridPanel)
        .first()
        .waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 2000);
      // Seed ANSI-colored output so the terminal palette is reviewable —
      // failures here must not sink the rest of the step.
      try {
        await page.locator(SEL.panel.gridPanel).first().click();
        await page.keyboard.type(
          "printf '\\e[31mred \\e[32mgreen \\e[33myellow \\e[34mblue \\e[35mmagenta \\e[36mcyan \\e[90mbright-black\\e[0m\\n'; git log --oneline --color=always | head -3; ls"
        );
        await page.keyboard.press("Enter");
        await settle(page, 1500);
      } catch {
        // plain prompt is still a usable capture
      }
      await snap(page, "22-terminal");
      // Terminal search bar (find-in-terminal chrome).
      await page.keyboard.press(process.platform === "darwin" ? "Meta+F" : "Control+F");
      const termSearch = page.locator(SEL.terminal.searchInput);
      if (await termSearch.isVisible({ timeout: 2500 }).catch(() => false)) {
        await termSearch.fill("hello");
        await settle(page, 500);
        await snap(page, "28-terminal-search");
        await page.keyboard.press("Escape");
        await settle(page, 300);
      }
      const minimize = page.locator(SEL.panel.minimize).first();
      if (await minimize.isVisible({ timeout: 2500 }).catch(() => false)) {
        await minimize.click();
        await settle(page, 1000);
        await snap(page, "23-dock");
      }
    });

    // 10b. Confirm dialog (destructive-tier chrome) — open via the worktree
    // context menu, capture, and ESCAPE without confirming.
    await step("confirm-dialog", async () => {
      await page
        .locator('[data-worktree-branch="chore/bump-electron-41"]')
        .first()
        .click({ button: "right" });
      await page.locator('[role="menu"]').waitFor({ state: "visible", timeout: 4000 });
      const deleteItem = page.getByRole("menuitem", { name: /delete/i }).first();
      await deleteItem.waitFor({ state: "visible", timeout: 3000 });
      await deleteItem.click();
      await page
        .locator('[role="alertdialog"], [role="dialog"]')
        .filter({ hasText: /delete/i })
        .last()
        .waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 500);
      await snap(page, "29-confirm-dialog");
      await page.keyboard.press("Escape");
      await settle(page, 400);
    });

    // 11. New worktree dialog — LAST: this flow has crashed the renderer in
    // local capture runs, so nothing important may run after it.
    await step("new-worktree-dialog", async () => {
      await page.locator(SEL.worktree.newWorktreeButton).click();
      const palette = page.locator(SEL.worktree.quickCreatePalette);
      if (await palette.isVisible({ timeout: 3000 }).catch(() => false)) {
        await snap(page, "15-quick-create-palette");
        const customize = page.locator(SEL.worktree.quickCreateCustomize);
        if (await customize.isVisible({ timeout: 1500 }).catch(() => false)) {
          await customize.click();
          await page
            .locator(SEL.worktree.newDialog)
            .waitFor({ state: "visible", timeout: 4000 })
            .catch(() => {});
          await settle(page, 500);
          await snap(page, "16-new-worktree-dialog");
        }
      }
      await page.keyboard.press("Escape");
      await settle(page, 300);
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 200);
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
