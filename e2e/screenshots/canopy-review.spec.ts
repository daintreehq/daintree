/**
 * Canopy panel review harness.
 *
 * Drives the panel's own preview entry (`canopy-preview.html`) rather than
 * booting Electron: the real `CanopyView`, `CanopyCard` and `AppPaletteDialog`,
 * the real theme tokens and `index.css`, with the fleet and canopy stores seeded
 * in the shapes main pushes. The live route needs a fleet of real agents parked
 * at menus, questions and errors; the fixtures reach every card kind at once,
 * and the states nobody sees in a quiet afternoon.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_CANOPY is set.
 *
 *   DAINTREE_SHOT_CANOPY=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots canopy-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CANOPY   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES   themes to sweep (default daintree,bondi,namib)
 *
 * Every capture asserts the state it claims before it is written, and the test
 * counts the files on disk at the end rather than trusting its own exit code.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";
import type { CanopyFixture } from "../../src/components/Canopy/__preview__/fixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_CANOPY;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const CURRENT_PROJECT = "a".repeat(64);

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const repoRoot = realpathSync(process.cwd());
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

/**
 * Clear one test's own earlier frames. Per test rather than in beforeAll: a
 * failed test restarts the worker, and a beforeAll wipe would then delete the
 * frames every earlier test had already verified and written.
 */
function clearFrames(prefix: string): void {
  for (const file of readdirSync(OUT_DIR)) {
    if (file.startsWith(prefix) && file.endsWith(".png")) {
      rmSync(path.join(OUT_DIR, file), { force: true });
    }
  }
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Canopy" });
const cards = (page: Page) => dialog(page).locator("[data-canopy-card]");

async function load(
  page: Page,
  theme: string,
  fixture: CanopyFixture,
  viewport = { width: 1280, height: 1400 }
): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await stubViteHmrClient(page);
  // A screenshot cannot read back a WebGL canvas, so the live pane would capture
  // as a black box. Refusing WebGL here sends xterm to its DOM renderer — the
  // same fallback the pane takes when a context is lost — which captures.
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind === "webgl2" || kind === "webgl") return null;
      return getContext.call(this, kind as "2d", ...(rest as []));
    } as typeof getContext;
  });
  await page.setViewportSize(viewport);
  await page.goto(
    `${baseURL}/canopy-preview.html?theme=${theme}&fixture=${fixture}&projectId=${CURRENT_PROJECT}`
  );
  try {
    // Generous: a first load after a new import re-optimises Vite's deps.
    await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: 60_000 });
    await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  } catch (error) {
    // A blank page is almost always a throw during module evaluation; say which.
    throw new Error(`${fixture}: panel never mounted — ${errors.join("; ") || String(error)}`, {
      cause: error,
    });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: FREEZE_CSS });
  // The panel lands keyboard focus on its first card two frames after open.
  await page.waitForTimeout(250);
  if (errors.length > 0) throw new Error(`${fixture}: page errors — ${errors.join("; ")}`);
}

/** Never write an unverified frame: the dialog must have a real box and the cards it claims. */
async function snap(
  page: Page,
  file: string,
  expectCards: number | "none" | "some"
): Promise<string> {
  const target = dialog(page);
  const box = await target.boundingBox();
  if (!box || box.width < 400 || box.height < 120) {
    throw new Error(`${file}: panel has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  if (expectCards === "none") await expect(cards(page)).toHaveCount(0);
  else if (expectCards === "some") await expect(cards(page).first()).toBeVisible();
  else await expect(cards(page)).toHaveCount(expectCards);

  const vp = page.viewportSize()!;
  const pad = 24;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, vp.width - x),
      height: Math.min(box.height + pad * 2, vp.height - y),
    },
  });
  return out;
}

/** Every fleet run is in the one list, working agents included. */
const FLEET_CARDS = 11;

for (const theme of THEMES) {
  test(`canopy panel — ${theme}`, async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_CANOPY is required for the canopy panel capture",
    });
    test.skip(!ENABLED, "set DAINTREE_SHOT_CANOPY=1 to run the capture");
    test.setTimeout(240_000);
    const written: string[] = [];
    clearFrames(`${theme}--0`);
    clearFrames(`${theme}--1`);

    // The whole fleet in one ranked list, the most pressing run selected.
    await load(page, theme, "fleet");
    await expect(cards(page).first()).toBeFocused();
    written.push(await snap(page, `${theme}--01-fleet.png`, FLEET_CARDS));

    // The foot of the list: working agents ranked by how long they went unseen.
    await dialog(page)
      .locator("[data-canopy-card]")
      .last()
      .evaluate((el) => el.scrollIntoView({ block: "end" }));
    await page.waitForTimeout(100);
    written.push(await snap(page, `${theme}--02-list-foot.png`, FLEET_CARDS));

    // Keyboard down the queue: the pane beside it follows the cursor.
    await load(page, theme, "fleet");
    await expect(cards(page).first()).toBeFocused();
    for (let i = 0; i < 2; i += 1) await page.keyboard.press("ArrowDown");
    await expect(cards(page).nth(2)).toBeFocused();
    // Arriving on a row reads nothing by itself: a look reads it once it has
    // lasted, which main times, and the preview stands in for none of it.
    await expect(cards(page).nth(2)).toHaveAttribute("data-unread", "true");
    written.push(await snap(page, `${theme}--03-keyboard-down-the-inbox.png`, FLEET_CARDS));

    // Answer the first menu in its own live terminal, then start a reply on the question.
    await load(page, theme, "fleet");
    await expect(cards(page).first()).toBeFocused();
    await dialog(page).locator("[data-canopy-terminal] textarea").focus();
    await page.keyboard.press("1");
    await expect(page.locator("body")).toHaveAttribute("data-canopy-last", /"input"/);
    // The reply goes in the selected agent's own composer, in the pane.
    await dialog(page).locator('[data-canopy-card][data-kind="question"]').first().click();
    const composer = dialog(page).locator("[data-canopy-detail] .cm-content");
    await composer.fill("Start with the contract tests");
    await expect(composer).toBeFocused();
    written.push(await snap(page, `${theme}--04-answered-and-replying.png`, FLEET_CARDS));

    await load(page, theme, "describing");
    await expect(dialog(page).getByText("Approve the edit to electron/store.ts")).toHaveCount(0);
    written.push(await snap(page, `${theme}--05-describing.png`, "some"));

    await load(page, theme, "off");
    await expect(dialog(page).getByText("Every agent, read for you")).toBeVisible();
    written.push(await snap(page, `${theme}--06-off.png`, "some"));

    await load(page, theme, "read-error");
    await expect(dialog(page).getByText("Some screens couldn't be read")).toBeVisible();
    written.push(await snap(page, `${theme}--07-read-error.png`, "some"));

    // Nothing waiting on you: the working agents are the list, and it opens on the top one.
    await load(page, theme, "calm");
    await expect(cards(page).first()).toBeFocused();
    written.push(await snap(page, `${theme}--08-calm.png`, "some"));

    await load(page, theme, "empty");
    await expect(dialog(page).getByText("Launch an agent and it shows up here.")).toBeVisible();
    written.push(await snap(page, `${theme}--09-empty.png`, "none"));

    await load(page, theme, "long");
    written.push(await snap(page, `${theme}--10-long.png`, "some"));

    // A run that looks done: its title bar says so.
    await load(page, theme, "fleet");
    await dialog(page).locator('[data-canopy-card][data-kind="finished"]').first().click();
    await expect(dialog(page).locator("[data-canopy-looks-done]")).toBeVisible();
    written.push(await snap(page, `${theme}--11-looks-done.png`, FLEET_CARDS));

    // The panel's keys, one press away in the header rather than a standing footer.
    await load(page, theme, "fleet");
    await expect(cards(page).first()).toBeFocused();
    await dialog(page).getByRole("button", { name: "Keyboard shortcuts" }).click();
    await expect(page.getByText("In a reply or the terminal")).toBeVisible();
    written.push(await snap(page, `${theme}--12-shortcuts.png`, FLEET_CARDS));

    const onDisk = readdirSync(OUT_DIR).filter(
      (f) => /^[^-]+--\d/.test(f) && f.startsWith(`${theme}--`)
    );
    expect(onDisk.sort()).toEqual(written.map((f) => path.basename(f)).sort());
  });
}

/**
 * The inbox rows on their own: the list column cropped at 2x, tall enough that
 * every row fits without scrolling, in each state a row can be in.
 */
const ROWS_VIEWPORT = { width: 1280, height: 2400 };

/** The dialog caps its height and the list scrolls; for a row capture both grow to fit every row. */
const UNCLIP_LIST_CSS = `
  [data-testid="canopy-dialog"] > div { height: auto !important; max-height: none !important; }
  [data-canopy-list] { overflow: visible !important; max-height: none !important; }
`;

async function snapList(page: Page, file: string, expectCards: number | "some"): Promise<string> {
  await page.addStyleTag({ content: UNCLIP_LIST_CSS });
  const list = dialog(page).locator("[data-canopy-list]");
  const box = await list.boundingBox();
  if (!box || box.width < 200 || box.height < 120) {
    throw new Error(`${file}: list has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  if (expectCards === "some") await expect(cards(page).first()).toBeVisible();
  else await expect(cards(page)).toHaveCount(expectCards);
  const out = path.join(OUT_DIR, file);
  await list.screenshot({ path: out });
  return out;
}

for (const theme of THEMES) {
  test(`canopy rows — ${theme}`, async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_CANOPY is required for the canopy row capture",
    });
    test.skip(!ENABLED, "set DAINTREE_SHOT_CANOPY=1 to run the capture");
    test.setTimeout(240_000);
    const written: string[] = [];
    clearFrames(`${theme}--r`);

    // The list as it opens: the first row selected, every waiting row unread.
    await load(page, theme, "fleet", ROWS_VIEWPORT);
    await expect(cards(page).first()).toBeFocused();
    written.push(await snapList(page, `${theme}--r01-inbox.png`, FLEET_CARDS));

    // Keyboard down two rows: a focus ring on the third, the first two read.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(cards(page).nth(2)).toBeFocused();
    written.push(await snapList(page, `${theme}--r02-keyboard-focus.png`, FLEET_CARDS));

    // A pointer over a row that is not selected.
    await cards(page).nth(4).hover();
    await page.waitForTimeout(100);
    written.push(await snapList(page, `${theme}--r03-hover.png`, FLEET_CARDS));

    // The archive button takes the pointer on a row whose progress meter it
    // replaces: the faded meter must not sit over it and swallow the click.
    const measured = cards(page)
      .filter({ has: page.locator('[role="progressbar"]') })
      .first();
    await measured.hover();
    const archiveBox = await measured.locator("[data-canopy-row-archive]").boundingBox();
    expect(archiveBox).not.toBeNull();
    const archiveHit = await page.evaluate(
      ([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest("[data-canopy-row-archive]")),
      [archiveBox!.x + archiveBox!.width / 2, archiveBox!.y + archiveBox!.height / 2]
    );
    expect(archiveHit, "the archive button is under the pointer").toBe(true);

    // Only working agents: progress words, and the one gone unseen longest on top.
    await load(page, theme, "calm", ROWS_VIEWPORT);
    written.push(await snapList(page, `${theme}--r04-calm.png`, "some"));

    await load(page, theme, "describing", ROWS_VIEWPORT);
    written.push(await snapList(page, `${theme}--r05-describing.png`, "some"));

    await load(page, theme, "read-error", ROWS_VIEWPORT);
    written.push(await snapList(page, `${theme}--r06-read-error.png`, "some"));

    // Off shows the pitch rather than a list, so it has no row capture.
    await load(page, theme, "long", ROWS_VIEWPORT);
    written.push(await snapList(page, `${theme}--r08-long.png`, "some"));

    // E archives the selected run: it leaves the list for the Archived group,
    // and the cursor moves on to the next run.
    await load(page, theme, "fleet", ROWS_VIEWPORT);
    await expect(cards(page).first()).toBeFocused();
    await page.keyboard.press("e");
    await dialog(page)
      .getByRole("button", { name: /Archived/ })
      .click();
    await expect(cards(page)).toHaveCount(FLEET_CARDS);
    written.push(await snapList(page, `${theme}--r09-archived.png`, FLEET_CARDS));
    await dialog(page)
      .getByRole("button", { name: /Archived/ })
      .click();

    const onDisk = readdirSync(OUT_DIR).filter((f) => f.startsWith(`${theme}--r`));
    expect(onDisk.sort()).toEqual(written.map((f) => path.basename(f)).sort());
  });
}
