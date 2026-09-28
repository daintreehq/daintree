/**
 * Shortcut-display visual-review harness.
 *
 * Drives `shortcut-display-preview.html`: the real menu shortcut slots, tooltip
 * content, shortcut hint, tips and banners, each fed the way its callers feed
 * it, on both platforms, under the real theme tokens and `index.css`.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_SHORTCUT_DISPLAY=1 npx playwright test --project=screenshots shortcut-display-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SHORTCUT_DISPLAY  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR               output directory (default artifacts/shortcut-display-shots)
 *   DAINTREE_SHOT_THEMES            comma-separated theme sweep (default: daintree,svalbard)
 *
 * Never writes a PNG it has not verified: each capture waits for the fixture's
 * surface to be visible and settled, and the test counts the files.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_SHORTCUT_DISPLAY;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "shortcut-display-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const FIXTURES = ["menu", "context-menu", "tooltip", "inline"] as const;
const PLATFORMS = ["mac", "win"] as const;

let server: ViteDevServer | undefined;
const pageErrors: string[] = [];
let baseURL = "";

test.use({ viewport: { width: 520, height: 360 }, deviceScaleFactor: 2 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // In a worktree `node_modules` is a symlink out of the project root, and Vite
  // refuses to serve through it — the keys then fall back to a system mono face.
  const modules = realpathSync(path.join(process.cwd(), "node_modules"));
  server = await createServer({
    server: { port: 0, strictPort: false, fs: { allow: [process.cwd(), modules] } },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

async function settle(page: Page, locator: ReturnType<Page["locator"]>, label: string) {
  await expect(locator.first(), `${label}: surface never appeared`).toBeVisible();
  await expect.poll(() => locator.first().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await page.evaluate(() => document.fonts.ready);
  // Let entry animations finish; opacity alone misses a scale-in.
  await page.waitForTimeout(350);
  const box = await locator.first().boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${label}: surface has no real box — refusing to write`);
  }
}

async function capture(
  page: Page,
  fixture: (typeof FIXTURES)[number],
  platform: (typeof PLATFORMS)[number],
  theme: string
): Promise<string> {
  const label = `${fixture}-${platform}-${theme}`;
  await page.goto(
    `${baseURL}/shortcut-display-preview.html?theme=${theme}&platform=${platform}&fixture=${fixture}`
  );
  await expect(
    page.locator("html[data-preview-ready]"),
    `${label}: preview never mounted — ${pageErrors.join(" | ") || "no page error"}`
  ).toBeAttached();
  if (fixture === "context-menu") {
    await page.locator("[data-preview-context-trigger]").click({ button: "right" });
    await settle(page, page.locator("[role=menu]"), label);
  } else if (fixture === "menu") {
    await settle(page, page.locator("[role=menu]"), label);
  } else if (fixture === "tooltip") {
    await settle(page, page.locator("[role=tooltip]").locator(".."), label);
    await settle(page, page.locator("[data-shortcut-hint-surface]"), label);
  } else {
    await settle(page, page.locator("[data-preview-surface]"), label);
  }
  const out = path.join(OUT_DIR, `${label}.png`);
  await page.screenshot({ path: out });
  return out;
}

test("shortcut display — fixtures, platforms and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SHORTCUT_DISPLAY is required for the shortcut-display capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SHORTCUT_DISPLAY=1 to run the capture");

  page.on("pageerror", (error) => pageErrors.push(error.message));
  const written: string[] = [];
  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      for (const platform of PLATFORMS) written.push(await capture(page, fixture, platform, theme));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * FIXTURES.length * PLATFORMS.length);
  console.log(`[shortcut-display-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
