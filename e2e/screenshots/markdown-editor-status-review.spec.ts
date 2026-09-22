/**
 * Markdown editor status-strip visual-review harness.
 *
 * The strip above the editor buffer carries seven states and almost all of them
 * are hard to reach on purpose: a save conflict needs an agent writing the same
 * file mid-edit, mixed line endings need a file somebody broke, and `Saving…`
 * is one frame of a write that finishes in milliseconds. Reviewing the design
 * from whatever state a repository happens to offer is no way to look at it.
 *
 * So this drives the component's own preview entry
 * (`markdown-editor-status-preview.html`) rather than booting Electron: the
 * real `MarkdownEditorStatusBar`, the real theme tokens through
 * `applyAppThemeToRoot`, the real `index.css`, under the real
 * `FileViewerToolbar` row it sits beneath, at the widths a file panel gets.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_MDSTATUS=1 npx playwright test --project=screenshots markdown-editor-status-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MDSTATUS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       output directory (default artifacts/markdown-status-shots)
 *   DAINTREE_SHOT_THEMES    comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the strip is attached with a real box before it
 * writes and throws otherwise, and the test counts the files itself at the end
 * rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_MDSTATUS;

/** A comfortable file panel, and the narrowest one worth shipping. */
const DEFAULT_WIDTH = 900;
const NARROW_WIDTH = 420;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "markdown-status-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `STATUS_BAR_FIXTURES` in the preview entry. */
const FIXTURES = ["saved", "dirty", "saving", "conflict", "mixed-eol", "bom", "empty"] as const;

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // `strictPort: false` matters — see the sibling harness's note: the project's
  // own vite config pins 5173, so this dies on a port clash while the app is up
  // unless it is allowed to fall forward to a free one.
  server = await createServer({
    server: { port: 0, strictPort: false },
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
): Promise<{ chrome: Locator }> {
  await page.setViewportSize({ width, height: 420 });
  await page.goto(
    `${baseURL}/markdown-editor-status-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const strip = page.getByTestId("markdown-editor-status");
  await expect(strip, `fixture "${fixture}" rendered no status strip`).toBeAttached();
  // Type metrics drive every measurement in a text strip, so a capture taken
  // before the fonts land measures the fallback face.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  // The toolbar row above is part of the review: the strip's weight is only
  // judgeable against the chrome it sits under.
  return { chrome: page.locator("[data-preview-shell]").first() };
}

test("Markdown editor status strip — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MDSTATUS is required for the status-strip capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MDSTATUS=1 to run the capture");

  const written: string[] = [];

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      const { chrome } = await open(page, fixture, theme, DEFAULT_WIDTH);
      written.push(await snap(chrome, `${fixture}-${theme}.png`));
    }
  }

  // The pressure case: the narrowest a file panel realistically gets, in the
  // default theme only — width is a layout question, not a palette one.
  {
    const theme = THEMES[0]!;
    for (const fixture of ["dirty", "bom"] as const) {
      const { chrome } = await open(page, fixture, theme, NARROW_WIDTH);
      written.push(await snap(chrome, `${fixture}-${theme}-narrow.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[markdown-status-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
