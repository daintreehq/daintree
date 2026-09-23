/**
 * Assistant footer visual-review harness.
 *
 * The footer's busiest states (a turn-outcome alert beside a live tool call, a watch
 * chip, a diverged worktree) only occur mid-session and rarely together, so this drives
 * the footer's own preview entry (`assistant-footer-preview.html`) rather than booting
 * Electron: the real `HelpPanelFooter`, the theme's real tokens, the panel's real widths.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_ASSISTANTFOOTER is set.
 *
 *   DAINTREE_SHOT_ASSISTANTFOOTER=1 npx playwright test --project=screenshots assistant-footer-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ASSISTANTFOOTER  required: any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              output directory (default artifacts/assistant-footer-shots)
 *   DAINTREE_SHOT_THEMES           comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: `snap()` refuses a target with no real box,
 * and the test counts the files itself rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_ASSISTANTFOOTER;

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "assistant-footer-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry. */
const FIXTURES = [
  "rest",
  "rest-assistant",
  "in-flight",
  "settled-error",
  "outcome-loop",
  "outcome-stuck",
  "diverged",
  "busy",
  "busy-confirm",
] as const;

/** The states that pressure the row's width, captured again at the resizer minimum. */
const NARROW_FIXTURES = ["rest-assistant", "outcome-loop", "busy", "busy-confirm"] as const;

test.use({ deviceScaleFactor: 2 });

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // `strictPort: false` so the harness can run beside a live `npm run dev`.
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
 * Serve an inert `@vite/client`, so no page in this sweep opens an HMR socket. The full
 * story of why is on the same helper in `session-tabs-review.spec.ts`; the short version
 * is that repeated handshakes get throttled until the client's recovery path trips the
 * dev CSP and the page renders blank.
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

async function open(
  page: Page,
  fixture: string,
  theme: string,
  width: number
): Promise<{ panel: Locator; footer: Locator }> {
  await page.setViewportSize({ width: 800, height: 400 });
  const url = `${baseURL}/assistant-footer-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`;
  const panel = page.locator("[data-preview-panel]").first();
  const footer = page.locator("[data-preview-footer]").first();
  try {
    await page.goto(url);
    await expect(footer).toBeAttached({ timeout: 30_000 });
  } catch {
    console.warn(
      `[assistant-footer-shots] first mount of ${fixture}/${theme}@${width} failed; retrying once`
    );
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(footer).toBeAttached({ timeout: 30_000 });
  }
  // Mounted is not styled: `flex` comes from a Tailwind utility, so its presence
  // proves the stylesheet landed.
  await expect(panel).toHaveCSS("display", "flex");
  await page.evaluate(() => document.fonts.ready);
  // Past the activity strip's 400ms Doherty gate, so an in-flight fixture shows its
  // live row rather than the resting label, and well inside the 5s success decay.
  await page.waitForTimeout(700);
  return { panel, footer };
}

test("assistant footer — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ASSISTANTFOOTER is required for the footer capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ASSISTANTFOOTER=1 to run the capture");

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const name of FIXTURES) {
      const { footer } = await open(page, name, theme, DEFAULT_WIDTH);
      // A status row is one line by contract. A wrapped item is the defect this
      // harness was built to catch, so it fails the capture rather than photographing it.
      const height = (await footer.boundingBox())?.height ?? 0;
      written.push(await snap(footer, `${name}-${theme}-380.png`));
      expect.soft(height, `${name}/${theme}: footer wrapped (${height}px tall)`).toBeLessThan(40);
    }
  }

  const narrowTheme = THEMES[0]!;
  for (const name of NARROW_FIXTURES) {
    const { footer } = await open(page, name, narrowTheme, MIN_WIDTH);
    written.push(await snap(footer, `${name}-${narrowTheme}-320.png`));
  }

  // Keyboard focus on the first footer control, through a real Tab so :focus-visible fires.
  {
    const { panel } = await open(page, "busy", narrowTheme, DEFAULT_WIDTH);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    written.push(await snap(panel, `busy-${narrowTheme}-380-focus.png`));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[assistant-footer-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
