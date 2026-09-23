/**
 * Rate-limit details panel visual-review harness.
 *
 * The toolbar's rate-limit clock opens a per-bucket panel whose shape depends on
 * what the provider reported: a primary or secondary limit, one bucket or three,
 * a bucket spent beside one nearly spent, no buckets at all, a countdown on either
 * side of an hours / minutes / seconds boundary. None of that is reachable on
 * demand from a real session, so this drives the panel's own preview entry
 * (`rate-limit-details-preview.html`), which mounts the REAL `RateLimitDetailsPanel`
 * inside the real `TooltipContent` against the real theme tokens.
 *
 * Kept apart from `forge-stats-review.spec.ts` (which photographs the toolbar strip
 * the clock sits in) so the two surfaces can be iterated independently.
 *
 *   DAINTREE_SHOT_RATELIMIT=1 npx playwright test --project=screenshots rate-limit-details-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RATELIMIT   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/rate-limit-details-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default daintree,bondi,namib,svalbard)
 *
 * The page clock is frozen before every load, so each countdown photographs the
 * same label on every run. Never writes a PNG it has not verified: the panel must
 * be open with a real box and must carry the fixture's expected text, and the
 * test counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_RATELIMIT;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "rate-limit-details-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** A fixed wall clock so countdown labels are stable between runs. */
const FROZEN_NOW = new Date("2026-09-23T10:00:00Z");

/**
 * Mirrors `FIXTURES` in the preview entry, which only resolves under Vite. The
 * value is text the fixture must render before it is photographed.
 */
const FIXTURES: Record<string, RegExp> = {
  "primary-single": /REST/,
  "primary-multi": /Search/,
  "near-vs-spent": /GraphQL/,
  secondary: /[Ss]econdary/,
  "secondary-no-details": /[Ss]econdary/,
  "kind-unknown": /\d+h/,
  "details-pending": /\d+m/,
  "details-missing": /./,
  gitlab: /REST/,
  "reset-due": /GraphQL/,
  "resume-passed": /next check/,
  "countdown-ladder": /59m 59s|59m/,
  "banner-ladder": /Resumes/,
};

test.use({ deviceScaleFactor: 3 });

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

async function capture(page: Page, fixture: string, theme: string): Promise<string> {
  await stubViteHmrClient(page);
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 640, height: 520 });
  await page.goto(`${baseURL}/rate-limit-details-preview.html?theme=${theme}&fixture=${fixture}`);
  const shell = page.locator("[data-preview-shell]");
  await expect(shell, `fixture "${fixture}" rendered no shell`).toBeAttached();

  const isBanner = fixture === "banner-ladder";
  // Radix mirrors tooltip text into a visually hidden role="tooltip" node, so
  // the visible bubble is found by its own marker, not the role.
  const panel = isBanner ? shell : page.locator("[data-preview-panel]");
  await expect(panel, `fixture "${fixture}" never opened its panel`).toBeVisible();
  await expect(panel).toContainText(FIXTURES[fixture]!);
  await page.evaluate(() => document.fonts.ready);
  // Tooltip entry motion plus the bar width transition.
  await page.waitForTimeout(450);

  const out = path.join(OUT_DIR, `${fixture}-${theme}.png`);
  const shellBox = await shell.boundingBox();
  const panelBox = await panel.boundingBox();
  if (!shellBox || !panelBox || panelBox.width < 8 || panelBox.height < 8) {
    throw new Error(`${fixture}-${theme}: no real box — refusing to write`);
  }
  const pad = 12;
  const x = Math.max(0, Math.min(shellBox.x, panelBox.x) - pad);
  const y = Math.max(0, Math.min(shellBox.y, panelBox.y) - pad);
  const right = Math.max(shellBox.x + shellBox.width, panelBox.x + panelBox.width) + pad;
  const bottom = Math.max(shellBox.y + shellBox.height, panelBox.y + panelBox.height) + pad;
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

test("Rate-limit details — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RATELIMIT is required for the rate-limit details capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_RATELIMIT=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const fixture of Object.keys(FIXTURES)) {
      written.push(await capture(page, fixture, theme));
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * Object.keys(FIXTURES).length);
});
