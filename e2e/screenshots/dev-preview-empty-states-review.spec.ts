/**
 * Dev preview empty-states visual-review harness.
 *
 * Everything the dev preview shows instead of a live page — the detected-script
 * prompt, the manual command form, the restored-stopped and waiting placeholders,
 * the dev-server error, and the not-yet-visible and evicted notes — belongs to a
 * project in a particular condition. This drives the preview entry
 * (`dev-preview-empty-states-preview.html`), which mounts the real
 * `DevPreviewEmptyStates` from a fixture inside a pane-sized box.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_DEVPREVIEW_EMPTY is set.
 *
 *   DAINTREE_SHOT_DEVPREVIEW_EMPTY=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots dev-preview-empty-states-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DEVPREVIEW_EMPTY  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR               required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES            themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP             "0" skips the all-themes sweep of `detected`
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  EMPTY_STATE_FIXTURES,
  EMPTY_STATE_FIXTURE_NAMES,
  type EmptyStateFixture,
  type EmptyStateFixtureName,
} from "../../src/components/DevPreview/__preview__/emptyStatesFixtures";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DEVPREVIEW_EMPTY;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

const PANE = "[data-preview-pane]";
const PAD = 16;

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  .animate-pulse-delayed, .animate-pulse-immediate { animation: none !important; opacity: 1 !important; }
`;

/**
 * Text that comes from the fixture's data rather than the component's copy, so
 * the check survives a rewrite of the wording while still proving the right
 * branch rendered.
 */
function sentinel(spec: EmptyStateFixture): RegExp | null {
  if (spec.error) return new RegExp(spec.error.module ?? spec.error.port ?? "");
  if (spec.status === "restored-stopped") return /pnpm dev --port 5174/;
  const first = spec.candidates?.[0];
  if (spec.isUnconfigured && first) {
    return new RegExp(first.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  return null;
}

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

async function open(page: Page, name: EmptyStateFixtureName, theme: string): Promise<void> {
  await page.setViewportSize({ width: 720, height: 560 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[empty-states-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/dev-preview-empty-states-preview.html?theme=${theme}&fixture=${name}`;
  const pane = page.locator(PANE);
  try {
    await page.goto(url);
    await expect(pane).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(pane).toBeVisible({ timeout: 30_000 });
  }
  // A Tailwind utility on the pane proves the stylesheet landed, not just markup.
  await expect(pane).toHaveCSS("border-top-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  // Past the 400ms Doherty gate, so the starting state shows its spinner.
  await page.waitForTimeout(550);
}

async function drive(page: Page, name: EmptyStateFixtureName): Promise<void> {
  const spec: EmptyStateFixture = EMPTY_STATE_FIXTURES[name];
  const pane = page.locator(PANE);
  if (spec.drive === "focus-primary") {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute("aria-label") ?? el?.textContent ?? "";
    });
    expect(focused).toMatch(/npm run dev/);
  } else if (spec.drive === "type-command") {
    const input = pane.locator("input").first();
    await input.focus();
    await page.keyboard.type("npm run dev");
    await expect(input).toHaveValue("npm run dev");
  } else if (spec.drive === "open-picker") {
    // By keyboard, as the menu-button contract is meant to be used: Tab to the
    // trigger, Enter opens it with the first item focused.
    const trigger = pane.getByRole("button", { name: /another script/i });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem").first()).toBeFocused();
  }
  await page.waitForTimeout(100);
}

async function expectFixtureState(page: Page, name: EmptyStateFixtureName): Promise<void> {
  const spec: EmptyStateFixture = EMPTY_STATE_FIXTURES[name];
  const pane = page.locator(PANE);
  const text = (await pane.innerText()).trim();
  if (text.length < 8) throw new Error(`${name}: pane rendered no copy ("${text}")`);
  if (spec.status === "stopped" && !spec.isUnconfigured) {
    // Gated behind the Doherty threshold; a blank pane here means the wait was too short.
    await expect(pane.getByRole("button", { name: /start dev server/i })).toBeVisible();
  }
  const expected = sentinel(spec);
  if (expected) await expect(pane.getByText(expected).first()).toBeVisible();
  if (spec.isUnconfigured && !spec.candidates?.length) {
    await expect(pane.locator("input")).toHaveCount(1);
  }
}

async function shoot(page: Page, file: string): Promise<string> {
  const pane = await page.locator(PANE).boundingBox();
  if (!pane || pane.width < 8 || pane.height < 8) {
    throw new Error(`${file}: pane has no real box (${JSON.stringify(pane)}) — refusing to write`);
  }
  let { x, y, width, height } = pane;
  // A popover portals out of the pane; widen the frame to hold it.
  for (const popper of await page.locator("[data-radix-popper-content-wrapper]").all()) {
    const box = await popper.boundingBox();
    if (!box) continue;
    const right = Math.max(x + width, box.x + box.width);
    const bottom = Math.max(y + height, box.y + box.height);
    x = Math.min(x, box.x);
    y = Math.min(y, box.y);
    width = right - x;
    height = bottom - y;
  }
  const viewport = page.viewportSize()!;
  const cx = Math.max(0, x - PAD);
  const cy = Math.max(0, y - PAD);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: cx,
      y: cy,
      width: Math.min(viewport.width - cx, width + PAD * 2),
      height: Math.min(viewport.height - cy, height + PAD * 2),
    },
  });
  return out;
}

test("Dev preview empty states — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DEVPREVIEW_EMPTY is required for the capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DEVPREVIEW_EMPTY=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const written: string[] = [];
  for (const theme of THEMES) {
    for (const name of EMPTY_STATE_FIXTURE_NAMES) {
      await open(page, name, theme);
      await drive(page, name);
      await expectFixtureState(page, name);
      written.push(await shoot(page, `${name}--${theme}.png`));
    }
  }

  if (SWEEP) {
    for (const sweepTheme of ALL_THEMES) {
      await open(page, "detected", sweepTheme);
      await expectFixtureState(page, "detected");
      written.push(await shoot(page, `sweep--detected--${sweepTheme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * EMPTY_STATE_FIXTURE_NAMES.length);
  console.log(`[empty-states-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
