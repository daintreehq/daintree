/**
 * Recipe management and launch visual-review harness.
 *
 * Drives `recipes-preview.html`, which mounts the real `RecipeManager`,
 * `RecipeEditor` and `RecipeRunner` against a recipe store seeded across all
 * four sources (global, plugin, team, project). The Electron harness
 * (`canvas-home-review.spec.ts`) can only seed in-repo recipes from disk, so it
 * never shows the manager's four sections or a crowded inventory.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_RECIPES is set.
 *
 *   DAINTREE_SHOT_RECIPES=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots recipes-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RECIPES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES   themes for the rest-state sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_RECIPES;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const DIALOG = '[role="dialog"]:visible';
const CANVAS = "[data-preview-canvas]";

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

let server: PreviewServer | undefined;
const failures: string[] = [];
const expected: string[] = [];

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

interface OpenOptions {
  view: "manager" | "runner";
  theme?: string;
  fixture?: string;
  edit?: string;
  width?: number;
  height?: number;
}

async function open(page: Page, opts: OpenOptions): Promise<void> {
  const { view, theme = "daintree", fixture = "populated" } = opts;
  await page.setViewportSize({ width: opts.width ?? 1280, height: opts.height ?? 900 });
  const query = new URLSearchParams({ view, theme, fixture });
  if (opts.edit) query.set("edit", opts.edit);
  await page.goto(`${server!.baseURL}/recipes-preview.html?${query}`, { waitUntil: "load" });
  await page.addStyleTag({ content: FREEZE_CSS });
  if (view === "manager") {
    await page.locator(DIALOG).first().waitFor({ state: "visible", timeout: 20_000 });
  } else {
    await page.locator(CANVAS).waitFor({ state: "visible", timeout: 20_000 });
    await expect
      .poll(
        () =>
          page
            .locator(
              '[data-testid="recipe-runner-empty"], [role="option"], [data-testid="recipe-suggestion-pill"]'
            )
            .count(),
        { timeout: 8000 }
      )
      .toBeGreaterThan(0);
  }
  await settle(page);
}

async function settle(page: Page, ms = 250): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** The element plus a margin, so its edge and shadow are part of the picture. */
async function snap(page: Page, selector: string, file: string, pad = 24): Promise<void> {
  expected.push(file);
  await settle(page, 150);
  const box = await page.locator(selector).last().boundingBox();
  if (!box || box.width < 40 || box.height < 40) {
    throw new Error(`${file}: ${selector} has no real box (${JSON.stringify(box)})`);
  }
  const viewport = page.viewportSize()!;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).split("\n")[0]}`);
  }
}

test("recipes review", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RECIPES is required for the recipes capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_RECIPES to run the recipes capture");
  test.setTimeout(300_000);
  await stubViteHmrClient(page);
  page.on("pageerror", (err) => failures.push(`pageerror: ${err.message.split("\n")[0]}`));

  // Warm the optimizer so its first-load reload cannot land mid-capture.
  await page.goto(`${server!.baseURL}/recipes-preview.html`, { waitUntil: "load" });
  await page.waitForTimeout(3000);

  // ── Manager ──
  for (const theme of THEMES) {
    await step(`manager-${theme}`, async () => {
      await open(page, { view: "manager", theme });
      await snap(page, DIALOG, `01-manager-populated-${theme}.png`);
    });
  }

  await step("manager-crowded", async () => {
    await open(page, { view: "manager", fixture: "crowded" });
    await snap(page, DIALOG, "02-manager-crowded-top.png");
    await page.locator(`${DIALOG} h3`).last().scrollIntoViewIfNeeded();
    await snap(page, DIALOG, "02-manager-crowded-bottom.png");
  });

  for (const fixture of ["empty", "global-only", "project-only"]) {
    await step(`manager-${fixture}`, async () => {
      await open(page, { view: "manager", fixture });
      await snap(page, DIALOG, `03-manager-${fixture}.png`);
    });
  }

  await step("manager-hover", async () => {
    await open(page, { view: "manager" });
    const name = page.locator(DIALOG).getByText("Design review", { exact: true }).first();
    await name.hover();
    await snap(page, DIALOG, "04-manager-row-hover.png");
  });

  await step("manager-keyboard", async () => {
    await open(page, { view: "manager" });
    // Walk the tab order until focus lands inside a recipe row's actions.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? ""
      );
      if (/recipe/i.test(label) && !/close/i.test(label)) break;
    }
    await snap(page, DIALOG, "05-manager-keyboard.png");
  });

  await step("manager-narrow", async () => {
    await open(page, { view: "manager", width: 720, height: 800 });
    await snap(page, DIALOG, "06-manager-narrow.png", 8);
  });

  await step("editor", async () => {
    await open(page, { view: "manager", edit: "recipe-8" });
    await snap(page, DIALOG, "07-editor-from-manager.png");
  });

  await step("manager-forced-colors", async () => {
    await page.emulateMedia({ forcedColors: "active" });
    await open(page, { view: "manager" });
    await snap(page, DIALOG, "08-manager-forced-colors.png");
    await page.emulateMedia({ forcedColors: "none" });
  });

  // ── Canvas launcher ──
  for (const fixture of ["empty", "suggestions", "one"]) {
    await step(`runner-${fixture}`, async () => {
      await open(page, { view: "runner", fixture });
      await snap(page, CANVAS, `10-runner-${fixture}.png`);
    });
  }

  for (const theme of THEMES) {
    await step(`runner-populated-${theme}`, async () => {
      await open(page, { view: "runner", theme });
      await snap(page, CANVAS, `11-runner-populated-${theme}.png`);
    });
  }

  await step("runner-three", async () => {
    await open(page, { view: "runner", fixture: "three" });
    await snap(page, CANVAS, "12-runner-three.png");
  });

  await step("runner-many", async () => {
    await open(page, { view: "runner", fixture: "many", height: 1400 });
    await snap(page, CANVAS, "13-runner-many.png");
  });

  await step("runner-filter", async () => {
    await open(page, { view: "runner", fixture: "many", height: 1100 });
    await page.getByRole("combobox", { name: "Filter recipes" }).fill("test");
    await page.keyboard.press("ArrowDown");
    await snap(page, CANVAS, "14-runner-filter-keyboard.png");
  });

  await step("runner-filter-empty", async () => {
    await open(page, { view: "runner", fixture: "many" });
    await page.getByRole("combobox", { name: "Filter recipes" }).fill("zzqq");
    await snap(page, CANVAS, "15-runner-filter-nomatch.png");
  });

  await step("runner-grid-keyboard", async () => {
    await open(page, { view: "runner" });
    await page.locator('[role="option"]').first().focus();
    await page.keyboard.press("ArrowRight");
    await snap(page, CANVAS, "16-runner-grid-keyboard.png");
  });

  await step("runner-narrow", async () => {
    await open(page, { view: "runner", width: 460, height: 900 });
    await snap(page, CANVAS, "17-runner-narrow.png", 8);
  });

  await step("runner-context-menu", async () => {
    await open(page, { view: "runner", height: 1000 });
    await page.locator('[role="option"]').first().click({ button: "right" });
    await page.locator('[role="menu"]').waitFor({ state: "visible", timeout: 5000 });
    expected.push("18-runner-context-menu.png");
    await settle(page, 200);
    await page.screenshot({ path: path.join(OUT_DIR, "18-runner-context-menu.png") });
  });

  const present = new Set(readdirSync(OUT_DIR));
  const missing = expected.filter((f) => !present.has(f));
  expect(failures, "recipes capture steps failed").toEqual([]);
  expect(missing, `recipes captures missing from ${OUT_DIR}`).toEqual([]);
});
