/**
 * File-editor hint bar visual-review harness.
 *
 * The bar only renders when a plugin claims the open file's extension, and its
 * two interesting states differ by whether that plugin is enabled — so putting
 * `ready` next to `disabled` in the real app means toggling Preferences between
 * screenshots, which is no way to judge whether the two read differently.
 *
 * So this drives the component's own preview entry (`file-editor-hint-preview.html`)
 * rather than booting Electron: the real `FileEditorHintBar`, the real theme
 * tokens through `applyAppThemeToRoot`, the real `index.css`, under the real
 * toolbar row it sits beneath.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_HINTBAR=1 npx playwright test --project=screenshots file-editor-hint-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HINTBAR  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      output directory (default artifacts/file-editor-hint-shots)
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the target is attached with a real box before it
 * writes, and the test counts the files itself rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_HINTBAR;

/** A typical file panel, and the narrowest one worth defending. */
const DEFAULT_WIDTH = 900;
const WIDE_WIDTH = 1600;
const NARROW_WIDTH = 420;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "file-editor-hint-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `HINT_BAR_FIXTURES`, with what each one is here to prove. */
const FIXTURES = [
  { name: "ready", what: "the plugin is on — the bar is only an offer" },
  { name: "disabled", what: "the plugin is off — the offer has a prerequisite" },
  { name: "pending", what: "the enable-and-open round trip is in flight" },
  { name: "error", what: "the attempt failed and the bar has to say so" },
  { name: "long-name", what: "a display name long enough to pressure the row" },
] as const;

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // `strictPort: false` matters: the project's own vite config sets
  // `strictPort: true`, and that wins over an inline `port: 0` — so with the app
  // running this harness would die on "Port 5173 is already in use".
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

/** Write one PNG, having proved there is something to write. */
async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out });
  return out;
}

/** Load one fixture in one theme at one width, and settle it. */
async function open(
  page: Page,
  fixture: string,
  theme: string,
  width: number
): Promise<{ shell: Locator; bar: Locator }> {
  await page.setViewportSize({ width, height: 520 });
  await page.goto(
    `${baseURL}/file-editor-hint-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached();
  const bar = page.locator("[data-hint-bar-slot]").first();
  // An empty slot means the component returned null, which for a review harness
  // is a picture of nothing dressed up as a passing run.
  await expect(bar.locator(":scope > *"), `fixture "${fixture}" rendered no bar`).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  return { shell, bar };
}

test("file-editor hint bar — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HINTBAR is required for the hint-bar capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_HINTBAR=1 to run the capture");

  const written: string[] = [];

  for (const theme of THEMES) {
    for (const { name } of FIXTURES) {
      const { shell } = await open(page, name, theme, DEFAULT_WIDTH);
      written.push(await snap(shell, `${name}-${theme}.png`));
    }
  }

  // Width is a layout question, not a palette one, so the pressure cases run in
  // the default theme only. Wide is where a left-aligned message and a
  // right-aligned action drift apart; narrow is where they collide.
  {
    const theme = THEMES[0]!;
    for (const name of ["ready", "disabled"] as const) {
      const wide = await open(page, name, theme, WIDE_WIDTH);
      written.push(await snap(wide.shell, `${name}-${theme}-wide.png`));
      const narrow = await open(page, name, theme, NARROW_WIDTH);
      written.push(await snap(narrow.shell, `${name}-${theme}-narrow.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[file-editor-hint-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
