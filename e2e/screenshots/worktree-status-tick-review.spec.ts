/**
 * Worktree card status tick visual-review harness.
 *
 * The tick is a 4x16 bar (a 6x6 square on a collapsed row) cut into one, two or
 * three pieces, so every judgement about it is a pixel judgement: whether the
 * counts read apart at size, whether a 2px gap survives 1x, whether the three
 * fills hold up on light themes, what is left once forced colours take the hue.
 * This drives the preview entry (`worktree-status-tick-preview.html`), which
 * mounts the REAL tick and the REAL `WorktreeHeader` in the sidebar card's and
 * the overview cell's real chrome, with each row's state derived by
 * `computeChipState` from worktree fields. `cleanup` and `complete` need a live
 * forge lookup in the full app, which is why this is not a step in the Electron
 * card harness (that one still owns the real `waiting` shot).
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_STATUS_TICK=1 npx playwright test --project=screenshots worktree-status-tick-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_STATUS_TICK  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/status-tick-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: every built-in)
 *
 * Never writes a PNG it has not verified: every page asserts the rows reached
 * the state the fixture was built for before anything is shot, the tooltip
 * shots assert the tooltip's text, and the test counts the files itself.
 */

import { test, expect, type Browser, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

// 2x, so a 2px gap can be judged as a gap rather than a smudge. The 1x
// specimen is shot from its own context below.
test.use({ deviceScaleFactor: 2 });

const ENABLED = !!process.env.DAINTREE_SHOT_STATUS_TICK;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "status-tick-shots")
);

/**
 * Every built-in theme. Copied rather than imported from the card harness:
 * importing a spec file registers its test in this run too.
 */
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

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ALL_THEMES.join(","))
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** One dark and one light theme carry the per-state shots. */
const FOCUS_THEMES = ["daintree", "bondi"];

type Fixture = "sidebar" | "collapsed" | "grid" | "specimen";

/**
 * What each fixture must render before it may be shot, mirroring the rows in
 * the preview entry (which cannot be imported under Node). A fixture whose
 * worktree fields stop deriving the state they were written for fails here
 * rather than photographing a card with no mark on it.
 */
const EXPECTED: Record<Fixture, Record<string, string>> = {
  sidebar: {
    waiting: "waiting",
    cleanup: "cleanup",
    complete: "complete",
    quiet: "none",
    "waiting-active": "waiting",
    "complete-main": "complete",
  },
  collapsed: {
    waiting: "waiting",
    cleanup: "cleanup",
    complete: "complete",
    quiet: "none",
    "waiting-active": "waiting",
    "complete-main": "complete",
  },
  grid: {
    waiting: "waiting",
    cleanup: "cleanup",
    complete: "complete",
    quiet: "none",
    "waiting-active": "waiting",
  },
  specimen: {},
};

const TICK_COUNT: Record<Fixture, number> = { sidebar: 5, collapsed: 5, grid: 4, specimen: 6 };

const TOOLTIP_ROWS = [
  { row: "waiting", text: "Agent waiting for input" },
  { row: "cleanup", text: "Ready for cleanup" },
  { row: "complete", text: "Complete: in review" },
] as const;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";
let snap: ReturnType<typeof makeSnap>;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
  snap = makeSnap(OUT_DIR);
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, fixture: Fixture, theme: string, opts: { width?: number } = {}) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 800, height: 1000 });
  const q = new URLSearchParams({ theme, fixture });
  if (opts.width) q.set("width", String(opts.width));
  // The pointer survives navigation; park it so a previous hover does not ride in.
  await page.mouse.move(0, 0);
  await page.goto(`${baseURL}/worktree-status-tick-preview.html?${q}`);
  const card = page.locator("[data-preview-card]");
  await expect(card, `fixture "${fixture}" rendered nothing`).toBeVisible();
  for (const [row, state] of Object.entries(EXPECTED[fixture])) {
    await expect(
      page.locator(`[data-preview-row="${row}"]`).first(),
      `${fixture}/${row}: derived the wrong chip state`
    ).toHaveAttribute("data-chip-state", state);
  }
  await expect(page.getByTestId("worktree-status-tick")).toHaveCount(TICK_COUNT[fixture]);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return card;
}

async function specimenAt1x(browser: Browser, theme: string, file: string) {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const card = await open(page, "specimen", theme);
    return await snap(card, file);
  } finally {
    await context.close();
  }
}

test("Worktree card status tick — states, footprints, variants and themes", async ({
  page,
  browser,
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_STATUS_TICK is required for the status tick capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_STATUS_TICK=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // Theme sweep: the expanded sidebar list and the collapsed one in every theme.
  for (const theme of THEMES) {
    written.push(await snap(await open(page, "sidebar", theme), `sidebar-${theme}.png`));
    written.push(await snap(await open(page, "collapsed", theme), `collapsed-${theme}.png`));
  }

  for (const theme of FOCUS_THEMES) {
    written.push(await snap(await open(page, "grid", theme), `grid-${theme}.png`));
    written.push(await snap(await open(page, "specimen", theme), `specimen-${theme}.png`));
    written.push(await specimenAt1x(browser, theme, `specimen-${theme}-1x.png`));

    // Tooltip open on each state. Portaled, so the frame is the viewport.
    for (const { row, text } of TOOLTIP_ROWS) {
      await open(page, "sidebar", theme);
      const tick = page.locator(`[data-preview-row="${row}"]`).getByTestId("worktree-status-tick");
      await tick.hover();
      const tip = page.getByRole("tooltip");
      await expect(tip, `${row}: tooltip never opened`).toContainText(text);
      // Past the tooltip's 150ms entry, so the frame is not a mid-fade ghost.
      await page.waitForTimeout(400);
      const file = `tooltip-${row}-${theme}.png`;
      await page.screenshot({ path: path.join(OUT_DIR, file), clip: tipClip });
      written.push(file);
    }

    // The pointer on a card, then on its grip: the grip's plate runs the
    // card's full height up to the tick's corner.
    await open(page, "sidebar", theme);
    const cleanupRow = page.locator('[data-preview-row="cleanup"]');
    await cleanupRow.hover({ position: { x: 160, y: 60 } });
    written.push(await snap(page.locator("[data-preview-card]"), `sidebar-${theme}-hover.png`));
    await cleanupRow.locator("[data-worktree-row-drag-handle]").hover();
    written.push(
      await snap(page.locator("[data-preview-card]"), `sidebar-${theme}-hover-grip.png`)
    );
    await open(page, "collapsed", theme);
    await page
      .locator('[data-preview-row="cleanup"]')
      .locator("[data-worktree-row-drag-handle]")
      .hover();
    written.push(
      await snap(page.locator("[data-preview-card]"), `collapsed-${theme}-hover-grip.png`)
    );

    // prefers-contrast: more (the macOS half) and forced-colors (the Windows half).
    await page.emulateMedia({ contrast: "more" });
    written.push(
      await snap(await open(page, "sidebar", theme), `sidebar-${theme}-contrast-more.png`)
    );
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
    written.push(
      await snap(await open(page, "sidebar", theme), `sidebar-${theme}-forced-colors.png`)
    );
    written.push(
      await snap(await open(page, "collapsed", theme), `collapsed-${theme}-forced-colors.png`)
    );
    written.push(
      await snap(await open(page, "specimen", theme), `specimen-${theme}-forced-colors.png`)
    );
    await page.emulateMedia({ forcedColors: "none" });
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[status-tick-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});

/** The top of the list, where the tooltip opens beside the first three rows. */
const tipClip = { x: 0, y: 0, width: 560, height: 360 };
