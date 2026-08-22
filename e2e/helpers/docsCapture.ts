/**
 * Shared capture harness for the daintree.org documentation screenshots.
 *
 * Extracted from `e2e/screenshots/docs-shots.spec.ts` once the set outgrew a
 * single file. The capture *mechanics* — freeze animation, settle two frames,
 * clip with padding, record a miss instead of dying — are identical for every
 * page; only the fixtures and the interaction steps differ. Keeping them here
 * means a new domain spec is a list of states, not another copy of the
 * plumbing, and means a fix to the plumbing lands everywhere at once.
 *
 * Each spec calls `createCapture(domain)` and writes its own report file, so
 * two specs in one Playwright run cannot clobber each other's results. The
 * harvest step reads every `capture-report*.json` in the directory.
 */

import { test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

/**
 * Output mirrors the website's `static/docs/` tree, so the harvest is a plain
 * copy rather than a mapping exercise.
 */
export const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "docs-screenshots");

mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Hide scrollbars and freeze animation so a capture never lands mid-tween.
 * `caret-color: transparent` stops a blinking cursor from being the one pixel
 * that differs between two otherwise identical runs.
 */
export const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

/** Wait out two animation frames so layout and paint have both settled. */
export async function settleFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
}

/**
 * The page's real logical size.
 *
 * `page.viewportSize()` returns null for an Electron page — Playwright only
 * tracks it for browser contexts it sized itself. Trusting it meant every
 * padded clip was silently clamped to a hardcoded 820px, so any surface taller
 * than that lost its bottom edge no matter how large the window was. Ask the
 * renderer instead.
 */
async function pageSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

function outPath(slug: string): string {
  const file = path.join(OUTPUT_DIR, `${slug}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

export interface CaptureMiss {
  slug: string;
  reason: string;
}

export interface Capture {
  /**
   * Run one capture. A throw is recorded and swallowed: the scene keeps going
   * so a single unreachable state costs one image rather than the whole run.
   * Returns whether the state was reached, for steps that want to branch.
   */
  shot(slug: string, fn: () => Promise<void>): Promise<boolean>;
  /** Whole-window capture. */
  snapWindow(page: Page, slug: string): Promise<void>;
  /**
   * Element capture, optionally padded so the surface keeps the chrome that
   * explains where it lives. Playwright clips to the element box exactly,
   * which on a popover crops away the trigger that gives it context.
   */
  snapElement(page: Page, locator: Locator, slug: string, pad?: number): Promise<void>;
  /** Band capture in logical pixels, for a surface with no single element. */
  snapBand(
    page: Page,
    slug: string,
    clip: { x: number; y: number; width: number; height: number }
  ): Promise<void>;
  /**
   * Assert the surface itself is on screen before the shot counts.
   *
   * Written after `review-hub` shipped for months capturing a hub whose file
   * list was still collapsed: the PNG held no diff at all while the caption
   * told the reader they were looking at one. A capture that silently misses
   * its subject is worse than a missing one, because someone signs it off.
   */
  requireSurface(page: Page, selector: string, label: string): Promise<void>;
  /** Write the domain's report and log a one-line summary. */
  writeReport(): void;
  readonly captured: string[];
  readonly missed: CaptureMiss[];
}

export function createCapture(domain: string): Capture {
  const captured: string[] = [];
  const missed: CaptureMiss[] = [];

  async function shot(slug: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      captured.push(slug);
      // eslint-disable-next-line no-console
      console.log(`[docs:${domain}] captured ${slug}`);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      missed.push({ slug, reason });
      // eslint-disable-next-line no-console
      console.log(`[docs:${domain}] MISSED  ${slug} — ${reason}`);
      test.info().annotations.push({ type: "docs-shot-missed", description: `${slug}: ${reason}` });
      return false;
    }
  }

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

  async function snapElement(
    page: Page,
    locator: Locator,
    slug: string,
    pad = 0
  ): Promise<void> {
    await settleFrame(page);
    if (pad === 0) {
      await locator.screenshot({
        path: outPath(slug),
        type: "png",
        animations: "disabled",
        caret: "hide",
      });
      return;
    }
    const box = await locator.boundingBox();
    if (!box) throw new Error("element has no bounding box");
    const vp = await pageSize(page);
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

  async function requireSurface(page: Page, selector: string, label: string): Promise<void> {
    const visible = await page
      .locator(selector)
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    if (!visible) throw new Error(`surface not reached: ${label} (${selector})`);
  }

  function writeReport(): void {
    const file = path.join(OUTPUT_DIR, `capture-report.${domain}.json`);
    writeFileSync(file, JSON.stringify({ domain, captured, missed }, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      `[docs:${domain}] done — ${captured.length} captured, ${missed.length} missed\n` +
        missed.map((m) => `  - ${m.slug}: ${m.reason}`).join("\n")
    );
  }

  return {
    shot,
    snapWindow,
    snapElement,
    snapBand,
    requireSurface,
    writeReport,
    captured,
    missed,
  };
}

/**
 * Return the workspace to a clickable state.
 *
 * Escape alone is not enough: a panel presented as a dialog stays up, and
 * every later shot in the scene then fails on a click that lands on the
 * backdrop. v1 lost two shots to exactly that, so this also clicks any
 * dialog's own close control before giving up.
 */
export async function resetOverlays(page: Page): Promise<void> {
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
  await settleFrame(page);
}
