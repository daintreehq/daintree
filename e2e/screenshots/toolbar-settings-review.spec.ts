/**
 * Settings → Toolbar customization visual-review harness.
 *
 * The page is long, most of its interesting states depend on what the profile
 * already holds (a grandfathered left array that still lists every agent, plugin
 * contributions, launcher pins), and the in-app route to those profiles needs a
 * binary per agent. So this drives the preview entry (`toolbar-settings-preview.html`):
 * the real `ToolbarSettingsTab` in a stand-in for the settings dialog body, fed
 * through the real stores, against the real theme tokens and `index.css`.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_TOOLBAR_SETTINGS=1 npx playwright test --project=screenshots toolbar-settings-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOOLBAR_SETTINGS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR               output directory (default artifacts/toolbar-settings-shots)
 *   DAINTREE_SHOT_THEMES            comma-separated theme sweep (default: daintree,bondi,bali)
 *
 * Output: `<state>-<theme>.png`. Every state in the first theme, the page-level
 * fixtures in the rest. Never writes a PNG it has not verified — each state waits
 * for its own marker, and the run counts the files on disk.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TOOLBAR_SETTINGS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "toolbar-settings-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,bali")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const FRAME = "[data-preview-frame]";
const ATTACH_TIMEOUT_MS = 30_000;

interface State {
  name: string;
  fixture: string;
  width?: number;
  /** Drive the page into the state; runs after the page has rendered. */
  drive?: (page: Page) => Promise<void>;
  /** Crop to this region instead of the whole page. */
  crop?: (page: Page) => Promise<{ x: number; y: number; width: number; height: number }>;
  media?: { forcedColors?: "active"; contrast?: "more" };
}

async function regionAround(page: Page, selector: string, pad = 24) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

/** The two side columns, plus the section header above them. */
const columnsCrop = (page: Page) => regionAround(page, `${FRAME} .settings-section >> nth=0`);

const STATES: State[] = [
  { name: "fresh", fixture: "fresh" },
  { name: "legacy", fixture: "legacy" },
  { name: "populated", fixture: "populated" },
  { name: "empty-right", fixture: "empty-right", crop: columnsCrop },
  {
    name: "agents-expanded",
    fixture: "fresh",
    drive: async (page) => {
      await page.getByRole("button", { name: /^Show \d+ agents? that aren.t installed$/ }).click();
      await expect(
        page.getByRole("button", { name: "Hide agents that aren't installed" })
      ).toBeVisible();
    },
  },
  {
    name: "move-menu",
    fixture: "legacy",
    drive: async (page) => {
      await page.locator('[data-move-trigger="claude"]').click();
      await expect(page.getByRole("menuitem", { name: "Move to right side" })).toBeVisible();
    },
    crop: columnsCrop,
  },
  {
    name: "grip-focus",
    fixture: "fresh",
    drive: async (page) => {
      // Keyboard route onto the first grip, so the ring is the one a keyboard user sees.
      await page.locator(`${FRAME}`).click({ position: { x: 4, y: 4 } });
      const grip = page.getByRole("button", { name: "Reorder Launcher" });
      await grip.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(grip).toBeFocused();
    },
    crop: columnsCrop,
  },
  {
    name: "dragging",
    fixture: "fresh",
    drive: async (page) => {
      const grip = page.getByRole("button", { name: "Reorder Codex agent" });
      const target = page.getByRole("button", { name: "Reorder Repository activity" });
      const from = (await grip.boundingBox())!;
      const to = (await target.boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y + 10, { steps: 4 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 6, { steps: 12 });
      await page.waitForTimeout(300);
    },
    crop: columnsCrop,
  },
  {
    name: "toggled",
    fixture: "legacy",
    drive: async (page) => {
      // One row switched off in a column and one switched on from the list
      // below: both rows must stay where they were pressed.
      await page.locator("#toolbar-column-codex").click();
      await page.locator("#toolbar-pool-gemini").click();
      await expect(page.locator("#toolbar-column-codex")).toHaveAttribute("aria-checked", "false");
      await expect(page.locator("#toolbar-pool-gemini")).toHaveAttribute("aria-checked", "true");
    },
  },
  { name: "narrow", fixture: "legacy", width: 560, crop: columnsCrop },
  {
    name: "forced-colors",
    fixture: "legacy",
    media: { forcedColors: "active" },
    crop: columnsCrop,
  },
];

/** Page-level fixtures get the theme sweep; interaction states stay in the first theme. */
const THEME_SUBSET = ["fresh", "legacy", "populated"];

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

// Review crops are judged at the pixel level; 1x hides hairlines and glyph shapes.
test.use({ deviceScaleFactor: 2 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold a page open until Vite's optimizer stops force-reloading it. */
async function settleDevServer(context: BrowserContext) {
  for (const fixture of ["populated", "legacy"]) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let navigations = 0;
    page.on("framenavigated", () => navigations++);
    await page.goto(`${server!.baseURL}/toolbar-settings-preview.html?fixture=${fixture}`);
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = navigations;
      await page.waitForTimeout(2_000);
      if (navigations === before && (await page.locator(FRAME).count()) === 1) break;
    }
    // Open a menu once, so the lazily loaded dropdown primitive is bundled before the sweep.
    await page
      .locator('[data-move-trigger="launcher"]')
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForTimeout(1_500);
    await page.close();
  }
}

async function capture(context: BrowserContext, state: State, theme: string): Promise<string> {
  const file = `${state.name}-${theme}.png`;
  const page = await context.newPage();
  await stubViteHmrClient(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: (state.width ?? 687) + 120, height: 1100 });
    if (state.media) await page.emulateMedia(state.media);
    const width = state.width ?? 687;
    await page.goto(
      `${server!.baseURL}/toolbar-settings-preview.html?fixture=${state.fixture}&theme=${theme}&width=${width}`
    );
    const frame = page.locator(FRAME);
    await expect(frame).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
    await expect(page.getByText("Toolbar buttons", { exact: true })).toBeVisible({
      timeout: ATTACH_TIMEOUT_MS,
    });
    if (state.fixture === "populated") {
      await expect(page.getByText("Pull requests").first()).toBeVisible({
        timeout: ATTACH_TIMEOUT_MS,
      });
    }
    await page.evaluate(() => document.fonts.ready);
    // An element screenshot taller than the viewport paints nothing past its
    // bottom edge, so the viewport grows to hold the whole page first.
    const frameHeight = await frame.evaluate((el) => el.getBoundingClientRect().bottom);
    await page.setViewportSize({
      width: (state.width ?? 687) + 120,
      height: Math.ceil(frameHeight) + 400,
    });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    if (state.drive) await state.drive(page);
    // A drive can grow the page (a disclosure opening); grow the viewport with it.
    const drivenBottom = await frame.evaluate((el) => el.getBoundingClientRect().bottom);
    const viewport = page.viewportSize();
    if (viewport && drivenBottom + 40 > viewport.height) {
      await page.setViewportSize({ width: viewport.width, height: Math.ceil(drivenBottom) + 400 });
    }
    await page.waitForTimeout(250);
    if (errors.length > 0) throw new Error(`page threw: ${errors.join(" | ")}`);

    if (state.crop) {
      const clip = await state.crop(page);
      const out = path.join(OUT_DIR, file);
      await page.screenshot({ path: out, clip, fullPage: true });
      if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
      if (state.name === "dragging") await page.mouse.up();
      return out;
    }
    return await snap(frame, file);
  } finally {
    await page.close().catch(() => undefined);
  }
}

test("toolbar settings — every fixture and interaction state", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TOOLBAR_SETTINGS is required for the toolbar-settings capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TOOLBAR_SETTINGS=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];
  const [first, ...rest] = THEMES;

  for (const state of STATES) written.push(await capture(context, state, first!));
  for (const theme of rest) {
    for (const name of THEME_SUBSET) {
      written.push(
        await capture(
          context,
          STATES.find((s) => s.name === name)!,
          theme
        )
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(STATES.length + rest.length * THEME_SUBSET.length);
  console.log(`[toolbar-settings-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
