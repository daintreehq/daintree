/**
 * Hybrid input (agent composer) LAYOUT review harness.
 *
 * The composer's layout is decided by two things that belong to the workspace
 * around it rather than to the component: how wide the grid column is, and how
 * many lines the draft wraps to. Reaching a 260px composer holding a three-line
 * draft in the real app means building a seven-way split and typing into one
 * pane of it — and the interesting widths are exactly the ones nobody builds by
 * hand.
 *
 * So this drives the composer's own preview entry (`hybrid-input-preview.html`)
 * rather than booting Electron: the real `HybridInputBar`, the real CodeMirror
 * autosize, the real theme tokens and `index.css`, placed in a column of a
 * named width with a seeded draft.
 *
 * Three arrangements, each answering one of the questions this review is about:
 *   ladder — one draft at every width, so the reflow behaviour is a single picture
 *   growth — one width at every draft length, so the vertical behaviour is too
 *   tiles  — ten panes at a fleet-realistic width, which is where repeated
 *            trailing icons are actually judged
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_HYBRIDINPUT is set.
 *
 *   DAINTREE_SHOT_HYBRIDINPUT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots hybrid-input-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HYBRIDINPUT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo.
 *                              Deliberately no default: a committed spec with an in-repo
 *                              fallback is how PNGs end up in a working tree.
 *   DAINTREE_SHOT_THEMES       themes for the per-case captures (default daintree,bondi,namib)
 *
 * Hard rule, inherited from the sibling harnesses: never write a PNG that has not been
 * verified. Every capture asserts the arrangement it means to show is on screen and that
 * every composer in it actually mounted an editor, and the test counts the files itself
 * at the end rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";
import { WIDTHS, TILE_AGENTS } from "../../src/components/Terminal/__preview__/hybridInputFixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_HYBRIDINPUT;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// 2× so a 24px button, a 1px border and the gap between the last glyph and the
// shell edge are judged at the size a Retina user sees them. At 1× the spacing
// details this harness exists to show round away.
test.use({ deviceScaleFactor: 2 });

const ROOT_SHEET = "#root > div[data-preview-case]";

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

  // `strictPort: false` so the harness can run beside a live `npm run dev`.
  // `fs.allow` names the REAL node_modules: a worktree symlinks it to the main
  // checkout, and Vite resolves the fonts through the link to a path outside the
  // project root, which its serving allow-list refuses. A capture measured in the
  // fallback face is the wrong picture — and this review is about spacing.
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
 * gives up and falls into a blob-URL SharedWorker that the dev CSP refuses —
 * after which every load mounts blank. `updateStyle` stays real: in dev every
 * CSS import is a JS module that calls it, so a no-op there renders the whole
 * page unstyled.
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
 * Freeze motion so a capture is the settled state, not a frame of a transition.
 * The caret is left alone — an empty composer showing one is the honest picture.
 */
// Scrollbars are deliberately NOT hidden here, unlike the sibling harnesses.
// The composer's canvas flips to `overflow-y: auto` at its 8-line cap, so at
// narrow widths whether a draft is scrollable or genuinely lost is one of the
// things this review has to judge — and hiding the bar makes the two look
// identical. The first run of this harness did hide it, and read as content
// loss.
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

/** Write one PNG, having proved there is something to write. */
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

async function open(
  page: Page,
  query: { case: string; theme: string; draft?: string; stash?: boolean }
): Promise<Locator> {
  const params = new URLSearchParams({ case: query.case, theme: query.theme });
  if (query.draft) params.set("draft", query.draft);
  if (query.stash) params.set("stash", "1");
  await page.goto(`${baseURL}/hybrid-input-preview.html?${params.toString()}`);
  await page.addStyleTag({ content: FREEZE_CSS });
  const sheet = page.locator(ROOT_SHEET);
  await expect(sheet).toBeAttached();
  return sheet;
}

/**
 * The contract every capture must satisfy before it is written.
 *
 * CodeMirror mounts imperatively and lazily, so a composer can be fully laid out
 * and still hold no editor — which photographs as a plausible empty bar. Proving
 * `.cm-content` is present in every pane is what stops this harness producing a
 * believable picture of a component that never rendered.
 */
async function proveComposersMounted(page: Page, expected: number): Promise<void> {
  const roots = page.locator("[data-hybrid-input-root]");
  await expect(roots).toHaveCount(expected);
  await expect(page.locator(".cm-content")).toHaveCount(expected);
  // Both trailing controls, on every pane. The mic renders only once voice is
  // configured, and the first run of this harness quietly captured a one-button
  // trailing group — a believable picture that understated the exact thing the
  // review is about. Counting them is what stops that recurring.
  await expect(page.getByRole("button", { name: "Attach files" })).toHaveCount(expected);
  await expect(page.locator("[data-hybrid-input-root] .lucide-mic")).toHaveCount(expected);
  // Every composer must also have a real box. A zero-height bar is the failure
  // mode a column-width harness is most likely to produce by accident.
  const heights = await roots.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().height)
  );
  const dead = heights.filter((h) => h < 8);
  if (dead.length > 0) {
    throw new Error(`${dead.length} of ${expected} composers have no height — refusing to write`);
  }
}

/**
 * Size the viewport to the sheet before capturing it. `index.css` pins the
 * document to the viewport, so a sheet taller than it never scrolls into an
 * element screenshot — it silently clips instead.
 */
async function fitViewport(page: Page, sheet: Locator): Promise<void> {
  // Widen first, then measure. The sheet's own width is constrained by the
  // viewport, so measuring at the default 1280 and sizing to that result is a
  // fixed point that silently clips — the tile grid lost its fifth column that
  // way. Measure against a viewport wide enough not to be the constraint.
  await page.setViewportSize({ width: 2600, height: 1400 });
  await page.waitForTimeout(150);
  const box = await sheet.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      w: Math.ceil(Math.max(r.width, el.scrollWidth)),
      h: Math.ceil(Math.max(r.height, el.scrollHeight)),
    };
  });
  await page.setViewportSize({
    width: Math.min(Math.max(box.w + 32, 640), 4000),
    height: Math.min(Math.max(box.h + 32, 400), 6000),
  });
  await page.waitForTimeout(250);
}

test("hybrid input layout review", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HYBRIDINPUT is required for the hybrid-input capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_HYBRIDINPUT=1 to run the capture");
  test.setTimeout(240_000);

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const theme of THEMES) {
    // The reflow ladder, at the reported draft and at a single line. Two drafts
    // because the width behaviour and the wrap behaviour are separate questions
    // and a single picture conflates them.
    for (const draft of ["reported", "short"] as const) {
      const sheet = await open(page, { case: "ladder", theme, draft });
      await proveComposersMounted(page, WIDTHS.length);
      await fitViewport(page, sheet);
      written.push(await snap(sheet, `ladder--${theme}--${draft}.png`));
    }

    // The ladder again with a stashed draft, which adds the third trailing
    // button. The narrow end of this row is where the trailing group's cost is
    // most visible.
    {
      const sheet = await open(page, { case: "ladder", theme, draft: "reported", stash: true });
      await proveComposersMounted(page, WIDTHS.length);
      await fitViewport(page, sheet);
      written.push(await snap(sheet, `ladder--${theme}--stash.png`));
    }

    // Vertical growth at one narrow width.
    {
      const sheet = await open(page, { case: "growth", theme });
      await proveComposersMounted(page, 4);
      await fitViewport(page, sheet);
      written.push(await snap(sheet, `growth--${theme}.png`));
    }

    // Ten tiled panes.
    {
      const sheet = await open(page, { case: "tiles", theme });
      await proveComposersMounted(page, TILE_AGENTS.length);
      await fitViewport(page, sheet);
      written.push(await snap(sheet, `tiles--${theme}.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 5);
  console.log(`[hybrid-input-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
