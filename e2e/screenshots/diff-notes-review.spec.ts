/**
 * Diff review-notes visual-review harness.
 *
 * A note's chrome only shows its interesting states once the diff has moved
 * under it: a stale note, one whose lines aren't rendered, and the pending list
 * a file with no diff table falls back to. This drives the preview entry
 * (`diff-notes-preview.html`) instead of booting Electron: the real `DiffViewer`
 * and `PendingFileNotes` against the real notes store, seeded with anchors hashed
 * from the fixture diff, under the real theme tokens and `index.css`. The
 * composer and the editor are opened the way a user opens them — a gutter click
 * and the card's Edit button — and the status explanations are reached by
 * keyboard, since that is the path a native `title` never served.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DIFF_NOTES=1 npx playwright test --project=screenshots diff-notes-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DIFF_NOTES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/diff-notes-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated themes for every state (default: daintree,bondi)
 *   DAINTREE_SHOT_SWEEP       comma-separated extra themes for the placements only
 *                             (default: namib,hokkaido,arashiyama)
 *
 * Never writes a PNG it has not verified: every capture asserts the cards it
 * expects are rendered with a real box, a tooltip capture waits for the card to
 * finish fading in, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_DIFF_NOTES;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "diff-notes-shots")
);

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const THEMES = list(process.env.DAINTREE_SHOT_THEMES, "daintree,bondi");
const SWEEP = list(process.env.DAINTREE_SHOT_SWEEP, "namib,hokkaido,arashiyama");

const WIDTH = 760;
/** A diff pane sharing the window with an agent pane. */
const NARROW = 480;

let server: ViteDevServer | undefined;
let baseURL = "";

test.use({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 2 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // In a worktree `node_modules` is a symlink out of the project root, and Vite
  // refuses to serve through it without the real path on its allow list.
  const modules = realpathSync(path.join(process.cwd(), "node_modules"));
  server = await createServer({
    server: { port: 0, strictPort: false, fs: { allow: [process.cwd(), modules] } },
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

// Transitions off: a ring or a button fill caught mid-tween is a colour the
// product never rests on.
const POLISH_CSS = `
  *, *::before, *::after {
    caret-color: transparent !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  ::-webkit-scrollbar { display: none !important; }
`;

/** Load a scene and wait until its cards (and the diff's highlighting) have settled. */
async function open(
  page: Page,
  scene: "inline" | "detached" | "pending",
  theme: string,
  cards: number,
  {
    platform = "mac",
    view = "split",
    width = WIDTH,
    window = width,
  }: {
    platform?: "mac" | "win";
    view?: "split" | "unified";
    /** The diff pane's width. */
    width?: number;
    /** The window's, which can be wider: viewport units resolve against it, not the pane. */
    window?: number;
  } = {}
): Promise<Locator> {
  await page.setViewportSize({ width: window, height: 900 });
  await page.goto(
    `${baseURL}/diff-notes-preview.html?theme=${theme}&scene=${scene}&width=${width}&platform=${platform}&view=${view}`
  );
  await page.addStyleTag({ content: POLISH_CSS });
  const root = page.locator(`[data-preview-ready="${scene}"]`);
  await expect(root).toBeAttached();
  await expect(page.getByTestId("diff-note"), `${scene}/${theme}: card count`).toHaveCount(cards, {
    timeout: 15_000,
  });
  if (scene !== "pending") {
    await expect(root.locator("td.diff-code").first()).toBeVisible();
    // Highlighting arrives from the tokenizer a beat after the table; a capture
    // before it is a picture of plain text the user never sees.
    await expect
      .poll(() => root.locator("td.diff-code .token").count(), { timeout: 10_000 })
      .toBeGreaterThan(0)
      .catch(() => console.warn(`[diff-notes-shots] ${scene}/${theme}: no syntax tokens`));
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(window - 2, 2);
  return root;
}

async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.page().screenshot({
    path: out,
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 860) },
  });
  return out;
}

/** The area of the page that holds the notes and enough context to read them. */
function frame(page: Page): Locator {
  return page.locator("[data-preview-ready]");
}

/**
 * Tab to a card's status label and wait for its explanation. Falls back to a
 * hover when the label takes no focus, so a build without the explanation still
 * captures what a user gets — nothing.
 */
async function revealStatus(page: Page, status: "stale" | "unplaced"): Promise<void> {
  const label = page.locator(`[data-note-status="${status}"]`).first();
  const legacy = page
    .getByTestId("diff-note")
    .locator("span[title]")
    .filter({ hasText: status === "stale" ? "Stale" : "Not in view" })
    .first();
  const target = (await label.count()) > 0 ? label : legacy;
  await expect(target).toBeVisible();
  let focused = false;
  for (let i = 0; i < 24 && !focused; i++) {
    await page.keyboard.press("Tab");
    focused = await target.evaluate((el) => el === document.activeElement);
  }
  if (!focused) {
    await target.hover();
    return;
  }
  const explanation = status === "stale" ? /changed after/ : /shown in this view/;
  const card = page.locator("[data-radix-popper-content-wrapper]").filter({ hasText: explanation });
  await expect(card, `${status}: no explanation on keyboard focus`).toHaveCount(1);
  await expect
    .poll(() => card.locator("> *").evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
  // The walk crossed other cards' Edit and Delete; their captions fade out on
  // their own, and a frame with one mid-fade is not this state.
  await expect(page.locator("[data-radix-popper-content-wrapper]")).toHaveCount(1);
}

test("diff notes — placements, composer, editor and status explanations", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DIFF_NOTES is required for the diff-notes capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DIFF_NOTES=1 to run the capture");

  const written: string[] = [];

  for (const theme of THEMES) {
    // Two notes under their lines.
    const root = await open(page, "inline", theme, 2);
    written.push(await snap(frame(page), `01-inline-${theme}.png`));

    // The composer, opened from the gutter of the loop condition.
    const row = root
      .locator("tr")
      .filter({ has: page.locator("td.diff-code-insert", { hasText: /while \(attempt/ }) });
    await row.locator("td.diff-gutter-insert").first().click();
    const composer = page.getByTestId("diff-note-composer");
    await expect(composer).toBeVisible();
    await expect(composer.getByRole("textbox")).toBeFocused();
    written.push(await snap(frame(page), `02-composer-empty-${theme}.png`));

    await composer
      .getByRole("textbox")
      .fill("Bound this by the budget, but keep the throw below reachable for zero attempts.");
    await expect(composer.getByRole("button", { name: "Add note" })).toBeEnabled();
    written.push(await snap(frame(page), `03-composer-text-${theme}.png`));

    // Editing a saved note.
    await open(page, "inline", theme, 2);
    await page.getByTestId("diff-note").first().getByRole("button", { name: "Edit note" }).click();
    await expect(page.getByTestId("diff-note").first().getByRole("textbox")).toBeFocused();
    written.push(await snap(frame(page), `04-edit-${theme}.png`));

    // File, stale and unplaced notes above the table, one still under its line.
    await open(page, "detached", theme, 4);
    written.push(await snap(frame(page), `05-detached-${theme}.png`));
    await revealStatus(page, "stale");
    written.push(await snap(frame(page), `06-stale-explained-${theme}.png`));

    // The fallback list for a file with no diff table.
    await open(page, "pending", theme, 3);
    written.push(await snap(frame(page), `07-pending-${theme}.png`));
    await revealStatus(page, "unplaced");
    written.push(await snap(frame(page), `08-unplaced-explained-${theme}.png`));
  }

  // The editor's keys off macOS.
  const root = await open(page, "inline", THEMES[0]!, 2, { platform: "win" });
  await page.getByTestId("diff-note").first().getByRole("button", { name: "Edit note" }).click();
  await expect(root.getByRole("textbox")).toBeFocused();
  written.push(await snap(frame(page), `09-edit-win-${THEMES[0]}.png`));

  // Deleting from the keyboard hands focus to the next note's Edit.
  await open(page, "detached", THEMES[0]!, 4);
  const doomed = page.getByTestId("diff-note").nth(1);
  await doomed.getByRole("button", { name: "Delete note" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("diff-note")).toHaveCount(3);
  await expect(
    page.getByTestId("diff-note").nth(1).getByRole("button", { name: "Edit note" })
  ).toBeFocused();
  written.push(await snap(frame(page), `12-after-delete-${THEMES[0]}.png`));

  // Unified view in a narrow pane, where the thread pins to the scroller's edge.
  await open(page, "detached", THEMES[0]!, 4, { view: "unified", width: NARROW, window: 1280 });
  written.push(await snap(frame(page), `11-unified-narrow-${THEMES[0]}.png`));

  // The placements across the rest of the sweep.
  for (const theme of SWEEP) {
    await open(page, "detached", theme, 4);
    written.push(await snap(frame(page), `10-detached-${theme}.png`));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 8 + 3 + SWEEP.length);
  console.log(`[diff-notes-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
