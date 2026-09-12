/**
 * Drag ghost and drop placeholder visual-review harness.
 *
 * Every state under `src/components/DragDrop/` exists only while a pointer is
 * down — a ghost following the cursor, a placeholder holding a slot open, an
 * insertion line between two chips, the source dimmed where it was lifted. In
 * the real app they last a second or two and have never been looked at
 * deliberately; this spec makes each one hold still.
 *
 * It drives the surface's own preview entry (`drag-drop-preview.html`) rather
 * than booting Electron: the real components, the real theme tokens through
 * `applyAppThemeToRoot`, the real `index.css`. Forced states (ghosts and
 * placeholders) come from fixtures; the states that live inside dnd-kit
 * (source dim, insertion lines) come from a genuine pointer drag performed
 * here against a sandboxed `DndContext`, captured mid-gesture.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DRAGDROP=1 npx playwright test --project=screenshots drag-drop-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DRAGDROP      required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           output directory (default artifacts/drag-drop-shots, gitignored)
 *   DAINTREE_SHOT_THEMES        themes for the full state matrix (default: daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP_THEMES  themes for the one-page-per-theme sheet (default: all 15; "" skips)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts a real box before it writes, the drag captures
 * assert the indicator they claim to show is actually in the DOM, and the test
 * counts the files itself rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DRAGDROP;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "drag-drop-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ALL_THEMES =
  "daintree,bondi,table-mountain,arashiyama,fiordland,galapagos,highlands,namib,redwoods,atacama,bali,hokkaido,serengeti,svalbard,movile";
const SWEEP_THEMES = (process.env.DAINTREE_SHOT_SWEEP_THEMES ?? ALL_THEMES)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `GHOSTS` / `WORKTREE_GHOSTS` in the preview fixtures. */
const GHOST_SHOTS = [
  "ghost-shell",
  "ghost-claude-working",
  "ghost-claude-waiting",
  "ghost-codex-directing",
  "ghost-gemini-group",
  "ghost-exited-agent",
  "ghost-long-title",
  "ghost-browser",
  "ghost-dev-preview",
  "ghost-review",
  "ghost-file",
  "ghost-file-browser",
  "ghost-diff",
  "ghost-plugin",
  "wt-issue",
  "wt-branch-only",
  "wt-main",
  "wt-long-issue",
] as const;

/** Mirrors `PLACEHOLDER_KINDS`, plus the no-active-terminal fallback for the grid. */
const GRID_KINDS = [
  "terminal",
  "agent",
  "browser",
  "dev-preview",
  "review",
  "file",
  "file-browser",
  "diff",
  "plugin",
  "none",
] as const;
const DOCK_KINDS = [
  "terminal",
  "agent",
  "browser",
  "dev-preview",
  "review",
  "file",
  "plugin",
] as const;

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Load one scene in one theme, and settle it. */
async function open(page: Page, query: Record<string, string>): Promise<Locator> {
  await page.setViewportSize({ width: 1400, height: 900 });
  const search = new URLSearchParams(query).toString();
  const url = `${server!.baseURL}/drag-drop-preview.html?${search}`;
  const shell = page.locator("[data-preview-shell]").first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(shell).toBeAttached({ timeout });
  } catch {
    console.warn(`[drag-drop-shots] first mount of ?${search} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(shell).toBeAttached({ timeout });
  }
  // Mounted is not styled. Every shell is a flex or grid container via a
  // Tailwind utility, so its computed display proves the stylesheet landed.
  await expect
    .poll(() => shell.evaluate((el) => getComputedStyle(el).display), {
      message: `?${search} rendered unstyled — refusing to capture`,
    })
    .toMatch(/^(flex|grid)$/);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  return shell;
}

async function pointerDown(page: Page, handle: Locator): Promise<{ x: number; y: number }> {
  const box = await handle.boundingBox();
  if (!box) throw new Error("drag handle has no box — refusing to drag");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y };
}

async function glide(page: Page, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(to.x, to.y, { steps: 12 });
  // The sortable strategy shifts neighbours under the pointer; a second, tiny
  // move after they settle lets dnd-kit re-resolve `over` against the moved rects.
  await page.mouse.move(to.x + 1, to.y, { steps: 2 });
  await page.waitForTimeout(300);
}

/**
 * A state indicator that compiled to nothing still exists in the DOM, so a
 * structural check would pass while the frame shows no line at all. Read the
 * painted colour and refuse anything transparent.
 */
async function expectPainted(target: Locator, property: "background-color" | "border-top-color") {
  const value = await target.evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property
  );
  const alpha = value.match(/rgba?\([^)]*,\s*([\d.]+)\)$/)?.[1];
  const transparent = value === "transparent" || value === "rgba(0, 0, 0, 0)" || alpha === "0";
  if (transparent)
    throw new Error(`${property} painted transparent (${value}) — refusing to write`);
}

async function expectActiveDrag(shell: Locator): Promise<void> {
  await expect(
    shell.locator("[data-sandbox-active]"),
    "the pointer gesture never registered as a drag — refusing to capture"
  ).toBeAttached();
}

test("drag ghosts and drop placeholders — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DRAGDROP is required for the drag-drop capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DRAGDROP=1 to run the capture");
  test.setTimeout(20 * 60_000);

  await stubViteHmrClient(page);

  const written: string[] = [];

  for (const theme of THEMES) {
    // Ghosts: the gallery, then each card alone at the size the eye judges it.
    {
      const shell = await open(page, { theme, scene: "ghosts" });
      written.push(await snap(shell, `ghosts-gallery-${theme}.png`));
      for (const shot of GHOST_SHOTS) {
        const target = shell.locator(`[data-shot="${shot}"]`);
        await expect(target.locator(":scope > *"), `${shot} rendered nothing`).toHaveCount(1);
        written.push(await snap(target, `${shot}-${theme}.png`));
      }
    }

    // Grid placeholder, per kind, between real-recipe panels.
    for (const kind of GRID_KINDS) {
      const shell = await open(page, { theme, scene: "grid", kind });
      const target = shell.locator('[data-shot="grid-placeholder"]');
      await expect(target.locator(":scope > *"), `grid/${kind} rendered nothing`).toHaveCount(1);
      await expectPainted(target.locator(":scope > *"), "border-top-color");
      written.push(await snap(shell, `grid-${kind}-${theme}.png`));
    }

    // Dock placeholder, per kind, in the empty rail with the drag-over highlight.
    for (const kind of DOCK_KINDS) {
      const shell = await open(page, { theme, scene: "dock", kind, over: "1" });
      const target = shell.locator('[data-shot="dock-placeholder"]');
      await expect(target.locator(":scope > *"), `dock/${kind} rendered nothing`).toHaveCount(1);
      await expectPainted(target.locator(":scope > *"), "border-top-color");
      written.push(await snap(shell, `dock-${kind}-${theme}.png`));
    }

    // Source dim in the grid, mid-drag, with the real overlay ghost in frame.
    {
      const shell = await open(page, { theme, scene: "drag-grid" });
      const handle = shell.locator("[data-fixture-handle]").first();
      const from = await pointerDown(page, handle);
      await glide(page, { x: from.x + 220, y: from.y + 140 });
      await expectActiveDrag(shell);
      written.push(await snap(shell, `drag-grid-source-${theme}.png`));
      await page.mouse.up();
    }

    // Dock reorder: source dim plus the insertion line, in both directions.
    {
      const shell = await open(page, { theme, scene: "drag-dock" });
      const chips = shell.locator("[data-dock-item]");
      await expect(chips).toHaveCount(3);
      // The sortable strategy slides the dragged chip into its projected slot,
      // so the hovered neighbour's midpoint is always on the far side of the
      // travel: a first chip dragged right yields `before`, a last chip dragged
      // left yields `after`. Each direction has to start from its own end.
      const seen = new Set<string>();
      for (const [source, target, frac] of [
        [0, 2, 0.85],
        [2, 0, 0.15],
      ] as const) {
        const box = await chips.nth(target).boundingBox();
        if (!box) throw new Error("dock chip has no box");
        await pointerDown(page, chips.nth(source));
        await glide(page, { x: box.x + box.width * frac, y: box.y + box.height / 2 });
        await expectActiveDrag(shell);
        const indicator = shell.locator("[data-dock-drop-indicator]");
        await expect(indicator, "no dock insertion line rendered mid-drag").toHaveCount(1);
        await expectPainted(indicator, "background-color");
        const direction = (await indicator.getAttribute("data-dock-drop-indicator")) ?? "unknown";
        if (!seen.has(direction)) {
          seen.add(direction);
          written.push(await snap(shell, `drag-dock-line-${direction}-${theme}.png`));
        }
        await page.mouse.up();
        await page.waitForTimeout(150);
      }
      if (seen.size < 2) {
        throw new Error(
          `dock drag produced only ${[...seen].join(",")} — both insertion directions are states`
        );
      }
    }

    // Sidebar reorder: row dim plus the above/below line.
    {
      const shell = await open(page, { theme, scene: "drag-sidebar" });
      const rows = shell.locator("[data-worktree-row]");
      await expect(rows).toHaveCount(3);
      const grips = shell.getByRole("button", { name: "Reorder worktree" });
      const seen = new Set<string>();
      for (const [source, target, frac] of [
        [0, 2, 0.8],
        [2, 0, 0.2],
      ] as const) {
        const box = await rows.nth(target).boundingBox();
        if (!box) throw new Error("worktree row has no box");
        await pointerDown(page, grips.nth(source));
        await glide(page, { x: box.x + box.width / 2, y: box.y + box.height * frac });
        await expectActiveDrag(shell);
        const indicator = shell.locator("[data-worktree-drop-indicator]");
        await expect(indicator, "no worktree insertion line rendered mid-drag").toHaveCount(1);
        await expectPainted(indicator, "background-color");
        const direction =
          (await indicator.getAttribute("data-worktree-drop-indicator")) ?? "unknown";
        if (!seen.has(direction)) {
          seen.add(direction);
          written.push(await snap(shell, `drag-sidebar-line-${direction}-${theme}.png`));
        }
        await page.mouse.up();
        await page.waitForTimeout(150);
      }
      if (seen.size < 2) {
        throw new Error(
          `sidebar drag produced only ${[...seen].join(",")} — both insertion directions are states`
        );
      }
    }
  }

  // Dock geometry questions are density questions, not palette ones: the two
  // other densities, the rail without its highlight, and the idle spacer, in
  // the first theme only.
  {
    const theme = THEMES[0]!;
    for (const density of ["compact", "comfortable"] as const) {
      const shell = await open(page, { theme, scene: "dock", kind: "browser", over: "1", density });
      written.push(await snap(shell, `dock-browser-${density}-${theme}.png`));
    }
    {
      const shell = await open(page, { theme, scene: "dock", kind: "terminal" });
      written.push(await snap(shell, `dock-terminal-noover-${theme}.png`));
    }
    {
      // Idle: the placeholder must hold its slot with no visible art at all.
      const shell = await open(page, { theme, scene: "dock", kind: "terminal", dragging: "0" });
      const spacer = shell.locator('[data-shot="dock-placeholder"] > *');
      await expect(spacer).toHaveCount(1);
      await expect(spacer.locator(":scope > *")).toHaveCount(0);
      written.push(await snap(shell, `dock-spacer-idle-${theme}.png`));
    }
  }

  // The sweep: one composite page per theme, then the same page mid-drag for
  // the dock line and the row line. Theme-specific collapse only shows up here.
  for (const theme of SWEEP_THEMES) {
    const shell = await open(page, { theme, scene: "sheet", width: "1360" });
    written.push(await snap(shell, `sheet-${theme}.png`));

    const chips = shell.locator("[data-sheet-dock] [data-dock-item]");
    await expect(chips).toHaveCount(3);
    const chipBox = await chips.nth(2).boundingBox();
    if (!chipBox) throw new Error("sheet dock chip has no box");
    await pointerDown(page, chips.nth(0));
    await glide(page, { x: chipBox.x + chipBox.width * 0.85, y: chipBox.y + chipBox.height / 2 });
    await expect(shell.locator("[data-dock-drop-indicator]")).toHaveCount(1);
    written.push(await snap(shell, `sheet-dockline-${theme}.png`));
    await page.mouse.up();
    await page.waitForTimeout(150);

    const rows = shell.locator("[data-sheet-sidebar] [data-worktree-row]");
    await expect(rows).toHaveCount(3);
    const rowBox = await rows.nth(2).boundingBox();
    if (!rowBox) throw new Error("sheet worktree row has no box");
    await pointerDown(page, shell.getByRole("button", { name: "Reorder worktree" }).nth(0));
    await glide(page, { x: rowBox.x + rowBox.width / 2, y: rowBox.y + rowBox.height * 0.8 });
    await expect(shell.locator("[data-worktree-drop-indicator]")).toHaveCount(1);
    written.push(await snap(shell, `sheet-rowline-${theme}.png`));
    await page.mouse.up();
  }

  // Count the files ourselves. A harness that trusts its own exit code is how
  // a review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(new Set(written).size).toBe(written.length);
  console.log(`[drag-drop-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
