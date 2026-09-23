/**
 * Host memory-pause indicator visual-review harness.
 *
 * The indicator only exists while a terminal host has paused output for memory
 * (#12375), which nobody holds still long enough to look at. This drives
 * `toolbar-preview.html` — the real `Toolbar` against seeded stores — and pushes
 * the pause through the real `hostMemoryPauseStore` the app's sync hook writes,
 * loaded through Vite's own module graph so it is the same instance the toolbar
 * reads. It covers both states (paused, and lifted-but-still-warning), the
 * tooltip each opens, keyboard focus, the right-hand run with and without the
 * indicator, narrow windows on both platforms, and the Why am I slow? tab the
 * click leads to (`diagnostics-preview.html`).
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_HOSTMEMORY is set.
 *
 *   DAINTREE_SHOT_HOSTMEMORY=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots host-memory-pause-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HOSTMEMORY  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES      themes for the theme sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_HOSTMEMORY;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const STRIP = '[role="toolbar"][aria-label="Main toolbar"]';
const INDICATOR = '[data-testid="host-memory-pause-indicator"]';
const STRIP_HEIGHT = 48;

type PauseState = "none" | "paused" | "monitoring";

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

let server: PreviewServer | undefined;
const consoleErrors: string[] = [];
const expected: string[] = [];

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
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Writes the store exactly as `useHostMemoryPauseSync` does once the display gate clears. */
async function writePause(page: Page, state: PauseState): Promise<void> {
  await page.evaluate(async (s) => {
    const mod = await import(/* @vite-ignore */ "/src/store/hostMemoryPauseStore.ts");
    mod.useHostMemoryPauseStore.setState(
      s === "none"
        ? { snapshot: { active: false, paused: false, stalled: false }, visible: false }
        : { snapshot: { active: true, paused: s === "paused", stalled: false }, visible: true }
    );
  }, state);
}

async function setPause(page: Page, state: PauseState): Promise<void> {
  await writePause(page, state);
  if (state === "none") {
    await expect(page.locator(INDICATOR)).toHaveCount(0);
  } else {
    await page.locator(INDICATOR).waitFor({ state: "visible", timeout: 10_000 });
  }
  await settle(page);
}

interface OpenOptions {
  theme?: string;
  platform?: "mac" | "windows";
  width?: number;
  state: PauseState;
}

async function openToolbar(page: Page, opts: OpenOptions): Promise<void> {
  const { theme = "daintree", platform = "mac" } = opts;
  await page.setViewportSize({ width: opts.width ?? 1440, height: 240 });
  const url = `${server!.baseURL}/toolbar-preview.html?theme=${theme}&fixture=owner&platform=${platform}`;
  await page.goto(url, { waitUntil: "load" });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page
    .locator(STRIP)
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch((e: unknown) => {
      throw new Error(`toolbar never mounted (${url}): ${String(e)}\n${consoleErrors.join("\n")}`);
    });
  await page
    .locator('[data-toolbar-button-id="launcher"] button')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await setPause(page, opts.state);
}

async function assertIndicator(page: Page, state: PauseState, file: string): Promise<void> {
  if (state === "none") return;
  const label = await page.locator(INDICATOR).getAttribute("aria-label");
  const wantsPaused = state === "paused";
  if (!label || /paused/i.test(label) !== wantsPaused) {
    throw new Error(`${file}: indicator label "${label}" does not match state ${state}`);
  }
}

async function shoot(
  page: Page,
  file: string,
  clip: { x: number; y: number; width: number; height: number }
): Promise<void> {
  expected.push(file);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
}

/** The strip, or its right-hand 620px, plus a few px of canvas under it. */
async function snapStrip(
  page: Page,
  file: string,
  state: PauseState,
  crop?: "right"
): Promise<void> {
  await settle(page, 150);
  await assertIndicator(page, state, file);
  const box = await page.locator(STRIP).boundingBox();
  if (!box || box.height < STRIP_HEIGHT - 1 || box.width < 400) {
    throw new Error(`${file}: toolbar has no real box (${JSON.stringify(box)})`);
  }
  const half = 620;
  await shoot(page, file, {
    x: crop === "right" ? box.width - half : 0,
    y: 0,
    width: crop ? half : box.width,
    height: box.height + 8,
  });
}

/** The indicator and its immediate neighbours, big enough to judge the pip. */
async function snapCloseup(page: Page, file: string, state: PauseState): Promise<void> {
  await settle(page, 150);
  await assertIndicator(page, state, file);
  const box = await page.locator(INDICATOR).boundingBox();
  if (!box || box.width < 20) throw new Error(`${file}: indicator has no real box`);
  await shoot(page, file, { x: box.x - 120, y: 0, width: box.width + 240, height: STRIP_HEIGHT });
}

/** The right end of the strip with the open tooltip under it. */
async function snapTooltip(page: Page, file: string, state: PauseState): Promise<void> {
  await settle(page, 400);
  await assertIndicator(page, state, file);
  const tip = page.locator('[role="tooltip"]').first();
  await tip.waitFor({ state: "attached", timeout: 5_000 });
  const content = page.locator("[data-radix-popper-content-wrapper]").first();
  const box = await content.boundingBox();
  if (!box || box.height < 20) throw new Error(`${file}: tooltip has no real box`);
  const viewport = page.viewportSize()!;
  const width = 620;
  await shoot(page, file, {
    x: viewport.width - width,
    y: 0,
    width,
    height: Math.min(viewport.height, Math.ceil(box.y + box.height + 16)),
  });
}

test.describe("host memory pause indicator review", () => {
  test("captures", async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_HOSTMEMORY is required for the host memory pause capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_HOSTMEMORY to run the host memory pause capture");
    test.setTimeout(600_000);
    await stubViteHmrClient(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(String(e));
      consoleErrors.push(e.stack ?? String(e));
    });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    // The right-hand run at rest, then with each state, on both platforms.
    for (const platform of ["mac", "windows"] as const) {
      for (const state of ["none", "paused", "monitoring"] as const) {
        await openToolbar(page, { platform, state });
        await snapStrip(page, `${platform}-${state}-right.png`, state, "right");
      }
    }

    // Pip-level close-ups of each state.
    for (const state of ["paused", "monitoring"] as const) {
      await openToolbar(page, { state });
      await snapCloseup(page, `mac-${state}-closeup.png`, state);
    }

    // Tooltips, pointer-opened.
    for (const state of ["paused", "monitoring"] as const) {
      await openToolbar(page, { state });
      await page.locator(INDICATOR).hover();
      await snapTooltip(page, `mac-${state}-tooltip.png`, state);
    }

    // Keyboard focus: tab into the strip, then arrow along it to the indicator.
    await openToolbar(page, { state: "paused" });
    await page.locator(INDICATOR).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await snapTooltip(page, "mac-paused-focus.png", "paused");

    // Narrow windows: the overflow engine is evicting while the indicator holds its slot.
    for (const width of [1100, 900]) {
      for (const platform of ["mac", "windows"] as const) {
        await openToolbar(page, { platform, width, state: "paused" });
        await snapStrip(page, `${platform}-paused-${width}.png`, "paused");
      }
    }

    // Theme sweep, both states.
    for (const theme of THEMES) {
      if (theme === "daintree") continue;
      for (const state of ["paused", "monitoring"] as const) {
        await openToolbar(page, { theme, state });
        await snapCloseup(page, `theme-${theme}-${state}-closeup.png`, state);
      }
    }

    // Where the click leads: the Why am I slow? tab during a memory pause.
    for (const theme of ["daintree"]) {
      const height = 440;
      await page.setViewportSize({ width: 1200, height: height * 2 + 40 });
      await page.goto(
        `${server!.baseURL}/diagnostics-preview.html?fixture=whyslow-memory-pause&theme=${theme}&height=${height}&width=1200`,
        { waitUntil: "load" }
      );
      await page.addStyleTag({ content: FREEZE_CSS });
      await writePause(page, "paused");
      const dock = page.locator(".diagnostics-dock").first();
      await page
        .locator('[aria-labelledby="why-slow-resource"]')
        .waitFor({ state: "visible", timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(0, 0);
      await settle(page, 400);
      const box = await dock.boundingBox();
      if (!box || Math.abs(box.height - height) > 2) {
        throw new Error(`why-slow: dock is ${box?.height}px tall, expected ${height}`);
      }
      await shoot(page, `whyslow-memory-pause-${theme}.png`, box);
    }

    expect(errors, errors.join("\n")).toEqual([]);
    const landed = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    const missing = expected.filter((f) => !landed.includes(f));
    expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
    expect(landed.length).toBe(expected.length);
  });
});
