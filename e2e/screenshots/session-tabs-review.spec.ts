/**
 * Assistant session-tab strip visual-review harness.
 *
 * The strip's most important job — showing that a lane you are NOT looking at has gone
 * to `working` or `waiting` — is by definition invisible from the lane on screen.
 * Reaching those states in the real app means launching two sessions and waiting for
 * one of them, which is no way to look at a surface deliberately.
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
  { name: "one-lane", what: "the state every project starts in" },
  { name: "one-lane-working", what: "one lane busy — header and strip both speak for it" },
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

  // `strictPort: false` matters: the project's own vite config sets
  // `strictPort: true` for the app's dev server, and that wins over an inline
  // `port: 0` — so with the app running this harness dies on "Port 5173 is
  // already in use" instead of taking a free one. Falling forward and reading
  // the port back off the server is what makes the harness runnable while the
  // app is up.
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
  // Generous on purpose. This harness is run on developer machines that are often
  // busy running the agent fleet this app exists to orchestrate, and at high load a
  // cold Vite transform of the preview entry comfortably outruns the 5s default —
  // which fails as "element(s) not found", i.e. looking exactly like a render bug in
  // the surface under review rather than a busy box.
  await expect(panel).toBeAttached({ timeout: 30_000 });
  // Deliberately not asserted here. Whether a one-lane project gets a strip at all is
  // one of the things this harness exists to show, so a missing strip has to be
  // capturable rather than a crash — `snap` still refuses to write a PNG for one.
  const strip = page.getByRole("tablist", { name: "Assistant sessions" });
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
      // selection that is too quiet stops being arguable. Skipped, not failed, when
      // the fixture renders no strip — that absence is itself a captured finding in
      // the panel shot above.
      if ((await strip.count()) > 0) {
        written.push(await snap(strip, `${name}-${theme}-strip.png`));
      }
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

    await strip.getByRole("tab", { name: "Session 2", exact: true }).hover();
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

    // Roving tabindex: ArrowRight moves focus WITHIN the strip without selecting,
    // which is the half of the tabs pattern a static fixture cannot show. If this
    // capture looks identical to the one above, focus did not move and the pattern
    // is not wired.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
    written.push(await snap(strip, `three-mixed-${hoverTheme}-strip-focus-arrow.png`));

    // One more Tab leaves the tablist entirely — the whole strip is a single tab
    // stop now — and lands on the trailing new-session control.
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    written.push(await snap(strip, `three-mixed-${hoverTheme}-strip-focus-new.png`));
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a review
  // ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  // One panel shot per fixture per theme is the floor that proves the sweep actually
  // ran. Strip shots are counted in `written` but not floored here, because whether a
  // given fixture has a strip is exactly what is under review.
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[session-tab-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
