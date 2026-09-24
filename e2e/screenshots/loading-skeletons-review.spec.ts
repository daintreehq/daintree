/**
 * Loading skeletons visual-review harness.
 *
 * A skeleton is on screen for a second at a time and pulses while it is there,
 * so the frame anyone remembers is not the frame that matters. This drives the
 * preview entry (`loading-skeletons-preview.html`), which mounts the real
 * `ui/Skeleton` primitives, `BrowserPaneSkeleton` and `WorktreeCardPlaceholder`,
 * then pauses every running animation on a chosen frame of the steady-state
 * pulse: `peak` (the bone at its strongest) and `trough` (its faintest — the
 * frame that decides whether a bone is visible at all).
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_SKELETONS is set.
 *
 *   DAINTREE_SHOT_SKELETONS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots loading-skeletons-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SKELETONS   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES      themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP       "0" skips the all-themes sweep of the primitives trough
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_SKELETONS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

type Frame = "peak" | "trough";

interface Shot {
  fixture: string;
  frames: Frame[];
  fast?: boolean;
  /** Proves the fixture reached the state its file name claims. */
  expectState: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  {
    fixture: "primitives",
    frames: ["peak", "trough"],
    expectState: async (page) => {
      await expect(page.locator("[data-surface]")).toHaveCount(4);
    },
  },
  {
    fixture: "hint",
    frames: ["peak"],
    expectState: async (page) => {
      await expect(
        page.locator('[aria-hidden="true"]', { hasText: "Fetching 3 of 12 files…" })
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(2);
    },
  },
  {
    fixture: "browser-pane",
    frames: ["peak", "trough"],
    expectState: async (page) => {
      await expect(page.getByRole("status", { name: "Loading browser panel" })).toBeAttached();
    },
  },
  {
    fixture: "browser-pane-hint",
    frames: ["peak"],
    fast: true,
    expectState: async (page) => {
      await expect(
        page.locator('[aria-hidden="true"]', { hasText: /Still working|Taking longer/ }).first()
      ).toBeVisible();
    },
  },
  {
    fixture: "worktree-creating",
    frames: ["peak", "trough"],
    expectState: async (page) => {
      await expect(page.locator("[data-pending-creation-path]")).toHaveCount(1);
      await expect(page.locator(".sidebar-worktree-card")).toHaveCount(3);
    },
  },
  {
    fixture: "worktree-error",
    frames: ["peak"],
    expectState: async (page) => {
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(page.getByText(/already exists/).last()).toBeVisible();
    },
  },
];

const FORCED_COLORS_FIXTURES = ["primitives", "browser-pane", "worktree-creating"];

let server: PreviewServer | undefined;

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
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, shot: Shot, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[skeleton-shots] pageerror: ${error.message}`));
  const query = `theme=${theme}&fixture=${shot.fixture}${shot.fast ? "&fast=1" : ""}`;
  const url = `${server!.baseURL}/loading-skeletons-preview.html?${query}`;
  const frame = page.locator(`[data-fixture="${shot.fixture}"]`);
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout: 30_000 });
  }
  // A Tailwind utility resolving proves the stylesheet landed, not just the markup.
  await expect(page.locator(".border-divider").first()).toHaveCSS("border-top-style", "solid");
  await page.evaluate(() => document.fonts.ready);
  // Let the hint thresholds (0ms, or 80ms under ?fast) and the 400ms gate elapse.
  await page.waitForTimeout(shot.fast ? 900 : 600);
  await shot.expectState(page);
}

/**
 * Pause every animation and park the whole document on the steady-state pulse
 * frame where a reference bone is strongest (`peak`) or faintest (`trough`).
 * The search runs past the anti-flicker gate so a pre-onset frame (opacity 0)
 * never counts as a trough, and it is implementation-agnostic: it reads the
 * computed opacity rather than assuming any keyframe layout.
 */
async function freeze(page: Page, frame: Frame): Promise<number> {
  const result = await page.evaluate((mode) => {
    const animations = document.getAnimations();
    for (const a of animations) a.pause();
    const bone = document.querySelector<HTMLElement>('[class*="animate-pulse"]');
    const setAll = (t: number) => {
      for (const a of animations) a.currentTime = t;
    };
    if (!bone) {
      setAll(4000);
      return { t: 4000, opacity: 1, found: false };
    }
    let bestT = 2000;
    let best = mode === "peak" ? -1 : 2;
    for (let t = 2000; t <= 6000; t += 10) {
      setAll(t);
      const o = Number(getComputedStyle(bone).opacity);
      if (mode === "peak" ? o > best : o < best) {
        best = o;
        bestT = t;
      }
    }
    setAll(bestT);
    return { t: bestT, opacity: Number(getComputedStyle(bone).opacity), found: true };
  }, frame);
  await page.waitForTimeout(100);
  return result.opacity;
}

async function capture(page: Page, shot: Shot, frame: Frame, file: string): Promise<string> {
  const opacity = await freeze(page, frame);
  if (frame === "trough" && opacity >= 0.99) {
    throw new Error(`${file}: trough frame found no dip (opacity ${opacity}) — refusing to write`);
  }
  const snap = makeSnap(OUT_DIR);
  return snap(page.locator(`[data-fixture="${shot.fixture}"]`), file);
}

test("Loading skeletons — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SKELETONS is required for the skeleton capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SKELETONS=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  await page.setViewportSize({ width: 1200, height: 800 });
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const shot of SHOTS) {
      for (const frame of shot.frames) {
        await open(page, shot, theme);
        written.push(await capture(page, shot, frame, `${shot.fixture}--${frame}--${theme}.png`));
      }
    }
  }

  await page.emulateMedia({ forcedColors: "active" });
  for (const name of FORCED_COLORS_FIXTURES) {
    const shot = SHOTS.find((s) => s.fixture === name)!;
    await open(page, shot, "daintree");
    written.push(await capture(page, shot, "peak", `forced-colors--${name}--daintree.png`));
  }
  await page.emulateMedia({ forcedColors: "none" });

  if (SWEEP) {
    const primitives = SHOTS[0]!;
    for (const theme of ALL_THEMES) {
      await open(page, primitives, theme);
      written.push(
        await capture(page, primitives, "trough", `sweep--primitives--trough--${theme}.png`)
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[skeleton-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
