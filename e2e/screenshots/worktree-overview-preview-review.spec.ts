/**
 * Worktree overview visual-review harness, fixture-driven.
 *
 * Drives `worktree-overview-preview.html`, which mounts the REAL
 * `WorktreeOverviewModal` over the real theme tokens, seeded through the
 * per-view worktree store and the panel store. The sibling
 * `worktree-overview-review` spec boots Electron with real git worktrees and
 * PTYs; this one trades that fidelity for a nine-worktree fleet in every state
 * the surface has to tell apart, captured in seconds.
 *
 *   DAINTREE_SHOT_OVERVIEW_PREVIEW=1 DAINTREE_SHOT_DIR=/abs/dir \
 *     ./node_modules/.bin/playwright test --project=screenshots worktree-overview-preview-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_OVERVIEW_PREVIEW  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR               output directory (default artifacts/overview-preview-shots)
 *   DAINTREE_SHOT_THEMES            comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: each state asserts its own content
 * after the settle, and the test counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

test.use({ deviceScaleFactor: 2 });

const ENABLED = !!process.env.DAINTREE_SHOT_OVERVIEW_PREVIEW;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "overview-preview-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FLEETS` in the preview entry, which cannot be imported under Node. */
const FLEET_SIZES = { busy: 9, few: 3, single: 1, empty: 0 } as const;

const DESKTOP = { width: 1600, height: 1000 };
const LAPTOP = { width: 1180, height: 780 };

const MODAL = '[data-testid="worktree-overview-modal"]';
const ROW = "[data-worktree-overview-cell]";

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

async function open(
  page: Page,
  opts: {
    theme: string;
    fleet?: keyof typeof FLEET_SIZES;
    viewport?: { width: number; height: number };
  }
) {
  const fleet = opts.fleet ?? "busy";
  await stubViteHmrClient(page);
  await page.setViewportSize(opts.viewport ?? DESKTOP);
  await page.mouse.move(0, 0);
  await page.goto(
    `${baseURL}/worktree-overview-preview.html?${new URLSearchParams({ theme: opts.theme, fleet })}`
  );
  const modal = page.locator(MODAL);
  await expect(modal, `fleet "${fleet}" rendered no overview`).toBeVisible();
  await expect(modal.locator(ROW)).toHaveCount(FLEET_SIZES[fleet]);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return modal;
}

async function shoot(page: Page, file: string): Promise<string> {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out });
  return out;
}

test("Worktree overview — fleets, states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_OVERVIEW_PREVIEW is required for the overview capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_OVERVIEW_PREVIEW=1 to run the capture");
  test.setTimeout(240_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    await open(page, { theme });
    written.push(await shoot(page, `busy-${theme}.png`));
  }

  const theme = THEMES[0]!;

  await open(page, { theme, fleet: "few" });
  written.push(await shoot(page, `few-${theme}.png`));

  await open(page, { theme, viewport: LAPTOP });
  written.push(await shoot(page, `busy-laptop-${theme}.png`));

  // Searching: the field's own treatment, and the narrowed list.
  {
    const modal = await open(page, { theme });
    const search = modal
      .getByRole("searchbox")
      .or(modal.getByRole("textbox"))
      .or(modal.getByRole("combobox"))
      .first();
    await search.fill("issue-12");
    await expect(modal.locator(ROW)).not.toHaveCount(FLEET_SIZES.busy);
    await page.waitForTimeout(200);
    written.push(await shoot(page, `search-${theme}.png`));
  }

  // Keyboard: into the results, cursor on the third row.
  {
    const modal = await open(page, { theme });
    await modal.getByRole("grid").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    written.push(await shoot(page, `cursor-${theme}.png`));

    // Selection mode: two rows selected by Space and Shift+ArrowDown.
    await page.keyboard.press("Space");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(modal.locator('[aria-selected="true"]')).toHaveCount(2);
    await page.waitForTimeout(150);
    written.push(await shoot(page, `selection-${theme}.png`));

    // Leaving selection mode from the bar's own Clear must hand focus to the
    // list, not strand it on the document as the bar unmounts.
    await modal.getByRole("button", { name: "Clear", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(modal.locator('[aria-selected="true"]')).toHaveCount(0);
    await expect(modal.getByRole("grid")).toBeFocused();
  }

  // The row menu from the keyboard: Shift+F10 on the cursor row, which lists
  // the row's sessions in full above its actions.
  {
    const modal = await open(page, { theme });
    await modal.getByRole("grid").focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Sessions")).toBeVisible();
    await page.waitForTimeout(200);
    written.push(await shoot(page, `menu-${theme}.png`));
    await page.keyboard.press("Escape");
  }

  // A filter that matches nothing, with no query typed.
  {
    const modal = await open(page, { theme, fleet: "few" });
    await modal.getByRole("button", { name: /^Attention/ }).click();
    await expect(modal.getByText("No worktrees match these filters")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Clear all filters" })).toBeVisible();
    await page.waitForTimeout(200);
    written.push(await shoot(page, `filter-empty-${theme}.png`));
  }

  // Pointer over a row: whatever the row reveals on hover.
  {
    const modal = await open(page, { theme });
    await modal.locator(ROW).nth(2).hover();
    await page.waitForTimeout(200);
    written.push(await shoot(page, `hover-${theme}.png`));
  }

  await open(page, { theme, fleet: "single" });
  written.push(await shoot(page, `single-${theme}.png`));

  {
    await stubViteHmrClient(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(
      `${baseURL}/worktree-overview-preview.html?${new URLSearchParams({ theme, fleet: "empty" })}`
    );
    const modal = page.locator(MODAL);
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/No worktrees yet|Create a worktree/).first()).toBeVisible();
    await page.addStyleTag({ content: FREEZE_CSS });
    await page.waitForTimeout(300);
    written.push(await shoot(page, `empty-${theme}.png`));
  }

  // The sidebar's own cards for the same fleet, so the two are judged as one family.
  {
    await stubViteHmrClient(page);
    await page.setViewportSize({ width: 400, height: 1400 });
    await page.goto(
      `${baseURL}/worktree-overview-preview.html?${new URLSearchParams({ theme, fleet: "busy", scene: "sidebar" })}`
    );
    const sidebar = page.locator("[data-preview-sidebar]");
    await expect(sidebar.locator(".sidebar-worktree-card")).toHaveCount(FLEET_SIZES.busy);
    await page.addStyleTag({ content: FREEZE_CSS });
    await page.waitForTimeout(300);
    written.push(await snap(sidebar, `sidebar-${theme}.png`));
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[overview-preview-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
