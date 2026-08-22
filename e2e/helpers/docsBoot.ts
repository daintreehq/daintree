/**
 * Boot an app window into a documentation-capture-ready state.
 *
 * Every docs scene needs the same opening moves — launch at 2x, open the
 * fixture as a project, get past onboarding, give the project a name a reader
 * would believe, and freeze animation — and every one of them has a way to go
 * subtly wrong that costs a whole scene. Centralising it means the recovery
 * for each of those is written once.
 *
 * The `Page` returned is the one to use. Opening or switching a project
 * recreates the WebContentsView, which invalidates any earlier handle.
 */

import type { Page } from "@playwright/test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  launchApp,
  mockOpenDialog,
  refreshActiveWindow,
  type AppContext,
} from "./launch";
import { dismissTelemetryConsent } from "./project";
import { dismissBlockingPalette } from "./overlays";
import { SEL } from "./selectors";
import { T_LONG, T_MEDIUM, T_SETTLE } from "./timeouts";
import { POLISH_CSS } from "./docsCapture";

export interface Booted {
  ctx: AppContext;
  page: Page;
  /** Profile to remove in the scene's `finally`. */
  userDataDir: string;
}

export interface BootOptions {
  /** Fixture repo to open as the project. */
  repoDir: string;
  /** Display name shown in the title bar — a folder slug reads as a fixture. */
  displayName: string;
  /** Project emoji, for the same reason. */
  emoji: string;
  /** Extra launch env, e.g. `fakeAgentEnv(binDir)` for offline agent states. */
  env?: Record<string, string>;
  /** Device scale factor, digit 1-9. Defaults to DAINTREE_SCREENSHOT_SCALE or 2. */
  scale?: string;
  /** Logical window size. */
  windowSize?: { width: number; height: number };
  /**
   * Caller-owned profile directory, for scenes that must seed files the app
   * reads at boot (crash markers, the crash-loop guard, the suspect ledger).
   *
   * Two traps come with it, both handled below. `launchApp` only applies
   * `windowSize` when it created the directory itself, so the size has to be
   * re-applied by hand; and its pre-launch hygiene pkills any Electron whose
   * profile path matches `daintree-e2e`, which would SIGKILL a concurrent
   * run — so the caller's prefix must not contain that string.
   */
  userDataDir?: string;
  /** Selector to wait for instead of the default sidebar toggle. */
  waitForSelector?: string;
  /**
   * Skip opening a project. The crash-recovery gate renders before the
   * workspace exists, so that scene has no folder to open.
   */
  skipProjectOpen?: boolean;
  /**
   * Keep a global banner that would otherwise be dismissed. Only the safe-mode
   * scene wants one; everywhere else it is contamination.
   */
  keepGlobalBanner?: boolean;
  /**
   * Reload once after boot. In-repo recipe reconciliation can finish *after*
   * the renderer's recipe store hydrated, which leaves every recipe surface
   * painting empty even though the IPC returns three.
   */
  reloadAfterBoot?: boolean;
}

/**
 * Window presets.
 *
 * The right size is a property of the shot, not of the suite. A modal cropped
 * to its own card does not care how big the window is, only that the card is
 * not forced to scroll inside it; a whole-window workspace shot cares a great
 * deal, because a cramped grid photographs as a cramped product.
 *
 * - `DOCS_WINDOW`  — the default. Element and dialog crops.
 * - `DOCS_WINDOW_TALL` — surfaces capped at a fraction of viewport height
 *   (the settings dialog is 75vh) that would otherwise scroll internally.
 * - `DOCS_WINDOW_WIDE` — whole-window shots of the workspace, where the panel
 *   grid needs room to lay out the way a real screen would.
 * - `DOCS_WINDOW_DECK` — the fleet deck specifically: three columns need
 *   roughly 1612px of grid, which no narrower window can give.
 */
export const DOCS_WINDOW = {
  width: Number(process.env.DAINTREE_DOCS_WIDTH ?? 1280),
  height: Number(process.env.DAINTREE_DOCS_HEIGHT ?? 820),
};

export const DOCS_WINDOW_TALL = { width: 1280, height: 1100 };
export const DOCS_WINDOW_WIDE = { width: 1600, height: 1000 };
export const DOCS_WINDOW_DECK = { width: 1920, height: 1080 };

/**
 * Padding around a modal captured as an element.
 *
 * Enough dimmed backdrop that the surface reads as layered over the app, and
 * no more. A wider margin is pretty and photographs as dead space: in a
 * documentation column the scrim carries no information, and it costs the
 * dialog the pixels that would have made its text legible.
 */
export const DIALOG_PAD = 16;

export async function bootDocsApp(options: BootOptions): Promise<Booted> {
  const {
    repoDir,
    displayName,
    emoji,
    env,
    scale = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2",
    windowSize = DOCS_WINDOW,
    reloadAfterBoot = false,
    userDataDir,
    waitForSelector,
    skipProjectOpen = false,
    keepGlobalBanner = false,
  } = options;

  if (userDataDir && userDataDir.includes("daintree-e2e")) {
    throw new Error(
      `userDataDir must not contain "daintree-e2e": launchApp's pre-launch pkill ` +
        `matches that path and would kill this run's own app (${userDataDir})`
    );
  }

  // Always own the profile, and never let its path contain `daintree-e2e`.
  //
  // launchApp's own default profiles are `daintree-e2e-*`, and its pre-launch
  // hygiene pkills any Electron whose path matches that — so one docs scene
  // launching would SIGKILL another that was still shutting down. An Electron
  // killed that way never clears its `running.lock`, which is precisely how a
  // later scene boots into "Daintree was forced to close" or safe mode and
  // photographs it. A distinct prefix keeps every docs capture out of that
  // blast radius.
  const profileDir = userDataDir ?? mkdtempSync(path.join(tmpdir(), "daintree-docsshot-"));

  const ctx = await launchApp({
    screenshotScale: scale,
    windowSize,
    ...(env ? { env } : {}),
    userDataDir: profileDir,
    ...(waitForSelector ? { waitForSelector } : {}),
    // macOS-local crashpad mitigation, mirrored from the marketing reel.
    extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
  });

  // launchApp sizes the window only for profiles it created itself, and we
  // always provide our own — so the size has to be applied by hand or every
  // shot would come out whatever shape the app's default happens to be.
  await ctx.app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.setSize(size.width, size.height);
    win.center();
  }, windowSize);
  await ctx.window.waitForTimeout(400);

  if (skipProjectOpen) {
    await ctx.window.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    return { ctx, page: ctx.window, userDataDir: profileDir };
  }

  if (!keepGlobalBanner) await clearRecoverySurfaces(ctx.window);

  await mockOpenDialog(ctx.app, repoDir);
  await ctx.window.getByRole("button", { name: "Open folder" }).click();

  let page = await refreshActiveWindow(ctx.app, ctx.window);
  await dismissTelemetryConsent(page);
  await dismissBlockingPalette(page);
  ctx.window = page;

  try {
    await page.addStyleTag({ content: POLISH_CSS });
  } catch {
    // The style tag races the view swap on a slow open; re-acquire and retry.
    page = await refreshActiveWindow(ctx.app, page);
    ctx.window = page;
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  }

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

  if (reloadAfterBoot) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await page.waitForTimeout(T_MEDIUM);
  }

  if (!keepGlobalBanner) await clearRecoverySurfaces(page);

  return { ctx, page, userDataDir: profileDir };
}

/**
 * Get rid of anything the previous session left behind.
 *
 * A profile is fresh per scene, so in principle neither of these can appear.
 * In practice an Electron that was killed rather than closed leaves a marker,
 * and the next boot renders either the crash-recovery dialog or the safe-mode
 * banner over the workspace — which then lands in the middle of a whole-window
 * capture. Cheap to check, and it logs when it fires so a recurring one is
 * visible rather than quietly papered over.
 */
async function clearRecoverySurfaces(page: Page): Promise<void> {
  const dialog = page.locator('[data-testid="crash-recovery-dialog"]');
  if (await dialog.isVisible({ timeout: 750 }).catch(() => false)) {
    // eslint-disable-next-line no-console
    console.warn("[docs] crash-recovery dialog on boot — continuing without restoring");
    await page
      .locator('[data-testid="fresh-button"]')
      .click({ timeout: 5_000 })
      .catch(() => {});
    await page.waitForTimeout(500);
  }

  for (const label of ["Dismiss safe mode banner", "Dismiss restore confirmation"]) {
    const dismiss = page.locator(`[aria-label="${label}"]`);
    if (await dismiss.isVisible({ timeout: 500 }).catch(() => false)) {
      // eslint-disable-next-line no-console
      console.warn(`[docs] dismissed a leftover banner: ${label}`);
      await dismiss.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}
