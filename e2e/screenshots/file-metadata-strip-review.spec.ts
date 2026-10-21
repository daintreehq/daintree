/**
 * File panel Source-mode metadata strip visual-review harness.
 *
 * The strip's facts depend on bytes a repository rarely offers on demand — a
 * BOM, CRLF or mixed line endings, text that isn't valid UTF-8, an empty file —
 * and its layout depends on the panel's width. So this drives the strip's own
 * preview entry (`file-metadata-strip-preview.html`) rather than booting
 * Electron: the real strip over the real `CodeViewer`, under the real
 * `FileViewerToolbar`, through the real theme tokens, at the widths a file panel
 * gets. The Markdown editor's strip is captured beside it because the two have
 * to line up when the mode toggles.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_METASTRIP=1 npx playwright test --project=screenshots file-metadata-strip-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_METASTRIP  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        output directory (default artifacts/metadata-strip-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: `snap()` asserts the strip has a real
 * box first, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_METASTRIP;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "metadata-strip-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `METADATA_STRIP_FIXTURES` in the preview entry. */
const FIXTURES = [
  "typescript",
  "markdown",
  "markdown-editor",
  "plain",
  "crlf",
  "mixed",
  "bom",
  "invalid",
  "empty",
  "stress",
  "cr",
] as const;

/** A wide editor pane, a comfortable one, a split one, and the floor. */
const WIDTHS = { wide: 1400, default: 900, narrow: 420, tight: 320 } as const;

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook. The
  // test body carries the structured skip; this hook does nothing when unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // The project's vite config pins 5173; fall forward when the app is up. A
  // worktree's node_modules is a symlink into the main checkout, which puts the
  // bundled fonts outside Vite's default allow list — and a strip of text
  // captured in the fallback face measures nothing real.
  server = await createServer({
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

async function open(page: Page, fixture: string, theme: string, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: 200 });
  await page.goto(
    `${baseURL}/file-metadata-strip-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const strip = page.getByTestId(
    fixture === "markdown-editor" ? "markdown-editor-status" : "file-viewer-metadata"
  );
  await expect(strip, `fixture "${fixture}" rendered no strip`).toBeVisible();
  await expect(page.locator(".cm-content").first()).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  // eslint-disable-next-line playwright/no-wait-for-timeout -- settle: CodeMirror's first highlight pass and the toolbar's width fit land a frame or two after attach
  await page.waitForTimeout(250);
  return page.locator("[data-preview-shell]").first();
}

test("File metadata strip — files, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_METASTRIP is required for the metadata strip capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_METASTRIP=1 to run the capture");
  test.setTimeout(240_000);

  const written: string[] = [];
  const theme0 = THEMES[0]!;

  // Every file at the comfortable width in the default theme.
  for (const fixture of FIXTURES) {
    written.push(
      await snap(
        await open(page, fixture, theme0, WIDTHS.default),
        `${fixture}-default-${theme0}.png`
      )
    );
  }
  // Width is a layout question: the richest files at every other width.
  for (const fixture of ["typescript", "bom", "invalid", "markdown-editor", "stress"] as const) {
    for (const key of ["wide", "narrow", "tight"] as const) {
      written.push(
        await snap(
          await open(page, fixture, theme0, WIDTHS[key]),
          `${fixture}-${key}-${theme0}.png`
        )
      );
    }
  }
  // Palette is a contrast question: the default and the warning case per theme.
  for (const theme of THEMES.slice(1)) {
    for (const fixture of ["typescript", "invalid"] as const) {
      written.push(
        await snap(
          await open(page, fixture, theme, WIDTHS.default),
          `${fixture}-default-${theme}.png`
        )
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[metadata-strip-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
