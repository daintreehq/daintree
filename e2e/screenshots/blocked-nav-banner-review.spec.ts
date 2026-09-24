/**
 * Dev preview blocked-navigation banner visual-review harness.
 *
 * Every phase of the banner past "blocked" sits behind a real OAuth round trip
 * through the system browser, so the family is never seen side by side. This
 * drives `blocked-nav-banner-preview.html`, which mounts the real pane chrome,
 * toolbar and banner with the banner's state produced by its own reducer, and
 * performs the states no fixture can hold — the copy confirmation, the open
 * overflow menu, keyboard focus — with a real pointer and real keys.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_BLOCKEDNAV is set.
 *
 *   DAINTREE_SHOT_BLOCKEDNAV=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots blocked-nav-banner-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_BLOCKEDNAV   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES       themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP        "0" skips the all-themes sweep of the OAuth offer
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  BLOCKED_NAV_FIXTURES,
  BLOCKED_NAV_FIXTURE_NAMES,
  type BlockedNavFixture,
  type BlockedNavFixtureName,
} from "../../src/components/DevPreview/__preview__/blockedNavFixtures";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_BLOCKEDNAV;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

const FRAME = "[data-fixture]";
const ADDRESS = '[data-testid="browser-address-bar"]';

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

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

async function open(page: Page, fixture: BlockedNavFixtureName, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: BLOCKED_NAV_FIXTURES[fixture].width + 80, height: 720 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[blocked-nav-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/blocked-nav-banner-preview.html?theme=${theme}&fixture=${fixture}`;
  const frame = page.locator(FRAME).first();
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout: 30_000 });
  }
  // A Tailwind-drawn border on the address bar proves the stylesheet landed,
  // not just the markup.
  await expect(page.locator(ADDRESS)).toBeVisible();
  await expect(page.locator(ADDRESS)).toHaveCSS("border-top-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  return frame;
}

/** Perform the fixture's pointer/keyboard state and prove it is on screen. */
async function drive(page: Page, fixture: BlockedNavFixtureName): Promise<void> {
  const spec: BlockedNavFixture = BLOCKED_NAV_FIXTURES[fixture];
  const banner = bannerLocator(page);
  switch (spec.drive) {
    case "copied": {
      await banner.getByRole("button", { name: /copy url/i }).click();
      await expect(banner.getByRole("button", { name: /copied/i })).toBeVisible();
      await page.mouse.move(0, 0);
      break;
    }
    case "overflow-open": {
      await banner.getByRole("button", { name: /more/i }).first().click();
      await expect(page.locator("[data-radix-popper-content-wrapper]").first()).toBeVisible();
      break;
    }
    case "keyboard-focus": {
      // Land on the banner's first control from the keyboard so the ring is
      // :focus-visible, the way a user tabbing out of the toolbar meets it.
      const first = banner.locator("button").first();
      for (
        let i = 0;
        i < 40 && !(await first.evaluate((el) => el === document.activeElement));
        i++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(first).toBeFocused();
      break;
    }
    default:
      break;
  }
  await page.waitForTimeout(150);
}

function bannerLocator(page: Page): Locator {
  return page.locator("[data-harness-banner] > *").first();
}

/**
 * What each fixture must show before its PNG is written: a phase that failed to
 * reach the banner would otherwise produce a correctly named picture of the
 * plain blocked state.
 */
async function expectFixtureState(page: Page, name: BlockedNavFixtureName): Promise<void> {
  const fixture: BlockedNavFixture = BLOCKED_NAV_FIXTURES[name];
  const banner = bannerLocator(page);
  await expect(banner).toBeVisible();
  const box = await banner.boundingBox();
  if (!box || box.height < 24) {
    throw new Error(`banner has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  await expect(banner).toContainText(PHASE_TITLE[fixture.phase]);
}

/** The banner's title per phase — what proves the phase reached the render. */
const PHASE_TITLE: Record<BlockedNavFixture["phase"], RegExp> = {
  blocked: /Navigation blocked/,
  "oauth-started": /Sign in via browser/,
  "oauth-intercepting": /Sign in via browser/,
  "oauth-completed": /Sign in completed/,
  "oauth-timed-out": /Sign in didn't complete/,
  "oauth-error": /Couldn't start sign-in/,
};

/** The frame plus any open menu or tooltip that spills past it. */
async function clipFor(page: Page) {
  const box = await page.locator(FRAME).first().boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`frame has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  let { x, y } = box;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  const overlays = page.locator(
    '[role="menu"], [role="tooltip"], [data-radix-popper-content-wrapper]'
  );
  for (const overlay of await overlays.all()) {
    const o = await overlay.boundingBox();
    if (!o) continue;
    x = Math.min(x, o.x);
    y = Math.min(y, o.y);
    right = Math.max(right, o.x + o.width);
    bottom = Math.max(bottom, o.y + o.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

test("Blocked navigation banner — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_BLOCKEDNAV is required for the blocked-nav capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_BLOCKEDNAV=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const name of BLOCKED_NAV_FIXTURE_NAMES) {
      await open(page, name, theme);
      await drive(page, name);
      await expectFixtureState(page, name);
      const out = path.join(OUT_DIR, `${name}--${theme}.png`);
      await page.screenshot({ path: out, clip: await clipFor(page) });
      written.push(out);
    }
  }

  if (SWEEP) {
    for (const sweepTheme of ALL_THEMES) {
      const frame = await open(page, "oauth-offer", sweepTheme);
      await expectFixtureState(page, "oauth-offer");
      written.push(await snap(frame, `sweep--oauth-offer--${sweepTheme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * BLOCKED_NAV_FIXTURE_NAMES.length);
  console.log(`[blocked-nav-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
