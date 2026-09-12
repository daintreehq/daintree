/**
 * Fleet ribbon visual-review harness.
 *
 * The ribbon's design questions live in states the real app only reaches mid-broadcast:
 * the centre row filling with a progress counter and Cancel, a supervised run being
 * watched, the inline destructive confirm that swaps the whole ribbon shell, a partial
 * failure banner stacked above it. Reaching those by hand means launching half a dozen
 * agents and catching a 400ms window. So this drives the surface's own preview entry
 * (`fleet-preview.html`) rather than booting Electron: the real `FleetArmingRibbon`,
 * `FleetDraftingPill` and `FleetPickerPalette`, seeded through the real Zustand stores,
 * against the real theme tokens.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_FLEET=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots fleet-ribbon-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FLEET    required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — output directory, outside the repo
 *   DAINTREE_SHOT_THEMES   comma-separated sweep (default: daintree,bondi,namib; `all` = every built-in)
 *
 * The first theme gets every fixture plus the pointer/keyboard states; the others get
 * the SWEEP subset, which is where theme-specific collapse shows up.
 *
 * Hard rule, inherited from the sibling harnesses: never write a PNG that has not been
 * verified. Every capture asserts its fixture's marker is really on screen first and
 * throws otherwise, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_FLEET;

const OUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";

const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const themesEnv = process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib";
const THEMES =
  themesEnv === "all"
    ? ALL_THEMES
    : themesEnv
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

const FRAME_WIDTH = 1100;
/** The narrowest a project window gets before the ribbon is a layout question. */
const NARROW_WIDTH = 640;

const RIBBON = '[data-testid="fleet-arming-ribbon"]';

/** Mirrors `FIXTURES` in the preview entry: name, marker to verify, what it proves. */
const FIXTURES: { name: string; marker: string; what: string; sweep?: boolean }[] = [
  { name: "armed-3", marker: RIBBON, what: "rest", sweep: true },
  {
    name: "armed-cross-worktree",
    marker: '[data-testid="fleet-worktree-dots"]',
    what: "dots + scope",
  },
  {
    name: "broadcast-running",
    marker: '[data-testid="fleet-broadcast-cancel"]',
    what: "progress + cancel",
    sweep: true,
  },
  {
    name: "broadcast-running-failed",
    marker: '[data-testid="fleet-broadcast-progress"]:has-text("failed")',
    what: "progress with a failure",
  },
  {
    name: "run-watching",
    marker: '[data-testid="fleet-run-status"]:has-text("working")',
    what: "run counts",
  },
  {
    name: "run-finished",
    marker: '[data-testid="fleet-run-status"]:has-text("Run finished")',
    what: "run summary",
  },
  {
    name: "run-failed",
    marker: '[data-testid="fleet-run-status"]:has-text("Run failed")',
    what: "run failed",
  },
  {
    name: "confirm-kill",
    marker: '[data-pending-action="kill"]',
    what: "inline confirm",
    sweep: true,
  },
  {
    name: "confirm-restart-loss",
    marker: '[data-pending-action="restart"]',
    what: "longest confirm message",
  },
  { name: "failure-banner", marker: '[role="alert"]', what: "failure banner", sweep: true },
  {
    name: "failure-banner-confirm",
    marker:
      '[data-testid="fleet-arming-ribbon-group"]:has([role="alert"]):has([data-pending-action="interrupt"])',
    what: "banner + confirm",
  },
  {
    name: "drafting-pill",
    marker: '[data-testid="fleet-drafting-pill-trigger"]',
    what: "pill closed",
  },
  {
    name: "drafting-pill-open",
    marker: '[data-testid="fleet-resolution-popover"]',
    what: "resolution popover",
    sweep: true,
  },
  {
    name: "picker-palette",
    marker: '[data-testid="fleet-picker-cold-start-root"]',
    what: "cold-start palette",
    sweep: true,
  },
];

let server: ViteDevServer | undefined;
let baseURL = "";

// Every PNG goes through `snap()`; Playwright's own failure screenshot would be an
// unverified artifact in test-results, so it is off for this spec.
test.use({ deviceScaleFactor: 2, screenshot: "off" });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR) throw new Error("DAINTREE_SHOT_DIR must be set to a directory outside the repo");
  // The directory is the harness's to clear, so it must not be the checkout, a
  // parent of it, or anything inside it — and even then only its PNGs go.
  const repo = path.resolve(process.cwd());
  if (
    OUT_DIR === path.parse(OUT_DIR).root ||
    repo === OUT_DIR ||
    repo.startsWith(OUT_DIR + path.sep)
  ) {
    throw new Error(`DAINTREE_SHOT_DIR (${OUT_DIR}) contains the checkout — refusing`);
  }
  if (OUT_DIR.startsWith(repo + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR (${OUT_DIR}) is inside the checkout — refusing`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  // Fresh per run: a leftover PNG from an earlier round read as this round's
  // output is the easiest way to review a screen that no longer exists.
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith(".png")) rmSync(path.join(OUT_DIR, f), { force: true });
  }

  // Walk to a free port: `vite.config.ts` pins 5173 with `strictPort`, and a dev server
  // already on it would otherwise read as a render failure in the surface under review.
  // A worktree's `node_modules` is a symlink into the main checkout, and Vite refuses to
  // serve the font files behind it unless the real path is allowed — the kbd chips would
  // then render in the fallback face and every type judgement on them would be wrong.
  const nodeModules = realpathSync(path.join(process.cwd(), "node_modules"));
  server = await createServer({
    server: { port: 0, strictPort: false, fs: { allow: [process.cwd(), nodeModules] } },
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
 * Serve an inert `@vite/client` so no page opens an HMR socket. Chromium throttles
 * repeated WebSocket handshakes to one host and the client's recovery path constructs a
 * `SharedWorker` the dev CSP refuses, after which every page mounts blank. Identical to
 * the session-tabs harness, including the live `updateStyle` — a no-op there renders the
 * whole page unstyled while every "is it mounted" check still passes.
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

/**
 * Write one PNG of the frame's region, having proved the fixture's marker is really on
 * screen. A page clip rather than an element screenshot so portaled popovers and menus
 * — which live under `<body>`, outside the frame — land in the picture.
 */
async function snap(page: Page, frame: Locator, marker: Locator, file: string): Promise<string> {
  await expect(marker, `${file}: marker not visible — refusing to write`).toBeVisible();
  const box = await frame.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: frame has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: box });
  return out;
}

async function open(
  page: Page,
  fixture: string,
  theme: string,
  width: number
): Promise<{ frame: Locator }> {
  await page.setViewportSize({ width: Math.max(width, 800), height: 680 });
  const url = `${baseURL}/fleet-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`;
  const frame = page.locator("[data-preview-frame]").first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout });
  } catch {
    console.warn(`[fleet-shots] first mount of ${fixture}/${theme}@${width} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout });
  }
  // Mounted is not styled: `flex` here is a Tailwind utility, so its presence proves
  // the stylesheet landed rather than photographing raw HTML.
  await expect(frame).toHaveCSS("display", "flex");
  await page.evaluate(() => document.fonts.ready);
  // Entrance spring (~200ms) plus the 400ms Doherty gate the progress counter sits
  // behind — `useDeferredLoading` deliberately hides it for the first 400ms.
  await page.waitForTimeout(700);
  return { frame };
}

test("fleet ribbon — states, interactions and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FLEET is required for the fleet ribbon capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FLEET=1 to run the capture");

  await stubViteHmrClient(page);

  const written: string[] = [];

  for (const [index, theme] of THEMES.entries()) {
    const fixtures = index === 0 ? FIXTURES : FIXTURES.filter((f) => f.sweep);
    for (const { name, marker } of fixtures) {
      const { frame } = await open(page, name, theme, FRAME_WIDTH);
      written.push(await snap(page, frame, page.locator(marker).first(), `${name}--${theme}.png`));
    }
  }

  const primary = THEMES[0]!;

  // Width pressure: the two states whose centre row is fullest, at the narrowest a
  // project window gets. A layout question, so the default theme only.
  for (const name of ["run-watching", "confirm-restart-loss"]) {
    const { frame } = await open(page, name, primary, NARROW_WIDTH);
    const marker = FIXTURES.find((f) => f.name === name)!.marker;
    written.push(
      await snap(page, frame, page.locator(marker).first(), `${name}--${primary}--narrow.png`)
    );
  }

  // Pointer and keyboard states no fixture can express.
  {
    // The armed list popover, then its add-panes mode.
    const { frame } = await open(page, "armed-cross-worktree", primary, FRAME_WIDTH);
    await page.getByTestId("fleet-armed-count-chip").click();
    await page.waitForTimeout(300);
    written.push(
      await snap(page, frame, page.getByTestId("fleet-armed-list"), `chip-popover--${primary}.png`)
    );
    await page.getByTestId("fleet-armed-list-add-panes").click();
    await page.waitForTimeout(300);
    written.push(
      await snap(
        page,
        frame,
        page.getByTestId("fleet-picker-add-root"),
        `chip-picker--${primary}.png`
      )
    );
  }
  {
    // The selection menu with saved fleets and the inline save form.
    const { frame } = await open(page, "armed-3", primary, FRAME_WIDTH);
    await page.getByTestId("fleet-selection-menu-trigger").click();
    await page.waitForTimeout(300);
    written.push(
      await snap(page, frame, page.getByTestId("fleet-save-form"), `selection-menu--${primary}.png`)
    );
  }
  {
    // The Exit button holding a real focus ring, reached through Tab presses so the
    // `:focus-visible` heuristic fires — programmatic focus paints nothing.
    const { frame } = await open(page, "armed-3", primary, FRAME_WIDTH);
    await page.mouse.move(0, 0);
    let reached = false;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") === "fleet-exit"
      );
    }
    if (!reached) throw new Error("focus never reached the Exit button — refusing to write");
    await page.waitForTimeout(250);
    written.push(
      await snap(page, frame, page.getByTestId("fleet-exit"), `exit-focus--${primary}.png`)
    );
  }
  {
    // The count chip under the pointer — its only disclosure cue is a hover fill.
    const { frame } = await open(page, "armed-3", primary, FRAME_WIDTH);
    await page.getByTestId("fleet-armed-count-chip").hover();
    await page.waitForTimeout(250);
    written.push(
      await snap(
        page,
        frame,
        page.getByTestId("fleet-armed-count-chip"),
        `chip-hover--${primary}.png`
      )
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  const sweepCount = FIXTURES.filter((f) => f.sweep).length;
  expect(onDisk.length).toBeGreaterThanOrEqual(
    FIXTURES.length + (THEMES.length - 1) * sweepCount + 2 + 5
  );
  console.log(`[fleet-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
