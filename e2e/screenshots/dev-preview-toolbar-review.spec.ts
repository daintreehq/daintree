/**
 * Dev preview chrome visual-review harness.
 *
 * The dev preview's header and toolbar change with things a live dev server
 * decides — a page mid-load, a server that stopped, a console drawer open next to
 * a framework tool, a device preset with its rotate, DPR and fit controls. This
 * drives the preview entry (`dev-preview-toolbar-preview.html`), which mounts the
 * real `ContentPanel` and `BrowserToolbar` from fixtures, and performs the states
 * no fixture can hold — an open history list, an address error, keyboard focus,
 * hover — with a real pointer and real keys.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_DEVPREVIEW is set.
 *
 *   DAINTREE_SHOT_DEVPREVIEW=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots dev-preview-toolbar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DEVPREVIEW   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES       themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP        "0" skips the all-themes sweep of the rest state
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  FIXTURES,
  FIXTURE_NAMES,
  type DevPreviewChromeFixture,
  type FixtureName,
} from "../../src/components/DevPreview/__preview__/fixtures";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DEVPREVIEW;
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

async function open(page: Page, fixture: FixtureName, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: FIXTURES[fixture].width + 80, height: 720 });
  await stubViteHmrClient(page);
  // The pointer survives navigation: a hover drive would otherwise leave every
  // later capture showing a hover state nobody asked for.
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[dev-preview-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/dev-preview-toolbar-preview.html?theme=${theme}&fixture=${fixture}`;
  const frame = page.locator(FRAME).first();
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout: 30_000 });
  }
  // `flex` on the pane body is a Tailwind utility: its presence proves the
  // stylesheet landed, not just the markup.
  await expect(page.locator(ADDRESS)).toBeVisible();
  await expect(page.locator(ADDRESS)).toHaveCSS("border-top-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  return frame;
}

/** Perform the fixture's pointer/keyboard state and prove it is on screen. */
async function drive(page: Page, fixture: FixtureName): Promise<void> {
  const spec = FIXTURES[fixture] as { drive?: string };
  const address = page.locator(ADDRESS);
  switch (spec.drive) {
    case "address-history": {
      await address.click();
      await address.fill("");
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
      break;
    }
    case "address-error": {
      await address.click();
      await address.fill("https://example.com/login");
      await page.keyboard.press("Enter");
      await expect(page.getByText(/Only localhost|not allowed|Invalid/i).first()).toBeVisible();
      break;
    }
    case "keyboard-focus": {
      // Land on the toolbar from the keyboard so the ring is :focus-visible.
      await page.keyboard.press("Tab");
      const reload = page.getByRole("button", { name: "Reload" });
      for (
        let i = 0;
        i < 20 && !(await reload.evaluate((el) => el === document.activeElement));
        i++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(reload).toBeFocused();
      break;
    }
    case "hover-action": {
      const copy = page.getByRole("button", { name: /copy url/i }).first();
      await copy.hover();
      await expect(page.getByRole("tooltip").first()).toBeVisible();
      break;
    }
    case "address-typed": {
      await address.click();
      await address.fill("localhost:5173/dash");
      await expect(page.getByRole("option")).not.toHaveCount(0);
      break;
    }
    case "more-menu": {
      await page.getByRole("button", { name: "More page actions" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      break;
    }
    case "zoom-popover": {
      await page.getByTestId("browser-zoom-indicator").click();
      await expect(page.getByRole("button", { name: "Reset zoom" })).toBeVisible();
      break;
    }
    case "device-menu": {
      await page.getByRole("button", { name: /^Device:/ }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      break;
    }
    default:
      break;
  }
  await page.waitForTimeout(150);
}

test("Dev preview chrome — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DEVPREVIEW is required for the dev preview capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DEVPREVIEW=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    // The preview falls back to the default theme for a name it does not know,
    // which would write a correctly named PNG of the wrong theme.
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const name of FIXTURE_NAMES) {
      await open(page, name, theme);
      await drive(page, name);
      await expectFixtureState(page, name);
      // Page-region shot: open listboxes and tooltips spill past the frame.
      const out = path.join(OUT_DIR, `${name}--${theme}.png`);
      await page.screenshot({ path: out, clip: await clipFor(page) });
      written.push(out);
    }
  }

  if (SWEEP) {
    for (const sweepTheme of ALL_THEMES) {
      const frame = await open(page, "rest", sweepTheme);
      written.push(await snap(frame, `sweep--rest--${sweepTheme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURE_NAMES.length);
  console.log(`[dev-preview-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});

/**
 * What each fixture is supposed to show, checked on screen before its PNG is
 * written: a prop that failed to reach the toolbar would otherwise produce a
 * correctly named picture of the resting state.
 */
async function expectFixtureState(page: Page, name: FixtureName): Promise<void> {
  const fixture: DevPreviewChromeFixture = FIXTURES[name];
  const viewportBar = page.getByTestId("browser-viewport-controls");
  if (fixture.viewportPreset) await expect(viewportBar).toBeVisible();
  else await expect(viewportBar).toHaveCount(0);
  if (fixture.isLoading) {
    await expect(page.getByRole("button", { name: "Stop loading" })).toBeVisible();
  }
  const zoomChip = page.getByTestId("browser-zoom-indicator");
  if (fixture.zoomFactor !== undefined && fixture.zoomFactor !== 1) {
    await expect(zoomChip).toContainText(`${Math.round(fixture.zoomFactor * 100)}%`);
  } else if (!fixture.drive) {
    await expect(zoomChip).toHaveCount(0);
  }
  if (fixture.width >= 700) {
    const consoleToggle = page.getByRole("button", { name: "Toggle console" });
    if (fixture.canToggleConsole === false) await expect(consoleToggle).toBeDisabled();
    if (fixture.consoleOpen) await expect(consoleToggle).toHaveAttribute("aria-pressed", "true");
  }
}

/** The frame plus any open menu, popover or tooltip that spills past it. */
async function clipFor(page: Page) {
  const box = await page.locator(FRAME).first().boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`frame has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  let { x, y } = box;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  const overlays = page.locator(
    '[role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper]'
  );
  for (const overlay of await overlays.all()) {
    const o = await overlay.boundingBox();
    if (!o) continue;
    x = Math.min(x, o.x);
    y = Math.min(y, o.y);
    right = Math.max(right, o.x + o.width);
    bottom = Math.max(bottom, o.y + o.height);
  }
  const viewport = page.viewportSize();
  if (viewport && (right > viewport.width + 1 || bottom > viewport.height + 1)) {
    throw new Error(`an overlay runs past the page (${right}×${bottom}) — refusing to write`);
  }
  return { x, y, width: right - x, height: bottom - y };
}
