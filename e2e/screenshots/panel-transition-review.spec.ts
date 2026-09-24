/**
 * Minimize-to-dock transition visual-review harness.
 *
 * The ghost that carries a pane into the dock lives for 120ms, so nobody has ever
 * looked at it standing still — which is exactly why its defects survive. This drives
 * `panel-transition-preview.html` (the real `PanelTransitionOverlay` and the real
 * `ContentDock` under a stand-in grid), runs the grid pane's minimize sequence, and
 * photographs single frames of the flight.
 *
 * Freezing a 120ms flight takes two clocks held still at once:
 *   - Playwright's fake clock holds `setTimeout` and `requestAnimationFrame`, so the
 *     overlay's own cleanup timer cannot remove the ghost mid-capture.
 *   - CDP `Animation.setPlaybackRate(0)` holds every CSS transition and WAAPI
 *     animation, so no animation finishes during the round trips between steps.
 * Each frame then seeks the overlay's animations to one instant of the flight.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_PANELTRANSITION=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots panel-transition-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PANELTRANSITION  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES           default daintree,namib,svalbard
 *
 * Output: `<fixture>-<theme>-<frame>.png`, where frame is `before`, `t30`, `t60`,
 * `t90` (percent of the flight) or `after` (the dock at rest once the flight ends).
 * Never writes a PNG it has not verified, and counts the files itself.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, unlinkSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PANELTRANSITION;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** The pane each fixture minimizes: the grid's top-right agent. */
const TARGET = "p-codex";
const FRAMES = [0.3, 0.6, 0.9] as const;
const ATTACH_TIMEOUT_MS = 30_000;
const CLOCK_START = Date.UTC(2026, 0, 1);
/** The overlay portal's own hook. */
const OVERLAY = "[data-panel-transition-overlay]";

test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".png")) unlinkSync(path.join(OUT_DIR, f));
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/panel-transition-preview.html`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
}

async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[transition-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}\n  pageerror: ${errors.join(" | ") || "(none)"}`, {
        cause: error,
      });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function load(page: Page, fixture: string, theme: string) {
  await page.clock.install({ time: CLOCK_START });
  await page.setViewportSize({ width: 1280, height: 680 });
  await page.goto(
    `${server!.baseURL}/panel-transition-preview.html?theme=${theme}&fixture=${fixture}`
  );
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  // `install` alone lets fake time keep flowing; `pauseAt` is what stops it. Jumping a
  // second ahead also runs out the dock's own mount fades before anything is measured.
  await page.clock.pauseAt(CLOCK_START + 1_000);
  await expect(page.locator(`[data-panel-id="${TARGET}"]`)).toBeVisible();
  await expect(page.locator("[data-dock-density]")).toBeVisible();
}

/** Run the grid pane's minimize sequence on TARGET. */
async function minimize(page: Page) {
  await page.evaluate(
    (id) => (window as unknown as { __minimize(id: string): void }).__minimize(id),
    TARGET
  );
  // React commits on a MessageChannel task, which the fake clock does not hold.
  await page.waitForTimeout(100);
}

/** Minimize TARGET and hold the flight at `progress`. */
async function flyTo(page: Page, progress: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  await minimize(page);
  // One frame, so the ghost's rAF arms the flight.
  await page.clock.runFor(17);
  await page.waitForTimeout(50);
  const frozen = await page.evaluate(
    (p) => (window as unknown as { __freeze(p: number): number }).__freeze(p),
    progress
  );
  if (frozen === 0) throw new Error(`no overlay animation to freeze at ${progress}`);
  await expect(page.locator(OVERLAY)).toHaveCount(1);
  return frozen;
}

test("panel transition — minimize flight, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PANELTRANSITION is required for the transition capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PANELTRANSITION=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];
  const shell = (page: Page) => page.locator("[data-preview-shell]");

  const shoot = async (fixture: string, theme: string) => {
    written.push(
      await withPage(context, `${fixture} ${theme} before`, async (page) => {
        await load(page, fixture, theme);
        return snap(shell(page), `${fixture}-${theme}-before.png`);
      })
    );
    for (const progress of FRAMES) {
      const frame = `t${Math.round(progress * 100)}`;
      written.push(
        await withPage(context, `${fixture} ${theme} ${frame}`, async (page) => {
          await load(page, fixture, theme);
          await flyTo(page, progress);
          return snap(page.locator("body"), `${fixture}-${theme}-${frame}.png`);
        })
      );
    }
    written.push(
      await withPage(context, `${fixture} ${theme} after`, async (page) => {
        await load(page, fixture, theme);
        await minimize(page);
        await page.clock.runFor(2_000);
        await page.waitForTimeout(400);
        await expect(page.locator(OVERLAY)).toHaveCount(0);
        await expect(
          page.locator(`[data-panel-id="${TARGET}"][data-panel-location="grid"]`)
        ).toHaveCount(0);
        await expect(page.locator(`[data-dock-item-id="${TARGET}"]`)).toBeVisible();
        return snap(shell(page), `${fixture}-${theme}-after.png`);
      })
    );
  };

  for (const theme of THEMES) await shoot("few", theme);
  await shoot("busy", THEMES[0]!);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe((THEMES.length + 1) * (FRAMES.length + 2));
  console.log(`[transition-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
