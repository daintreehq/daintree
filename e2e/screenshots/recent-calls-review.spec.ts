/**
 * Recent tool calls popover visual-review harness.
 *
 * The popover's interesting states (an error beside a success in one turn, a rate limit,
 * a gate outcome with no output, a call outside any turn) need a live assistant session to
 * line up, so this drives the popover's own preview entry (`recent-calls-preview.html`):
 * the real `McpActivityStrip` and `RecentCallsPopover`, fed through the strip's one bridge
 * read, against the theme's real tokens at the panel's real widths.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_RECENTCALLS is set.
 *
 *   DAINTREE_SHOT_RECENTCALLS=1 npx playwright test --project=screenshots recent-calls-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RECENTCALLS  required: any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/recent-calls-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: `snap()` refuses a target with no real box, every
 * state asserts the content it is meant to show before it is photographed, and the test
 * counts the files itself rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_RECENTCALLS;

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "recent-calls-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await createServer({
    // `fs.strict: false` because a worktree's `node_modules` is often a symlink out of
    // the tree, and a strict server then refuses the fonts and captures fallback type.
    server: { port: 0, strictPort: false, fs: { strict: false } },
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
): Promise<{ panel: Locator; content: Locator }> {
  await page.setViewportSize({ width: width + 40, height: 600 });
  const url = `${baseURL}/recent-calls-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`;
  const panel = page.locator("[data-preview-panel]").first();
  const trigger = page.getByRole("button", { name: "Recent tool calls" });
  try {
    await page.goto(url);
    await expect(trigger).toBeVisible({ timeout: 30_000 });
  } catch {
    console.warn(
      `[recent-calls-shots] first mount of ${fixture}/${theme}@${width} failed; retrying`
    );
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
  }
  await expect(panel).toHaveCSS("display", "flex");
  await page.evaluate(() => document.fonts.ready);
  await trigger.click();
  const content = page.locator("[data-radix-popper-content-wrapper]").first();
  await expect(content).toBeVisible({ timeout: 10_000 });
  await page.mouse.move(0, 0);
  // Past the popover's 200ms entry motion.
  await page.waitForTimeout(400);
  return { panel, content };
}

async function expand(content: Locator, toolId: string): Promise<void> {
  const row = content
    .getByRole("button", { name: new RegExp(toolId.replace(/\./g, "\\.")) })
    .first();
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

test("recent tool calls popover — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RECENTCALLS is required for the popover capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_RECENTCALLS=1 to run the capture");

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const theme of THEMES) {
    {
      const { panel, content } = await open(page, "populated", theme, DEFAULT_WIDTH);
      await expect(content.getByText("terminal.sendCommand")).toBeVisible();
      await page.mouse.move(0, 0);
      written.push(await snap(panel, `populated-${theme}.png`));

      await expand(content, "terminal.sendCommand");
      await page.mouse.move(0, 0);
      written.push(await snap(panel, `expanded-error-${theme}.png`));
    }
    {
      const { panel, content } = await open(page, "populated", theme, DEFAULT_WIDTH);
      await expand(content, "worktree.list");
      await page.mouse.move(0, 0);
      written.push(await snap(panel, `expanded-success-${theme}.png`));
    }
    {
      const { panel, content } = await open(page, "populated", theme, DEFAULT_WIDTH);
      await expand(content, "git.push");
      await expand(content, "github.listIssues");
      await page.mouse.move(0, 0);
      written.push(await snap(panel, `expanded-gates-${theme}.png`));
    }
    {
      const { panel, content } = await open(page, "long", theme, DEFAULT_WIDTH);
      await expand(content, "worktree.createFromBranch");
      await page.mouse.move(0, 0);
      written.push(await snap(panel, `long-expanded-${theme}.png`));
    }
    for (const name of ["empty", "error"] as const) {
      const { panel, content } = await open(page, name, theme, DEFAULT_WIDTH);
      await expect(
        content.getByText(name === "empty" ? /show up here/i : /couldn't load/i)
      ).toBeVisible();
      written.push(await snap(panel, `${name}-${theme}.png`));
    }
    {
      const { panel, content } = await open(page, "loading", theme, DEFAULT_WIDTH);
      await expect(content.getByRole("status")).toBeAttached();
      // Past the skeleton's delayed-pulse onset so the bones are painted.
      await page.waitForTimeout(900);
      written.push(await snap(panel, `loading-${theme}.png`));
    }
  }

  const narrowTheme = THEMES[0]!;
  {
    const { panel, content } = await open(page, "long", narrowTheme, MIN_WIDTH);
    await expect(content.getByText(/worktree\.createFromBranch/)).toBeVisible();
    written.push(await snap(panel, `long-${narrowTheme}-320.png`));
  }

  // Keyboard: the trigger opened from the keyboard, then one Tab, through real key
  // presses so :focus-visible fires wherever focus actually lands.
  {
    await page.setViewportSize({ width: DEFAULT_WIDTH + 40, height: 600 });
    await page.goto(
      `${baseURL}/recent-calls-preview.html?theme=${narrowTheme}&fixture=populated&width=${DEFAULT_WIDTH}`
    );
    const panel = page.locator("[data-preview-panel]").first();
    const trigger = page.getByRole("button", { name: "Recent tool calls" });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-radix-popper-content-wrapper]").first()).toBeVisible();
    await page.waitForTimeout(400);
    written.push(await snap(panel, `keyboard-open-${narrowTheme}.png`));
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    written.push(await snap(panel, `keyboard-tab-${narrowTheme}.png`));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 8 + 3);
  console.log(`[recent-calls-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
