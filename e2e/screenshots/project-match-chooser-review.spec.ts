/**
 * Repository-copy chooser visual-review harness: the copies of a repository a
 * host already has, as the host switch dialog offers them.
 *
 * Drives `project-match-chooser-preview.html` — the real `ProjectMatchChooser`
 * in the real `AppDialog`, from fixtures: several clones, near-identical
 * clones, long paths with several remotes, and the three single-copy cases.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_MATCH_CHOOSER=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots project-match-chooser-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_MATCH_CHOOSER  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES         comma-separated themes (default daintree,bondi)
 *
 * Output: `{state}-{theme}.png`, plus keyboard focus, busy and narrow-window
 * frames in the first theme. Never writes a PNG it has not verified, fails on
 * any page error, and counts the files on disk at the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_MATCH_CHOOSER;
const OUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `MATCH_STATES`, with how many radios each must render. */
const STATES = [
  { name: "several-clones", radios: 4 },
  { name: "near-identical", radios: 3 },
  { name: "deep-prefix", radios: 3 },
  { name: "long-paths", radios: 3 },
  { name: "single-registered", radios: 0 },
  { name: "single-on-disk", radios: 0 },
  { name: "single-committed-id", radios: 0 },
] as const;

test.use({ deviceScaleFactor: 2 });

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    transition-duration: 0s !important;
    animation-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) throw new Error("DESIGN_CAPTURE_DIR must be an absolute path");
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

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
      if (crashed && attempt === 1) continue;
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openState(
  page: Page,
  state: (typeof STATES)[number],
  theme: string,
  opts: { width?: number; busy?: boolean } = {}
): Promise<Locator> {
  // Narrow frames are tall so the whole dialog, footer included, is in shot.
  await page.setViewportSize({ width: opts.width ?? 900, height: opts.width ? 2000 : 1100 });
  await page.goto(
    `${server!.baseURL}/project-match-chooser-preview.html?theme=${theme}&state=${state.name}${opts.busy ? "&busy=1" : ""}`
  );
  const dialog = page.getByRole("dialog").first();
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await expect(dialog.locator('input[type="radio"]'), `${state.name}: radios`).toHaveCount(
    state.radios
  );
  await expect(dialog.getByText(/greg|daintree/).first()).toBeVisible();
  return dialog;
}

const PAD = 24;

/** The dialog panel plus a margin of the backdrop, verified before it is written. */
async function snapPanel(page: Page, file: string): Promise<string> {
  const panel = page
    .locator("[data-preview-body]")
    .locator('xpath=ancestor::*[contains(@class,"max-w-xl")][1]');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  if (!box || box.width < 200 || box.height < 120) {
    throw new Error(`${file}: panel has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const viewport = page.viewportSize()!;
  const x = Math.max(0, box.x - PAD);
  const y = Math.max(0, box.y - PAD);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + PAD * 2),
      height: Math.min(viewport.height - y, box.height + PAD * 2),
    },
  });
  return out;
}

test("project match chooser — every state", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MATCH_CHOOSER is required for the chooser capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MATCH_CHOOSER=1 to run the capture");
  test.setTimeout(300_000);

  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) => {
          await openState(page, state, theme);
          return snapPanel(page, `${state.name}-${theme}.png`);
        })
      );
    }
  }

  const theme = THEMES[0]!;
  const several = STATES[0];
  written.push(
    await withPage(context, "keyboard focus", async (page) => {
      const dialog = await openState(page, several, theme);
      await dialog.locator('input[type="radio"]').first().focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(dialog.locator('input[type="radio"]').nth(2)).toBeChecked();
      await page.waitForTimeout(150);
      return snapPanel(page, `several-clones-${theme}-focus.png`);
    })
  );
  written.push(
    await withPage(context, "hover", async (page) => {
      const dialog = await openState(page, several, theme);
      await dialog.locator("label").nth(3).hover();
      await page.waitForTimeout(150);
      return snapPanel(page, `several-clones-${theme}-hover.png`);
    })
  );
  written.push(
    await withPage(context, "busy", async (page) => {
      await openState(page, several, theme, { busy: true });
      return snapPanel(page, `several-clones-${theme}-busy.png`);
    })
  );
  for (const name of ["long-paths", "several-clones"] as const) {
    const state = STATES.find((s) => s.name === name)!;
    written.push(
      await withPage(context, `${name} narrow`, async (page) => {
        await openState(page, state, theme, { width: 420 });
        return snapPanel(page, `${name}-${theme}-narrow.png`);
      })
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  for (const file of written) {
    expect(onDisk, `${file} missing on disk`).toContain(path.basename(file));
  }
  expect(written.length).toBe(THEMES.length * STATES.length + 5);
});
