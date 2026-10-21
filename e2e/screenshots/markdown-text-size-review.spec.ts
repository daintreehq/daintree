/**
 * Markdown text-size popover visual-review harness.
 *
 * The "Aa" control on a rendered markdown file opens a small stepper whose
 * design weight sits in states a single open never shows: Reset inert at the
 * default and live away from it, each end of the ladder with one stepper
 * inert, the pointer resting on an inert control, and the keyboard ring. This
 * opens the real `MarkdownTextSizeControl` through the menus gallery
 * (`menus-preview.html?scene=markdown-text-size&size=<rung>`) and photographs a
 * crop around the trigger and the open popover.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_MDTEXTSIZE=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots markdown-text-size-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MDTEXTSIZE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES      theme sweep (default daintree,bondi)
 *
 * Output: `<theme>-<state>.png`. Never writes a PNG whose popover it has not
 * verified visible with a real box, and counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_MDTEXTSIZE;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const PAD = 24;
const TRIGGER = '[data-testid="menus-markdown-text-size"]';
const POPOVER = '[data-radix-popper-content-wrapper] [role="dialog"]:visible';

test.use({ deviceScaleFactor: 2 });

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

interface State {
  slug: string;
  size: string;
  /** Runs once the popover is open, before the capture. */
  then?: (page: Page, popover: Locator) => Promise<void>;
  /** Open from the keyboard instead of a click, so focus rings are drawn. */
  keyboard?: boolean;
}

const STATES: State[] = [
  { slug: "default", size: "sm" },
  { slug: "stepped", size: "lg" },
  { slug: "smallest", size: "2xs" },
  { slug: "largest", size: "3xl" },
  {
    slug: "default-hover-reset",
    size: "sm",
    then: async (_page, popover) => {
      await popover.getByTestId("markdown-text-size-reset").hover({ force: true });
    },
  },
  {
    slug: "largest-hover-increase",
    size: "3xl",
    then: async (_page, popover) => {
      await popover.getByTestId("markdown-text-size-increase").hover({ force: true });
    },
  },
  {
    slug: "keyboard-focus",
    size: "lg",
    keyboard: true,
    then: async (page) => {
      await page.keyboard.press("Tab");
    },
  },
];

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
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settle(page: Page, ms = 250): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function open(page: Page, trigger: Locator, popover: Locator, keyboard: boolean) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (keyboard) {
      await trigger.focus();
      await page.keyboard.press("Enter");
    } else {
      await trigger.click();
    }
    try {
      await expect(popover).toBeVisible({ timeout: 3_000 });
      return;
    } catch {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  }
  await expect(popover, "popover never opened").toBeVisible({ timeout: 1_000 });
}

test("Markdown text-size popover — rungs, inert controls, hover and focus", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MDTEXTSIZE is required for the text-size capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MDTEXTSIZE=1 to run the capture");

  // The first load compiles the whole gallery graph cold.
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 620, height: 380 });
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      await page.goto(
        `${server!.baseURL}/menus-preview.html?scene=markdown-text-size&size=${state.size}&theme=${theme}`
      );
      const trigger = page.locator(TRIGGER).first();
      await trigger.waitFor({ state: "visible", timeout: 90_000 }).catch((error: unknown) => {
        throw new Error(`trigger never mounted: ${errors.join("\n") || "no page errors"}`, {
          cause: error,
        });
      });
      await page.addStyleTag({ content: FREEZE_CSS });
      await page.evaluate(() => document.fonts.ready);

      const popover = page.locator(POPOVER).last();
      await open(page, trigger, popover, state.keyboard ?? false);
      await state.then?.(page, popover);
      await settle(page);

      const a = await trigger.boundingBox();
      const b = await popover.boundingBox();
      if (!a || !b || b.width < 40 || b.height < 20) {
        throw new Error(`${theme}-${state.slug}: popover has no real box — refusing to write`);
      }
      const x = Math.max(0, Math.min(a.x, b.x) - PAD);
      const y = Math.max(0, Math.min(a.y, b.y) - PAD);
      const out = path.join(OUT_DIR, `${theme}-${state.slug}.png`);
      await page.screenshot({
        path: out,
        clip: {
          x,
          y,
          width: Math.max(a.x + a.width, b.x + b.width) + PAD - x,
          height: Math.max(a.y + a.height, b.y + b.height) + PAD - y,
        },
      });
      written.push(out);
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length);
  console.log(`[markdown-text-size-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
