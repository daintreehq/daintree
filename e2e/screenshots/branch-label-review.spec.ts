/**
 * Worktree branch label visual-review harness.
 *
 * The label is a 14px type glyph beside a mono branch name, repeated on every
 * worktree card, so its judgements are pixel judgements: whether 25-odd glyphs
 * read apart at size, whether the name holds its contrast in every theme, and
 * what the tooltip says once the prefix has been cut. This drives the preview
 * entry (`branch-label-preview.html`), which mounts the REAL `WorktreeHeader`
 * (with its meta line) in the sidebar card's chrome, plus a sheet of every
 * glyph the label can draw.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_BRANCH_LABEL=1 npx playwright test --project=screenshots branch-label-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_BRANCH_LABEL  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           output directory (default artifacts/branch-label-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated theme sweep (default: every built-in)
 *
 * Never writes a PNG it has not verified: every page asserts the rows and
 * glyphs it was built with are on screen before anything is shot, the tooltip
 * shots assert the tooltip's text, and the test counts the files itself.
 */

import { test, expect, type Browser, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

test.use({ deviceScaleFactor: 2 });

const ENABLED = !!process.env.DAINTREE_SHOT_BRANCH_LABEL;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "branch-label-shots")
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

type Fixture = "cards" | "glyphs";

/** Mirrors the preview entry's fixtures, which cannot be imported under Node. */
const CARD_ROWS = [
  "main",
  "feature",
  "alias",
  "titled",
  "agent",
  "agent-typed",
  "unknown",
  "bare",
  "long",
  "muted",
];
const MIN_GLYPHS = 30;

const TOOLTIP_ROWS = [
  { row: "feature", text: "feature/login-retry" },
  { row: "agent-typed", text: "codex/fix/flaky-e2e" },
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

async function open(page: Page, fixture: Fixture, theme: string, width?: number) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.mouse.move(0, 0);
  const q = new URLSearchParams({ theme, fixture });
  if (width) q.set("width", String(width));
  await page.goto(`${baseURL}/branch-label-preview.html?${q}`);
  const card = page.locator("[data-preview-card]");
  await expect(card, `fixture "${fixture}" rendered nothing`).toBeVisible();
  if (fixture === "cards") {
    for (const row of CARD_ROWS) {
      await expect(page.locator(`[data-preview-row="${row}"]`), `${row} missing`).toBeVisible();
    }
  } else {
    expect(await page.locator("[data-preview-glyph]").count()).toBeGreaterThanOrEqual(MIN_GLYPHS);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return card;
}

async function glyphsAt1x(browser: Browser, theme: string, file: string) {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    return await snap(await open(page, "glyphs", theme), file);
  } finally {
    await context.close();
  }
}

/** The tooltip is portaled, so shoot the union of its row and the tooltip. */
async function snapWithTooltip(page: Page, row: string, file: string): Promise<string> {
  const boxes = [];
  for (const part of [page.locator(`[data-preview-row="${row}"]`), page.getByRole("tooltip")]) {
    const box = await part.boundingBox();
    if (!box || box.width < 8 || box.height < 8) {
      throw new Error(`${file}: part has no real box (${JSON.stringify(box)}) — refusing to write`);
    }
    boxes.push(box);
  }
  const pad = 12;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

test("Worktree branch label — cards, glyph set, tooltip and themes", async ({ page, browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_BRANCH_LABEL is required for the branch label capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_BRANCH_LABEL=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    written.push(await snap(await open(page, "cards", theme), `cards-${theme}.png`));
  }

  for (const theme of FOCUS_THEMES) {
    // A narrow sidebar: long names have to give way without losing their head.
    written.push(await snap(await open(page, "cards", theme, 200), `cards-narrow-${theme}.png`));
    written.push(await snap(await open(page, "glyphs", theme), `glyphs-${theme}.png`));
    written.push(await glyphsAt1x(browser, theme, `glyphs-${theme}-1x.png`));

    for (const { row, text } of TOOLTIP_ROWS) {
      await open(page, "cards", theme);
      const label = page.locator(`[data-preview-row="${row}"] [data-branch-label]`).first();
      await label.hover();
      const tip = page.getByRole("tooltip");
      await expect(tip, `${row}: tooltip never opened`).toContainText(text);
      // Past the tooltip's 150ms entry, so the frame is not a mid-fade ghost.
      await page.waitForTimeout(400);
      written.push(await snapWithTooltip(page, row, `tooltip-${row}-${theme}.png`));
    }
  }

  expect(pageErrors, "the preview threw").toEqual([]);
  const onDisk = new Set(readdirSync(OUT_DIR));
  const missing = written.map((f) => path.basename(f)).filter((f) => !onDisk.has(f));
  expect(missing, "promised files missing from disk").toEqual([]);
  expect(written.length).toBe(THEMES.length + FOCUS_THEMES.length * (3 + TOOLTIP_ROWS.length));
});
