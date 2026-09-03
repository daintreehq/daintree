/**
 * Assistant session-tab strip visual-review harness.
 *
 * The strip only appears once a project has a second assistant lane open, and its most
 * important job — showing that a lane you are NOT looking at has gone to `working` or
 * `waiting` — is by definition invisible from the lane on screen. Reaching those states
 * in the real app means launching two sessions and waiting for one of them, which is no
 * way to look at a surface deliberately.
 *
 * So this drives the strip's own preview entry (`session-tabs-preview.html`) rather than
 * booting Electron: the same `HelpPanelHeader` and `HelpSessionTabs`, the same theme
 * tokens through `applyAppThemeToRoot`, the same `index.css` that owns the selected
 * tab's rail — at the panel's real widths.
 *
 * Opt-in only, like every sibling review harness: skips itself unless
 * DAINTREE_SHOT_SESSIONTABS is set, so no normal run and no marketing workflow trips it.
 *
 *   DAINTREE_SHOT_SESSIONTABS=1 npx playwright test --project=screenshots session-tabs-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SESSIONTABS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/session-tab-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Hard rule, inherited from the sibling harnesses: never write a PNG that has not been
 * verified. `snap()` asserts the target is attached and has a real box before it writes
 * and throws otherwise, and the test counts the files itself at the end rather than
 * trusting the exit code — a plausible-looking empty PNG sends a whole design review off
 * reasoning about a screen that does not exist.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_SESSIONTABS;

/**
 * The panel's real widths, from `helpPanelStore`: 380 is the default a user sees, 320 is
 * the minimum the resizer allows and therefore the only genuine pressure case a strip
 * capped at three `Session N` chips ever meets.
 */
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "session-tab-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry, with what each one is here to prove. */
const FIXTURES = [
  { name: "two-idle", what: "the common case — two lanes, neither reporting" },
  { name: "two-background-working", what: "the lane you cannot see is busy" },
  { name: "three-mixed", what: "all three markers at once, still distinguishable" },
  { name: "three-active-last", what: "selection on the far lane" },
  { name: "unfocused", what: "no title-bar lift behind the header" },
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
 * Write one PNG, having proved there is something to write. Throws rather than writing
 * when the target is not really on screen, which is what keeps a green run from
 * producing a blank picture.
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

/** Load one fixture in one theme at one width, and settle it. */
async function open(
  page: Page,
  fixture: string,
  theme: string,
  width: number
): Promise<{ panel: Locator; strip: Locator }> {
  await page.setViewportSize({ width: width + 40, height: 640 });
  await page.goto(
    `${baseURL}/session-tabs-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const panel = page.locator("[data-preview-panel]").first();
  await expect(panel).toBeAttached();
  const strip = page.getByRole("group", { name: "Assistant sessions" });
  await expect(strip).toBeAttached();
  // Type metrics drive every measurement in the strip, so a capture taken before the
  // fonts land measures the fallback face.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  return { panel, strip };
}

test("assistant session tabs — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SESSIONTABS is required for the session-tab capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SESSIONTABS=1 to run the capture");

  const written: string[] = [];

  for (const theme of THEMES) {
    for (const { name } of FIXTURES) {
      const { panel, strip } = await open(page, name, theme, DEFAULT_WIDTH);
      written.push(await snap(panel, `${name}-${theme}-panel.png`));
      // The strip alone, at the size the eye actually judges it. This is where a
      // selection that is too quiet stops being arguable.
      written.push(await snap(strip, `${name}-${theme}-strip.png`));
    }
  }

  // The pressure case: three lanes at the narrowest the resizer allows. Captured in the
  // default theme only — width is a layout question, not a palette one.
  {
    const narrowTheme = THEMES[0]!;
    const { panel, strip } = await open(page, "three-mixed", narrowTheme, MIN_WIDTH);
    written.push(await snap(panel, `three-mixed-${narrowTheme}-panel-320.png`));
    written.push(await snap(strip, `three-mixed-${narrowTheme}-strip-320.png`));
  }

  // The two states no fixture can express, because they are pointer and keyboard
  // states rather than data: an inactive tab under the cursor, and a tab holding the
  // focus ring. Both change what the strip is claiming, so both get captured.
  {
    const hoverTheme = THEMES[0]!;
    const { panel, strip } = await open(page, "three-mixed", hoverTheme, DEFAULT_WIDTH);

    await strip.getByRole("button", { name: "Session 2", exact: true }).hover();
    await page.waitForTimeout(250);
    written.push(await snap(strip, `three-mixed-${hoverTheme}-strip-hover-inactive.png`));

    // Keyboard focus, taken through real Tab presses rather than `.focus()`, so the
    // `:focus-visible` heuristic actually fires — a programmatic focus does not paint
    // the ring and would capture a picture of nothing.
    //
    // Tabbing until focus is INSIDE the strip rather than pressing a fixed number of
    // times: the header sits ahead of it in the DOM and its button count varies with
    // what the session can do, so a hardcoded count silently captures a header button
    // instead. The first run of this harness did exactly that.
    await page.mouse.move(0, 0);
    let reached = false;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await strip.evaluate((el) => el.contains(document.activeElement));
    }
    if (!reached) throw new Error("focus never reached the session strip — refusing to write");
    await page.waitForTimeout(250);
    written.push(await snap(strip, `three-mixed-${hoverTheme}-strip-focus-first.png`));
    // The same ring in the panel, uncropped: the strip's own 4px vertical padding is
    // the same size as the ring's offset plus width, so a strip-only crop cannot show
    // whether the ring is clipped by the chrome around it.
    written.push(await snap(panel, `three-mixed-${hoverTheme}-panel-focus-first.png`));

    // The close control's own ring. It is a separate tab stop by design, and it is the
    // one control here small enough that its ring can collide with the chip's edge.
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    written.push(await snap(strip, `three-mixed-${hoverTheme}-strip-focus-close.png`));
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a review
  // ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length * 2);
  console.log(`[session-tab-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
