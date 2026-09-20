/**
 * SvelteKit Site Builder visual-review harness.
 *
 * The builder is a strip under the dev preview's toolbar plus a drawer beside
 * the page, and the states that decide its design belong to a live dev server
 * and a real agent CLI — a page that has not loaded, a component whose source
 * main is still resolving, a request that failed half-way into an agent's
 * input, a project on a Svelte version that cannot be edited. Reaching each one
 * in the real app is a cold Vite start and a real CLI per state.
 *
 * So this drives the builder's own preview entry (`site-builder-preview.html`)
 * rather than booting Electron: the real `SiteBuilderToolbar`, the real
 * `SiteBuilderDrawer`, the real `InspectorController`, the real theme tokens and
 * the real `index.css`, over a stand-in bridge that speaks the same protocol.
 * States no fixture can express — hover, keyboard focus, an open agent picker,
 * a live class autocomplete — are driven here with a real pointer and real keys.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_SITEBUILDER is set.
 *
 *   DAINTREE_SHOT_SITEBUILDER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots site-builder-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SITEBUILDER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo.
 *                              Deliberately no default: a committed spec with an in-repo
 *                              fallback is how PNGs end up in a working tree.
 *   DAINTREE_SHOT_THEMES       themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP        "0" skips the all-themes sweep of the selected state
 *
 * Hard rule, inherited from the sibling harnesses: never write a PNG that has not
 * been verified. Every capture asserts the state it means to show is on screen
 * first, and the test counts the files itself at the end rather than trusting the
 * exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  FIXTURE_NAMES,
  fixtureFor,
  type FixtureName,
} from "../../plugins/builtin/sveltekit-builder/renderer/__preview__/fixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_SITEBUILDER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

// 2× so a 32px strip's glyphs, 1px edges and 10px chip text are judged at the
// size a Retina user sees them; at 1× the details this harness exists to show
// round away.
test.use({ deviceScaleFactor: 2 });

const FRAME = "[data-fixture]";
const STRIP = '[role="toolbar"][aria-label="Site Builder"]';
const DRAWER = '[aria-label="Site Builder details"]';

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  // Fresh captures per run: a leftover PNG from an earlier round read as this
  // round's output is the single easiest way to review a screen that no longer
  // exists. Only the PNGs go — this never removes a directory it did not create.
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }

  // `strictPort: false` so the harness can run beside a live `npm run dev`.
  // `fs.allow` names the REAL node_modules: a worktree symlinks it to the main
  // checkout, and Vite resolves fonts through the link to a path outside the
  // project root, which its serving allow-list refuses. A capture measured in
  // the fallback face is the wrong picture.
  server = await createServer({
    server: {
      port: 0,
      strictPort: false,
      fs: { allow: [process.cwd(), realpathSync(path.join(process.cwd(), "node_modules"))] },
    },
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
 * Serve an inert `@vite/client` so no page in this sweep opens an HMR socket.
 * Chromium throttles repeated WebSocket handshakes to one host until the client
 * gives up and falls into a blob-URL SharedWorker the dev CSP refuses — after
 * which every load mounts blank. `updateStyle` stays real: in dev every CSS
 * import is a JS module that calls it, so a no-op there renders the page
 * unstyled. See the panel-header harness for the full chain.
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

/** Freeze motion so a capture is the settled state, not a frame of a transition. */
const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

/**
 * Write one PNG, having proved there is something to write. Throws rather than
 * writing when the target is not really on screen.
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

/** A page-region capture for states that spill out of the frame — an open picker. */
async function snapRegion(page: Page, file: string): Promise<string> {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out });
  return out;
}

/**
 * Open one fixture in one theme and wait until it has actually settled.
 *
 * Three separate proofs, because each has failed on its own in a sibling
 * harness: the frame is attached, the stylesheet landed (a Tailwind utility
 * resolved), and the fixture's own drive finished AND its named evidence is on
 * screen. A timeout here is a real failure — never a reason to photograph
 * whatever happens to be rendered.
 */
async function open(page: Page, fixture: FixtureName, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 760 });
  await stubViteHmrClient(page);
  // A harness that mounts blank is the failure this whole spec exists to avoid,
  // and Playwright reports it only as "element(s) not found". Surface the real
  // reason instead.
  page.removeAllListeners("console");
  page.removeAllListeners("pageerror");
  page.on("console", (message) => {
    if (message.type() === "error") console.warn(`[site-builder-shots] console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    console.warn(`[site-builder-shots] pageerror: ${error.message}`);
  });
  const url = `${baseURL}/site-builder-preview.html?theme=${theme}&fixture=${fixture}`;
  const frame = page.locator(FRAME).first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout });
  } catch {
    console.warn(`[site-builder-shots] first mount of ${fixture}/${theme} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout });
  }
  // Mounted is not styled: `flex` comes from a Tailwind utility, so its presence
  // proves the stylesheet landed.
  await expect(frame).toHaveCSS("display", "flex");
  // The strip is the one surface present in every state; its absence means the
  // builder never mounted, whatever else is on the page.
  await expect(page.locator(STRIP)).toBeAttached({ timeout });
  // A drive that threw leaves `data-ready` false forever; read its reason rather
  // than reporting a bare attribute mismatch 30 seconds later.
  try {
    await expect(frame).toHaveAttribute("data-ready", "true", { timeout });
  } catch (error) {
    const reason = await frame.getAttribute("data-failure");
    throw new Error(
      reason
        ? `fixture "${fixture}" never settled: ${reason}`
        : `fixture "${fixture}" never settled and reported no reason`,
      { cause: error }
    );
  }
  await expect(page.locator(fixtureFor(fixture).settled).first()).toBeVisible({ timeout });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return frame;
}

test("site builder — states, interactions and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SITEBUILDER is required for the site-builder capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SITEBUILDER=1 to run the capture");
  test.setTimeout(20 * 60_000);

  const written: string[] = [];

  // Every state, in the review themes: the whole frame (so the drawer is judged
  // against the page beside it) and the strip alone (where the density lives).
  for (const theme of THEMES) {
    for (const name of FIXTURE_NAMES) {
      const frame = await open(page, name, theme);
      written.push(await snap(frame, `${name}--${theme}.png`));
      written.push(await snap(page.locator(STRIP).first(), `${name}--${theme}--strip.png`));
      // The drawer is closed in several states by design; only shoot it when open.
      const drawer = page.locator(DRAWER).first();
      if ((await drawer.count()) > 0) {
        written.push(await snap(drawer, `${name}--${theme}--drawer.png`));
      }
    }
  }

  // Interaction states no fixture can hold, in the primary theme.
  const theme = THEMES[0]!;

  // The agent destination picker open: the composer's one menu, and the one
  // place the destination's own mark is seen beside every alternative.
  {
    await open(page, "element", theme);
    await page.getByRole("combobox", { name: "Agent to send to" }).click();
    await expect(page.getByRole("listbox").first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(200);
    written.push(await snapRegion(page, `element--${theme}--agent-picker.png`));
  }

  // Keyboard focus on the send action — the focus ring is a hard requirement and
  // it is invisible in every resting capture.
  {
    const frame = await open(page, "composing", theme);
    const send = page.getByRole("button", { name: "Send to agent" });
    await send.focus();
    await expect(send).toBeFocused();
    written.push(await snap(frame, `composing--${theme}--send-focused.png`));
  }

  // A narrow drawer on a short viewport: the width is capped at 360px, so the
  // test of the layout is height. `sent` is the densest state the drawer has —
  // identity, a delivery notice with two actions, the request record and the
  // composer — and it is where anything that pushes the composer out of reach
  // shows up first.
  {
    await open(page, "sent", theme);
    await page.setViewportSize({ width: 1100, height: 560 });
    await page.waitForTimeout(250);
    written.push(await snap(page.locator(FRAME).first(), `sent--${theme}--short.png`));
  }

  // One state across every built-in theme. Theme-specific collapse is real and
  // only a sweep finds it; the selected state is the one that carries the most
  // vocabulary at once (badge, breadcrumb, mono path, notice, composer, chips).
  if (SWEEP) {
    for (const sweepTheme of ALL_THEMES) {
      const frame = await open(page, "element", sweepTheme);
      written.push(await snap(frame, `sweep--element--${sweepTheme}.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURE_NAMES.length);
  console.log(`[site-builder-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
