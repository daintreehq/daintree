/**
 * "Waiting for input" popover visual-review harness.
 *
 * Drives the Layout dock preview entry (`dock-preview.html`), which mounts the
 * real `ContentDock` against the real stores, and opens the Waiting pill's
 * popover the way a user does: by clicking it. The fixtures cover the shapes
 * the list actually takes — a handful of identical agents here, a split across
 * worktrees, every reason chip, a tab group, and a list long enough to scroll.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_WAITING=1 npx playwright test --project=screenshots waiting-popover-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_WAITING required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR     output directory (default artifacts/waiting-shots)
 *   DAINTREE_SHOT_THEMES  comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output, per theme:
 *   <fixture>-<theme>.png        the popover, open, at rest
 * Plus, in the first theme only:
 *   <fixture>-<theme>-hover.png  the first row under the pointer
 *   <fixture>-<theme>-focus.png  the first row with keyboard focus
 *   siblings-<theme>-trash.png   the Trash popover, for row-grammar comparison
 *
 * Never writes a PNG it has not verified, and counts the files itself.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, unlinkSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_WAITING;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR || path.join(process.cwd(), "artifacts", "waiting-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors the `waiting-*` entries of `FIXTURES` in the preview entry. */
const FIXTURES = [
  "waiting-three-here",
  "waiting-split",
  "waiting-reasons",
  "waiting-group",
  "waiting-many",
] as const;

/** Row counts each fixture must render, so a capture of the wrong state fails. */
const EXPECTED_ROWS: Record<(typeof FIXTURES)[number], number> = {
  "waiting-three-here": 3,
  "waiting-split": 4,
  "waiting-reasons": 5,
  "waiting-group": 4,
  "waiting-many": 12,
};

const INTERACTIVE_FIXTURES = ["waiting-three-here", "waiting-split"] as const;

const ATTACH_TIMEOUT_MS = 30_000;
const POPOVER = '[role="dialog"][aria-label="Waiting panels"]';

test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  const cwd = process.cwd();
  if (OUT_DIR === cwd || cwd.startsWith(OUT_DIR + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR resolves to the checkout (${OUT_DIR}) — refusing`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".png")) unlinkSync(path.join(OUT_DIR, f));
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/dock-preview.html?fixture=waiting-split`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
}

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
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[waiting-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}\n  pageerror: ${errors.join(" | ") || "(none)"}`, {
        cause: error,
      });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openWaiting(page: Page, fixture: (typeof FIXTURES)[number], theme: string) {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(`${server!.baseURL}/dock-preview.html?theme=${theme}&fixture=${fixture}`);
  await expect(page.locator("[data-preview-shell]").first()).toBeAttached({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page
    .getByRole("button", { name: /^Waiting/ })
    .first()
    .click();
  const popover = page.locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(popover.locator('[data-testid="waiting-single-item"]')).toHaveCount(
    EXPECTED_ROWS[fixture]
  );
  // Radix popover enter animation.
  await page.waitForTimeout(350);
  return popover;
}

test("waiting popover — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_WAITING is required for the waiting popover capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_WAITING=1 to run the capture");
  test.setTimeout(10 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      written.push(
        await withPage(context, `${fixture} ${theme}`, async (page) =>
          snap(await openWaiting(page, fixture, theme), `${fixture}-${theme}.png`)
        )
      );
    }
  }

  const theme = THEMES[0]!;

  for (const fixture of INTERACTIVE_FIXTURES) {
    written.push(
      await withPage(context, `${fixture} hover`, async (page) => {
        const popover = await openWaiting(page, fixture, theme);
        await popover.locator('[data-testid="waiting-single-item"]').first().hover();
        await page.waitForTimeout(300);
        return snap(popover, `${fixture}-${theme}-hover.png`);
      })
    );
    written.push(
      await withPage(context, `${fixture} focus`, async (page) => {
        const popover = await openWaiting(page, fixture, theme);
        await popover.locator('[data-testid="waiting-single-item"]').first().focus();
        await page.keyboard.press("Shift");
        await page.waitForTimeout(300);
        return snap(popover, `${fixture}-${theme}-focus.png`);
      })
    );
  }

  written.push(
    await withPage(context, "trash sibling", async (page) => {
      await page.setViewportSize({ width: 1440, height: 700 });
      await page.goto(`${server!.baseURL}/dock-preview.html?theme=${theme}&fixture=rest`);
      await expect(page.locator("[data-preview-shell]").first()).toBeAttached({
        timeout: ATTACH_TIMEOUT_MS,
      });
      await page.waitForTimeout(400);
      await page.locator('[data-testid="trash-container"]').click();
      const popover = page.locator('[role="dialog"][aria-label="Recently closed terminals"]');
      await expect(popover).toBeVisible();
      await page.waitForTimeout(350);
      return snap(popover, `siblings-${theme}-trash.png`);
    })
  );

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * FIXTURES.length + INTERACTIVE_FIXTURES.length * 2 + 1);
  console.log(`[waiting-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
