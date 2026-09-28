/**
 * Pressed toggle buttons and filter chips — visual-review harness.
 *
 * Drives `pressed-toggles-chips-preview.html`: every pressed-toggle and
 * filter-chip family side by side, each on its consumer's surface, in both
 * states. States that carry design weight: rest in every theme of the sweep,
 * then in the first theme a pressed toggle and a selected chip hovered and
 * keyboard-focused, and the whole page under forced colors and under
 * `prefers-contrast: more`.
 *
 * Opt-in only: skips itself unless DESIGN_CAPTURE_DIR is set. That directory is
 * also the output — there is deliberately no in-repo default.
 *
 *   DESIGN_CAPTURE_DIR=/abs/out npx playwright test --project=screenshots pressed-toggles-chips-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE_DIR     required — absolute output directory
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Output: <dir>/<specimen>--<state>--<theme>.png
 *
 * Never writes a PNG it has not verified, and counts the files at the end
 * rather than trusting the exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const OUT = process.env.DESIGN_CAPTURE_DIR;
const ENABLED = !!OUT;

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors the `data-shot` ids in the preview entry. */
const SPECIMENS = ["audit", "small-toggles", "icon-toggles", "diagnostics", "events", "chips"];

/** A pressed toggle and a selected chip, hovered and focused in the first theme. */
const PROBES: { slug: string; specimen: string; name: string | RegExp }[] = [
  { slug: "group-by-turn", specimen: "audit", name: "Group by turn" },
  { slug: "auto-scroll", specimen: "diagnostics", name: "Auto-scroll" },
  { slug: "log-level", specimen: "diagnostics", name: /^Info/ },
  { slug: "worktree-chip", specimen: "chips", name: /^Dirty/ },
];

const ATTACH_TIMEOUT_MS = 30_000;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  mkdirSync(OUT!, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function snap(target: Locator, file: string): Promise<void> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  await target.screenshot({ path: path.join(OUT!, file), animations: "disabled" });
}

async function withPage(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<void>
): Promise<void> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await stubViteHmrClient(page);
    await body(page);
    if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function openGallery(
  page: Page,
  theme: string,
  media: { forcedColors?: "active"; contrast?: "more" } = {}
) {
  await page.setViewportSize({ width: 1200, height: 1600 });
  await page.emulateMedia(media);
  for (let attempt = 0; ; attempt++) {
    await page.goto(`${baseURL}/pressed-toggles-chips-preview.html?theme=${theme}`);
    try {
      await expect(page.locator("[data-preview-shell]")).toBeAttached({
        timeout: ATTACH_TIMEOUT_MS,
      });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`gallery ${theme} never rendered`, { cause: error });
    }
  }
  // The event detail keeps its context pills behind a collapsed section; open
  // it (and fold the payload away) so the pills are what the frame shows.
  const events = page.locator('[data-shot="events"]');
  await events.getByRole("button", { name: "Payload", exact: true }).click();
  await events.getByRole("button", { name: "Context", exact: true }).click();
  await expect(events.locator("button", { hasText: "wt-feature-login" })).toBeVisible({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
}

test("pressed toggles and filter chips — every family, every state", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE_DIR is required for the pressed-toggles-chips capture",
  });
  test.skip(!ENABLED, "Set DESIGN_CAPTURE_DIR to run the pressed-toggles-chips capture");
  test.setTimeout(8 * 60_000);
  const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "reduce" });
  const expected: string[] = [];

  for (const theme of THEMES) {
    await withPage(context, `gallery ${theme}`, async (page) => {
      await openGallery(page, theme);
      for (const id of SPECIMENS) {
        const file = `${id}--rest--${theme}.png`;
        await snap(page.locator(`[data-shot="${id}"]`), file);
        expected.push(file);
      }
    });
  }

  const first = THEMES[0]!;
  await withPage(context, `probes ${first}`, async (page) => {
    await openGallery(page, first);
    for (const probe of PROBES) {
      const specimen = page.locator(`[data-shot="${probe.specimen}"]`);
      const target = specimen.getByRole("button", { name: probe.name, pressed: true }).first();
      await target.hover();
      await page.waitForTimeout(250);
      const hoverFile = `${probe.slug}--hover--${first}.png`;
      await snap(specimen, hoverFile);
      expected.push(hoverFile);

      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await target.focus();
      await page.waitForTimeout(250);
      const focusVisible = await target.evaluate((el) => el.matches(":focus-visible"));
      if (!focusVisible) throw new Error(`${probe.slug}: target is not :focus-visible`);
      const focusFile = `${probe.slug}--focus--${first}.png`;
      await snap(specimen, focusFile);
      expected.push(focusFile);
      await target.blur();
    }
  });

  // Increased contrast with keyboard focus on a pressed toggle and a selected
  // chip: the mode's own outline rules must not replace the focus ring.
  await withPage(context, `contrast focus ${first}`, async (page) => {
    await openGallery(page, first, { contrast: "more" });
    for (const probe of PROBES) {
      const specimen = page.locator(`[data-shot="${probe.specimen}"]`);
      const target = specimen.getByRole("button", { name: probe.name, pressed: true }).first();
      await page.keyboard.press("Tab");
      await target.focus();
      await page.waitForTimeout(250);
      const file = `${probe.slug}--contrast-focus--${first}.png`;
      await snap(specimen, file);
      expected.push(file);
      await target.blur();
    }
  });

  for (const [state, media] of [
    ["forced", { forcedColors: "active" }],
    ["contrast", { contrast: "more" }],
  ] as const) {
    await withPage(context, `${state} ${first}`, async (page) => {
      await openGallery(page, first, media);
      for (const id of SPECIMENS) {
        const file = `${id}--${state}--${first}.png`;
        await snap(page.locator(`[data-shot="${id}"]`), file);
        expected.push(file);
      }
    });
  }

  await context.close();

  const written = new Set(readdirSync(OUT!).filter((f) => f.endsWith(".png")));
  const missing = expected.filter((f) => !written.has(f) || !existsSync(path.join(OUT!, f)));
  expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
  console.log(`[pressed-toggles-chips-shots] wrote ${expected.length} PNGs to ${OUT}`);
});
