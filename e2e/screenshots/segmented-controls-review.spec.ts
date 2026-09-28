/**
 * Segmented-control family visual-review harness.
 *
 * Drives `segmented-controls-preview.html` — one specimen per single-choice
 * segmented control in the app, each on its consumer's surface — plus the fleet
 * picker's commit-mode switch from the fleet preview, through the states that
 * carry design weight: rest in every theme of the sweep, keyboard focus, and
 * Windows forced colours.
 *
 * Opt-in only: skips itself unless DESIGN_CAPTURE_DIR is set. That directory is
 * also the output — there is deliberately no in-repo default.
 *
 *   DESIGN_CAPTURE_DIR=/abs/out npx playwright test --project=screenshots segmented-controls-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE_DIR     required — absolute output directory
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Output: <dir>/<specimen>--<state>--<theme>.png
 *   state = rest (every theme) | focus | forced (first theme only)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified, and count the files at the end rather than trusting the exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const OUT = process.env.DESIGN_CAPTURE_DIR;
const ENABLED = !!OUT;

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors the `data-shot` ids in the preview entry. */
const SPECIMENS = [
  "settings",
  "diff-pane",
  "review-hub",
  "surface-strip",
  "prompt-history",
  "image-diff",
  "file-toolbar",
  "quick-state",
  "pilot",
  "pulse",
  "viewport-dpr",
  "github-filter",
  "theme-browser",
] as const;

/** Specimens whose keyboard-focus state is captured (first theme only). */
const FOCUS_SPECIMENS = ["settings", "diff-pane", "quick-state", "pulse", "theme-browser"];

const ATTACH_TIMEOUT_MS = 30_000;

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  mkdirSync(OUT!, { recursive: true });
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "warn" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
  await server.warmupRequest("/src/components/ui/__preview__/segmentedControls.tsx");
});

test.afterAll(async () => {
  await server?.close();
});

async function settleDevServer(context: BrowserContext, url: string) {
  const page = await context.newPage();
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(url);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    if (navigations === before && (await page.locator("[data-preview-shell]").count()) >= 1) break;
  }
  await page.close();
}

async function snap(
  target: Locator,
  file: string,
  animations: "disabled" | "allow" = "disabled"
): Promise<void> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  await target.screenshot({ path: path.join(OUT!, file), animations });
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
    await body(page);
    if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function openGallery(page: Page, theme: string, forced = false) {
  await page.setViewportSize({ width: 1200, height: 1400 });
  if (forced) await page.emulateMedia({ forcedColors: "active" });
  await page.goto(`${baseURL}/segmented-controls-preview.html?theme=${theme}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  // The seeded pulse card and the theme browser's list are the last things to
  // settle; their controls being present is the signal the page is whole.
  await expect(page.locator('[data-shot="pulse"] [role="radiogroup"]')).toBeVisible({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await expect(
    page.locator('[data-shot="theme-browser"] button', { hasText: "Light" })
  ).toBeVisible({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
}

async function openFleet(page: Page, theme: string, forced = false): Promise<Locator> {
  await page.setViewportSize({ width: 1200, height: 900 });
  if (forced) await page.emulateMedia({ forcedColors: "active" });
  await page.goto(`${baseURL}/fleet-preview.html?theme=${theme}&fixture=picker-palette`);
  const group = page.locator('[data-testid="fleet-picker-cold-start-commit-mode"]');
  await expect(group).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  // The footer row the switch sits in, so it is judged beside its neighbours.
  return group.locator("xpath=..");
}

test("segmented controls — every consumer, every state", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE_DIR is required for the segmented-controls-review capture",
  });
  test.skip(!ENABLED, "Set DESIGN_CAPTURE_DIR to run the segmented-controls-review capture");
  const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "reduce" });
  await settleDevServer(context, `${baseURL}/segmented-controls-preview.html`);
  await settleDevServer(context, `${baseURL}/fleet-preview.html?fixture=picker-palette`);
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
    await withPage(context, `fleet ${theme}`, async (page) => {
      const row = await openFleet(page, theme);
      const file = `fleet--rest--${theme}.png`;
      await snap(row, file);
      expected.push(file);
    });
  }

  const first = THEMES[0]!;
  await withPage(context, `focus ${first}`, async (page) => {
    await openGallery(page, first);
    for (const id of FOCUS_SPECIMENS) {
      // A Tab press first, so focus arrives with keyboard modality and the ring
      // is the one a keyboard user sees; then the control's own tab stop, which
      // is not always the specimen's first (the theme browser's close button
      // comes before its appearance switch).
      await page.keyboard.press("Tab");
      const specimen = page.locator(`[data-shot="${id}"]`);
      const radioStop = specimen.locator('[role="radio"][tabindex="0"]').first();
      const target = (await radioStop.count()) > 0 ? radioStop : specimen.locator("button").first();
      await target.focus();
      await page.waitForTimeout(150);
      const focusVisible = await target.evaluate((el) => el.matches(":focus-visible"));
      if (!focusVisible) throw new Error(`${id}: the control's tab stop is not :focus-visible`);
      const file = `${id}--focus--${first}.png`;
      await snap(page.locator(`[data-shot="${id}"]`), file);
      expected.push(file);
    }
  });

  await withPage(context, `forced ${first}`, async (page) => {
    await openGallery(page, first, true);
    for (const id of SPECIMENS) {
      const file = `${id}--forced--${first}.png`;
      await snap(page.locator(`[data-shot="${id}"]`), file);
      expected.push(file);
    }
  });
  await withPage(context, `fleet forced ${first}`, async (page) => {
    const row = await openFleet(page, first, true);
    const file = `fleet--forced--${first}.png`;
    await snap(row, file);
    expected.push(file);
  });

  await context.close();

  // The slide itself, in a real layout engine: motion on, a user pick, and a
  // frame taken partway through the 150ms transition. A thumb that snapped (or
  // had its transition stripped by a re-measure) is already at rest here.
  const motion = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "no-preference" });
  await withPage(motion, `midslide ${first}`, async (page) => {
    await openGallery(page, first);
    const specimen = page.locator('[data-shot="diff-pane"]');
    await specimen.getByRole("radio", { name: "Unified" }).click();
    // Freeze the transition halfway rather than racing it with a timer: a
    // screenshot under load can land after 150ms and photograph a thumb at rest.
    const frozen = await specimen
      .locator('[role="radiogroup"][aria-label="Diff layout"] [data-slot="segmented-thumb"]')
      .evaluate((el) => {
        const running = el.getAnimations();
        for (const animation of running) {
          animation.pause();
          animation.currentTime = 75;
        }
        return running.length;
      });
    if (frozen === 0) throw new Error("diff layout: a user pick started no thumb transition");
    const file = `diff-pane--midslide--${first}.png`;
    // "allow": the default would finish the frozen transition before capturing.
    await snap(specimen, file, "allow");
    expected.push(file);
  });
  await motion.close();

  const written = new Set(readdirSync(OUT!).filter((f) => f.endsWith(".png")));
  const missing = expected.filter((f) => !written.has(f) || !existsSync(path.join(OUT!, f)));
  expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
  console.log(`[segmented-shots] wrote ${expected.length} PNGs to ${OUT}`);
});
