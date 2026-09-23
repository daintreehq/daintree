/**
 * All-clear flash visual-review harness.
 *
 * The flash is a pure motion surface, so a single screenshot says almost
 * nothing about it. This spec fires the real `agent:all-clear` event down the
 * real `events:push` channel (the same envelope `registerEventsHandlers` relays
 * from `AgentNotificationService`), catches the overlay the instant React mounts
 * it, pauses its animation, and seeks it to fixed fractions of its duration.
 * Each fraction is one PNG, so the sequence is a frame strip rather than a
 * lucky mid-flight grab.
 *
 * The component's own unmount timer would tear the overlay down while a paused
 * frame is being captured, so the spec holds page timers for the duration of a
 * frame and releases them before the next one.
 *
 * Beyond the PNGs it writes `samples.json`: per theme and frame, the overlay's
 * computed background, its animated opacity, and the theme's resolved
 * `--color-status-success`. "The tint is too strong on light themes" is a
 * measurable claim.
 *
 * States, per theme:
 *   rest          the workspace with no flash, the baseline every frame is read against
 *   frame-NN      the flash paused at NN% of its duration
 *   modal-peak    the flash at its strongest frame with the Settings dialog open,
 *                 which is the question of whether it sits over or under modals
 *   settings      the Notifications settings page, scrolled to the flash toggle
 *
 *   DAINTREE_SHOT_ALLCLEAR=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots all-clear-flash-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ALLCLEAR  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       required — absolute output dir; captures never go in the repo
 *   DAINTREE_SHOT_THEMES    optional comma list of theme ids (default: daintree,namib,svalbard,atacama)
 */

import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";

const ENABLED = !!process.env.DAINTREE_SHOT_ALLCLEAR;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,namib,svalbard,atacama")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const OVERLAY = "[data-all-clear-flash], .animate-all-clear-flash";
const FRAMES = [0.05, 0.15, 0.25, 0.3, 0.5, 0.75];
// The keyframe peak in src/index.css (`all-clear-flash`).
const PEAK = 0.25;
const WINDOW = { width: 1440, height: 900 };
const PROJECT_NAME = "Helios Dashboard";

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CLOSE = '[aria-label="Close settings"]';

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-allclear-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const version = 1;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function fireAllClear(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      wc.send("events:push", {
        name: "agent:all-clear",
        payload: { timestamp: Date.now(), shouldFlash: true },
      });
    }
  });
}

interface FrameSample {
  fraction: number;
  duration: number;
  opacity: string;
  background: string;
  zIndex: string;
  statusSuccess: string;
}

/**
 * Arms a one-shot observer that pauses the overlay's animation at `fraction`
 * the moment it mounts, and holds page timers so the component's unmount
 * fallback cannot fire while the frame is on screen.
 */
async function armFrame(page: Page, fraction: number): Promise<void> {
  await page.evaluate(
    ({ selector, fraction }) => {
      const w = window as unknown as {
        __acRelease?: () => void;
        __acFrame?: Promise<unknown>;
      };
      const realSetTimeout = window.setTimeout;
      const held: Array<() => void> = [];
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof fn === "function" && (ms ?? 0) >= 100 && (ms ?? 0) <= 10_000) {
          held.push(() => (fn as (...a: unknown[]) => void)(...args));
          return 0;
        }
        return realSetTimeout(fn, ms, ...args);
      }) as typeof window.setTimeout;

      w.__acFrame = new Promise((resolve, reject) => {
        const timeout = realSetTimeout(() => {
          observer.disconnect();
          reject(new Error("all-clear overlay never mounted"));
        }, 5000);
        const tryPause = (): boolean => {
          const el = document.querySelector<HTMLElement>(selector);
          if (!el) return false;
          const anims = el.getAnimations();
          if (anims.length === 0) return false;
          observer.disconnect();
          clearTimeout(timeout);
          const anim = anims[0]!;
          anim.pause();
          const timing = anim.effect?.getComputedTiming();
          const duration = Number(timing?.duration ?? 0);
          anim.currentTime = duration * fraction;
          const cs = getComputedStyle(el);
          resolve({
            fraction,
            duration,
            opacity: cs.opacity,
            background: cs.backgroundColor,
            zIndex: cs.zIndex,
            statusSuccess: getComputedStyle(document.documentElement)
              .getPropertyValue("--color-status-success")
              .trim(),
          });
          return true;
        };
        const observer = new MutationObserver(() => void tryPause());
        observer.observe(document.body, { childList: true, subtree: true });
      });

      w.__acRelease = () => {
        window.setTimeout = realSetTimeout;
        const el = document.querySelector<HTMLElement>(selector);
        el?.getAnimations().forEach((a) => a.finish());
        held.splice(0).forEach((fn) => fn());
      };
    },
    { selector: OVERLAY, fraction }
  );
}

async function captureFrame(
  app: ElectronApplication,
  page: Page,
  fraction: number,
  file: string
): Promise<FrameSample> {
  await armFrame(page, fraction);
  await fireAllClear(app);
  const sample = (await page.evaluate(
    () => (window as unknown as { __acFrame: Promise<unknown> }).__acFrame
  )) as FrameSample;
  await settle(page, 120);
  // Verify after the settle: the overlay must still be mounted and paused, or
  // the PNG would be a plain workspace passing itself off as a flash frame.
  const stillPaused = await page.evaluate((selector) => {
    const el = document.querySelector<HTMLElement>(selector);
    return !!el && el.getAnimations().some((a) => a.playState === "paused");
  }, OVERLAY);
  if (!stillPaused) throw new Error(`overlay not paused at ${fraction} for ${file}`);
  await page.screenshot({ path: path.join(OUTPUT_DIR, file), type: "png", caret: "hide" });
  await page.evaluate(() => (window as unknown as { __acRelease: () => void }).__acRelease());
  await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 5000 });
  return sample;
}

async function openSettingsAt(page: Page, tab: string): Promise<void> {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
  }, { tab });
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await settle(page, 700);
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .locator(CLOSE)
    .click()
    .catch(() => {});
  await page.locator(DIALOG).waitFor({ state: "hidden", timeout: 8000 });
  await settle(page, 300);
}

test("all-clear flash review — frame strip, modal stacking, settings toggle", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ALLCLEAR is required for the all-clear flash capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_ALLCLEAR to run the all-clear flash capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-allclearshot-"));
  const samples: Record<string, Record<string, FrameSample>> = {};
  const expected: string[] = [];
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WINDOW,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);

    for (const theme of THEMES) {
      await setAppTheme(page, theme);
      await dismissBlockingPalette(page);
      // Reduced motion suppresses the flash by design; the capture must see it.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await settle(page, 800);
      samples[theme] = {};

      const rest = `${theme}--01-rest.png`;
      await page.screenshot({ path: path.join(OUTPUT_DIR, rest), type: "png", caret: "hide" });
      expected.push(rest);

      for (const fraction of FRAMES) {
        const pct = String(Math.round(fraction * 100)).padStart(2, "0");
        const file = `${theme}--02-frame-${pct}.png`;
        samples[theme]![`frame-${pct}`] = await captureFrame(ctx.app, page, fraction, file);
        expected.push(file);
      }

      await openSettingsAt(page, "notifications");
      const modal = `${theme}--03-modal-peak.png`;
      samples[theme]!["modal-peak"] = await captureFrame(ctx.app, page, PEAK, modal);
      expected.push(modal);

      const toggle = page.getByText(/flash/i).first();
      await toggle.scrollIntoViewIfNeeded();
      await settle(page, 300);
      const settings = `${theme}--04-settings.png`;
      await page.screenshot({ path: path.join(OUTPUT_DIR, settings), type: "png", caret: "hide" });
      expected.push(settings);
      await closeSettings(page);
    }

    writeFileSync(path.join(OUTPUT_DIR, "samples.json"), JSON.stringify(samples, null, 2));
    const written = new Set(readdirSync(OUTPUT_DIR));
    const missing = expected.filter((f) => !written.has(f));
    if (missing.length > 0) throw new Error(`captures missing: ${missing.join(", ")}`);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    repo.cleanup();
  }
});
