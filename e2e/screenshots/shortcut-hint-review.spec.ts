/**
 * Shortcut-hint visual-review harness.
 *
 * The hint is a 2.5-second overlay raised at a pointer position, and only at an
 * invocation milestone, so there is no practical way to catch it in the running
 * app. This drives its preview entry (`shortcut-hint-preview.html`) instead: the
 * real `ShortcutHint`, raised through the real store with the combo formatted by
 * the real keybinding service, under the real theme tokens and `index.css`.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_SHORTCUT_HINT=1 npx playwright test --project=screenshots shortcut-hint-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SHORTCUT_HINT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            output directory (default artifacts/shortcut-hint-shots)
 *   DAINTREE_SHOT_THEMES         comma-separated theme sweep (default: daintree,bondi,namib,svalbard)
 *
 * Never writes a PNG it has not verified: each capture waits for the hint's
 * surface to be attached and fully faded in, and the test counts the files.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";
import { SHORTCUT_HINT_FIXTURES } from "../../src/components/ui/__preview__/shortcutHintFixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_SHORTCUT_HINT;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "shortcut-hint-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const FIXTURES = Object.keys(SHORTCUT_HINT_FIXTURES);

/** Every fixture in the first theme; only the palette-sensitive ones across the rest. */
const THEMED_FIXTURES = ["triple", "chord", "win-triple"];

let server: ViteDevServer | undefined;
let baseURL = "";

test.use({ viewport: { width: 480, height: 200 }, deviceScaleFactor: 2 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // The keycaps are set in the bundled mono face. In a worktree `node_modules` is
  // a symlink out of the project root, and Vite refuses to serve through it — the
  // chips then fall back to a system monospace and the capture shows the wrong font.
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

/** Raise one fixture in one theme and write it, having proved the hint is up. */
async function capture(page: Page, fixture: string, theme: string): Promise<string> {
  await page.goto(`${baseURL}/shortcut-hint-preview.html?theme=${theme}&fixture=${fixture}`);
  await expect(page.locator("html[data-hint-raised]")).toBeAttached();
  const surface = page.locator("[data-shortcut-hint-surface]");
  await expect(surface, `fixture "${fixture}" raised no hint`).toBeVisible();
  // The hint fades in; a mid-fade capture is a picture of a transition, not a state.
  await expect.poll(() => surface.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await page.evaluate(() => document.fonts.ready);
  const box = await surface.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${fixture}/${theme}: hint has no real box — refusing to write`);
  }
  const out = path.join(OUT_DIR, `${fixture}-${theme}.png`);
  await page.screenshot({ path: out });
  return out;
}

test("shortcut hint — fixtures and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SHORTCUT_HINT is required for the shortcut-hint capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SHORTCUT_HINT=1 to run the capture");

  const written: string[] = [];
  const [first, ...rest] = THEMES;
  for (const fixture of FIXTURES) written.push(await capture(page, fixture, first!));
  for (const theme of rest) {
    for (const fixture of THEMED_FIXTURES) written.push(await capture(page, fixture, theme));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(FIXTURES.length + rest.length * THEMED_FIXTURES.length);
  console.log(`[shortcut-hint-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
