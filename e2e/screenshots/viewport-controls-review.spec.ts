/**
 * Browser device-emulation bar visual-review harness.
 *
 * The device bar (`ViewportControls`) sits under the browser toolbar whenever a
 * device preset is on, and it has to hold up in every pane the grid can make —
 * from a narrow split column to the full window — in portrait, landscape and
 * fit. This drives the dev preview chrome entry (`dev-preview-toolbar-preview.html`),
 * which mounts the REAL `BrowserToolbar`, sweeping the pane width with its
 * `?width=` override, then performs the states only a pointer or a key can
 * reach: the device menu open, keyboard focus, and the Fit and pixel-ratio
 * tooltips.
 *
 * Opt-in only: skips itself unless DESIGN_CAPTURE_DIR is set. That directory is
 * also the output — there is deliberately no in-repo default.
 *
 *   DESIGN_CAPTURE_DIR=/abs/out npx playwright test --project=screenshots viewport-controls-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE_DIR     required — absolute output directory outside the repo
 *   DAINTREE_SHOT_THEMES   extra themes for the theme check (default bondi,namib)
 *
 * Output: <dir>/<state>--<width>--<theme>.png
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const OUT = process.env.DESIGN_CAPTURE_DIR ?? "";
const ENABLED = !!OUT;
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Narrow split column through to a wide pane. */
const WIDTHS = [280, 340, 400, 480, 560, 720, 900];

const DEVICE_STATES = {
  portrait: { preset: "iphone", rotated: "0", fit: "0", dpr: "2" },
  landscape: { preset: "ipad", rotated: "1", fit: "1", dpr: "2" },
  "long-name": { preset: "ipad", rotated: "0", fit: "0", dpr: "3" },
} as const;
type DeviceState = keyof typeof DEVICE_STATES;

const BAR = '[data-testid="browser-viewport-controls"]';
const TOOLBAR = '[data-testid="browser-toolbar"]';

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

let server: PreviewServer | undefined;

test.use({ deviceScaleFactor: 2 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT)) throw new Error("DESIGN_CAPTURE_DIR must be absolute");
  mkdirSync(OUT, { recursive: true });
  const repoRoot = realpathSync(process.cwd());
  const outReal = realpathSync(OUT);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUT})`);
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, state: DeviceState, width: number, theme: string) {
  await page.setViewportSize({ width: Math.max(width + 80, 640), height: 560 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  const q = new URLSearchParams({
    theme,
    fixture: "viewport",
    width: String(width),
    ...DEVICE_STATES[state],
  });
  await page.goto(`${server!.baseURL}/dev-preview-toolbar-preview.html?${q}`);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(TOOLBAR)).toHaveCSS("border-bottom-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

/** The toolbar plus any open menu or tooltip that spills past it. */
async function shoot(page: Page, file: string): Promise<string> {
  const box = await page.locator(TOOLBAR).boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(
      `${file}: toolbar has no real box (${JSON.stringify(box)}) — refusing to write`
    );
  }
  let { x, y } = box;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  for (const overlay of await page
    .locator('[role="menu"], [role="tooltip"], [data-radix-popper-content-wrapper]')
    .all()) {
    // An overlay can close between listing and measuring; skip it rather than wait.
    const o = await overlay.boundingBox({ timeout: 1_000 }).catch(() => null);
    if (!o) continue;
    x = Math.min(x, o.x);
    y = Math.min(y, o.y);
    right = Math.max(right, o.x + o.width);
    bottom = Math.max(bottom, o.y + o.height);
  }
  const pad = 8;
  const out = path.join(OUT, file);
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, x - pad),
      y: Math.max(0, y - pad),
      width: right - x + pad * 2,
      height: bottom - y + pad * 2,
    },
  });
  return file;
}

test("viewport controls — widths, device states, interaction states", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE_DIR is required for the viewport-controls-review capture",
  });
  test.skip(!ENABLED, "Set DESIGN_CAPTURE_DIR to run the viewport-controls-review capture");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const written: string[] = [];

  for (const state of Object.keys(DEVICE_STATES) as DeviceState[]) {
    for (const width of WIDTHS) {
      await open(page, state, width, "daintree");
      written.push(await shoot(page, `${state}--${width}--daintree.png`));
    }
  }

  for (const theme of THEMES) {
    await open(page, "landscape", 400, theme);
    written.push(await shoot(page, `landscape--400--${theme}.png`));
  }

  await open(page, "portrait", 400, "daintree");
  await page
    .locator(BAR)
    .getByRole("button", { name: /^Device:/ })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  written.push(await shoot(page, "device-menu--400--daintree.png"));

  await open(page, "landscape", 560, "daintree");
  await page
    .locator(BAR)
    .getByRole("button", { name: /^Device:/ })
    .focus();
  await page.keyboard.press("Tab");
  const focused = page.locator(`${BAR} :focus-visible`);
  await expect(focused).toHaveCount(1);
  written.push(await shoot(page, "keyboard-focus--560--daintree.png"));

  for (const [name, locate] of [
    ["fit-tooltip", (p: Page) => p.locator(BAR).getByRole("button", { name: /fit/i })],
    ["dpr-tooltip", (p: Page) => p.locator(BAR).getByRole("radio").nth(1)],
    [
      "rotate-tooltip",
      (p: Page) => p.locator(BAR).getByRole("button", { name: /landscape|rotate/i }),
    ],
  ] as const) {
    await open(page, "landscape", 560, "daintree");
    await locate(page).hover();
    // A control with no tooltip is a finding, not a harness failure: say so
    // and write nothing for it rather than a picture of a plain hover.
    const shown = await page
      .getByRole("tooltip")
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      console.log(`[viewport-controls-shots] ${name}: no tooltip on hover`);
      continue;
    }
    written.push(await shoot(page, `${name}--560--daintree.png`));
  }

  await page.emulateMedia({ forcedColors: "active" });
  await open(page, "landscape", 480, "daintree");
  written.push(await shoot(page, "forced--480--daintree.png"));
  await page.emulateMedia({ forcedColors: "none" });

  expect(errors, `page threw: ${errors.join(" | ")}`).toEqual([]);
  const onDisk = new Set(readdirSync(OUT).filter((f) => f.endsWith(".png")));
  const missing = written.filter((f) => !onDisk.has(f) || !existsSync(path.join(OUT, f)));
  expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
  console.log(`[viewport-controls-shots] wrote ${written.length} PNGs to ${OUT}`);
});
