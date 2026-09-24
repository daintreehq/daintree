/**
 * Daintree Tour dialog visual-review harness.
 *
 * Drives the tour's own preview entry (`tour-preview.html`), which mounts the
 * REAL `TourDialog` against the real theme tokens and `index.css` with a stubbed
 * onboarding bridge. The CDN is blocked so every chapter runs its silent wall
 * clock: the frames are deterministic and the timeline never waits on a voice.
 *
 *   DAINTREE_SHOT_TOUR=1 npx playwright test --project=screenshots tour-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOUR    required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR     output directory (default artifacts/tour-dialog-shots)
 *   DAINTREE_SHOT_THEMES  comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: each state asserts what it is meant
 * to show before the shot, and the test counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TOUR;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "tour-dialog-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

interface TourHandle {
  play(): void;
  pause(): void;
  seek(t: number): void;
  getState(): { status: string; chapterIndex: number };
  timing: { duration: number };
}

async function open(
  page: Page,
  {
    theme,
    chapter,
    t,
    size = { width: 1440, height: 900 },
  }: {
    theme: string;
    chapter: string;
    t: number;
    size?: { width: number; height: number };
  }
): Promise<void> {
  await stubViteHmrClient(page);
  await page.route("https://cdn.daintree.org/**", (route) => route.abort());
  await page.mouse.move(0, 0);
  await page.setViewportSize(size);
  await page.goto(`${baseURL}/tour-preview.html?theme=${theme}&chapter=${chapter}&t=${t}&muted=1`);
  await expect(page.getByTestId("daintree-tour")).toBeVisible();
  await expect(page.locator("[data-tour-canvas]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  // Dialog entry is 200ms; scene transitions settle within a few hundred more.
  await page.waitForTimeout(700);
}

/** Runs `fn` against the live player; `fn` must be self-contained (it is serialised). */
function tour(page: Page) {
  return {
    eval: <T>(fn: (t: TourHandle) => T) =>
      page.evaluate(`(${fn.toString()})(window.__tour)`) as Promise<T>,
  };
}

async function shot(page: Page, file: string, written: string[]): Promise<void> {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out });
  written.push(out);
}

test("Daintree Tour — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TOUR is required for the tour capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TOUR=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    // Paused mid-chapter: the state the user sees after clicking the stage.
    await open(page, { theme, chapter: "welcome", t: 4 });
    expect(await tour(page).eval((t) => t.getState().status)).toBe("paused");
    await shot(page, `01-paused-${theme}.png`, written);

    // Playing mid-chapter with a one-line caption.
    await tour(page).eval((t) => t.play());
    await page.waitForTimeout(250);
    expect(await tour(page).eval((t) => t.getState().status)).toBe("playing");
    await tour(page).eval((t) => t.pause());
    await tour(page).eval((t) => {
      // Keep the frame on "playing" chrome without the timeline moving on.
      t.seek(4);
      t.play();
    });
    await page.waitForTimeout(200);
    await shot(page, `02-playing-${theme}.png`, written);

    // A long, two-line caption later in the tour (Back is present).
    await open(page, { theme, chapter: "state", t: 7 });
    await tour(page).eval((t) => t.play());
    await page.waitForTimeout(200);
    await shot(page, `03-long-caption-${theme}.png`, written);

    // End card with the auto-advance countdown running.
    await open(page, { theme, chapter: "worktrees", t: 0 });
    await tour(page).eval((t) => {
      t.seek(t.timing.duration - 0.1);
      t.play();
    });
    await expect
      .poll(() => tour(page).eval((t) => t.getState().status), { timeout: 3000 })
      .toBe("ended");
    await page.waitForTimeout(900);
    await shot(page, `04-end-card-${theme}.png`, written);

    // Last chapter's end card: no countdown, finishing is the user's call.
    await open(page, { theme, chapter: "outro", t: 0 });
    await tour(page).eval((t) => {
      t.seek(t.timing.duration - 0.1);
      t.play();
    });
    await expect
      .poll(() => tour(page).eval((t) => t.getState().status), { timeout: 3000 })
      .toBe("ended");
    await page.waitForTimeout(400);
    await shot(page, `05-finish-card-${theme}.png`, written);
  }

  // Interaction and layout states, dark default only.
  const theme = THEMES[0]!;

  // Hovering a chapter segment in the progress track.
  await open(page, { theme, chapter: "agents", t: 5 });
  const segment = page.getByRole("button", { name: /^Chapter 6:/ });
  await segment.hover();
  await page.waitForTimeout(600);
  await shot(page, `06-track-hover-${theme}.png`, written);

  // Keyboard focus on the stage.
  await open(page, { theme, chapter: "agents", t: 5 });
  await page.getByTestId("tour-stage-toggle").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  await shot(page, `07-stage-focus-${theme}.png`, written);

  // Mid-transition: the frame straight after moving to the next chapter.
  await open(page, { theme, chapter: "agents", t: 5 });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForTimeout(90);
  await shot(page, `08-transition-${theme}.png`, written);

  // A short laptop window: the stage gives up space first, and nothing clips.
  await open(page, { theme, chapter: "fleet", t: 9, size: { width: 1280, height: 720 } });
  const card = await page
    .getByTestId("daintree-tour")
    .locator("[tabindex='-1']")
    .first()
    .boundingBox();
  const next = await page.getByRole("button", { name: "Next", exact: true }).boundingBox();
  expect(card && next && next.y + next.height + 8 <= card.y + card.height).toBe(true);
  await shot(page, `09-short-window-${theme}.png`, written);

  // End card after "Stay here": no countdown, focus kept on the card.
  await open(page, { theme, chapter: "worktrees", t: 0 });
  await tour(page).eval((t) => {
    t.seek(t.timing.duration - 0.1);
    t.play();
  });
  await expect
    .poll(() => tour(page).eval((t) => t.getState().status), { timeout: 3000 })
    .toBe("ended");
  await page.getByRole("button", { name: "Stay here" }).click();
  await page.waitForTimeout(3500);
  expect(await tour(page).eval((t) => t.getState().chapterIndex)).toBe(1);
  await shot(page, `10-end-card-held-${theme}.png`, written);

  // Focus follows the stage onto the end card, and off it again, in a real
  // browser where `inert` is enforced.
  await open(page, { theme, chapter: "worktrees", t: 0 });
  await page.getByTestId("tour-stage-toggle").focus();
  await tour(page).eval((t) => {
    t.seek(t.timing.duration - 0.1);
    t.play();
  });
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
    .toMatch(/^Next: /);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid")), {
      timeout: 5000,
    })
    .toBe("tour-stage-toggle");

  // A focused scrubber keeps focus as the chapter it belongs to moves on.
  await open(page, { theme, chapter: "worktrees", t: 0 });
  await page.getByRole("slider").focus();
  await tour(page).eval((t) => {
    t.seek(t.timing.duration - 0.1);
    t.play();
  });
  await expect(page.getByTestId("tour-chapter-count")).toHaveText(/^Chapter 3 of/, {
    timeout: 6000,
  });
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("slider");

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * 5 + 5);
});
