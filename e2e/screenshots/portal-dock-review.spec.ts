/**
 * Portal dock visual-review harness — the web-chat sidebar.
 *
 * Drives the Portal preview entry (`portal-preview.html`), which mounts the real
 * `PortalDock` from fixtures: the launchpad on first run and on a blank tab, a
 * chat page with its tab strip, the no-links empty state, and the dev-server
 * section empty and populated. Hover and keyboard-focus states are performed
 * with a real pointer and real keys.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_PORTAL is set.
 *
 *   DAINTREE_SHOT_PORTAL=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots portal-dock-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PORTAL   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES   themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP    "0" skips the all-themes sweep of the first-run launchpad
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  FIXTURES,
  FIXTURE_NAMES,
  type FixtureName,
} from "../../src/components/Portal/__preview__/fixtures";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PORTAL;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

const FRAME = "[data-fixture]";
const DOCK = 'aside[aria-label="Portal"]';

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

async function open(page: Page, fixture: FixtureName, theme: string): Promise<Locator> {
  const spec = FIXTURES[fixture];
  // PortalDock clamps a restored width so the editor keeps 400px of viewport;
  // leave that much room or every fixture photographs at the 320px minimum.
  await page.setViewportSize({ width: spec.width + 520, height: spec.height + 80 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[portal-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/portal-preview.html?theme=${theme}&fixture=${fixture}`;
  const frame = page.locator(FRAME).first();
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout: 60_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout: 60_000 });
  }
  // A Tailwind utility resolving proves the stylesheet landed, not just markup.
  await expect(page.locator(DOCK)).toHaveCSS("display", "flex");
  await expect(page.locator(DOCK)).toHaveCSS("width", `${spec.width}px`);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  return frame;
}

async function drive(page: Page, fixture: FixtureName): Promise<void> {
  const spec = FIXTURES[fixture] as { drive?: string };
  switch (spec.drive) {
    case "hover-row": {
      await page
        .getByRole("button", { name: /ChatGPT/ })
        .first()
        .hover();
      break;
    }
    case "focus-row": {
      const target = page.getByRole("button", { name: /ChatGPT/ }).first();
      await page.locator(DOCK).focus();
      for (
        let i = 0;
        i < 30 && !(await target.evaluate((el) => el === document.activeElement));
        i++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(target).toBeFocused();
      break;
    }
    case "hover-copy": {
      await page
        .getByRole("button", { name: /copy url/i })
        .first()
        .hover();
      await expect(page.getByRole("tooltip").first()).toBeVisible();
      break;
    }
    case "hover-dev-action": {
      await page
        .getByRole("button", { name: /Restart dev server for main/ })
        .first()
        .hover();
      break;
    }
    default:
      break;
  }
  await page.waitForTimeout(200);
}

async function expectFixtureState(page: Page, name: FixtureName): Promise<void> {
  const spec = FIXTURES[name];
  const dashboard = page.getByRole("region", { name: /dev servers/i });
  if (spec.showDevDashboard) await expect(dashboard).toBeVisible();
  else await expect(dashboard).toHaveCount(0);
  if ((spec.devSessions?.length ?? 0) > 0) {
    await expect(dashboard.getByRole("listitem")).toHaveCount(spec.devSessions!.length);
  }
  for (const tab of spec.tabs) {
    await expect(page.getByRole("tab", { name: tab.title }).first()).toBeAttached();
  }
  const launchpad =
    spec.activeTabId === null || spec.tabs.find((t) => t.id === spec.activeTabId)?.url === null;
  if (launchpad && !("noLinks" in spec)) {
    await expect(page.getByRole("button", { name: /Claude/ }).first()).toBeVisible();
  }
}

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

test("Portal dock — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PORTAL is required for the Portal dock capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PORTAL=1 to run the capture");
  test.setTimeout(30 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const name of FIXTURE_NAMES) {
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
      const frame = await open(page, "launchpad-first-run", sweepTheme);
      written.push(await snap(frame, `sweep--launchpad--${sweepTheme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURE_NAMES.length);
  console.log(`[portal-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
