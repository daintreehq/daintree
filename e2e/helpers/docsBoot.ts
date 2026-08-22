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
   * Reload once after boot. In-repo recipe reconciliation can finish *after*
   * the renderer's recipe store hydrated, which leaves every recipe surface
   * painting empty even though the IPC returns three.
   */
  reloadAfterBoot?: boolean;
}

export const DOCS_WINDOW = {
  width: Number(process.env.DAINTREE_DOCS_WIDTH ?? 1280),
  height: Number(process.env.DAINTREE_DOCS_HEIGHT ?? 820),
};

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
  } = options;

  if (userDataDir && userDataDir.includes("daintree-e2e")) {
    throw new Error(
      `userDataDir must not contain "daintree-e2e": launchApp's pre-launch pkill ` +
        `matches that path and would kill this run's own app (${userDataDir})`
    );
  }

  const ctx = await launchApp({
    screenshotScale: scale,
    windowSize,
    ...(env ? { env } : {}),
    ...(userDataDir ? { userDataDir } : {}),
    ...(waitForSelector ? { waitForSelector } : {}),
    // macOS-local crashpad mitigation, mirrored from the marketing reel.
    extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
  });

  // launchApp sizes the window only for profiles it created itself, so a
  // caller-owned one would silently capture at whatever size the last run
  // persisted — and every shot would be a different shape.
  if (userDataDir) {
    await ctx.app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      win.setSize(size.width, size.height);
      win.center();
    }, windowSize);
  }

  if (skipProjectOpen) {
    await ctx.window.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    return { ctx, page: ctx.window };
  }

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

  return { ctx, page };
}
