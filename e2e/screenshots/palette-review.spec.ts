/**
 * Palette visual-review harness.
 *
 * Opens a representative slice of the palette family and writes a tightly-cropped
 * PNG of each, so the shared design language can be judged against rendered
 * pixels instead of token names. Sibling of `theme-review.spec.ts`, which covers
 * app chrome broadly; this one goes deep on one family across every theme.
 *
 * Nine steps, covering both hosts (modal + anchored popover) and the range of
 * body content (rows, groups, rich rows, empty states). Palettes that need a
 * seeded state to render anything — panel palette, fleet picker, send-to-agent,
 * prompt history — are not captured; they take the same shared chrome, and the
 * modal-vs-dropdown assertion below is what actually guards it.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set, so the marketing
 * screenshots workflow never executes it.
 *
 *   DAINTREE_SHOT_THEME=daintree npx playwright test --project=screenshots palette-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. daintree, bondi)
 *   DAINTREE_SHOT_TAG    optional suffix to keep before/after rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (see step names below)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: artifacts/palette-shots/<theme>/<NN-slug>[-tag].png (gitignored).
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
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "palette-shots", THEME || "unset");

const MOD = process.platform === "darwin" ? "Meta" : "Control";

// Freeze animations and hide carets so captures are deterministic. Palettes
// zoom and fade on entry; a mid-transition frame reads as a design flaw that
// isn't there.
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

/** Repo with a handful of worktrees so palettes have real rows to render. */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-palette-shots-"));
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
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n");

  for (const branch of [
    "feature/oauth-device-flow",
    "feature/streaming-tokens",
    "fix/retry-backoff-jitter",
  ]) {
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

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Clip to the palette plus a margin, so the capture carries the surface edge,
 * its shadow and the scrim immediately behind it — the three things that make a
 * floating surface read as elevated. An element screenshot would crop exactly
 * at the border and hide all of it.
 */
async function snapSurface(page: Page, slug: string, selector: string, pad = 48): Promise<void> {
  await settle(page);
  const box = await page.locator(selector).first().boundingBox();
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (!box) {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
    return;
  }
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

/**
 * The properties that make a palette read as one surface. Deliberately not the
 * shadow: the modal sits above a scrim and is allowed to cast further than the
 * anchored dropdown.
 */
interface SurfaceStyle {
  backgroundColor: string;
  borderColor: string;
  borderWidth: string;
  borderRadius: string;
  width: string;
}

async function surfaceStyle(page: Page, selector: string): Promise<SurfaceStyle> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        backgroundColor: s.backgroundColor,
        borderColor: s.borderTopColor,
        borderWidth: s.borderTopWidth,
        borderRadius: s.borderTopLeftRadius,
        width: s.width,
      };
    });
}

/**
 * Run a capture step. A failure never stops the remaining shots — one missing
 * surface should not cost the whole sweep — but it IS recorded, and the test
 * fails at the end. Swallowing outright made a run that captured nothing report
 * green. The overlay is always dismissed, so a step that dies mid-flight can't
 * leave a palette open on top of the next one.
 */
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[palette-shots] step "${name}" FAILED:`, detail);
    stepFailures.push(`${name}: ${detail}`);
    await closeOverlay(page).catch(() => {});
  }
}

/**
 * Double-Shift first, then the canonical `action.palette.open` binding as the
 * fallback. NOT Cmd+K — that starts a chord and raises the command HUD, which
 * then sits on top of whatever is captured next.
 *
 * The gate has to be `waitFor`, not `isVisible`: the latter resolves against the
 * current DOM without waiting, so it reports false during the palette's own
 * mount frame and the fallback fires on top of an already-open palette.
 */
async function openCommandPalette(page: Page): Promise<void> {
  const dialog = page.locator(SEL.actionPalette.dialog);
  await page.keyboard.press("Shift");
  await page.keyboard.press("Shift");
  const opened = await dialog
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    await page.keyboard.press(`${MOD}+Shift+P`);
    await dialog.waitFor({ state: "visible", timeout: 5000 });
  }
}

/**
 * Runs an action by its palette title. Waits for the named row to actually rank
 * first before committing — pressing Enter on whatever the ranked list happened
 * to hold mid-keystroke fires the wrong action.
 */
async function runAction(page: Page, title: string): Promise<void> {
  await openCommandPalette(page);
  await page.locator(SEL.actionPalette.searchInput).fill(title);
  const first = page.locator(SEL.actionPalette.options).first();
  await expect(first).toContainText(title, { timeout: 5000 });
  await page.keyboard.press("Enter");
  await settle(page, 400);
}

/** Opens a terminal and minimises it so the dock (and its launcher) renders. */
let dockReady = false;
async function ensureDock(page: Page): Promise<void> {
  if (dockReady) return;
  await page.locator(SEL.toolbar.openTerminal).click();
  await page.locator(SEL.panel.gridPanel).first().waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 1500);
  // `waitFor`, not `isVisible({timeout})` — the latter probes the current DOM
  // and ignores its timeout, so the dock would be declared ready on a frame
  // where the control had not mounted yet.
  const minimize = page.locator(SEL.panel.minimize).first();
  await minimize.waitFor({ state: "visible", timeout: 5000 });
  await minimize.click();
  await settle(page, 1000);
  dockReady = true;
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await settle(page, 250);
  await page.keyboard.press("Escape").catch(() => {});
  await settle(page, 200);
}

test("palette review — every surface in the family", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the palette-review capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the palette-review capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  // Prefix deliberately avoids "daintree-e2e" — launchApp's pre-launch hygiene
  // pkills that pattern, and parallel theme captures would SIGKILL each other.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-paletteshot-"));
  let ctx: AppContext | undefined;
  // Captured by the two project-switcher steps and compared after every step
  // has run, so a capture failure stays non-fatal while the drift check does
  // not (the `step` wrapper swallows throws by design).
  let dropdownSurface: SurfaceStyle | undefined;
  let modalSurface: SurfaceStyle | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
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
    await settle(page, 2500);
    await dismissBlockingPalette(page);

    // 1. Project switcher dropdown — the reference surface. Everything else in
    // the family is being aligned to this one.
    await step(page, "project-dropdown", async () => {
      await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
      await page.locator(SEL.projectSwitcher.palette).waitFor({ state: "visible", timeout: 5000 });
      await snapSurface(page, "10-project-dropdown", SEL.projectSwitcher.palette);
      dropdownSurface = await surfaceStyle(page, SEL.projectSwitcher.palette);
      await closeOverlay(page);
    });

    // 2. Project switcher modal (Cmd+Alt+P) — same content, dialog host.
    //
    // This pair is the whole point of the unification: one palette, two hosts.
    // The capture is for eyeballing, the assertion is what actually holds the
    // line — if the dialog ever drifts back onto its own fill or border, the
    // themes all drift with it and no screenshot review would catch every one.
    await step(page, "project-modal", async () => {
      const selector = '[role="dialog"][aria-label="Project switcher"]';
      await page.keyboard.press(`${MOD}+Alt+P`);
      await page.locator(selector).waitFor({ state: "visible", timeout: 5000 });
      await snapSurface(page, "11-project-modal", selector);
      modalSurface = await surfaceStyle(page, selector);
      await closeOverlay(page);
    });

    // 3. Pilot "All agents" (Cmd+Alt+O).
    await step(page, "pilot", async () => {
      await page.keyboard.press(`${MOD}+Alt+O`);
      const dialog = page.locator('[role="dialog"][aria-label="All agents"]');
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      await snapSurface(page, "12-pilot-all-agents", '[role="dialog"][aria-label="All agents"]');
      await closeOverlay(page);
    });

    // 4. Command palette. Double-Shift is the primary opener; Cmd+K is the
    // documented fallback and the one that survives a missed first press.
    await step(page, "command-palette", async () => {
      await openCommandPalette(page);
      await snapSurface(page, "13-command-palette", SEL.actionPalette.dialog);
      await page.locator(SEL.actionPalette.searchInput).fill("theme");
      await snapSurface(page, "14-command-palette-search", SEL.actionPalette.dialog);
      await closeOverlay(page);
    });

    // 5. Theme palette (Cmd+K Cmd+T).
    await step(page, "theme-palette", async () => {
      await page.keyboard.press(`${MOD}+K`);
      await settle(page, 200);
      await page.keyboard.press(`${MOD}+T`);
      const dialog = page.locator(SEL.themePalette.dialog);
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      await snapSurface(page, "16-theme-palette", SEL.themePalette.dialog);
      await closeOverlay(page);
    });

    // 6. New-terminal palette. Dispatched directly rather than driven through
    // the command palette: the action's own row activates whatever the ranked
    // list put first, which is not reliably this palette.
    await step(page, "new-terminal", async () => {
      await page.evaluate(() =>
        window.dispatchEvent(new Event("daintree:open-new-terminal-palette"))
      );
      const dialog = page.locator(SEL.newTerminalPalette.dialog);
      await dialog.waitFor({ state: "visible", timeout: 5000 });
      await snapSurface(page, "19-new-terminal", SEL.newTerminalPalette.dialog);
      await closeOverlay(page);
    });

    // 7. Worktree quick-create palette. Driven through the command palette:
    // the sidebar's own create control is a split button whose label changes
    // with the worktree selection, so the action name is the stable handle.
    await step(page, "quick-create", async () => {
      await runAction(page, "Quick Create Worktree");
      const palette = page.locator(SEL.worktree.quickCreatePalette);
      await palette.waitFor({ state: "visible", timeout: 5000 });
      await snapSurface(page, "17-quick-create", SEL.worktree.quickCreatePalette);
      await closeOverlay(page);
    });

    // 8. Dock quick launcher popover. The dock only renders once a panel has
    // been minimised into it, so open a terminal and minimise it first.
    await step(page, "dock-launcher", async () => {
      await ensureDock(page);
      await page.locator('[aria-label="Open launcher"]').first().click();
      const popover = page.locator('[role="dialog"][aria-label="Launch"]');
      await popover.waitFor({ state: "visible", timeout: 5000 });
      await snapSurface(page, "15-dock-launcher", '[role="dialog"][aria-label="Launch"]');
      await closeOverlay(page);
    });

    // 9. Resume-sessions palette. Captured in its empty state: a docked panel's
    // close only dismisses the preview and leaves the PTY running, so there is
    // no cheap way to seed a genuinely closed session here. The chrome — header,
    // search, empty state, footer — is what this harness is reviewing, and that
    // all renders.
    await step(page, "resume-sessions", async () => {
      await ensureDock(page);
      const resumeButton = page.locator('[aria-label="Resume session"]').first();
      await resumeButton.waitFor({ state: "visible", timeout: 5000 });
      await resumeButton.click({ timeout: 8000 });
      const selector = '[role="dialog"][aria-label="Resume session"]';
      await page.locator(selector).waitFor({ state: "visible", timeout: 5000 });
      await snapSurface(page, "18-resume-sessions", selector);
      await closeOverlay(page);
    });

    // One palette, two hosts: the modal and the dropdown render the same
    // component and must be cut from the same material in every theme. Shadow
    // is deliberately out of the comparison — the modal floats over a scrim and
    // carries `shadow-modal`, one step above the dropdown's `shadow-overlay`.
    //
    // Width is out of it too, and now carries its own assertion: the ⌘P modal
    // is the command tier and the title-bar dropdown is anchored, so the same
    // content deliberately gets a box scaled to how the user reached it.
    if (dropdownSurface && modalSurface) {
      const { width: modalWidth, ...modalMaterial } = modalSurface;
      const { width: dropdownWidth, ...dropdownMaterial } = dropdownSurface;
      expect(modalMaterial, `palette material drifted between hosts in "${THEME}"`).toEqual(
        dropdownMaterial
      );
      expect(
        parseFloat(modalWidth),
        `the command-tier modal should be wider than the anchored dropdown in "${THEME}"`
      ).toBeGreaterThan(parseFloat(dropdownWidth));
    } else if (ONLY.length === 0) {
      stepFailures.push("surface drift check: a project-switcher capture did not run");
    }

    expect(stepFailures, `palette capture steps failed in "${THEME}"`).toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
