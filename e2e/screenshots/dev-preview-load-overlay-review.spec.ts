/**
 * Dev preview load-overlay visual-review harness (#16646).
 *
 * The dev preview covers its webview with a pane-filling overlay whenever a
 * load doesn't complete. Two very different causes land there: the user
 * stopping the load (the loading overlay's Cancel, or the toolbar's Stop), and
 * a load that genuinely failed. The question is whether the two read apart, in
 * pixels, in every theme, and beside the Browser panel's own cancelled state.
 *
 * Driven through the real seams:
 *   - A configured dev server (`node dev-server.cjs` in the fixture repo) runs
 *     behind the panel's proxy, as a real project's would.
 *   - Cancel and Stop are real clicks on a real load that never finishes: the
 *     dev server holds `/hang` open, so the webview stays loading.
 *   - Failures are the webview's own `did-fail-load` event, dispatched on the
 *     `<webview>` element with the payload Chromium sends, so the real
 *     classifier in `useDevPreviewLoadLifecycle` picks the code and copy.
 *
 * States:
 *   loading            the loading overlay once its Cancel is offered
 *   cancelled          after the overlay's Cancel, every theme
 *   cancelled-stop     after the toolbar's Stop
 *   cert               certificate failure (-202), every theme
 *   timeout            connection timed out (-118)
 *   dns                address didn't resolve (-105)
 *   forced-*           cancelled and cert under forced-colors: active
 *   narrow-cancelled   cancelled in a narrow window
 *   browser-cancelled  the Browser panel's cancelled state, for comparison
 *
 * Opt-in only; skips unless DAINTREE_SHOT_DEVPREVIEW_LOAD is set:
 *
 *   DAINTREE_SHOT_DEVPREVIEW_LOAD=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots dev-preview-load-overlay-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DEVPREVIEW_LOAD  required
 *   DESIGN_CAPTURE_DIR             required, outside the repo
 *   DAINTREE_SHOT_THEMES           comma list for the theme sweep (default: all)
 */

import { test, expect, type Page, type Locator, type ElectronApplication } from "@playwright/test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { Socket } from "net";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { openBrowser, openDevPreview } from "../helpers/panels";
import { setAppTheme } from "../helpers/theme";
import { saveCurrentProjectSettings } from "../helpers/projectSettings";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_DEVPREVIEW_LOAD;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const ALL_THEMES = [
  "daintree",
  "arashiyama",
  "fiordland",
  "galapagos",
  "highlands",
  "movile",
  "namib",
  "redwoods",
  "atacama",
  "bali",
  "bondi",
  "hokkaido",
  "serengeti",
  "svalbard",
  "table-mountain",
];
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ALL_THEMES.join(","))
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const DEFAULT_THEME = "daintree";
const LIGHT_THEME = "bondi";
const WIDE = { width: 1280, height: 820 };
// The window's own minimum width.
const NARROW = { width: 800, height: 820 };
const PROJECT = "storefront";
const POLISH_ID = "pw-load-overlay-polish";
const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

// Matches the overlay's cancelled copy whichever words a round settles on.
const CANCELLED_RE = /cancel|stopp/i;

const GUEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Storefront</title><style>
  body { margin:0; font: 14px/1.5 system-ui, sans-serif; background:#f6f7f9; color:#1c1e21; }
  header { padding:14px 20px; background:#fff; border-bottom:1px solid #e3e5e8; font-weight:600; }
  main { padding:20px; display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; }
  .card { height:120px; background:#fff; border:1px solid #e4e6ea; border-radius:8px; }
</style></head><body><header>Storefront — products</header>
<main><div class="card"></div><div class="card"></div><div class="card"></div>
<div class="card"></div><div class="card"></div><div class="card"></div></main></body></html>`;

// Binds the PORT the session injects, prints the URL the session watches for,
// serves the storefront page, and never answers /hang.
const DEV_SERVER_SCRIPT = `
const http = require('http');
const port = parseInt(process.env.PORT || '0', 10);
const page = ${JSON.stringify(GUEST_PAGE)};
const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/hang')) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});
server.listen(port, '127.0.0.1', () => {
  console.log('http://localhost:' + server.address().port);
});
`;

// The Browser panel's comparison load hangs on this server.
let server: Server;
let serverPort = 0;
const heldSockets = new Set<Socket>();

function handle(req: IncomingMessage, res: ServerResponse) {
  const route = (req.url ?? "/").split("?")[0];
  if (route.startsWith("/hang")) {
    // Never answer: the webview stays loading until it is stopped.
    heldSockets.add(req.socket);
    req.socket.once("close", () => heldSockets.delete(req.socket));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(GUEST_PAGE);
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function polish(page: Page): Promise<void> {
  await page.evaluate(
    ({ id, css }) => {
      document.getElementById(id)?.remove();
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.appendChild(style);
    },
    { id: POLISH_ID, css: POLISH_CSS }
  );
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(2, 400);
}

async function setWindowSize(
  app: ElectronApplication,
  page: Page,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height);
  }, size);
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: T_LONG })
    .toBe(size.width);
  await settle(page, 600);
}

async function switchTheme(page: Page, theme: string): Promise<void> {
  const current = await page.locator("html").getAttribute("data-theme");
  if (current === theme) return;
  await page.evaluate(async (id) => {
    await window.electron.appTheme.setColorScheme(id);
  }, theme);
  const live = await expect
    .poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 8000 })
    .toBe(theme)
    .then(() => true)
    .catch(() => false);
  if (!live) {
    // A reload drops the overlay; the state check after the settle catches that.
    await setAppTheme(page, theme);
    await dismissBlockingPalette(page);
  }
  await polish(page);
  await settle(page, 700);
}

const pane = (page: Page, id: string): Locator => page.locator(`[data-panel-id="${id}"]`);

/** The load-error overlay: the pane-filling frame holding a role=status or role=alert region. */
function loadOverlay(page: Page, panelId: string): Locator {
  return pane(page, panelId)
    .locator("div.absolute.inset-0")
    .filter({ has: page.locator('[role="status"], [role="alert"]') })
    .filter({ hasNotText: /Loading preview|Loading page/ });
}

async function snap(page: Page, name: string, target: Locator, verify: () => Promise<void>) {
  await parkPointer(page);
  await settle(page);
  // Verify after the settle, at the moment of capture: never write a frame of the wrong state.
  await verify();
  await target.screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`), type: "png" });
}

async function navigate(page: Page, panelId: string, url: string): Promise<void> {
  const bar = pane(page, panelId).locator(SEL.browser.addressBar);
  await bar.click();
  await bar.fill(url);
  await page.keyboard.press("Enter");
}

let devPreviewOrigin = "";

async function startHangingLoad(page: Page, panelId: string, tag: string): Promise<void> {
  const stop = pane(page, panelId).locator('[aria-label="Stop loading"]');
  await navigate(page, panelId, `${devPreviewOrigin}/hang/${tag}`);
  const started = await stop
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  // An Enter the address bar's suggestions swallowed leaves the typed URL
  // committed but unloaded; the toolbar's Reload requests it.
  if (!started) await pane(page, panelId).locator('[aria-label="Reload"]').click();
  await expect(stop).toBeVisible({ timeout: T_LONG });
}

async function cancelFromOverlay(page: Page, panelId: string): Promise<void> {
  const cancel = pane(page, panelId).getByRole("button", { name: /^cancel/i });
  await cancel.waitFor({ state: "visible", timeout: 20_000 });
  await cancel.click();
  await expect(loadOverlay(page, panelId)).toContainText(CANCELLED_RE, { timeout: T_MEDIUM });
}

async function stopFromToolbar(page: Page, panelId: string): Promise<void> {
  await pane(page, panelId).locator('[aria-label="Stop loading"]').click();
  await expect(loadOverlay(page, panelId)).toContainText(CANCELLED_RE, { timeout: T_MEDIUM });
}

/** Stop whatever load is in flight, or start one and stop it, ending on the cancelled overlay. */
async function ensureCancelled(page: Page, panelId: string, tag: string): Promise<void> {
  const stop = pane(page, panelId).locator('[aria-label="Stop loading"]');
  if (!(await stop.isVisible().catch(() => false))) await startHangingLoad(page, panelId, tag);
  await stopFromToolbar(page, panelId);
}

async function failLoad(
  page: Page,
  panelId: string,
  errorCode: number,
  errorDescription: string,
  validatedURL: string
): Promise<void> {
  await pane(page, panelId)
    .locator("webview")
    .evaluate(
      (wv, payload) => {
        const event = new Event("did-fail-load");
        Object.assign(event, payload, { isMainFrame: true });
        wv.dispatchEvent(event);
      },
      { errorCode, errorDescription, validatedURL }
    );
}

const expectOverlay = (page: Page, panelId: string, text: RegExp) => async () => {
  await expect(loadOverlay(page, panelId)).toContainText(text, { timeout: T_MEDIUM });
};

function expectedFiles(): string[] {
  const out = [
    "loading--daintree",
    "cancelled-stop--daintree",
    "timeout--daintree",
    `timeout--${LIGHT_THEME}`,
    "dns--daintree",
    "forced-cancelled",
    "forced-cert",
    "narrow-cancelled--daintree",
    "browser-cancelled--daintree",
  ];
  for (const theme of THEMES) out.push(`cancelled--${theme}`, `cert--${theme}`);
  return out.map((f) => `${f}.png`).sort();
}

test.describe("dev preview load overlay review", () => {
  test.setTimeout(20 * 60_000);

  test("captures cancelled and failed load overlays", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_DEVPREVIEW_LOAD is required for this capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_DEVPREVIEW_LOAD=1 to run the load overlay capture");
    if (!OUTPUT_DIR)
      throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const repoRoot = realpathSync(process.cwd());
    const outReal = realpathSync(OUTPUT_DIR);
    if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
      throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUTPUT_DIR})`);
    }
    const expected = expectedFiles();
    for (const file of readdirSync(OUTPUT_DIR)) {
      if (expected.includes(file)) rmSync(path.join(OUTPUT_DIR, file), { force: true });
    }

    server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    serverPort = typeof addr === "object" && addr ? addr.port : 0;

    const repo = createFixtureRepo({ name: "storefront" });
    writeFileSync(path.join(repo.dir, "dev-server.cjs"), DEV_SERVER_SCRIPT);
    let ctx: AppContext | undefined;
    try {
      ctx = await launchApp({ windowSize: WIDE, screenshotScale: "2" });
      const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT);
      await dismissBlockingPalette(page);
      await setWindowSize(ctx.app, page, WIDE);
      await polish(page);

      await saveCurrentProjectSettings(page, { devServerCommand: "node dev-server.cjs" });
      await openDevPreview(page);
      const bar = page.locator(SEL.browser.addressBar).first();
      await bar.waitFor({ state: "visible", timeout: T_LONG });
      const panelId = await bar.evaluate(
        (el) => el.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? ""
      );
      if (!panelId) throw new Error("dev preview panel id not found");
      const dp = pane(page, panelId);

      // The dev server's page first, so the webview has something to cover.
      await expect(dp.locator("webview")).toBeAttached({ timeout: 60_000 });
      await expect(bar).toHaveValue(/localhost:\d+/, { timeout: 60_000 });
      await expect(dp.locator('[aria-label="Reload"]')).toBeVisible({ timeout: T_LONG });
      const shown = await bar.inputValue();
      devPreviewOrigin = new URL(shown.includes("://") ? shown : `http://${shown}`).origin;

      // Loading, then the overlay's Cancel.
      await startHangingLoad(page, panelId, "a");
      await dp.getByRole("button", { name: /^cancel/i }).waitFor({
        state: "visible",
        timeout: 20_000,
      });
      await snap(page, "loading--daintree", dp, async () => {
        await expect(dp.getByRole("button", { name: /^cancel/i })).toBeVisible();
      });
      await cancelFromOverlay(page, panelId);
      await snap(page, "cancelled--daintree", dp, expectOverlay(page, panelId, CANCELLED_RE));

      // The toolbar's Stop.
      await startHangingLoad(page, panelId, "b");
      await stopFromToolbar(page, panelId);
      await snap(page, "cancelled-stop--daintree", dp, expectOverlay(page, panelId, CANCELLED_RE));

      // Real failures, through the webview's own did-fail-load.
      await failLoad(page, panelId, -202, "ERR_CERT_AUTHORITY_INVALID", "https://localhost:5173/");
      await snap(page, "cert--daintree", dp, expectOverlay(page, panelId, /certificate/i));
      await failLoad(page, panelId, -118, "ERR_CONNECTION_TIMED_OUT", "http://localhost:5173/");
      await snap(page, "timeout--daintree", dp, expectOverlay(page, panelId, /timed out/i));
      await failLoad(
        page,
        panelId,
        -105,
        "ERR_NAME_NOT_RESOLVED",
        "http://storefront.internal:3000/"
      );
      await snap(page, "dns--daintree", dp, expectOverlay(page, panelId, /resolve/i));

      // Narrow: how the copy and actions wrap.
      await setWindowSize(ctx.app, page, NARROW);
      await ensureCancelled(page, panelId, "d");
      await snap(
        page,
        "narrow-cancelled--daintree",
        dp,
        expectOverlay(page, panelId, CANCELLED_RE)
      );
      await setWindowSize(ctx.app, page, WIDE);

      // A theme switch re-navigates the guest and drops the overlay, so each
      // theme drives its states again.
      for (const theme of THEMES) {
        if (theme === DEFAULT_THEME) continue;
        await switchTheme(page, theme);
        await settle(page, 600);
        await ensureCancelled(page, panelId, `t-${theme}`);
        await snap(page, `cancelled--${theme}`, dp, expectOverlay(page, panelId, CANCELLED_RE));
        await failLoad(
          page,
          panelId,
          -202,
          "ERR_CERT_AUTHORITY_INVALID",
          "https://localhost:5173/"
        );
        await snap(page, `cert--${theme}`, dp, expectOverlay(page, panelId, /certificate/i));
        if (theme === LIGHT_THEME) {
          await failLoad(page, panelId, -118, "ERR_CONNECTION_TIMED_OUT", "http://localhost:5173/");
          await snap(page, `timeout--${theme}`, dp, expectOverlay(page, panelId, /timed out/i));
        }
      }
      await switchTheme(page, DEFAULT_THEME);
      await settle(page, 600);

      // Forced colours: colour drops out, so only the glyph and the words tell them apart.
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 500);
      await ensureCancelled(page, panelId, "c");
      await snap(page, "forced-cancelled", dp, expectOverlay(page, panelId, CANCELLED_RE));
      await failLoad(page, panelId, -202, "ERR_CERT_AUTHORITY_INVALID", "https://localhost:5173/");
      await snap(page, "forced-cert", dp, expectOverlay(page, panelId, /certificate/i));
      await page.emulateMedia({ forcedColors: "none" });
      await settle(page, 500);

      // The Browser panel's cancelled state, for comparison.
      await openBrowser(page);
      const bars = page.locator(SEL.browser.addressBar);
      await expect(bars).toHaveCount(2, { timeout: T_LONG });
      const browserId = await bars
        .nth(1)
        .evaluate((el) => el.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? "");
      const otherId =
        browserId === panelId
          ? await bars
              .nth(0)
              .evaluate((el) => el.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? "")
          : browserId;
      if (!otherId || otherId === panelId) throw new Error("browser panel id not found");
      await navigate(page, otherId, `http://127.0.0.1:${serverPort}/hang/browser`);
      const allow = pane(page, otherId).getByRole("button", { name: "Allow" });
      if (await allow.isVisible().catch(() => false)) await allow.click();
      await expect(pane(page, otherId).locator('[aria-label="Stop loading"]')).toBeVisible({
        timeout: T_LONG,
      });
      await pane(page, otherId).locator('[aria-label="Stop loading"]').click();
      await snap(
        page,
        "browser-cancelled--daintree",
        pane(page, otherId),
        expectOverlay(page, otherId, CANCELLED_RE)
      );
    } finally {
      for (const socket of heldSockets) socket.destroy();
      server?.close();
      if (ctx?.app) await closeApp(ctx.app);
      repo.cleanup();
    }

    const present = readdirSync(OUTPUT_DIR)
      .filter((f) => expected.includes(f))
      .sort();
    const missing = expected.filter((f) => !present.includes(f));
    console.log(
      `[dev-preview-load] wrote ${present.length}/${expected.length} PNGs to ${OUTPUT_DIR}`
    );
    expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
  });
});
