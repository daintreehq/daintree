/**
 * Assistant tool-group visual-review harness.
 *
 * The transcript folds a settled turn's tool calls into a collapsed group header, and
 * that header is the only trace a completed function call leaves in the chat history
 * once the turn is done. It is therefore the thing worth looking at directly, and it is
 * almost impossible to reach in the real app: it exists for a few seconds at the end of
 * a live engine turn and then scrolls away.
 *
 * So this drives the panel's own preview entry (`assistant-preview.html`) instead of
 * booting Electron — the same React tree, the same `--assistant-*` palette resolution,
 * the same reducer output, rendered from states CAPTURED off the real transport
 * (`__preview__/capturedStates.ts`). What it shows is what the panel actually produces.
 *
 * Opt-in only, like every sibling review harness: skips itself unless
 * DAINTREE_SHOT_TOOLGROUP is set, so no normal run and no marketing workflow trips it.
 *
 *   DAINTREE_SHOT_TOOLGROUP=1 npx playwright test --project=screenshots assistant-tool-group-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOOLGROUP  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        output directory (default artifacts/tool-group-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Hard rule, inherited from the sibling harnesses: never write a PNG that has not been
 * verified. `snap()` asserts the target is attached and has a real box before it writes
 * and throws otherwise, and the test counts the files itself at the end rather than
 * trusting the exit code — a plausible-looking empty PNG sends a whole design review
 * off reasoning about a screen that does not exist.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_TOOLGROUP;

/** The panel's real docked width, so line breaks land where they land in the product. */
const PANEL_WIDTH = 420;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "tool-group-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/**
 * The fixtures that carry a tool group, and what each one is here to show. `toolBatch`
 * is the subject: a settled clean turn, which is the case that auto-collapses and the
 * case the reader sees most. The other two exist so a change cannot fix the clean row
 * by quietly flattening the states that must stay distinguishable from it.
 */
const FIXTURES = [
  { name: "toolBatch", what: "settled clean turn — collapses" },
  { name: "degraded", what: "a failed call — must not read as clean" },
  { name: "asyncWork", what: "handed off — still running after the turn" },
] as const;

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is not available in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test body
  // carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  // Fresh directory per run: a leftover PNG from an earlier round read as this round's
  // output is the single easiest way to review a screen that no longer exists.
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  server = await createServer({ server: { port: 0 }, logLevel: "error" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

/**
 * Write one PNG, having proved there is something to write. Returns the file path so a
 * caller can assert on it; throws rather than writing when the target is not really on
 * screen, which is what keeps a green run from producing a blank picture.
 */
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

/** Load one fixture in one theme and settle it. */
async function open(page: Page, fixture: string, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: PANEL_WIDTH + 40, height: 900 });
  await page.goto(`${baseURL}/assistant-preview.html?theme=${theme}&fixture=${fixture}`);
  const panel = page.locator("[data-assistant-panel], #root > div").first();
  await expect(panel).toBeAttached();
  // The transcript paints its own surface and the fonts drive every measurement in it,
  // so a capture taken before they land measures the fallback face.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return panel;
}

test("assistant tool group — collapsed and expanded, across themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TOOLGROUP is required for the tool-group capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TOOLGROUP=1 to run the capture");

  const written: string[] = [];

  for (const theme of THEMES) {
    for (const { name } of FIXTURES) {
      const panel = await open(page, name, theme);
      written.push(await snap(panel, `${name}-${theme}-panel.png`));

      // The group header itself, cropped. The panel shot shows it in context; this one
      // shows it at the size the eye actually judges it, which is where a row that is
      // too quiet stops being arguable.
      const header = page.getByRole("button", { expanded: false }).first();
      if (await header.isVisible().catch(() => false)) {
        written.push(await snap(header, `${name}-${theme}-collapsed.png`));

        // The same group opened. Collapsed and expanded are meant to read as one object
        // in two states, and that claim can only be checked side by side.
        await header.click();
        await page.waitForTimeout(200);
        written.push(await snap(panel, `${name}-${theme}-expanded.png`));
      }
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a review
  // ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[tool-group-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
