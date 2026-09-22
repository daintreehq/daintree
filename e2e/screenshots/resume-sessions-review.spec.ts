/**
 * Resume-sessions palette visual-review harness.
 *
 * The palette-family harness captures this palette empty, because a closed
 * session only enters the journal after a real close and there is no cheap way
 * to seed one through the app. So this drives the palette's own preview entry
 * (`resume-sessions-preview.html`): the real `ResumeSessionsPalette` against
 * the real stores, tokens and `index.css`, with the journal served from a
 * fixture that names the state.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_RESUME=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots resume-sessions-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RESUME   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. Every capture proves the state it means to show is on screen first,
 * and the test counts the files itself rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_RESUME;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const DIALOG = '[role="dialog"][aria-label="Resume session"]';
const VIEWPORT = { width: 1000, height: 900 };

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
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }

  // See panel-header-review for why: `strictPort: false` so it runs beside a
  // live dev server, and `fs.allow` names the real node_modules behind a
  // worktree's symlink so the fonts resolve.
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

/** Inert `@vite/client`, so no page opens an HMR socket (see panel-header-review). */
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
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

/**
 * Clip to the palette plus a margin, so the capture carries the surface edge,
 * its shadow and the scrim behind it. Throws rather than writing when the
 * dialog is not really on screen.
 */
async function snap(page: Page, dialog: Locator, file: string, pad = 40): Promise<string> {
  await expect(dialog).toBeAttached();
  const box = await dialog.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: dialog has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, VIEWPORT.width - x),
      height: Math.min(box.height + pad * 2, VIEWPORT.height - y),
    },
  });
  return out;
}

/** Load one fixture in one theme and settle it. */
async function open(page: Page, fixture: string, theme: string): Promise<Locator> {
  await page.setViewportSize(VIEWPORT);
  const url = `${baseURL}/resume-sessions-preview.html?theme=${theme}&fixture=${fixture}`;
  const dialog = page.locator(DIALOG).first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(dialog).toBeAttached({ timeout });
  } catch {
    console.warn(`[resume-shots] first mount of ${fixture}/${theme} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(dialog).toBeAttached({ timeout });
  }
  // Mounted is not styled: the command tier's width comes from a utility, so
  // its presence proves the stylesheet landed.
  await expect(dialog).toHaveCSS("width", "608px");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return dialog;
}

function options(dialog: Locator): Locator {
  return dialog.getByRole("option");
}

async function selectedId(dialog: Locator): Promise<string | null> {
  const selected = dialog.locator('[role="option"][aria-selected="true"]');
  if ((await selected.count()) === 0) return null;
  return selected.first().getAttribute("id");
}

test("resume sessions palette — states, interactions and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RESUME is required for the resume-sessions capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_RESUME=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  const written: string[] = [];
  const timeout = 10_000;

  for (const theme of THEMES) {
    // Browse, populated: the resting state.
    {
      const dialog = await open(page, "populated", theme);
      await expect(
        options(dialog).filter({ hasText: "Pane resize scroll position bug" })
      ).toBeVisible({ timeout });
      expect(await selectedId(dialog)).not.toBeNull();
      written.push(await snap(page, dialog, `populated--${theme}.png`));

      // Keyboard: the selection walked down to the long-titled row, so the
      // rail is off the first row and the footer carries a title that has to
      // give way.
      const before = await selectedId(dialog);
      const longRow = options(dialog).filter({ hasText: "Port the forge token banner" });
      for (let i = 0; i < 12; i += 1) {
        if (await longRow.evaluate((el) => el.getAttribute("aria-selected") === "true")) break;
        await page.keyboard.press("ArrowDown");
      }
      await page.waitForTimeout(150);
      const after = await selectedId(dialog);
      if (after === null || after === before) {
        throw new Error("ArrowDown did not move the selection — refusing to write");
      }
      await expect(longRow).toHaveAttribute("aria-selected", "true");
      written.push(await snap(page, dialog, `populated--${theme}--keyboard.png`));

      // Search narrows the list and highlights the match.
      await dialog.getByRole("combobox").fill("rebase");
      await expect(options(dialog).filter({ hasText: "Rebase with develop" })).toBeVisible({
        timeout,
      });
      await expect(options(dialog).filter({ hasText: "Pane resize" })).toHaveCount(0);
      await page.waitForTimeout(150);
      written.push(await snap(page, dialog, `populated--${theme}--search.png`));

      // A search that only matches removed-worktree sessions.
      await dialog.getByRole("combobox").fill("screenshots");
      await expect(options(dialog).filter({ hasText: "Screenshots request" })).toBeVisible({
        timeout,
      });
      await page.waitForTimeout(150);
      written.push(await snap(page, dialog, `populated--${theme}--search-removed.png`));
    }

    // Browse with the removed-worktree fold opened.
    {
      const dialog = await open(page, "populated", theme);
      const fold = dialog.getByRole("button", { name: /worktree removed/i });
      await expect(fold).toBeVisible({ timeout });
      await expect(options(dialog).filter({ hasText: "Delete work tree" })).toHaveCount(0);
      await fold.click();
      await expect(options(dialog).filter({ hasText: "Delete work tree" })).toBeVisible({
        timeout,
      });
      await page.waitForTimeout(150);
      written.push(await snap(page, dialog, `populated--${theme}--removed-open.png`));
    }

    // Every session's worktree gone.
    {
      const dialog = await open(page, "removed-only", theme);
      await expect(dialog.getByText(/worktree removed/i).first()).toBeVisible({ timeout });
      // With nothing resumable the history is shown, not folded away.
      await expect(options(dialog).filter({ hasText: "Delete work tree" })).toBeVisible({
        timeout,
      });
      written.push(await snap(page, dialog, `removed-only--${theme}.png`));
    }

    // More than a page of resumable sessions.
    {
      const dialog = await open(page, "many", theme);
      await expect(dialog.getByRole("button", { name: /load more/i })).toBeVisible({ timeout });
      written.push(await snap(page, dialog, `many--${theme}.png`));
    }

    // Nothing closed yet.
    {
      const dialog = await open(page, "empty", theme);
      await expect(dialog.getByText("No closed sessions yet")).toBeVisible({ timeout });
      written.push(await snap(page, dialog, `empty--${theme}.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 8);
  console.log(`[resume-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
