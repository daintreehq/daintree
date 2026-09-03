/**
 * Rendered-Markdown diff visual-review harness.
 *
 * The diff panel's **Rendered** layout is the one surface in the app whose whole
 * content is somebody else's writing. Reaching an interesting state in the real
 * app means finding a Markdown file that happens to have been edited the right
 * way, which is no way to look at a design deliberately — and the cases that
 * decide it (a paragraph rewritten around its surviving clauses, a changed table
 * cell, an unpaired insertion, two changes a screen and a half apart) are not
 * states you can ask a repository for.
 *
 * So this drives the component's own preview entry (`markdown-diff-preview.html`)
 * rather than booting Electron: the real `RenderedMarkdownDiff`, the real theme
 * tokens through `applyAppThemeToRoot`, the real `index.css` and
 * `MarkdownDocument.css`, at the width the diff panel actually gives it.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_MDDIFF=1 npx playwright test --project=screenshots markdown-diff-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MDDIFF   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      output directory (default artifacts/markdown-diff-shots)
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default: daintree,bondi,namib)
 *   DAINTREE_SHOT_FIXTURES comma-separated fixture subset (default: all of them)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the diff root is attached with a real box before it
 * writes and throws otherwise, and the test counts the files itself at the end
 * rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_MDDIFF;

/**
 * The width the diff panel gives the document at a typical window size. Rendered
 * mode drops the reading measure on purpose, so width is a real variable here:
 * the narrow case is where a two-tier fill and a change bar have the least room
 * to stay distinguishable.
 */
const DEFAULT_WIDTH = 900;
const NARROW_WIDTH = 520;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "markdown-diff-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry, with what each one is here to prove. */
const ALL_FIXTURES = [
  { name: "prose-rewrite", what: "a rewrite that keeps most of its clauses" },
  { name: "light-edit", what: "a few words swapped — the baseline that must keep working" },
  { name: "structure", what: "heading, list items and a blockquote" },
  { name: "table-and-code", what: "a changed table cell and a changed fence" },
  { name: "insert-and-delete", what: "unpaired insertion and unpaired deletion" },
  { name: "sparse", what: "two changes in a long document" },
] as const;

const FIXTURES = process.env.DAINTREE_SHOT_FIXTURES
  ? ALL_FIXTURES.filter((f) =>
      process.env
        .DAINTREE_SHOT_FIXTURES!.split(",")
        .map((n) => n.trim())
        .includes(f.name)
    )
  : ALL_FIXTURES;

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  // Fresh directory per run: a leftover PNG from an earlier round read as this
  // round's output is the easiest way to review a screen that no longer exists.
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

/** Write one PNG, having proved there is something to write. */
async function snap(target: Locator, file: string, fullPage = false): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  if (fullPage) {
    await target.page().screenshot({ path: out, fullPage: true });
  } else {
    await target.screenshot({ path: out });
  }
  return out;
}

/** Load one fixture in one theme at one width, and settle it. */
async function open(
  page: Page,
  fixture: string,
  theme: string,
  width: number
): Promise<{ body: Locator; diff: Locator }> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(
    `${baseURL}/markdown-diff-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const body = page.locator("[data-preview-shell]").first();
  await expect(body).toBeAttached();
  const diff = page.getByTestId("rendered-markdown-diff");
  // The engine can decline to build a view at all (`onVerdict`), in which case
  // the component renders null and the host would swap back to the source diff.
  // Here that is a broken fixture, and it must fail loudly rather than write a
  // picture of an empty panel.
  await expect(diff, `fixture "${fixture}" produced no rendered diff`).toBeAttached();
  // Type metrics drive every measurement in a prose surface, so a capture taken
  // before the fonts land measures the fallback face.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  return { body, diff };
}

test("rendered Markdown diff — cases, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MDDIFF is required for the rendered-Markdown diff capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MDDIFF=1 to run the capture");

  const written: string[] = [];

  for (const theme of THEMES) {
    for (const { name } of FIXTURES) {
      const { body } = await open(page, name, theme, DEFAULT_WIDTH);
      // The viewport, not the whole document: this is what a reader sees when
      // they open the panel, and the question the surface has to answer first
      // ("what changed here?") is answered above the fold or not at all.
      written.push(await snap(body, `${name}-${theme}.png`));
    }
  }

  // The pressure case: the narrowest the diff panel realistically gets, in the
  // default theme only — width is a layout question, not a palette one.
  {
    const theme = THEMES[0]!;
    for (const name of ["prose-rewrite", "table-and-code"] as const) {
      if (!FIXTURES.some((f) => f.name === name)) continue;
      const { body } = await open(page, name, theme, NARROW_WIDTH);
      written.push(await snap(body, `${name}-${theme}-narrow.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[markdown-diff-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
