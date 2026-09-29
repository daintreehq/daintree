/**
 * Assistant panel banners visual-review harness.
 *
 * The banners at the top of the assistant panel are almost all reached by a failure or
 * mid-session (a refused tool, a lapsed grant, a launch whose services never started),
 * so this drives `assistant-banners-preview.html` rather than booting Electron: the real
 * `HelpPanelBanners`, the theme's real tokens, the panel's real widths.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_ASSISTANTBANNERS is set.
 *
 *   DAINTREE_SHOT_ASSISTANTBANNERS=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots assistant-banners-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ASSISTANTBANNERS  required: any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR              output directory (default artifacts/assistant-banners-shots)
 *   DAINTREE_SHOT_THEMES            comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: `snap()` refuses a target with no real box,
 * and the test counts the files itself rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_ASSISTANTBANNERS;

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "assistant-banners-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry. */
const FIXTURES = [
  "resume",
  "grant-active",
  "grant-revoking",
  "grant-ended",
  "grant-ceiling",
  "tier-mismatch",
  "tier-approving",
  "tier-unknown",
  "launch-retry",
  "launch-spawn",
  "launch-lanes",
  "launch-folder",
  "revoked",
  "stack",
] as const;

/** The states that pressure the width, captured again at the resizer minimum. */
const NARROW_FIXTURES = ["grant-active", "tier-mismatch", "launch-folder", "stack"] as const;

test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(
  page: Page,
  fixture: string,
  theme: string,
  width: number
): Promise<{ panel: Locator; banners: Locator }> {
  await page.setViewportSize({ width: 800, height: 900 });
  const url = `${server!.baseURL}/assistant-banners-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`;
  const panel = page.locator("[data-preview-panel]").first();
  const banners = page.locator("[data-preview-banners]").first();
  try {
    await page.goto(url);
    await expect(panel).toBeAttached({ timeout: 30_000 });
  } catch {
    console.warn(
      `[assistant-banners-shots] first mount of ${fixture}/${theme}@${width} failed; retrying once`
    );
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(panel).toBeAttached({ timeout: 30_000 });
  }
  // Mounted is not styled: `flex` comes from a Tailwind utility, so its presence
  // proves the stylesheet landed.
  await expect(panel).toHaveCSS("display", "flex");
  // A fixture that mounts no banner is a harness bug, not an empty state to photograph.
  await expect(banners.locator("[data-testid^='help-']").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // Past any banner entry transition.
  await page.waitForTimeout(400);
  return { panel, banners };
}

test("assistant banners — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ASSISTANTBANNERS is required for the banners capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ASSISTANTBANNERS=1 to run the capture");

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const name of FIXTURES) {
      const { panel } = await open(page, name, theme, DEFAULT_WIDTH);
      written.push(await snap(panel, `${name}-${theme}-380.png`));
    }
  }

  const narrowTheme = THEMES[0]!;
  for (const name of NARROW_FIXTURES) {
    const { panel } = await open(page, name, narrowTheme, MIN_WIDTH);
    written.push(await snap(panel, `${name}-${narrowTheme}-320.png`));
  }

  // Keyboard focus through a real Tab, so :focus-visible fires: first the dismiss on a
  // one-control banner, then the primary action on a banner with a recovery row.
  for (const name of ["resume", "tier-mismatch"] as const) {
    const { panel } = await open(page, name, narrowTheme, DEFAULT_WIDTH);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    written.push(await snap(panel, `${name}-${narrowTheme}-380-focus.png`));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[assistant-banners-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
