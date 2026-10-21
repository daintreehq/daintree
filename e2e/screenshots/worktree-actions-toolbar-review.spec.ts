/**
 * Worktree card actions toolbar visual-review harness.
 *
 * The toolbar is the Delete / Collapse / More cluster at the right end of a
 * worktree card's title row. Its design questions are all about rest versus
 * pointer: how loud three icons are when they repeat on every card, whether the
 * resting ink still reads, and what the destructive one does when it is pointed
 * at. This drives the status-tick preview entry
 * (`worktree-status-tick-preview.html`), which mounts the REAL `WorktreeHeader`
 * — and so the real toolbar — in the sidebar card's chrome. It is used rather
 * than the Electron card harness because Delete only renders on a worktree
 * whose PR has merged, which needs a live forge lookup in the full app; the
 * preview's `cleanup` row is built from those same worktree fields. The open
 * menu is not shot here: its items read app stores the preview does not boot,
 * so the card harness's `toolbar-copy` step owns it.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_TOOLBAR=1 npx playwright test --project=screenshots worktree-actions-toolbar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOOLBAR  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      output directory (default artifacts/actions-toolbar-shots)
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default: every built-in)
 *
 * Never writes a PNG it has not verified: every frame asserts the state it is
 * named for (the hovered control's tooltip, `:focus-visible`) before it is
 * shot, and the test counts the files itself.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

test.use({ deviceScaleFactor: 2 });

const ENABLED = !!process.env.DAINTREE_SHOT_TOOLBAR;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "actions-toolbar-shots")
);

/** Copied rather than imported: importing a spec file registers its test too. */
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

async function open(page: Page, fixture: "sidebar" | "collapsed", theme: string) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.mouse.move(0, 0);
  await page.goto(`${baseURL}/worktree-status-tick-preview.html?theme=${theme}&fixture=${fixture}`);
  const card = page.locator("[data-preview-card]");
  await expect(card, `fixture "${fixture}" rendered nothing`).toBeVisible();
  await expect(
    page.locator('[data-preview-row="cleanup"] [data-testid="worktree-cleanup-button"]'),
    "the cleanup row lost its Delete button"
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return card;
}

const rowOf = (page: Page, id: string): Locator => page.locator(`[data-preview-row="${id}"]`);

/**
 * Shoot a row with room to its right and above for a tooltip, clipped from the
 * page so the pointer stays where it was put.
 */
async function snapRow(page: Page, row: Locator, file: string, padTop = 0): Promise<string> {
  const box = await row.boundingBox();
  if (!box || box.width < 40 || box.height < 16) {
    throw new Error(`${file}: row has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const y = Math.max(0, box.y - padTop);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, box.x - 8),
      y,
      width: box.width + 16,
      height: box.y + box.height - y + 8,
    },
  });
  return out;
}

/**
 * Point at the empty right-hand end of a card's last line. The title and the
 * branch line open hover cards and tooltips of their own, which land over the
 * toolbar being judged.
 */
async function hoverCardBody(row: Locator): Promise<void> {
  const box = await row.boundingBox();
  if (!box) throw new Error("card has no box to hover");
  await row.hover({ position: { x: box.width - 24, y: box.height - 12 } });
}

/** Tab until `target` holds `:focus-visible`; a scripted focus does not satisfy it. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await page.locator("[data-preview-shell]").click({ position: { x: 2, y: 2 } });
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const reached = await target
      .evaluate((el) => el === document.activeElement && el.matches(":focus-visible"))
      .catch(() => false);
    if (reached) return;
  }
  throw new Error("never reached :focus-visible by Tab");
}

test("Worktree card actions toolbar — rest, pointer, focus and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TOOLBAR is required for the actions toolbar capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TOOLBAR=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of FOCUS_THEMES) {
    // The list at rest: the toolbar on the active card, on inactive siblings,
    // and with Delete on the cleanup card — how loud the repetition is.
    written.push(await snap(await open(page, "sidebar", theme), `10-list-rest-${theme}.png`));
    written.push(
      await snap(await open(page, "collapsed", theme), `11-collapsed-rest-${theme}.png`)
    );

    // The pointer on the cleanup card's body: what the hover reveal does.
    await open(page, "sidebar", theme);
    const cleanup = rowOf(page, "cleanup");
    await hoverCardBody(cleanup);
    // Past the reveal's delay and fade, so the frame is not mid-transition.
    await page.waitForTimeout(400);
    written.push(await snapRow(page, cleanup, `20-card-hover-${theme}.png`));

    // The pointer on Delete itself, with its tooltip.
    const remove = cleanup.getByTestId("worktree-cleanup-button");
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await remove.hover();
    await expect(page.getByRole("tooltip"), "Delete tooltip never opened").toContainText(
      "Delete worktree"
    );
    await page.waitForTimeout(400);
    written.push(await snapRow(page, cleanup, `21-delete-hover-${theme}.png`, 40));

    // The pointer on Collapse, beside a still-resting Delete.
    const collapse = cleanup.getByRole("button", { name: "Collapse card" });
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await collapse.hover();
    await expect(page.getByRole("tooltip")).toContainText("Collapse card");
    await page.waitForTimeout(400);
    written.push(await snapRow(page, cleanup, `22-collapse-hover-${theme}.png`, 40));

    // Keyboard focus on Delete, reached by real Tab presses.
    await open(page, "sidebar", theme);
    await tabTo(page, rowOf(page, "cleanup").getByTestId("worktree-cleanup-button"));
    await page.waitForTimeout(400);
    written.push(await snapRow(page, rowOf(page, "cleanup"), `23-delete-focus-${theme}.png`, 40));

    // Windows high contrast swaps the inks for system colours.
    await page.emulateMedia({ forcedColors: "active" });
    written.push(await snap(await open(page, "sidebar", theme), `30-forced-colors-${theme}.png`));
    await page.emulateMedia({ forcedColors: "none" });
  }

  // Theme sweep: the cleanup card at rest and under the pointer, every theme.
  for (const theme of THEMES) {
    await open(page, "sidebar", theme);
    const cleanup = rowOf(page, "cleanup");
    const quiet = rowOf(page, "quiet");
    written.push(await snapRow(page, cleanup, `40-theme-rest-${theme}.png`));
    written.push(await snapRow(page, quiet, `41-theme-rest-quiet-${theme}.png`));
    await hoverCardBody(cleanup);
    // Past the reveal's delay and fade, so the frame is not mid-transition.
    await page.waitForTimeout(400);
    written.push(await snapRow(page, cleanup, `42-theme-hover-${theme}.png`));
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[actions-toolbar-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
