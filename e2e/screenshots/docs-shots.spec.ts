/**
 * Documentation screenshot pipeline — daintree.org/docs.
 *
 * Distinct from `store-reel.spec.ts` in intent. The marketing reel captures
 * six hero frames, one per demo repo, and each frame sells the product. This
 * spec captures the *reference* images the documentation pages hang off:
 * many small, exact UI states, driven off as few app launches as possible.
 *
 * Rules it follows, from the documentation screenshot audit:
 *   - One fixture (`atlas-ledger`) so branch names are identical across every
 *     page that shows a sidebar.
 *   - No API keys, no agent runs. Every state here is deterministic and
 *     reachable offline, so the set can be recaptured on any machine.
 *   - Element and region captures where the surface is a control rather than
 *     the whole window — a popover without its trigger is ambiguous, but a
 *     popover inside a 2560px screenshot is unreadable.
 *   - A missed shot annotates and continues. A capture run that dies on its
 *     fourth state is worth less than one that lands nineteen of twenty and
 *     names the one it missed.
 *
 * Output: artifacts/docs-screenshots/<page-slug>/<filename>.png, mirroring
 * the website's static/docs/ tree so the harvest step is a plain copy.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, mockOpenDialog, refreshActiveWindow, type AppContext } from "../helpers/launch";
import { dismissTelemetryConsent } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { SAMPLE_PLUGINS_DIR, openPluginManager, activateE2EPlugin } from "../helpers/plugins";
import type { DemoRepo } from "../helpers/screenshotFixtures";

const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const WINDOW_WIDTH = Number(process.env.DAINTREE_DOCS_WIDTH ?? 1280);
const WINDOW_HEIGHT = Number(process.env.DAINTREE_DOCS_HEIGHT ?? 820);
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "docs-screenshots");

mkdirSync(OUTPUT_DIR, { recursive: true });

// `createDemoRepo` reads DAINTREE_DEMO_ROOT at call time. Setting it here
// keeps the project path in every capture free of `/private/tmp/...`.
process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

/**
 * Hide scrollbars and freeze animation so a capture never lands mid-tween.
 * `caret-color: transparent` stops a blinking cursor from being the one
 * pixel that differs between two otherwise identical runs.
 */
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

const captured: string[] = [];
const missed: Array<{ slug: string; reason: string }> = [];

async function settleFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
}

function outPath(slug: string): string {
  const file = path.join(OUTPUT_DIR, `${slug}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/**
 * Run one capture. A throw is recorded and swallowed: the scene keeps going
 * so a single unreachable state costs one image rather than the whole run.
 */
async function shot(slug: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    captured.push(slug);
    // eslint-disable-next-line no-console
    console.log(`[docs-shots] captured ${slug}`);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    missed.push({ slug, reason });
    // eslint-disable-next-line no-console
    console.log(`[docs-shots] MISSED  ${slug} — ${reason}`);
    test.info().annotations.push({ type: "docs-shot-missed", description: `${slug}: ${reason}` });
    return false;
  }
}

/** Whole-window capture. */
async function snapWindow(page: Page, slug: string): Promise<void> {
  await settleFrame(page);
  await page.screenshot({
    path: outPath(slug),
    type: "png",
    animations: "disabled",
    caret: "hide",
    timeout: 60_000,
  });
}

/**
 * Element capture, optionally padded so the surface keeps the chrome that
 * explains where it lives. Playwright clips to the element box exactly, which
 * on a popover crops away the trigger that gives it context — the padded
 * variant clips the page to the element's box grown by `pad` logical pixels.
 */
async function snapElement(
  page: Page,
  locator: Locator,
  slug: string,
  pad = 0
): Promise<void> {
  await settleFrame(page);
  if (pad === 0) {
    await locator.screenshot({ path: outPath(slug), type: "png", animations: "disabled", caret: "hide" });
    return;
  }
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  const vp = page.viewportSize() ?? { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: outPath(slug),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(vp.width - x, box.width + pad * 2),
      height: Math.min(vp.height - y, box.height + pad * 2),
    },
  });
}

/**
 * Band capture in logical pixels. The dock is the case that needs it: its
 * container element only spans the pills on the left, so an element capture
 * silently drops the Background / Waiting / Errors / Trash containers that
 * are the other half of what the dock *is*.
 */
async function snapBand(
  page: Page,
  slug: string,
  clip: { x: number; y: number; width: number; height: number }
): Promise<void> {
  await settleFrame(page);
  await page.screenshot({
    path: outPath(slug),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip,
  });
}

interface Booted {
  ctx: AppContext;
  page: Page;
}

async function boot(
  repo: DemoRepo,
  displayName: string,
  emoji: string,
  env?: Record<string, string>
): Promise<Booted> {
  const ctx = await launchApp({
    screenshotScale: SCALE,
    windowSize: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    ...(env ? { env } : {}),
  });

  await mockOpenDialog(ctx.app, repo.dir);
  await ctx.window.getByRole("button", { name: "Open folder" }).click();

  let page = await refreshActiveWindow(ctx.app, ctx.window);
  await dismissTelemetryConsent(page);
  await dismissBlockingPalette(page);
  ctx.window = page;

  try {
    await page.addStyleTag({ content: POLISH_CSS });
  } catch {
    page = await refreshActiveWindow(ctx.app, page);
    ctx.window = page;
    await page.addStyleTag({ content: POLISH_CSS });
  }

  // A kebab-case folder slug in the title bar reads as a test fixture. A
  // display name and emoji make the same window read as a real project.
  await page.evaluate(
    async (overrides) => {
      const current = await window.electron.project.getCurrent();
      if (!current?.id) return;
      await window.electron.project.update(current.id, {
        name: overrides.displayName,
        emoji: overrides.emoji,
      });
    },
    { displayName, emoji }
  );
  await page.waitForTimeout(T_SETTLE);

  page = await refreshActiveWindow(ctx.app, page);
  ctx.window = page;
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
  await dismissBlockingPalette(page);
  // Surface a seed failure rather than swallowing it: a silent throw here is
  // how v2 shipped an empty Recipe Manager.
  await seedGlobalRecipe(page);
  // In-repo recipe reconciliation can finish *after* the renderer's recipe
  // store hydrated, which leaves every recipe surface painting empty even
  // though the IPC returns three. One reload re-runs the load against the
  // settled filesystem.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await page.waitForTimeout(T_MEDIUM);
  return { ctx, page };
}

/**
 * Seed a global recipe through IPC.
 *
 * The fixture commits three recipes to `.daintree/recipes/`, which the app
 * loads as *team* recipes. The Recipe Manager documents three scopes side by
 * side, and the empty-grid launcher documents recipes as its first section —
 * neither reads correctly with only one scope populated. A global recipe
 * cannot come from the repo by definition, so it is added here.
 */
async function seedGlobalRecipe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.electron.globalRecipes.addRecipe({
      id: "global-morning-sweep",
      name: "Morning sweep",
      createdAt: Date.UTC(2026, 4, 18, 8, 0),
      lastUsedAt: Date.UTC(2026, 5, 12, 8, 5),
      showInEmptyState: true,
      terminals: [
        {
          type: "claude",
          title: "Overnight diff",
          initialPrompt:
            "Summarise every commit on this branch since yesterday, then stop.",
          exitBehavior: "keep",
        },
        {
          type: "terminal",
          title: "Tests",
          command: "npm test",
          exitBehavior: "keep",
        },
      ],
    });
  });
  await page.waitForTimeout(1_500);
}

async function teardown(ctx: AppContext): Promise<void> {
  try {
    await closeApp(ctx.app);
  } catch {
    // best-effort
  }
}

/**
 * Return the workspace to a clickable state.
 *
 * Escape alone is not enough: a panel presented as a dialog stays up, and
 * every later shot in the scene then fails on a click that lands on the
 * backdrop. v1 lost two shots to exactly that, so this also clicks any
 * dialog's own close control before giving up.
 */
async function resetOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  for (let i = 0; i < 4; i++) {
    const dialog = page.locator('[data-testid="panel-dialog"]').first();
    if (!(await dialog.isVisible({ timeout: 500 }).catch(() => false))) break;
    const close = dialog.locator('[aria-label="Close dialog"]').first();
    if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
      await close.click({ timeout: 3000 }).catch(() => {});
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(300);
  }
  await dismissBlockingPalette(page);
  await settleFrame(page);
}

/** Reveal the sidebar header's hover-only controls (overview, fleet arming). */
async function hoverSidebarHeader(page: Page): Promise<void> {
  const header = page.locator(`${SEL.sidebar.aside} >> text=Worktrees`).first();
  await header.hover({ timeout: 5_000 });
  await page.waitForTimeout(400);
}

test.describe.serial("Documentation Screenshots", () => {
  test.afterAll(() => {
    const report = { captured, missed };
    writeFileSync(path.join(OUTPUT_DIR, "capture-report.json"), JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      `[docs-shots] done — ${captured.length} captured, ${missed.length} missed\n` +
        missed.map((m) => `  - ${m.slug}: ${m.reason}`).join("\n")
    );
  });

  // -------------------------------------------------------------------------
  // Scene A — the workspace: sidebar, toolbar, grid, dock, worktree surfaces
  // -------------------------------------------------------------------------
  test("scene-a-workspace", async () => {
    const repo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    let booted: Booted | undefined;
    try {
      booted = await boot(repo, "Atlas Ledger", "📒");
      const { page } = booted;

      const sidebar = page.locator(SEL.sidebar.aside);
      await expect(sidebar).toBeVisible({ timeout: T_LONG });
      // The worktree poll paints status badges incrementally; wait for the
      // list to stop growing so no capture shows a mid-refresh count.
      await expect
        .poll(() => page.locator("[data-worktree-row]").count(), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(4);
      await page.waitForTimeout(T_MEDIUM);

      // --- The empty grid, which is really the launcher -------------------
      await shot("terminals-and-panels/terminals-and-panels-empty-grid", async () => {
        await resetOverlays(page);
        await snapWindow(page, "terminals-and-panels/terminals-and-panels-empty-grid");
      });

      // --- Toolbar band ----------------------------------------------------
      await shot("ui-layout/ui-layout-toolbar-groups", async () => {
        await resetOverlays(page);
        const toolbar = page.locator('[role="toolbar"][aria-label="Main toolbar"]');
        await expect(toolbar).toBeVisible({ timeout: T_MEDIUM });
        await snapElement(page, toolbar, "ui-layout/ui-layout-toolbar-groups");
      });

      // --- Sidebar: worktree cards and their status signals ----------------
      await shot("worktrees/cards/worktrees-row-status-signals", async () => {
        await resetOverlays(page);
        await snapElement(page, sidebar, "worktrees/cards/worktrees-row-status-signals");
      });

      // --- Worktree card context menu -------------------------------------
      await shot("ui-layout/palettes-and-menus/palettes-and-menus-worktree-card-menu", async () => {
        await resetOverlays(page);
        const card = page.locator(SEL.worktree.card("feature/reconciliation")).first();
        await expect(card).toBeVisible({ timeout: T_MEDIUM });
        await card.click({ button: "right" });
        const menu = page.locator(SEL.contextMenu.content).first();
        await expect(menu).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_SHORT);
        await snapElement(
          page,
          menu,
          "ui-layout/palettes-and-menus/palettes-and-menus-worktree-card-menu",
          16
        );
      });

      // --- Worktrees Overview modal ---------------------------------------
      await shot("worktrees/overview/worktrees-overview-selection", async () => {
        await resetOverlays(page);
        // The overview button lives in a hover-revealed group on the sidebar
        // header, so it is present but not clickable until the header is
        // hovered — v1 spent its whole click budget on an invisible target.
        await hoverSidebarHeader(page);
        await page.locator(SEL.worktree.openOverviewButton).click();
        const modal = page.locator(SEL.worktree.overviewModal);
        await expect(modal).toBeVisible({ timeout: T_MEDIUM });
        // Multi-select two rows so the bulk action bar is populated — an
        // overview with nothing selected does not show what it is for.
        // Left as the browse state on purpose. Two attempts at driving the
        // multi-select failed differently: Meta-clicking the cells selected
        // nothing, and pressing Space (which the modal's own footer documents
        // as "select") closed the modal outright. Rather than ship a capture
        // of an empty grid labelled as a selection, this shows the overview as
        // it opens — which is still the state most readers arrive at.
        const cells = page.locator(SEL.worktree.overviewCell);
        await expect(cells.first()).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "worktrees/overview/worktrees-overview-selection");
      });

      // --- Delete worktree dialog ------------------------------------------
      await shot("worktrees/worktrees-delete-dialog", async () => {
        await resetOverlays(page);
        const card = page.locator(SEL.worktree.card("chore/dependency-bump")).first();
        await expect(card).toBeVisible({ timeout: T_MEDIUM });
        await card.click({ button: "right" });
        const menu = page.locator(SEL.contextMenu.content).first();
        await expect(menu).toBeVisible({ timeout: T_MEDIUM });
        await menu.locator(SEL.contextMenu.item).filter({ hasText: /delete/i }).first().click();
        const dialog = page.locator(SEL.worktree.deleteDialog);
        await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_SHORT);
        await snapWindow(page, "worktrees/worktrees-delete-dialog");
        await page.keyboard.press("Escape");
      });

      // --- Review Hub on a dirty working tree ------------------------------
      await shot("review-hub/review-hub-working-tree", async () => {
        await resetOverlays(page);
        // Scope the Review & Commit button to the row it belongs to. Taking
        // `.first()` off the page picked whichever worktree happened to sort
        // first, which is how v1 captured `bugfix/rounding-drift` on a shot
        // whose whole point was the two-file reconciliation tree.
        const row = page.locator(SEL.worktree.row("feature/reconciliation")).first();
        await expect(row).toBeVisible({ timeout: T_MEDIUM });
        await row.click();
        await page.waitForTimeout(T_MEDIUM);
        await row.hover();
        const reviewButton = row.locator(SEL.worktree.reviewHubButton).first();
        await expect(reviewButton).toBeVisible({ timeout: T_MEDIUM });
        await reviewButton.click();
        const hub = page.locator(SEL.reviewHub.container);
        await expect(hub).toBeVisible({ timeout: T_LONG });
        // The file list is collapsed on open. A Review Hub screenshot with
        // "Show files (2)" still folded shows the chrome and none of the work.
        const toggle = page.locator(SEL.reviewHub.fileListToggle).first();
        if (await toggle.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          const expanded = await toggle.getAttribute("aria-expanded");
          if (expanded !== "true") await toggle.click();
        }
        await page.waitForTimeout(T_MEDIUM);
        await snapElement(page, hub, "review-hub/review-hub-working-tree", 40);
      });

      // --- A panel presented as a dialog, promote button in the header -----
      await shot("terminals-and-panels/terminals-and-panels-panel-dialog", async () => {
        const diffButton = page
          .locator('[aria-label^="View diff:"]')
          .first();
        await expect(diffButton).toBeVisible({ timeout: T_MEDIUM });
        await diffButton.click();
        const diffDialog = page.locator(SEL.reviewHub.diffDialog);
        await expect(diffDialog).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        // Keep a margin of dimmed workspace so the layering reads as modal.
        await snapElement(page, diffDialog, "terminals-and-panels/terminals-and-panels-panel-dialog", 48);
      });

      await resetOverlays(page);

      // --- Populated panel grid --------------------------------------------
      await shot("terminals-and-panels/terminals-and-panels-grid-overview", async () => {
        await resetOverlays(page);
        await page.locator(SEL.toolbar.openTerminal).click();
        const firstPanel = page.locator(SEL.panel.gridPanel).first();
        await expect(firstPanel).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        // Give the first terminal something to say, so the grid is not three
        // empty prompts.
        await firstPanel.click();
        await page.keyboard.type("git -c color.ui=always log --oneline --graph -8\n", { delay: 8 });
        await page.waitForTimeout(T_MEDIUM);
        // A second terminal, so the grid actually reads as a grid.
        await page.locator(SEL.toolbar.openTerminal).click();
        await page.waitForTimeout(T_MEDIUM);
        const second = page.locator(SEL.panel.gridPanel).nth(1);
        await second.click();
        await page.keyboard.type("cat src/journal/entry.ts\n", { delay: 8 });
        await page.waitForTimeout(T_MEDIUM);
        // The File Browser is a different panel kind with its own accent, and
        // unlike the browser panel it needs no webview to paint.
        const browseFiles = page.locator('[aria-label="Browse files"]').first();
        if (await browseFiles.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await browseFiles.click();
          await page.waitForTimeout(T_LONG);
        }
        await resetOverlays(page);
        await snapWindow(page, "terminals-and-panels/terminals-and-panels-grid-overview");
      });

      // --- Dock bar --------------------------------------------------------
      await shot("ui-layout/ui-layout-dock", async () => {
        await resetOverlays(page);
        const panels = page.locator(SEL.panel.gridPanel);
        const n = await panels.count();
        for (let i = 0; i < Math.min(n, 2); i++) {
          const minimize = panels.first().locator(SEL.panel.minimize);
          if (await minimize.isVisible({ timeout: T_SHORT }).catch(() => false)) {
            await minimize.click();
            await page.waitForTimeout(T_SHORT);
          }
        }
        // Close one panel so it lands in Trash and the action containers on
        // the right of the bar have something to report.
        const spare = page.locator(SEL.panel.gridPanel).first();
        const spareClose = spare.locator(SEL.panel.close);
        if (await spareClose.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await spareClose.click();
          await page.waitForTimeout(T_SHORT);
        }
        const dock = page.locator(SEL.dock.container);
        await expect(dock).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_MEDIUM);
        const box = await dock.boundingBox();
        if (!box) throw new Error("dock has no bounding box");
        // Full window width: the action containers (Background, Waiting,
        // Errors, Trash) sit outside the dock container's own box, and a
        // dock screenshot without them is half the surface.
        await snapBand(page, "ui-layout/ui-layout-dock", {
          x: 0,
          y: Math.max(0, box.y - 12),
          width: WINDOW_WIDTH,
          height: Math.min(WINDOW_HEIGHT - Math.max(0, box.y - 12), box.height + 24),
        });
      });

      // --- File Browser panel ----------------------------------------------
      await shot("terminals-and-panels/file-browser/file-browser-panel", async () => {
        await resetOverlays(page);
        const browseFiles = page.locator('[aria-label="Browse files"]').first();
        if (await browseFiles.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await browseFiles.click();
        } else {
          await page.keyboard.press("Meta+Alt+KeyF");
        }
        await page.waitForTimeout(T_LONG);
        await resetOverlays(page);
        await snapWindow(page, "terminals-and-panels/file-browser/file-browser-panel");
      });

      // --- Empty grid context menu ------------------------------------------
      await shot("ui-layout/palettes-and-menus/palettes-and-menus-empty-grid-menu", async () => {
        await resetOverlays(page);
        // Close every panel so the empty canvas is back, then right-click it.
        const panels = page.locator(SEL.panel.gridPanel);
        let guard = 12;
        while ((await panels.count()) > 0 && guard-- > 0) {
          const close = panels.first().locator(SEL.panel.close);
          if (!(await close.isVisible({ timeout: T_SHORT }).catch(() => false))) break;
          await close.click();
          await page.waitForTimeout(400);
        }
        await page.waitForTimeout(T_MEDIUM);
        await page.mouse.click(WINDOW_WIDTH / 2, WINDOW_HEIGHT / 2, { button: "right" });
        const menu = page.locator(SEL.contextMenu.content).first();
        await expect(menu).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_SHORT);
        await snapElement(
          page,
          menu,
          "ui-layout/palettes-and-menus/palettes-and-menus-empty-grid-menu",
          16
        );
      });

      // --- The launcher popover ---------------------------------------------
      await shot("ui-layout/ui-layout-launcher", async () => {
        await resetOverlays(page);
        await page.locator(SEL.agent.trayButton).first().click();
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "ui-layout/ui-layout-launcher");
      });

      // --- Terminal search bar ------------------------------------------------
      await shot("terminals-and-panels/terminals/terminals-search", async () => {
        await resetOverlays(page);
        await page.locator(SEL.toolbar.openTerminal).click();
        const panel = page.locator(SEL.panel.gridPanel).first();
        await expect(panel).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        // Put something on screen worth searching before opening the finder.
        await panel.click();
        await page.keyboard.type("grep -rn 'Money' src | head -40\n", { delay: 8 });
        await page.waitForTimeout(T_MEDIUM);
        await page.keyboard.type("cat src/journal/posting.ts src/types.ts\n", { delay: 8 });
        await page.waitForTimeout(T_MEDIUM);
        await page.keyboard.press("Meta+KeyF");
        const search = page.locator(SEL.terminal.searchInput).first();
        await expect(search).toBeVisible({ timeout: T_MEDIUM });
        await search.fill("Money");
        await page.waitForTimeout(T_SHORT);
        // Crop to the top of the panel: the search bar, its toggles, the match
        // counter and the matched scrollback. The empty rows below say nothing.
        const panelBox = await panel.boundingBox();
        if (!panelBox) throw new Error("terminal panel has no bounding box");
        await snapBand(page, "terminals-and-panels/terminals/terminals-search", {
          x: panelBox.x,
          y: panelBox.y,
          width: panelBox.width,
          height: Math.min(panelBox.height, 300),
        });
        await page.keyboard.press("Escape");
      });

      // --- Quick switcher -----------------------------------------------------
      await shot("ui-layout/palettes-and-menus/palettes-and-menus-quick-switcher", async () => {
        await resetOverlays(page);
        await page.keyboard.press("Meta+KeyP");
        const palette = page.locator(SEL.quickSwitcher.dialog);
        await expect(palette).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_SHORT);
        await snapWindow(page, "ui-layout/palettes-and-menus/palettes-and-menus-quick-switcher");
      });

      await resetOverlays(page);
    } finally {
      if (booted) await teardown(booted.ctx);
      repo.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scene B — Settings, in every group the documentation describes
  // -------------------------------------------------------------------------
  test("scene-b-settings", async () => {
    const repo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    let booted: Booted | undefined;
    try {
      booted = await boot(repo, "Atlas Ledger", "📒");
      const { page } = booted;

      await shot("settings/settings-overview-sidebar", async () => {
        await resetOverlays(page);
        await page.locator(SEL.toolbar.openSettings).click();
        await expect(page.locator(SEL.settings.heading)).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "settings/settings-overview-sidebar");
      });

      await shot("settings/settings-search-results", async () => {
        const search = page.locator(SEL.settings.searchInput);
        await expect(search).toBeVisible({ timeout: T_MEDIUM });
        await search.click();
        await search.fill("notification");
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "settings/settings-search-results");
        await page.locator(SEL.settings.searchClear).click().catch(() => {});
      });

      const openTab = async (name: string) => {
        const tab = page.locator(`.settings-sidebar button:has-text("${name}")`).first();
        await expect(tab).toBeVisible({ timeout: T_MEDIUM });
        await tab.click();
        await page.waitForTimeout(T_MEDIUM);
      };

      await shot("keyboard-shortcuts/keyboard-shortcuts-settings", async () => {
        await openTab("Keyboard");
        await snapWindow(page, "keyboard-shortcuts/keyboard-shortcuts-settings");
      });

      await shot("themes/themes-terminal-color-schemes", async () => {
        await openTab("Appearance");
        const terminalSub = page
          .locator(`${SEL.settings.subtabNav} button:has-text("Terminal")`)
          .first();
        if (await terminalSub.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await terminalSub.click();
          await page.waitForTimeout(T_MEDIUM);
        }
        await snapWindow(page, "themes/themes-terminal-color-schemes");
      });

      await shot("themes/themes-theme-browser", async () => {
        await openTab("Appearance");
        const appSub = page.locator(`${SEL.settings.subtabNav} button:has-text("App")`).first();
        if (await appSub.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await appSub.click();
          await page.waitForTimeout(T_SHORT);
        }
        const changeTheme = page.locator(SEL.settings.changeThemeButton).first();
        await expect(changeTheme).toBeVisible({ timeout: T_MEDIUM });
        await changeTheme.click();
        const drawer = page.locator(SEL.settings.themeBrowserDialog);
        await expect(drawer).toBeVisible({ timeout: T_LONG });
        // Preview a theme other than the committed one so the previewing
        // highlight and the committed checkmark are both in frame.
        const rows = page.locator(`${SEL.settings.themeListbox} [role="option"]`);
        if ((await rows.count()) > 2) {
          await rows.nth(2).click();
          await page.waitForTimeout(T_MEDIUM);
        }
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "themes/themes-theme-browser");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(T_SHORT);
      });

      await shot("mcp-server/mcp-server-settings-tab", async () => {
        await openTab("MCP");
        const turnOn = page.locator(SEL.settings.mcpServerEnableButton).first();
        if (await turnOn.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await turnOn.click();
          // The server binds a local port; wait for the connection block.
          await page
            .locator(SEL.settings.mcpConnectionMarker)
            .first()
            .waitFor({ state: "visible", timeout: T_LONG })
            .catch(() => {});
          await page.waitForTimeout(T_MEDIUM);
        }
        await snapWindow(page, "mcp-server/mcp-server-settings-tab");
      });

      // Voice Input is dropped from the capture set for now. The tab is a
      // single off toggle until voice input is enabled, and the generic
      // switch selector did not find the real control — an empty pane with
      // one toggle in it documents less than the prose already does.

      await resetOverlays(page);
    } finally {
      if (booted) await teardown(booted.ctx);
      repo.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scene C — Recipes, plugins, diagnostics
  // -------------------------------------------------------------------------
  test("scene-c-recipes-and-tools", async () => {
    const repo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    let booted: Booted | undefined;
    try {
      // Sideload the sample plugins. A fresh e2e profile has none installed, so
      // the Plugin Manager's "Installed plugins" listbox renders empty and the
      // detail-pane shot has nothing to click — which is exactly how v3 missed
      // it. Two plugins also give the list something to *be* a list of.
      booted = await boot(repo, "Atlas Ledger", "📒", {
        DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: SAMPLE_PLUGINS_DIR,
      });
      const { page } = booted;
      // Sideloading puts the plugins on disk; activation is what makes them
      // appear in the manager's "Installed plugins" listbox. Without it the
      // list renders empty and the detail-pane shot has nothing to click.
      for (const id of ["daintree.hello", "daintree.rich"]) {
        await activateE2EPlugin(booted.ctx.app, id).catch(() => {});
      }
      await page.waitForTimeout(T_MEDIUM);

      const runPaletteAction = async (query: string, optionText: RegExp) => {
        await resetOverlays(page);
        await page.keyboard.press("Meta+Shift+KeyP");
        const palette = page.locator(SEL.actionPalette.dialog);
        await expect(palette).toBeVisible({ timeout: T_MEDIUM });
        await page.locator(SEL.actionPalette.searchInput).fill(query);
        await page.waitForTimeout(T_SHORT);
        await page
          .locator(SEL.actionPalette.options)
          .filter({ hasText: optionText })
          .first()
          .click();
        await page.waitForTimeout(T_MEDIUM);
      };

      await shot("recipes/recipes-recipe-manager", async () => {
        await runPaletteAction("recipe", /recipe manager/i);
        await page.waitForTimeout(T_MEDIUM);
        // Team Recipes — the section that makes the three-scope model legible
        // — sits below the fold on open. Scroll it into frame.
        const team = page.locator('text=Shared via .daintree/recipes/').first();
        if (await team.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await team.scrollIntoViewIfNeeded();
        } else {
          await page.mouse.wheel(0, 420);
        }
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "recipes/recipes-recipe-manager");
      });

      await shot("recipes/recipes-recipe-editor", async () => {
        const newRecipe = page
          .locator('button')
          .filter({ hasText: /new (project|global) recipe/i })
          .first();
        await expect(newRecipe).toBeVisible({ timeout: T_MEDIUM });
        await newRecipe.click();
        await expect(page.locator(SEL.recipeEditor.nameInput)).toBeVisible({ timeout: T_MEDIUM });
        await page.locator(SEL.recipeEditor.nameInput).fill("Full Stack Dev");
        await page.waitForTimeout(T_SHORT);
        await snapWindow(page, "recipes/recipes-recipe-editor");
        await resetOverlays(page);
      });

      await shot("plugins/plugins-manager-view", async () => {
        // The action dispatches a `daintree:open-plugin-manager` CustomEvent;
        // firing it directly is the same code path without the palette's
        // ranking as a dependency.
        await resetOverlays(page);
        await openPluginManager(page);
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "plugins/plugins-manager-view");
      });

      await shot("plugins/plugins-detail-pane", async () => {
        // Not SEL.plugin.option: that expects a listbox/option structure the
        // manager no longer uses — the installed list is plain rows with
        // toggles, so the old selector matched nothing while four plugins sat
        // on screen. Rich Daintree is the sample with the most detail tabs.
        const row = page
          .locator(SEL.plugin.manager)
          .getByText("Rich Daintree", { exact: false })
          .first();
        await expect(row).toBeVisible({ timeout: T_LONG });
        await row.click();
        await page.waitForTimeout(T_MEDIUM);
        const perms = page.locator(SEL.plugin.tabPermissions);
        if (await perms.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await perms.click();
          await page.waitForTimeout(T_SHORT);
        }
        await snapWindow(page, "plugins/plugins-detail-pane");
        await resetOverlays(page);
      });

      await resetOverlays(page);
    } finally {
      if (booted) await teardown(booted.ctx);
      repo.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scene D — first run: the welcome screen a new reader actually sees first
  // -------------------------------------------------------------------------
  test("scene-d-welcome", async () => {
    let ctx: AppContext | undefined;
    try {
      ctx = await launchApp({
        screenshotScale: SCALE,
        windowSize: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      });
      const page = ctx.window;
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await expect(page.locator(SEL.welcome.openFolder)).toBeVisible({ timeout: T_LONG });
      await page.waitForTimeout(T_MEDIUM);

      await shot("getting-started/getting-started-welcome-screen", async () => {
        await snapWindow(page, "getting-started/getting-started-welcome-screen");
      });
    } finally {
      if (ctx) await teardown(ctx);
    }
  });
});
