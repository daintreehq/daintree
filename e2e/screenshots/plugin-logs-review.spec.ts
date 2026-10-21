/**
 * Plugin log buffer visual-review harness.
 *
 * Drives `plugin-logs-preview.html` — the Logs tab body of the plugin manager
 * in every state it can reach (populated, scrolling, refreshing, first load,
 * emptied, not running, read failed) plus the project plugin pane's framing —
 * across a theme sweep, with keyboard focus on the scrolling list and Windows
 * forced colours on the first theme.
 *
 * Opt-in only: skips itself unless DESIGN_CAPTURE_DIR is set. That directory is
 * also the output — there is deliberately no in-repo default.
 *
 *   DESIGN_CAPTURE_DIR=/abs/out npx playwright test --project=screenshots plugin-logs-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE_DIR     required — absolute output directory
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Output: <dir>/<state>--<theme>.png, plus long--focus--<theme>.png,
 * long--scrolled--<theme>.png and
 * <state>--forced--<theme>.png for the first theme.
 *
 * Never writes a PNG it has not verified, and counts the files at the end
 * rather than trusting the exit code.
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
const STATES = [
  "populated",
  "long",
  "refreshing",
  "loading",
  "empty",
  "not-running",
  "error",
  "error-stale",
  "project",
] as const;

const FORCED_STATES = ["populated", "not-running"];

const ATTACH_TIMEOUT_MS = 30_000;

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  mkdirSync(OUT!, { recursive: true });
  server = await createServer({
    // A worktree's node_modules is a symlink to the main checkout, which sits
    // outside Vite's allow list — without this the mono font 404s and every
    // capture falls back to the system monospace.
    server: { port: 0, strictPort: false, fs: { strict: false } },
    logLevel: "warn",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
  await server.warmupRequest("/src/components/Plugin/__preview__/logsPreview.tsx");
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
    await body(page);
    if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function open(page: Page, theme: string, forced = false) {
  await page.setViewportSize({ width: 800, height: 1200 });
  if (forced) await page.emulateMedia({ forcedColors: "active" });
  await page.goto(`${baseURL}/plugin-logs-preview.html?theme=${theme}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  // The populated specimen's text is the signal the page rendered real content.
  await expect(page.locator('[data-shot="populated"]')).toContainText("sync failed", {
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
}

test("plugin logs — every state, every theme", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE_DIR is required for the plugin-logs-review capture",
  });
  test.skip(!ENABLED, "Set DESIGN_CAPTURE_DIR to run the plugin-logs-review capture");
  const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "reduce" });
  await settleDevServer(context, `${baseURL}/plugin-logs-preview.html`);
  const expected: string[] = [];

  for (const theme of THEMES) {
    await withPage(context, `states ${theme}`, async (page) => {
      await open(page, theme);
      for (const id of STATES) {
        const file = `${id}--${theme}.png`;
        await snap(page.locator(`[data-shot="${id}"]`), file);
        expected.push(file);
      }
    });
  }

  const first = THEMES[0]!;
  await withPage(context, `focus ${first}`, async (page) => {
    await open(page, first);
    const specimen = page.locator('[data-shot="long"]');
    // Keyboard modality first, then walk Tab from the Refresh button to the
    // next stop inside the specimen, which is the scrolling list when it has one.
    await specimen.getByRole("button", { name: /refresh/i }).focus();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    // No assertion on where focus landed: a list that takes no focus is a
    // finding the capture shows, not a harness failure.
    const file = `long--focus--${first}.png`;
    await snap(specimen, file);
    expected.push(file);

    // Scrolled up to read: the list unpins and offers the way back down.
    await specimen.locator("ol").evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(specimen.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await page.mouse.move(0, 0);
    const scrolled = `long--scrolled--${first}.png`;
    await snap(specimen, scrolled);
    expected.push(scrolled);
  });

  await withPage(context, `forced ${first}`, async (page) => {
    await open(page, first, true);
    for (const id of FORCED_STATES) {
      const file = `${id}--forced--${first}.png`;
      await snap(page.locator(`[data-shot="${id}"]`), file);
      expected.push(file);
    }
  });

  await context.close();

  const missing = expected.filter((f) => !existsSync(path.join(OUT!, f)));
  if (missing.length > 0) throw new Error(`missing captures: ${missing.join(", ")}`);
  const written = readdirSync(OUT!).filter((f) => f.endsWith(".png"));
  console.log(`[plugin-logs-review] wrote ${written.length} PNGs (${expected.length} expected)`);
});
