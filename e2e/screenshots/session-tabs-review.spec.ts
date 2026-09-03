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

  // `strictPort: false` is the load-bearing half of this. The project's own
  // `vite.config.ts` sets `port: 5173` with `strictPort: true`, and that survives the
  // merge with this inline config — so on a machine already running `npm run dev` the
  // harness tried to bind an occupied port. It surfaced as `element(s) not found` on
  // whichever page load lost the race, which reads exactly like a render bug in the
  // surface under review rather than a port collision. Walking to the next free port
  // means the harness can run beside a live dev server, which is when it is most useful.
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

/**
 * Serve an inert `@vite/client`, so no page in this sweep opens an HMR socket.
 *
 * This harness does about 22 navigations against one dev server, and it used to go blank
 * from roughly the twenty-second onwards — permanently, for every load after it, whatever
 * the fixture or width. The chain is worth writing down, because none of its links is
 * visible from the failure:
 *
 * Vite's HMR client opens a WebSocket per page load. Chromium throttles repeated
 * handshakes to one host with an escalating delay — measured here at 2ms for the first,
 * ~1.1s by the fourteenth and ~4s by the twenty-second — and because each navigation
 * arrives about 1.2s after the last, the pending handshake is torn down before it
 * completes, so the throttle never resets. Once the delay outruns the load, the client
 * gives up and enters its recovery path, which constructs a `SharedWorker` from a blob
 * URL. That is refused outright: `cspTransformPlugin` stamps the renderer's dev CSP,
 * `require-trusted-types-for 'script'` included, onto every dev HTML entry — this
 * standalone harness among them, even though it ships an empty CSP meta of its own. The
 * throw aborts the module graph, `#root` stays empty, and nothing recovers.
 *
 * Stubbing the client removes the socket, and with it the whole chain. HMR is worthless
 * to a screenshot run that navigates for every shot anyway.
 *
 * One export is NOT inert: `updateStyle`. In dev, Vite delivers every `.css` import as a
 * JS module that calls `updateStyle(id, css)` from this very client to append a `<style>`
 * tag — so a stub that no-ops it renders the whole page unstyled, and a capture of that
 * passes every "is it mounted" check while photographing raw HTML. The first version of
 * this stub did exactly that, and the `open()` helper now refuses an unstyled page so it
 * cannot happen quietly again.
 *
 * The unscoped CSP is the deeper half of this and is left alone deliberately: it is a
 * dev-server security control shared by the whole app, and narrowing which pages receive
 * it is not a change that belongs to a review of one tab strip.
 */
async function stubViteHmrClient(page: Page): Promise<void> {
  await page.route("**/@vite/client", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: [
        "const noop = () => {};",
        "export const createHotContext = () => ({ accept: noop, acceptExports: noop, dispose: noop, prune: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop, data: {} });",
        "export const injectQuery = (u) => u;",
        // Vite's own implementation, minus HMR bookkeeping: one <style> per module id.
        "const sheets = new Map();",
        "export function updateStyle(id, content) {",
        "  let style = sheets.get(id);",
        "  if (!style) {",
        "    style = document.createElement('style');",
        "    style.setAttribute('type', 'text/css');",
        "    style.setAttribute('data-vite-dev-id', id);",
        "    style.textContent = content;",
        "    document.head.appendChild(style);",
        "    sheets.set(id, style);",
        "  } else {",
        "    style.textContent = content;",
        "  }",
        "}",
        "export function removeStyle(id) {",
        "  const style = sheets.get(id);",
        "  if (style) { document.head.removeChild(style); sheets.delete(id); }",
        "}",
      ].join("\n"),
    })
  );
}

/** Load one fixture in one theme at one width, and settle it. */
async function open(
  page: Page,
  fixture: string,
  theme: string,
  width: number
): Promise<{ panel: Locator; strip: Locator }> {
  // A fixed, generous viewport rather than one sized to the panel. The panel is a
  // fixed-width element and `snap` screenshots that element, so the surrounding space
  // never reaches a PNG, while a viewport tightened to the panel does reach the browser
  // window and Chromium will not go below its own minimum window width on macOS.
  await page.setViewportSize({ width: 1000, height: 640 });

  const url = `${baseURL}/session-tabs-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`;
  const panel = page.locator("[data-preview-panel]").first();

  // Load, and give it one more go if the app never mounted. A backstop only — the cause
  // is dealt with by `stubViteHmrClient` below.
  //
  // Bounded and loud on purpose: the failure it covers is indistinguishable from the
  // outside from the surface genuinely failing to render, since both arrive as
  // `element(s) not found`. If the second attempt is also empty, that IS the product,
  // and it throws.
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(panel).toBeAttached({ timeout });
  } catch {
    // Loud, so a retry never passes silently: a sweep that needed one is a sweep whose
    // first mount failed, and that is worth knowing even when the second one lands.
    console.warn(
      `[session-tab-shots] first mount of ${fixture}/${theme}@${width} failed; retrying once`
    );
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(panel).toBeAttached({ timeout });
  }
  // Deliberately not asserted here. Whether a one-lane project gets a strip at all is
  // one of the things this harness exists to show, so a missing strip has to be
  // capturable rather than a crash — `snap` still refuses to write a PNG for one.
  const strip = page.getByRole("tablist", { name: "Assistant sessions" });
  // Mounted is not the same as styled. A page whose stylesheet never arrived still has a
  // tablist to find and a box to photograph — and the resulting PNG is raw HTML that
  // passes every structural check while looking nothing like the product. `flex` here
  // comes from a Tailwind utility, so its presence proves the stylesheet landed.
  await expect(strip).toHaveCSS("display", "flex");
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

  // Once, before any navigation — see the note on the helper.
  await stubViteHmrClient(page);

  const written: string[] = [];

  for (const theme of THEMES) {
    for (const { name } of FIXTURES) {
      const { panel, strip } = await open(page, name, theme, DEFAULT_WIDTH);
      written.push(await snap(panel, `${name}-${theme}-panel.png`));
      // The strip alone, at the size the eye actually judges it. This is where a
      // selection that is too quiet stops being arguable. Required for EVERY fixture,
      // the one-lane ones included: the strip is always rendered now, and a fixture
      // without one is a regression, not a state.
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
    // The picture cannot tell a roving tab stop from a pinned one — both draw the ring
    // on the second tab — so the DOM has to. Focus, the stop AND the selection are all
    // asserted: the first two moved together, the third did not move at all.
    const roving = await strip.evaluate((el) => {
      const items = [...el.querySelectorAll<HTMLElement>('[role="tab"]')];
      return items.map((t) => ({
        focused: t === document.activeElement,
        stop: t.tabIndex === 0,
        selected: t.getAttribute("aria-selected") === "true",
      }));
    });
    expect(roving.map((t) => t.focused)).toEqual([false, true, false]);
    expect(roving.map((t) => t.stop)).toEqual([false, true, false]);
    expect(roving.map((t) => t.selected)).toEqual([true, false, false]);
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
  // A panel shot AND a strip shot per fixture per theme is the floor that proves the
  // sweep actually ran and that every fixture had a strip to shoot.
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length * 2);
  console.log(`[session-tab-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
