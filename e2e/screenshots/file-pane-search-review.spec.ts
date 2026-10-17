/**
 * File pane picker visual-review harness.
 *
 * A File panel with no file shows an "Open a file" empty state with a search
 * field and a result list over the project's files. Reaching its states in the
 * app means a project, a file panel opened empty, and a search that fails on
 * demand. This drives its preview entry (`file-pane-search-preview.html`)
 * instead: the real `FilePane` with no `filePath`, `files:search` answered from
 * a fixture repository, under the real theme tokens.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_FILEPICKER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots file-pane-search-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FILEPICKER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES      themes for the populated-query sweep
 *                             (default daintree,bondi,namib,redwoods,svalbard,atacama,hokkaido,serengeti)
 *
 * Never writes a PNG it has not verified: every capture waits for the shimmed
 * search to answer the query it names, then for the list to hold exactly the
 * rows that answer produced, and the test counts the files itself. A JSON
 * sidecar per capture records the active row, the focused element and any open
 * tooltip.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";
import { MANY_FILES, searchFixture } from "../../src/panels/file/__preview__/fixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_FILEPICKER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ??
  "daintree,bondi,namib,redwoods,svalbard,atacama,hokkaido,serengeti"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** The picker lists at most this many rows, whatever the search returns. */
const ROW_CAP = 50;

test.use({ deviceScaleFactor: 2, viewport: { width: 640, height: 600 } });

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
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png") || file.endsWith(".json")) {
      rmSync(path.join(OUT_DIR, file), { force: true });
    }
  }
  // A worktree symlinks node_modules out of the project root, and Vite refuses
  // to serve the bundled fonts through it unless the real path is allowed.
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

/** Inert HMR client, as in the sibling harnesses: repeated sockets end in a blank mount. */
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

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

interface Open {
  theme?: string;
  w?: number;
  h?: number;
  fail?: boolean;
  many?: boolean;
}

/** Uncaught errors from the preview page, so a blank mount says why. */
const pageErrors: string[] = [];

async function open(page: Page, opts: Open = {}): Promise<void> {
  pageErrors.length = 0;
  const q = new URLSearchParams({
    theme: opts.theme ?? "daintree",
    w: String(opts.w ?? 560),
    h: String(opts.h ?? 520),
  });
  if (opts.fail) q.set("search", "fail");
  if (opts.many) q.set("repo", "many");
  await page.goto(`${baseURL}/file-pane-search-preview.html?${q}`);
  await page.addStyleTag({ content: FREEZE_CSS });
  await expect(
    page.locator("[data-preview-shell]"),
    `preview did not mount${pageErrors.length ? `: ${pageErrors.join(" | ")}` : ""}`
  ).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId("file-pane-search")).toBeVisible({ timeout: 30_000 });
  await settle(page, "", !!opts.fail, opts.many ? MANY_FILES : undefined);
}

/** Waits for the shim to answer `query`, then for the list to show what it answered. */
async function settle(
  page: Page,
  query: string,
  fail: boolean,
  files?: readonly string[]
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (q) =>
            (
              Reflect.get(window, "__filePaneSearch") as {
                calls: { query: string; outcome: string }[];
              }
            ).calls.some((c) => c.query === q),
          query
        ),
      { message: `search for "${query}" never answered`, timeout: 15_000 }
    )
    .toBe(true);
  const expected = fail ? 0 : Math.min(searchFixture(query, 100, files).length, ROW_CAP);
  await expect(page.getByTestId("file-pane-result"), `rows for "${query}"`).toHaveCount(expected);
  // One frame for the commit that follows the answer to paint.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

async function type(page: Page, query: string, fail = false): Promise<void> {
  const field = page.getByTestId("file-pane-search");
  await field.click();
  await field.fill(query);
  await settle(page, query, fail);
}

async function shoot(page: Page, name: string): Promise<string> {
  await page.evaluate(() => document.fonts.ready);
  const shell = page.locator("[data-preview-shell]");
  const box = await shell.boundingBox();
  if (!box || box.width < 100 || box.height < 100) {
    throw new Error(`${name}: shell has no real box — refusing to write`);
  }
  const state = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="file-pane-result"]')];
    const active = document.activeElement as HTMLElement | null;
    const lit = rows.find((r) => r.getAttribute("aria-selected") === "true") as
      HTMLElement | undefined;
    const cut = (el: Element | null | undefined) =>
      el instanceof HTMLElement ? el.scrollWidth > el.clientWidth + 1 : null;
    return {
      litRow: lit
        ? {
            label: lit.getAttribute("aria-label"),
            tooltipState: lit.dataset.state ?? null,
            nameCut: cut(lit.querySelector(".truncate:not([dir])")),
            parts: [...lit.querySelectorAll("span")].map((s) => ({
              cls: s.className.slice(0, 40),
              cut: cut(s),
            })),
          }
        : null,
      rows: rows.length,
      selected: rows.findIndex((r) => r.getAttribute("aria-selected") === "true"),
      activeElement: active?.dataset.testid ?? active?.tagName ?? null,
      activeDescendant: active?.getAttribute("aria-activedescendant") ?? null,
      tooltip: document.querySelector('[role="tooltip"]')?.textContent ?? null,
      status:
        document.querySelector('[data-testid="file-pane-search-status"]')?.textContent ?? null,
    };
  });
  writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(state, null, 2));
  const out = path.join(OUT_DIR, `${name}.png`);
  // The whole viewport, not the shell: a row's tooltip portals to the body.
  await page.screenshot({ path: out });
  return out;
}

test("file pane picker review", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FILEPICKER is required for the file picker capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FILEPICKER=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  const written: string[] = [];

  // Rest: the pane as it opens, nothing focused, the first files listed.
  await open(page);
  written.push(await shoot(page, "01-rest"));

  // A query typed, the field focused.
  await type(page, "settings");
  written.push(await shoot(page, "02-query"));

  // Two rows down with the arrow keys.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  written.push(await shoot(page, "03-keyboard"));

  // The pointer resting on the fifth row.
  await open(page);
  await type(page, "settings");
  const fifth = page.getByTestId("file-pane-result").nth(4);
  const fifthBox = await fifth.boundingBox();
  if (!fifthBox) throw new Error("hover: fifth row has no box");
  await page.mouse.move(fifthBox.x + 40, fifthBox.y + fifthBox.height / 2);
  await page.mouse.move(fifthBox.x + 48, fifthBox.y + fifthBox.height / 2);
  await page.waitForTimeout(500);
  written.push(await shoot(page, "04-hover"));

  // A narrow pane, where the long and deep paths clip.
  await page.setViewportSize({ width: 400, height: 600 });
  await open(page, { w: 340 });
  await type(page, "settings");
  written.push(await shoot(page, "05-narrow"));

  // The keys on the longest path in the narrow pane.
  const longest = searchFixture("settings", 100).indexOf(
    "src/components/Settings/integrations/providers/GitHubIntegrationSettingsPanel.tsx"
  );
  if (longest < 0) throw new Error("fixture lost its longest path");
  for (let i = 0; i < longest; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500);
  written.push(await shoot(page, "06-narrow-keyboard"));
  await page.setViewportSize({ width: 640, height: 600 });

  // Same-named files in different folders.
  await open(page);
  await type(page, "index");
  written.push(await shoot(page, "07-same-names"));

  // A query nothing matches.
  await open(page);
  await type(page, "zzqx");
  written.push(await shoot(page, "08-no-matches"));

  // Every search failing.
  await open(page, { fail: true });
  await type(page, "settings", true);
  written.push(await shoot(page, "09-error"));

  // A short pane: the empty state and the list share 300px.
  await page.setViewportSize({ width: 640, height: 380 });
  await open(page, { h: 300 });
  await type(page, "set");
  written.push(await shoot(page, "10-short"));
  await page.setViewportSize({ width: 640, height: 600 });

  // A repository past the cap, scrolled to the end of the list.
  await open(page, { many: true });
  await page.getByTestId("file-pane-search").click();
  await page.getByRole("listbox", { name: "Files" }).evaluate((list) => {
    const scroller = list.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForTimeout(300);
  written.push(await shoot(page, "11-capped"));

  // The populated query across themes.
  for (const theme of THEMES) {
    await open(page, { theme });
    await type(page, "settings");
    written.push(await shoot(page, `theme--${theme}`));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(11 + THEMES.length);
  console.log(`[file-picker-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
