/**
 * Worktree bulk-remove confirm visual-review harness.
 *
 * The overview's bulk remove opens one D3 confirm over a per-target preview that
 * branches on three settled states, each with its own nested lists — files,
 * submodule files, teardown commands, at-risk commits. Most of those states need
 * a submodule fixture repo or a failing status read in the full app, so this
 * drives the preview entry (`worktree-bulk-remove-preview.html`), which renders
 * the real dialog from a hook snapshot per state.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_BULK_REMOVE is set.
 *
 *   DAINTREE_SHOT_BULK_REMOVE=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots worktree-bulk-remove-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_BULK_REMOVE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES       themes for the per-state captures (default daintree,bondi,highlands)
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  BULK_REMOVE_FIXTURES,
  BULK_REMOVE_FIXTURE_NAMES,
  type BulkRemoveFixtureName,
} from "../../src/components/Worktree/__preview__/bulkRemoveFixtures";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_BULK_REMOVE;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,highlands")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);
/** States that carry the most design weight get every theme; the rest, the default only. */
const THEMED: BulkRemoveFixtureName[] = ["mixed", "long", "all-excluded"];

test.use({ deviceScaleFactor: 2 });

const CARD = '[role="dialog"] > [tabindex="-1"], [role="alertdialog"] > [tabindex="-1"]';
const PAD = 24;

// Skeletons pulse from opacity 0 behind a gate; with animations frozen they would
// photograph as nothing, so pin them at their visible resting state.
const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  .animate-pulse-delayed, .animate-pulse-immediate { animation: none !important; opacity: 1 !important; }
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

async function open(page: Page, name: BulkRemoveFixtureName, theme: string): Promise<void> {
  // Tall enough that the dialog's own max height, not the viewport, decides
  // where the body scrolls.
  await page.setViewportSize({ width: 820, height: 1000 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[bulk-remove-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/worktree-bulk-remove-preview.html?theme=${theme}&fixture=${name}`;
  const card = page.locator(CARD).first();
  try {
    await page.goto(url);
    await expect(card).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(card).toBeVisible({ timeout: 30_000 });
  }
  await expect(card).toHaveCSS("border-top-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function drive(page: Page, name: BulkRemoveFixtureName): Promise<void> {
  const spec = BULK_REMOVE_FIXTURES[name];
  const card = page.locator(CARD).first();
  await expect(card.getByText(spec.expectText, { exact: true }).first()).toBeVisible();
  if ("typeGate" in spec && spec.typeGate) {
    const input = card.locator('input[type="text"]');
    await input.fill(spec.value.typedNameTarget);
    // Blur so the capture shows the resting matched field, not a focus ring.
    await input.evaluate((el) => (el as HTMLInputElement).blur());
  }
  await page.waitForTimeout(100);
}

async function shoot(page: Page, file: string): Promise<string> {
  const box = await page.locator(CARD).first().boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: dialog has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const viewport = page.viewportSize()!;
  if (box.y + box.height > viewport.height - 4) {
    throw new Error(`${file}: dialog runs past the page (${box.y + box.height}) — refusing`);
  }
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

/** Every body scroll position the list needs, so no row is only reachable in code. */
async function shootScrolled(page: Page, stem: string, written: string[]): Promise<void> {
  const body = page.locator('[data-testid="bulk-remove-target-list"]').first();
  if ((await body.count()) === 0) return;
  const { scrollHeight, clientHeight } = await body.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  if (scrollHeight <= clientHeight + 4) return;
  await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForTimeout(100);
  written.push(await shoot(page, `${stem}--scrolled.png`));
}

test("Worktree bulk remove confirm — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_BULK_REMOVE is required for the capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_BULK_REMOVE=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const written: string[] = [];
  for (const name of BULK_REMOVE_FIXTURE_NAMES) {
    const themes = THEMED.includes(name) ? THEMES : THEMES.slice(0, 1);
    for (const theme of themes) {
      await open(page, name, theme);
      await drive(page, name);
      written.push(await shoot(page, `${name}--${theme}.png`));
      if (theme === THEMES[0]) await shootScrolled(page, `${name}--${theme}`, written);
    }
  }

  // Forced colours and increased contrast, on the state with every row kind.
  await page.emulateMedia({ forcedColors: "active" });
  await open(page, "mixed", THEMES[0]!);
  await drive(page, "mixed");
  written.push(await shoot(page, `mixed--forced-colors.png`));
  await page.emulateMedia({ forcedColors: "none", contrast: "more" });
  await open(page, "mixed", THEMES[0]!);
  await drive(page, "mixed");
  written.push(await shoot(page, `mixed--contrast-more.png`));
  await page.emulateMedia({ contrast: "no-preference" });

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.sort()).toEqual(written.map((f) => path.basename(f)).sort());
  console.log(`[bulk-remove-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
