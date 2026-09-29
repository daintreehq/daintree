/**
 * Shortcut recorder chord-window visual-review harness.
 *
 * After the first stroke the recorder waits CHORD_TIMEOUT_MS for a second one. That
 * window lasts a second, so a normal capture either misses it or lands wherever the
 * screenshot happened to fall. This harness holds the recorder's chord timer open,
 * pauses the field's animations and seeks them, so the start, middle and end of the
 * window are each shot on purpose — in full motion and under Reduce UI animations,
 * in a dark and a light theme in one launch.
 *
 *   DAINTREE_SHOT_CHORD_WINDOW=1 DAINTREE_SHOT_DIR=/tmp/out \
 *     npx playwright test --project=screenshots shortcut-chord-window-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CHORD_WINDOW  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES        comma-separated theme ids (default `,bondi`; empty = app default)
 *
 * A manifest.json beside the PNGs lists every state written, with the frozen bar's
 * transform and animation state, and the run fails unless the files on disk match it.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";

const ENABLED = !!process.env.DAINTREE_SHOT_CHORD_WINDOW;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ",bondi").split(",");

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CLOSE = '[aria-label="Close settings"]';
const KEYBOARD_PANEL = "#settings-panel-keyboard";
const CAPTURE = '[data-testid="shortcut-capture"]';
const FIELD = '[data-testid="shortcut-capture-field"]';
const BAR = "[data-chord-window]";
const ROW_NAME = "Close focused terminal";
// Mirrors CHORD_TIMEOUT_MS; the hold below only intercepts timers of this length.
const CHORD_WINDOW_MS = 1000;

const PROJECT_NAME = "Helios Dashboard";
const WIDE = { width: 1680, height: 1050 };

type Pass = "full" | "reduced";

interface ManifestEntry {
  file: string;
  state: string;
  theme: string;
  pass: Pass;
  bar: { present: boolean; transform: string; animations: number } | null;
}

const manifest: ManifestEntry[] = [];
const failures: string[] = [];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-chord-window-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
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

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
}

/**
 * Parks every chord-length timer instead of running it, so the waiting state stays
 * on screen for as long as the capture needs. `releaseChordTimers` runs them.
 */
async function holdChordTimers(page: Page): Promise<void> {
  await page.evaluate((ms) => {
    const w = window as unknown as {
      __chordHold?: { original: typeof setTimeout; parked: (() => void)[] };
    };
    if (w.__chordHold) return;
    const original = window.setTimeout;
    const parked: (() => void)[] = [];
    w.__chordHold = { original, parked };
    (window as unknown as { setTimeout: unknown }).setTimeout = ((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === ms && typeof fn === "function") {
        parked.push(() => (fn as (...a: unknown[]) => void)(...args));
        return -1;
      }
      return original(fn, delay, ...args);
    }) as typeof setTimeout;
  }, CHORD_WINDOW_MS);
}

async function releaseChordTimers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __chordHold?: { original: typeof setTimeout; parked: (() => void)[] };
    };
    if (!w.__chordHold) return;
    (window as unknown as { setTimeout: unknown }).setTimeout = w.__chordHold.original;
    const parked = w.__chordHold.parked.splice(0);
    delete w.__chordHold;
    for (const run of parked) run();
  });
}

/** Pauses the bar's animations at `fraction` of their run and reports what it froze. */
async function freezeBar(page: Page, fraction: number): Promise<ManifestEntry["bar"]> {
  return page.evaluate(
    ({ selector, fraction }) => {
      const bar = document.querySelector<HTMLElement>(selector);
      if (!bar) return { present: false, transform: "", animations: 0 };
      const fill = (bar.firstElementChild as HTMLElement | null) ?? bar;
      const animations = [...new Set([bar, fill])].flatMap((el) => el.getAnimations());
      for (const a of animations) {
        a.pause();
        const timing = a.effect!.getComputedTiming();
        a.currentTime = (Number(timing.duration) || 0) * fraction;
      }
      return {
        present: true,
        transform: getComputedStyle(fill).transform,
        animations: animations.length,
      };
    },
    { selector: BAR, fraction }
  );
}

async function shoot(
  page: Page,
  state: string,
  theme: string,
  pass: Pass,
  bar: ManifestEntry["bar"]
): Promise<void> {
  const box = await page.locator(CAPTURE).first().boundingBox();
  if (!box) throw new Error(`no capture block for ${state}`);
  const pad = 16;
  const file = `${state}--${pass}--${theme || "default"}.png`;
  await page.screenshot({
    path: path.join(OUTPUT_DIR, file),
    type: "png",
    animations: "allow",
    caret: "hide",
    clip: {
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  manifest.push({ file, state, theme: theme || "default", pass, bar });
}

async function openKeyboardSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "keyboard" } })
    );
  });
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(`${KEYBOARD_PANEL} [data-testid="shortcut-row"]`).first()).toBeVisible({
    timeout: 15_000,
  });
  await settle(page, 600);
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .locator(CLOSE)
    .click()
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

/** Opens the recorder on a row and leaves it armed, waiting for the first stroke. */
async function armRecorder(page: Page): Promise<void> {
  const row = page
    .locator(`${KEYBOARD_PANEL} [data-testid="shortcut-row"]`)
    .filter({ hasText: ROW_NAME })
    .first();
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await row.hover();
  await row
    .getByRole("button", { name: /^Edit|Change shortcut|Rebind/ })
    .first()
    .click();
  await settle(page, 200);
  const field = page.locator(`${FIELD}[data-recording="true"]`);
  if (!(await field.isVisible().catch(() => false))) {
    await page.locator(FIELD).first().click();
  }
  await expect(field).toBeVisible({ timeout: 5000 });
  await settle(page, 200);
}

async function cancelEdit(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .first()
    .click()
    .catch(() => {});
  await settle(page, 200);
}

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).slice(0, 400)}`);
    await releaseChordTimers(page).catch(() => {});
    await dismissBlockingPalette(page).catch(() => {});
  }
}

async function capturePass(page: Page, theme: string, pass: Pass): Promise<void> {
  await openKeyboardSettings(page);

  await step(page, `${pass}-idle`, async () => {
    await armRecorder(page);
    await page.mouse.move(2, 2);
    await settle(page, 200);
    await shoot(page, "chord-01-armed", theme, pass, await freezeBar(page, 0));
  });

  await step(page, `${pass}-waiting`, async () => {
    await holdChordTimers(page);
    // Free on every platform and harmless if it leaks past the recorder.
    await page.keyboard.press("Meta+Shift+Alt+KeyY");
    await expect(page.locator(FIELD).first()).toContainText(/second key/i, { timeout: 5000 });
    const fractions: [string, number][] =
      pass === "full"
        ? [
            ["chord-02-waiting-start", 0],
            ["chord-03-waiting-mid", 0.5],
            ["chord-04-waiting-late", 0.9],
          ]
        : [["chord-02-waiting-start", 0]];
    for (const [state, fraction] of fractions) {
      const bar = await freezeBar(page, fraction);
      await settle(page, 60);
      await shoot(page, state, theme, pass, bar);
    }
    await releaseChordTimers(page);
    await expect(page.locator(FIELD).first()).not.toContainText(/second key/i, {
      timeout: 5000,
    });
    await settle(page, 200);
    await shoot(page, "chord-05-captured", theme, pass, await freezeBar(page, 0));
    await cancelEdit(page);
  });

  await closeSettings(page);
}

async function dispatch(page: Page, actionId: string, args: unknown): Promise<void> {
  const result = await page.evaluate(
    ({ actionId, args }) =>
      window.__daintreeDispatchAction?.(actionId, args, { source: "user" }) ??
      Promise.resolve({ ok: false }),
    { actionId, args }
  );
  if (!(result as { ok: boolean }).ok) throw new Error(`${actionId} failed`);
}

test("shortcut recorder chord window — start, mid, late, reduced motion", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CHORD_WINDOW is required for the chord-window capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_CHORD_WINDOW to run the chord-window capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  test.setTimeout(10 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-chordshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await setWindowSize(ctx.app, WIDE);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);

    for (const theme of THEMES) {
      if (theme) await setAppTheme(page, theme);
      await dismissBlockingPalette(page);
      await settle(page, 600);

      await dispatch(page, "preferences.reduceAnimations.set", { value: false });
      await capturePass(page, theme, "full");

      await dispatch(page, "preferences.reduceAnimations.set", { value: true });
      await expect
        .poll(() => page.evaluate(() => document.body.dataset.reduceAnimations ?? ""))
        .toBe("true");
      await capturePass(page, theme, "reduced");
      await dispatch(page, "preferences.reduceAnimations.set", { value: false });
    }
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  console.log(
    `[chord-window-shots] ${manifest.length - missing.length}/${manifest.length} PNGs → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`chord-window capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBeGreaterThan(0);
});
