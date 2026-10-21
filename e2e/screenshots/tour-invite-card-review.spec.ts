/**
 * Tour invite card visual-review harness.
 *
 * Drives `tour-invite-preview.html`, which mounts the REAL `TourInviteCard`
 * against the real theme tokens and `index.css`, with the onboarding bridge
 * seeded through the same `onboarding.get` read the card makes in the app.
 *
 *   DAINTREE_SHOT_TOUR_INVITE=1 DAINTREE_SHOT_DIR=/abs/dir \
 *     npx playwright test --project=screenshots tour-invite-card-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOUR_INVITE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — output directory, outside the repo
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: each state asserts what it is meant
 * to show before the shot, and the test counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TOUR_INVITE;
const OUT = process.env.DAINTREE_SHOT_DIR;

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";
let OUT_DIR = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT) throw new Error("DAINTREE_SHOT_DIR must name a directory outside the repo");
  OUT_DIR = path.resolve(OUT);
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function open(
  page: Page,
  { theme, chapter = 0, measure = 38 }: { theme: string; chapter?: number; measure?: number }
): Promise<void> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto(
    `${baseURL}/tour-invite-preview.html?theme=${theme}&chapter=${chapter}&measure=${measure}`
  );
  await expect(page.getByTestId("tour-invite-card")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250); // Fonts and the tooltip provider settle before the frame.
}

/** Turns the invitation down and waits for the note to be on screen and settled. */
async function dismiss(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Don't show again" }).click();
  await expect(page.getByRole("status")).toContainText("Help");
  await expect(page.getByTestId("tour-invite-card")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400); // The note's entry settles before the frame.
}

async function shot(page: Page, file: string, written: string[]): Promise<void> {
  const frame = page.locator("[data-preview-frame]");
  const box = await frame.boundingBox();
  if (!box || box.height < 24)
    throw new Error(`${file}: frame has no real box — refusing to write`);
  const out = path.join(OUT_DIR, file);
  await frame.screenshot({ path: out });
  written.push(out);
}

test("Tour invite card — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TOUR_INVITE is required for the invite card capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TOUR_INVITE=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    await open(page, { theme });
    await expect(page.getByTestId("tour-invite-card")).toContainText("Take the");
    await shot(page, `01-invite--${theme}.png`, written);

    await open(page, { theme, chapter: 3 });
    await expect(page.getByTestId("tour-invite-card")).toContainText("See who needs you");
    await shot(page, `02-resume--${theme}.png`, written);

    await open(page, { theme, chapter: 6, measure: 24 });
    await expect(page.getByTestId("tour-invite-card")).toContainText("Hand your codebase");
    await shot(page, `03-resume-narrow--${theme}.png`, written);

    await open(page, { theme });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /start tour/i })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await shot(page, `04-focus-primary--${theme}.png`, written);

    await open(page, { theme, measure: 24 });
    await dismiss(page);
    await shot(page, `05-note-narrow--${theme}.png`, written);

    await open(page, { theme });
    await dismiss(page);
    await shot(page, `06-dismissed-note--${theme}.png`, written);
  }

  expect(pageErrors, "page errors during capture").toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length, "every promised PNG is on disk").toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 6);
});
