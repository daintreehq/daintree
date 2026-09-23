/**
 * Error-boundary fallback visual-review harness.
 *
 * The crash screen is the one surface people only see when something has
 * already gone wrong, so it is the one nobody opens on purpose. This drives the
 * crash-screen preview entry (`crash-screen-preview.html`), which throws through
 * the real `ErrorBoundary` at the fullscreen, section and component variants,
 * plus the worktree-card and plugin-view siblings, at the sizes the app gives
 * them. The throw lives in a Vite preview entry that is never part of the app
 * build, so it cannot reach users.
 *
 * The server defines `import.meta.env.DEV` as false, because production is what
 * users see: the calm copy, the Error ID and the scrubbed stack are all
 * production-only. Set DAINTREE_SHOT_CRASH_DEV=1 to capture the developer
 * rendering (raw message, raw stack) instead.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_CRASH=1 npx playwright test --project=screenshots crash-screen-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CRASH      required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        output directory (default artifacts/crash-screen-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi,namib)
 *   DAINTREE_SHOT_CRASH_DEV  capture the development rendering
 *
 * Output, per theme: `<state>-<theme>.png`.
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the target has a real box, each state asserts its
 * fallback actually rendered, and the test counts the files itself.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_CRASH;
const DEV_RENDERING = !!process.env.DAINTREE_SHOT_CRASH_DEV;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "crash-screen-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;

interface State {
  name: string;
  fixture: string;
  viewport: { width: number; height: number };
  /** Selector every capture of this state must find before it is written. */
  marker: string;
  /** How many of `marker` must be on screen. */
  count?: number;
  drive?: (page: Page) => Promise<void>;
}

const FALLBACK = '[data-testid="error-fallback"]';

async function expandDetails(page: Page) {
  const summary = page.locator(`${FALLBACK} summary`).first();
  await summary.click();
  await expect(page.locator(`${FALLBACK} details[open]`).first()).toBeAttached();
}

const STATES: State[] = [
  {
    name: "fullscreen",
    fixture: "fullscreen",
    viewport: { width: 1280, height: 800 },
    marker: `${FALLBACK}[data-variant="fullscreen"]`,
  },
  {
    name: "fullscreen-details",
    fixture: "fullscreen",
    viewport: { width: 1280, height: 800 },
    marker: `${FALLBACK}[data-variant="fullscreen"]`,
    drive: expandDetails,
  },
  {
    // A copied Error ID is the one piece of feedback the screen gives back.
    name: "fullscreen-copied",
    fixture: "fullscreen",
    viewport: { width: 1280, height: 800 },
    marker: `${FALLBACK}[data-variant="fullscreen"]`,
    drive: async (page) => {
      const copy = page.locator('[data-testid="error-fallback-copy-id"]');
      await copy.click();
      await expect(copy).toContainText(/Copied/);
    },
  },
  {
    // Small windows are real: a split-screen laptop window, or 200% zoom.
    name: "fullscreen-narrow",
    fixture: "fullscreen",
    viewport: { width: 560, height: 640 },
    marker: `${FALLBACK}[data-variant="fullscreen"]`,
    drive: expandDetails,
  },
  {
    name: "section-main",
    fixture: "section-main",
    viewport: { width: 1280, height: 800 },
    marker: `${FALLBACK}[data-variant="section"]`,
  },
  {
    name: "section-main-details",
    fixture: "section-main",
    viewport: { width: 1280, height: 800 },
    marker: `${FALLBACK}[data-variant="section"]`,
    drive: expandDetails,
  },
  {
    name: "section-sidebar",
    fixture: "section-sidebar",
    viewport: { width: 1280, height: 800 },
    marker: `${FALLBACK}[data-variant="section"]`,
  },
  {
    name: "component-panel",
    fixture: "component-panel",
    viewport: { width: 980, height: 460 },
    marker: `${FALLBACK}[data-variant="component"]`,
    count: 2,
  },
  {
    name: "worktree-card",
    fixture: "worktree-card",
    viewport: { width: 420, height: 320 },
    marker: "button",
  },
  {
    name: "plugin-installed",
    fixture: "plugin-installed",
    viewport: { width: 680, height: 560 },
    marker: '[data-testid="plugin-view-diagnostics"]',
  },
  {
    name: "plugin-dev",
    fixture: "plugin-dev",
    viewport: { width: 680, height: 560 },
    marker: '[data-testid="plugin-view-diagnostics"]',
  },
];

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook. The
  // test body carries the skip; this hook does no work when the flag is unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  server = await createServer({
    // A worktree's node_modules is often a symlink into the main checkout, and
    // Vite refuses to serve fonts from outside its allow list — the stack and
    // Error ID would then render in a fallback face that is not the app's.
    server: {
      port: 0,
      strictPort: false,
      fs: { allow: [process.cwd(), realpathSync(path.join(process.cwd(), "node_modules"))] },
    },
    logLevel: "warn",
    define: DEV_RENDERING ? {} : { "import.meta.env.DEV": "false" },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
  await server.warmupRequest("/src/components/ErrorBoundary/__preview__/preview.tsx");
});

test.afterAll(async () => {
  await server?.close();
});

/**
 * Vite discovers dependencies as it transforms, and a discovery mid-run
 * re-bundles and force-reloads every open page. Hold a throwaway page open until
 * the optimizer stops reloading it.
 */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${baseURL}/crash-screen-preview.html?fixture=plugin-dev`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
}

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
 * Every capture gets its own page, and a renderer the OS kills under load gets
 * one more go. Uncaught page errors fail the capture: the throws this page
 * stages are caught by boundaries, so anything reaching `pageerror` escaped one.
 */
async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[crash-screen-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      if (crashed) throw new Error(`${what}: renderer crashed twice`, { cause: error });
      const html = await page.content().catch(() => "<unavailable>");
      throw new Error(`${what}: ${String(error)}\n  html: ${html.slice(0, 400)}`, {
        cause: error,
      });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function capture(page: Page, state: State, theme: string): Promise<string> {
  await page.setViewportSize(state.viewport);
  await page.goto(`${baseURL}/crash-screen-preview.html?theme=${theme}&fixture=${state.fixture}`);
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  const markers = page.locator(state.marker);
  // A fixture whose boundary never caught would show the decoration alone —
  // a picture of an empty frame dressed up as a passing run.
  await expect(markers, `${state.name}: fallback did not render`).toHaveCount(state.count ?? 1);
  await state.drive?.(page);
  await page.waitForTimeout(250);
  // Re-check after the settle, not before it.
  await expect(markers.first()).toBeVisible();
  return snap(page.locator("body"), `${state.name}-${theme}.png`);
}

test("crash screen family — every variant, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CRASH is required for the crash-screen capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_CRASH=1 to run the capture");
  test.setTimeout(10 * 60_000);

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, (page) => capture(page, state, theme))
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length);
  console.log(`[crash-screen-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
