/**
 * Pane loading, empty, placeholder and error states — visual-review harness.
 *
 * Drives `pane-states-preview.html`, which mounts the REAL state components of
 * the browser pane and the dev preview pane side by side (not yet viewed,
 * evicted, load failed, loading, no URL, blocked navigation), plus the other
 * "reconnecting", startup and inline busy marks, so two panes showing the same
 * situation differently are visible in one frame.
 *
 *   DAINTREE_SHOT_PANE_STATES=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots pane-states-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PANE_STATES  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR         output directory (default artifacts/pane-states-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: each row must be attached with a real
 * box, no pane may have hit its error boundary, and the test counts the files
 * itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PANE_STATES;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "pane-states-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const SECTIONS = [
  "first-view",
  "evicted",
  "load-error",
  "loading",
  "empty",
  "banners",
  "reconnecting",
  "inline-busy",
];

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1480, height: 2600 });
  const url = `${baseURL}/pane-states-preview.html?theme=${theme}`;
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(page.locator('[data-shot="inline-busy"]')).toBeAttached({
        timeout: attempt === 0 ? 20_000 : 30_000,
      });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`${url} never rendered`, { cause: error });
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  // Past the 400ms Doherty gate the loading overlays wait out.
  await page.waitForTimeout(900);
  const errors = await page.locator("[data-shot-error]").allTextContents();
  expect(errors, `panes hit their error boundary:\n${errors.join("\n")}`).toEqual([]);
}

test("Pane loading, empty, placeholder and error states", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PANE_STATES is required for the pane states capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PANE_STATES=1 to run the capture");
  test.setTimeout(5 * 60_000);

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console] ${m.text()}`);
  });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 500) console.log(`[500] ${r.url()}`);
  });

  for (const theme of THEMES) {
    await open(page, theme);
    for (const section of SECTIONS) {
      written.push(await snap(page.locator(`[data-shot="${section}"]`), `${section}-${theme}.png`));
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
});
