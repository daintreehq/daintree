/**
 * Surface headers and footers visual-review harness.
 *
 * Captures the header bars and status footers of the app's secondary surfaces —
 * the assistant column, the artifact overlay, the theme browser, the plugin
 * manager, the compare dialog, the Review Hub in both hosts, and four status
 * footers — beside the grid pane's compact `SurfaceHeader` they are judged
 * against. Drives its own preview entry (`surface-headers-preview.html`), which
 * mounts the REAL components against the real theme tokens and `index.css`, one
 * shot per page load.
 *
 *   DAINTREE_SHOT_SURFACEHEADERS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots surface-headers-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SURFACEHEADERS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR             required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES          theme sweep (default daintree,svalbard — dark and light)
 *
 * Never writes a PNG it has not verified: every capture waits for the frame's
 * `data-ready`, asserts the shot's key text inside the surface it photographs,
 * and the test counts the files at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";
import {
  SHOTS,
  SHOT_NAMES,
  type ShotName,
  type ShotSpec,
} from "../../src/components/ui/__preview__/surfaceHeadersShots";

const ENABLED = !!process.env.DAINTREE_SHOT_SURFACEHEADERS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const repoRoot = realpathSync(process.cwd());
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function capture(
  page: Page,
  snap: ReturnType<typeof makeSnap>,
  name: ShotName,
  theme: string
): Promise<string> {
  const spec: ShotSpec = SHOTS[name];
  await stubViteHmrClient(page);
  await page.setViewportSize(spec.viewport);
  // `commit`, not `load`: the first page against a cold dev server transforms
  // well over a thousand modules (the Review Hub and panel registry pull in most
  // of the renderer), which outlasts the navigation timeout. The frame wait below
  // carries that budget instead.
  await page.goto(`${baseURL}/surface-headers-preview.html?shot=${name}&theme=${theme}`, {
    waitUntil: "commit",
  });

  const frame = page.getByTestId(`shot-${name}`);
  await expect(frame, `${name}: frame never mounted`).toBeVisible({ timeout: 240_000 });
  await expect(frame, `${name}: real content never mounted`).toHaveAttribute("data-ready", "true", {
    timeout: 30_000,
  });
  await expect(frame.locator("[data-preview-error]")).toHaveCount(0);

  const target: Locator = spec.target === "frame" ? frame : page.locator(spec.target).first();
  // Text is checked inside the surface, never the caption, which names it too.
  const content: Locator = spec.target === "frame" ? frame.locator("[data-shot-body]") : target;
  await expect(target).toBeVisible();

  switch (spec.interaction) {
    case "open-artifacts":
      await page.locator("[data-artifact-trigger]").click();
      await expect(page.locator("[data-artifact-panel]")).toBeVisible();
      break;
    case "hover-theme-close": {
      const close = page.getByRole("button", { name: "Close theme browser" });
      await close.hover();
      await expect(close).toBeVisible();
      break;
    }
    case "none":
      await page.mouse.move(spec.viewport.width - 2, spec.viewport.height - 2);
      break;
  }

  for (const text of spec.expectText) {
    await expect(content, `${name}-${theme}: "${text}" not on screen`).toContainText(text);
  }

  await page.evaluate(() => document.fonts.ready);
  // Hover transitions and the full-window view's entry fade.
  await page.waitForTimeout(400);

  return snap(target, `${name}-${theme}.png`);
}

test("Surface headers and footers — every shot, every theme", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SURFACEHEADERS is required for the surface-headers capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SURFACEHEADERS=1 to run the capture");
  test.setTimeout(20 * 60_000);

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const name of SHOT_NAMES) written.push(await capture(page, snap, name, theme));
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * SHOT_NAMES.length);
});
