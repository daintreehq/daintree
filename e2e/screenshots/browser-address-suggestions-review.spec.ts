/**
 * Browser address-bar history suggestions visual-review harness.
 *
 * The suggestion list only exists while the address bar is focused and typed
 * into, against a project's own visit history, so its long-URL, untitled,
 * narrow-pane and remove-control states are never seen side by side. This
 * drives `browser-address-suggestions-preview.html`, which mounts the real pane
 * chrome and `BrowserToolbar` with history seeded through `useUrlHistoryStore`,
 * and performs every state with real keys and a real pointer.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_ADDRESS_SUGGESTIONS is set.
 *
 *   DAINTREE_SHOT_ADDRESS_SUGGESTIONS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots browser-address-suggestions-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ADDRESS_SUGGESTIONS   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR                   required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES                themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP                 "0" skips the all-themes sweep of the keyboard-long state
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  ADDRESS_SUGGESTION_FIXTURES,
  ADDRESS_SUGGESTION_FIXTURE_NAMES,
  LONG_ROW_MATCH,
  type AddressSuggestionsFixture,
  type AddressSuggestionsFixtureName,
} from "../../src/components/Browser/__preview__/addressSuggestionsFixtures";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_ADDRESS_SUGGESTIONS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

const FRAME = "[data-fixture]";
const ADDRESS = '[data-testid="browser-address-bar"]';
const SELECTED = '[role="option"][aria-selected="true"]';
// Either shape of the remove control: a hidden span with the shared row-control
// treatment, or the bare button it replaced.
const REMOVE = '[data-testid="browser-history-remove"], button[aria-hidden="true"]';

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

let server: PreviewServer | undefined;

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
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, name: AddressSuggestionsFixtureName, theme: string): Promise<void> {
  const fixture: AddressSuggestionsFixture = ADDRESS_SUGGESTION_FIXTURES[name];
  await page.setViewportSize({ width: fixture.width + 80, height: 600 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[address-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/browser-address-suggestions-preview.html?theme=${theme}&fixture=${name}`;
  const frame = page.locator(FRAME).first();
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout: 30_000 });
  }
  // A Tailwind-drawn border on the address bar proves the stylesheet landed,
  // not just the markup.
  await expect(page.locator(ADDRESS)).toBeVisible();
  await expect(page.locator(ADDRESS)).toHaveCSS("border-top-style", "solid");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  // Favicons are data URIs; a broken one has to have fallen back before the shot.
  await page.waitForTimeout(150);
}

async function typeQuery(page: Page, query: string): Promise<void> {
  const address = page.locator(ADDRESS);
  await address.click();
  // Focus selects the address on a zero timeout; let it land before typing over it.
  await page.waitForTimeout(50);
  await address.fill(query);
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("option").nth(1)).toBeVisible();
}

async function arrowTo(page: Page, match: RegExp): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("ArrowDown");
    const text = (await page.locator(SELECTED).textContent()) ?? "";
    if (match.test(text)) return;
  }
  throw new Error(`no suggestion matching ${match} reachable from the keyboard`);
}

/** Perform the fixture's keyboard/pointer state and prove it is on screen. */
async function drive(page: Page, name: AddressSuggestionsFixtureName): Promise<void> {
  const fixture: AddressSuggestionsFixture = ADDRESS_SUGGESTION_FIXTURES[name];
  await typeQuery(page, fixture.query);
  const options = page.getByRole("option");
  switch (fixture.drive) {
    case "typed":
      await expect(page.locator(SELECTED)).toHaveCount(0);
      break;
    case "keyboard-first":
      await page.keyboard.press("ArrowDown");
      await expect(page.locator(SELECTED)).toHaveCount(1);
      break;
    case "keyboard-long":
      await arrowTo(page, LONG_ROW_MATCH);
      break;
    case "hover-row": {
      const row = options.nth(1);
      const box = await row.boundingBox();
      if (!box) throw new Error("second suggestion has no box");
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
      await expect(row).toHaveAttribute("aria-selected", "true");
      break;
    }
    case "hover-remove": {
      const row = options.nth(1);
      const rowBox = await row.boundingBox();
      if (!rowBox) throw new Error("second suggestion has no box");
      await page.mouse.move(rowBox.x + rowBox.width * 0.4, rowBox.y + rowBox.height / 2);
      const remove = row.locator(REMOVE).first();
      await expect(remove).toHaveCSS("opacity", "1");
      const box = await remove.boundingBox();
      if (!box) throw new Error("remove control has no box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect(row).toHaveAttribute("aria-selected", "true");
      break;
    }
    case "keyboard-removed": {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const removed = (await page.locator(SELECTED).textContent()) ?? "";
      await page.keyboard.press("Shift+Delete");
      // The list refills from the next match, so the count can hold; the row cannot.
      await expect(options.filter({ hasText: removed })).toHaveCount(0);
      // The cursor stays on the position, now the row that moved up into it.
      await expect(page.locator(SELECTED)).toHaveCount(1);
      await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
      break;
    }
  }
  await page.waitForTimeout(200);
}

/** The frame plus any tooltip that spills past it. */
async function clipFor(page: Page) {
  const box = await page.locator(FRAME).first().boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`frame has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  let { x, y } = box;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  for (const overlay of await page.locator("[data-radix-popper-content-wrapper]").all()) {
    const o = await overlay.boundingBox();
    if (!o || o.width < 2) continue;
    x = Math.min(x, o.x);
    y = Math.min(y, o.y);
    right = Math.max(right, o.x + o.width);
    bottom = Math.max(bottom, o.y + o.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

async function capture(
  page: Page,
  name: AddressSuggestionsFixtureName,
  theme: string,
  file: string
): Promise<string> {
  await open(page, name, theme);
  await drive(page, name);
  const listbox: Locator = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const fixture: AddressSuggestionsFixture = ADDRESS_SUGGESTION_FIXTURES[name];
  if (fixture.revealsDestination) {
    await expect(page.getByTestId("browser-suggestion-destination")).toBeVisible();
  }
  const listBox = await listbox.boundingBox();
  if (!listBox || listBox.height < 40) {
    throw new Error(
      `${file}: list has no real box (${JSON.stringify(listBox)}) — refusing to write`
    );
  }
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: await clipFor(page) });
  return out;
}

test("Browser address suggestions — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ADDRESS_SUGGESTIONS is required for the suggestions capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ADDRESS_SUGGESTIONS=1 to run the capture");
  test.setTimeout(20 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const written: string[] = [];
  for (const theme of THEMES) {
    for (const name of ADDRESS_SUGGESTION_FIXTURE_NAMES) {
      written.push(await capture(page, name, theme, `${name}--${theme}.png`));
    }
  }

  if (SWEEP) {
    for (const theme of ALL_THEMES) {
      written.push(
        await capture(page, "keyboard-long", theme, `sweep--keyboard-long--${theme}.png`)
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(
    THEMES.length * ADDRESS_SUGGESTION_FIXTURE_NAMES.length
  );
  console.log(`[address-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
