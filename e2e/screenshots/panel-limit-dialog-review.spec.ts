/**
 * Panel-limit confirm dialog visual-review harness.
 *
 * Drives `panel-limit-preview.html`, which mounts the real
 * `PanelLimitConfirmDialog` against the real `panelLimitStore` and opens it
 * through `preflightSpawnBatchLimit` — the call a recipe run or worktree
 * spin-up makes — so every state carries counts the product really produces.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_PANEL_LIMIT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots panel-limit-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PANEL_LIMIT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/panel-limit-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default daintree,bondi,namib,redwoods)
 *
 * Output:
 *   <fixture>-<theme>.png      the dialog card, every fixture in every theme
 *   batch-<theme>-window.png   the whole window with the scrim, first theme only
 *   batch-<theme>-focus.png    keyboard focus moved to the second action, first theme only
 *   large-<theme>-narrow.png   the longest copy in a 520px window, first theme only
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PANEL_LIMIT;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "panel-limit-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,redwoods")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `PANEL_LIMIT_FIXTURES`. */
const FIXTURES = ["batch", "single", "trimmed", "trimmed-one", "large"] as const;

const WIDTH = 1280;
const HEIGHT = 800;
const NARROW_WIDTH = 520;
const ATTACH_TIMEOUT_MS = 30_000;

/** AppDialog puts the role on its full-window scrim; the card is its only child. */
const DIALOG = '[role="dialog"], [role="alertdialog"]';
const CARD = '[role="dialog"] > div, [role="alertdialog"] > div';

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

test.use({ deviceScaleFactor: 2 });

const snap = makeSnap(OUT_DIR);
let server: PreviewServer | undefined;

test.beforeAll(async () => {
  // The skip lives in the test body: `test.info()` is unavailable in beforeAll.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold a throwaway page open until Vite's dependency optimizer stops reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/panel-limit-preview.html?fixture=batch`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const dialogs = await page.locator(DIALOG).count();
    if (navigations === before && dialogs === 1) break;
  }
  await page.close();
}

/** Every capture gets its own page; a renderer that dies under load gets one more go. */
async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[panel-limit-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openFixture(
  page: Page,
  fixture: string,
  theme: string,
  width = WIDTH
): Promise<Locator> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(`${server!.baseURL}/panel-limit-preview.html?theme=${theme}&fixture=${fixture}`);
  await page.addStyleTag({ content: FREEZE_CSS });
  const dialog = page.locator(CARD).first();
  // No dialog means the preflight never asked — a picture of the backdrop grid
  // dressed up as a passing run.
  await expect(dialog, `fixture "${fixture}" opened no dialog`).toBeVisible({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  // The title must have real text: an empty heading is a render failure, not a state.
  const title = (await dialog.locator("h2").first().textContent())?.trim() ?? "";
  if (!title) throw new Error(`fixture "${fixture}" rendered an empty title`);
  return dialog;
}

test("panel-limit confirm dialog — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PANEL_LIMIT is required for the panel-limit capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PANEL_LIMIT=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const name of FIXTURES) {
      written.push(
        await withPage(context, `${name} ${theme}`, async (page) =>
          snap(await openFixture(page, name, theme), `${name}-${theme}.png`)
        )
      );
    }
  }

  const theme = THEMES[0]!;
  written.push(
    await withPage(context, "window", async (page) => {
      await openFixture(page, "batch", theme);
      return snap(page.locator("[data-preview-shell]"), `batch-${theme}-window.png`);
    })
  );
  written.push(
    await withPage(context, "focus", async (page) => {
      const dialog = await openFixture(page, "batch", theme);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);
      return snap(dialog, `batch-${theme}-focus.png`);
    })
  );
  written.push(
    await withPage(context, "narrow", async (page) =>
      snap(await openFixture(page, "large", theme, NARROW_WIDTH), `large-${theme}-narrow.png`)
    )
  );

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * FIXTURES.length + 3);
  console.log(`[panel-limit-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
