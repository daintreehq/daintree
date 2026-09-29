/**
 * File-list rows: the file browser tree, the diff file shelf, the worktree
 * card's change list and the Review Hub's staging and base-branch rows.
 *
 * Every one of these lists answers the same three questions — which row is the
 * selection, which row is under the pointer, which row an open context menu
 * targets — and they had drifted into answering them with different fills, some
 * with hover brighter than the selection. So each surface is put through the
 * same states in one sweep:
 *
 *   rest      pointer parked off the page
 *   hover     pointer resting on a row that is not the selection
 *   menu      a row's context menu open, pointer moved off into the menu
 *   keys      the list focused and one arrow press (tree, diff, changes)
 *
 *   DAINTREE_SHOT_FILELIST=1 DAINTREE_SHOT_DIR=/abs/out \
 *     ./node_modules/.bin/playwright test --project=screenshots file-list-rows-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FILELIST  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       required — absolute output directory outside the repo
 *   DAINTREE_SHOT_THEMES    themes to sweep (default: daintree,bondi)
 *
 * Output: <surface>--<state>--<theme>.png. A frame is written only after its
 * state is verified, and the run counts the files on disk against the plan.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FILELIST;
const OUT_DIR = path.resolve(process.env.DAINTREE_SHOT_DIR ?? "");
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

interface Surface {
  slug: string;
  /** A row that is NOT the selection, for the hover and menu states. */
  target: (page: Page) => ReturnType<Page["locator"]>;
  /** Where focus lands for the keyboard state, or null for no keyboard state. */
  focus: ((page: Page) => ReturnType<Page["locator"]>) | null;
}

const within = (page: Page, slug: string) => page.locator(`[data-surface="${slug}"]`);

const SURFACES: Surface[] = [
  {
    slug: "tree",
    target: (page) => within(page, "tree").locator('[role="treeitem"][aria-label="main.tsx"]'),
    focus: (page) => within(page, "tree").locator('[role="tree"]'),
  },
  {
    slug: "diff",
    target: (page) => within(page, "diff").locator('[data-file-index="2"]'),
    focus: (page) => within(page, "diff").locator('[data-file-index="1"] button').first(),
  },
  {
    slug: "changes",
    target: (page) =>
      within(page, "changes").locator('[aria-label="Open src/components/FileRow.tsx"]'),
    focus: (page) => within(page, "changes").locator('[aria-label="Open src/index.css"]'),
  },
  {
    slug: "stage",
    target: (page) =>
      within(page, "stage").locator('[data-testid="file-stage-row-src/components/FileRow.tsx"]'),
    focus: null,
  },
];

const STATES = ["rest", "hover", "menu", "keys"] as const;
const plannedFiles = () =>
  THEMES.flatMap((theme) =>
    SURFACES.flatMap((s) =>
      STATES.filter((state) => state !== "keys" || s.focus).map(
        (state) => `${s.slug}--${state}--${theme}.png`
      )
    )
  );

test.use({ deviceScaleFactor: 2, viewport: { width: 1500, height: 520 } });

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!process.env.DAINTREE_SHOT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  const owned = new RegExp(`^(?:${SURFACES.map((s) => s.slug).join("|")})--.+\\.png$`);
  for (const file of readdirSync(OUT_DIR)) {
    if (owned.test(file)) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function load(page: Page, theme: string) {
  await stubViteHmrClient(page);
  const url = `${server!.baseURL}/file-list-rows-preview.html?theme=${theme}`;
  await page.goto(url);
  // A cold server optimises dependencies on the first request and asks the page
  // to reload — which the inert HMR client cannot do, so that page stays blank.
  // One reload picks up the optimised graph.
  const first = SURFACES[0]!.target(page);
  await first.waitFor({ timeout: 15_000 }).catch(() => page.reload());
  for (const s of SURFACES) await expect(s.target(page)).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(1, 1);
  // Let the state tier's colour transitions settle before any frame.
  await page.waitForTimeout(250);
}

const background = (page: Page, locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((el) => getComputedStyle(el).backgroundColor);

// One test, not one per theme: Playwright gives each test its own worker, and
// each worker's beforeAll would clear the frames the other one wrote.
test("file-list rows", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FILELIST is required for the file-list row capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FILELIST=1 to capture");
  const snap = makeSnap(OUT_DIR);
  for (const theme of THEMES) {
    for (const surface of SURFACES) {
      const frame = within(page, surface.slug);

      await load(page, theme);
      const restBg = await background(page, surface.target(page));
      await snap(frame, `${surface.slug}--rest--${theme}.png`);

      await surface.target(page).hover();
      await page.waitForTimeout(250);
      const hoverBg = await background(page, surface.target(page));
      if (hoverBg === restBg) {
        throw new Error(`${surface.slug}/${theme}: hover painted nothing (${hoverBg})`);
      }
      await snap(frame, `${surface.slug}--hover--${theme}.png`);

      await load(page, theme);
      await surface.target(page).click({ button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(surface.target(page)).toHaveAttribute("data-state", "open");
      // Pointer into the menu, so the frame shows the targeted row without hover.
      const box = await menu.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 4);
      await page.waitForTimeout(250);
      await snap(page.locator("body"), `${surface.slug}--menu--${theme}.png`);
      await page.keyboard.press("Escape");

      if (surface.focus) {
        await load(page, theme);
        await surface.focus(page).focus();
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(250);
        const inside = await frame.evaluate((el) => el.contains(document.activeElement));
        if (!inside) throw new Error(`${surface.slug}/${theme}: arrow key moved focus out`);
        await snap(frame, `${surface.slug}--keys--${theme}.png`);
      }
    }
  }
});

test.afterAll(() => {
  if (!ENABLED) return;
  const expected = plannedFiles();
  const onDisk = new Set(readdirSync(OUT_DIR));
  const missing = expected.filter((f) => !onDisk.has(f));
  if (missing.length > 0) throw new Error(`missing frames: ${missing.join(", ")}`);
});
