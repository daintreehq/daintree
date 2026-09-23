/**
 * Command HUD (Cmd+K chord indicator) visual-review harness.
 *
 * Sibling of `palette-review.spec.ts`, which deliberately never presses Cmd+K
 * because the HUD would sit over its captures. This one does nothing else. It
 * drives the preview entry (`command-hud-preview.html`) rather than booting
 * Electron: the real `ChordIndicator` against the real `KeybindingService`
 * default Cmd+K layer, over a dense terminal grid, opened and closed with real
 * keystrokes.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_COMMAND_HUD=1 npx playwright test --project=screenshots command-hud-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COMMAND_HUD  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/command-hud-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Settled states are captured with transitions frozen; the two `*-mid` states
 * are captured with motion live, part-way through the entry and the exit, so
 * the transition itself can be judged.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_COMMAND_HUD;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "command-hud-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const MOD = process.platform === "darwin" ? "Meta" : "Control";

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
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

interface OpenOptions {
  theme: string;
  width?: number;
  height?: number;
  long?: boolean;
  perf?: boolean;
  freeze?: boolean;
}

async function load(page: Page, opts: OpenOptions): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: opts.width ?? 1440, height: opts.height ?? 900 });
  const q = new URLSearchParams({ theme: opts.theme });
  if (opts.long) q.set("long", "1");
  if (opts.perf) q.set("perf", "1");
  await page.goto(`${baseURL}/command-hud-preview.html?${q.toString()}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  if (opts.freeze !== false) await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForTimeout(150);
}

const hud = (page: Page) => page.locator("[data-command-hud]");
const input = (page: Page) => page.getByRole("combobox", { name: "Search commands" });

/**
 * Whether the search input owns focus after opening. Read from `activeElement`
 * rather than `toBeFocused`, which reports every element inactive on a headless
 * page without OS focus. Recorded, not asserted, so a regression shows up in
 * `focus.json` beside the captures instead of costing the sweep.
 */
const focusLog: Record<string, boolean> = {};
async function inputOwnsFocus(page: Page): Promise<boolean> {
  return expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null), {
      timeout: 1500,
    })
    .toBe("Search commands")
    .then(() => true)
    .catch(() => false);
}

async function openHud(page: Page, label: string, mod = MOD): Promise<void> {
  await page.keyboard.press(`${mod}+K`);
  await expect(hud(page)).toBeVisible();
  focusLog[label] = await inputOwnsFocus(page);
  // Keep the sweep going either way: the states below are about rendering.
  if (!focusLog[label]) await input(page).focus();
  await page.waitForTimeout(250);
}

/**
 * Never write an unverified frame: the HUD must be mounted with a real box, and
 * the listbox must hold the number of rows the state claims (or the empty line).
 */
async function snap(
  page: Page,
  file: string,
  expectRows: number | "some" | "none" | "any",
  mode: "crop" | "full" = "crop"
): Promise<string> {
  const target = hud(page);
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 40 || box.height < 40) {
    throw new Error(`${file}: HUD has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const rows = page.locator('[data-command-hud] [role="option"]');
  if (expectRows === "none") await expect(rows).toHaveCount(0);
  else if (expectRows === "some") expect(await rows.count()).toBeGreaterThan(0);
  else if (typeof expectRows === "number") await expect(rows).toHaveCount(expectRows);

  const out = path.join(OUT_DIR, file);
  if (mode === "full") {
    await page.screenshot({ path: out });
  } else {
    const vp = page.viewportSize()!;
    const pad = 40;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    await page.screenshot({
      path: out,
      clip: {
        x,
        y,
        width: Math.min(box.width + pad * 2, vp.width - x),
        height: Math.min(box.height + pad * 2, vp.height - y),
      },
    });
  }
  return out;
}

test("Command HUD — states, platforms and themes", async ({ page, browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMMAND_HUD is required for the command HUD capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_COMMAND_HUD=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    // First chord key: the whole layer, over busy content.
    await load(page, { theme });
    await openHud(page, `open-${theme}`);
    written.push(await snap(page, `01-open-context-${theme}.png`, "some", "full"));
    written.push(await snap(page, `02-open-${theme}.png`, "some"));

    // Wrap to the last row — the scrolled end of the list.
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(100);
    written.push(await snap(page, `03-selected-last-${theme}.png`, "some"));

    // Many completions against few against none.
    await input(page).fill("terminal");
    written.push(await snap(page, `04-filter-many-${theme}.png`, "some"));
    await input(page).fill("push");
    written.push(await snap(page, `05-filter-few-${theme}.png`, 1));
    await input(page).fill("xyzzy");
    written.push(await snap(page, `06-no-match-${theme}.png`, "none"));

    // Long, plugin-contributed labels at a narrow window.
    await load(page, { theme, long: true, width: 640 });
    await openHud(page, `long-${theme}`);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(100);
    written.push(await snap(page, `07-long-labels-narrow-${theme}.png`, "some"));

    // Motion live: part-way into the entry, and part-way out of the exit.
    await load(page, { theme, freeze: false });
    await page.keyboard.press(`${MOD}+K`);
    await page.waitForTimeout(60);
    written.push(await snap(page, `08-enter-mid-${theme}.png`, "some"));
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
    // "any": the exit frame is judged on what it shows, including an emptied list.
    written.push(await snap(page, `09-exit-mid-${theme}.png`, "any"));
    await expect(hud(page)).toHaveCount(0, { timeout: 2000 });
  }

  // Degraded surfaces, one theme: performance mode, increased contrast,
  // forced colours.
  await load(page, { theme: "daintree", perf: true });
  await openHud(page, "perf");
  written.push(await snap(page, `10-perf-mode-daintree.png`, "some"));

  await page.emulateMedia({ contrast: "more" });
  await load(page, { theme: "daintree" });
  await openHud(page, "contrast-more");
  written.push(await snap(page, `11-contrast-more-daintree.png`, "some"));
  await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
  await load(page, { theme: "daintree" });
  await openHud(page, "forced-colors");
  written.push(await snap(page, `12-forced-colors-daintree.png`, "some"));
  await page.emulateMedia({ forcedColors: "none" });

  // Win/Linux key rendering: the display code keys off navigator.platform.
  const winContext = await browser.newContext({ deviceScaleFactor: 2 });
  const winPage = await winContext.newPage();
  winPage.on("pageerror", (e) => pageErrors.push(e.message));
  await winPage.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
  });
  await load(winPage, { theme: "daintree" });
  await openHud(winPage, "windows", "Control");
  written.push(await snap(winPage, `13-windows-keys-daintree.png`, "some"));
  await winContext.close();

  writeFileSync(path.join(OUT_DIR, "focus.json"), JSON.stringify(focusLog, null, 2));
  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * 9 + 4);
  console.log(`[command-hud-shots] wrote ${written.length} captures to ${OUT_DIR}`);
});
