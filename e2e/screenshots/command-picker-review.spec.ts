/**
 * Command picker review harness.
 *
 * Drives the picker's own preview entry (`command-picker-preview.html`) rather
 * than booting Electron: the real `CommandPicker`, `SearchablePalette` and
 * `AppPaletteDialog`, the real theme tokens and `index.css`, fed manifest entries
 * in the shape `CommandService.list()` returns. The trigger is captured from the
 * composer's preview entry (`hybrid-input-preview.html`), which mounts the real
 * `HybridInputBar` the picker is opened from.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_COMMAND_PICKER is set.
 *
 *   DAINTREE_SHOT_COMMAND_PICKER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots command-picker-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COMMAND_PICKER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR             required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES          themes to sweep (default daintree,bondi,namib)
 *
 * Every capture asserts the state it claims before it is written, and the test
 * counts the files on disk at the end rather than trusting its own exit code.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_COMMAND_PICKER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

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
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

type Fixture = "shipped" | "no-forge" | "wide" | "loading" | "empty";

async function loadPicker(page: Page, theme: string, fixture: Fixture): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${baseURL}/command-picker-preview.html?theme=${theme}&fixture=${fixture}`);
  // Generous: a first load after a new import re-optimises Vite's deps.
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: 30_000 });
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForTimeout(200);
}

const dialog = (page: Page) => page.locator('[role="dialog"][aria-label="Command picker"]');
const input = (page: Page) => page.getByRole("combobox", { name: "Search commands" });
// Command rows only: category band labels are inert options too.
const options = (page: Page) => dialog(page).locator('[role="option"][data-command-id]');

/** Never write an unverified frame: the dialog must have a real box and the rows it claims. */
async function snap(
  page: Page,
  file: string,
  expectRows: number | "some" | "none",
  mode: "crop" | "full" = "crop"
): Promise<string> {
  const target = dialog(page);
  const box = await target.boundingBox();
  if (!box || box.width < 200 || box.height < 60) {
    throw new Error(`${file}: picker has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  if (expectRows === "none") await expect(options(page)).toHaveCount(0);
  else if (expectRows === "some") expect(await options(page).count()).toBeGreaterThan(0);
  else await expect(options(page)).toHaveCount(expectRows);

  const out = path.join(OUT_DIR, file);
  if (mode === "full") {
    await page.screenshot({ path: out });
  } else {
    const vp = page.viewportSize()!;
    const pad = 32;
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

async function expectSelected(page: Page, id: string): Promise<void> {
  await expect(input(page)).toHaveAttribute("aria-activedescendant", `command-${id}`);
}

async function snapTrigger(page: Page, theme: string, focus: boolean): Promise<string> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`${baseURL}/hybrid-input-preview.html?case=ladder&theme=${theme}&draft=empty`);
  const trigger = page.getByRole("button", { name: "Open command picker" }).first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: FREEZE_CSS });
  if (focus) {
    // A key first, so Chromium treats the programmatic focus as keyboard focus.
    await page.keyboard.press("Shift");
    await trigger.focus();
    await expect(trigger).toBeFocused();
  }
  await page.waitForTimeout(150);
  const root = page.locator("[data-hybrid-input-root]").first();
  const box = await root.boundingBox();
  if (!box || box.width < 100 || box.height < 16) {
    throw new Error(`trigger: composer has no real box (${JSON.stringify(box)})`);
  }
  const out = path.join(OUT_DIR, `${focus ? "13-trigger-focus" : "12-trigger-rest"}--${theme}.png`);
  // The leading third of the composer: the trigger and the start of the line it prompts.
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, box.x - 16),
      y: Math.max(0, box.y - 16),
      width: Math.min(420, box.width + 32),
      height: box.height + 32,
    },
  });
  return out;
}

test("Command picker — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMMAND_PICKER is required for the command picker capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_COMMAND_PICKER=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    // The shipped manifest: two GitHub commands, first one selected.
    await loadPicker(page, theme, "shipped");
    written.push(await snap(page, `01-shipped-context--${theme}.png`, 2, "full"));
    await expectSelected(page, "github:create-issue");
    written.push(await snap(page, `02-shipped--${theme}.png`, 2));

    await page.keyboard.press("ArrowDown");
    await expectSelected(page, "github:work-issue");
    written.push(await snap(page, `03-second-selected--${theme}.png`, 2));

    // One word that names one of the two commands. Captured at whatever count the
    // search actually returns: whether it narrows is part of what is under review.
    await input(page).fill("worktree");
    await expect(input(page)).toHaveValue("worktree");
    await page.waitForTimeout(150);
    written.push(await snap(page, `04-search-worktree--${theme}.png`, "some"));

    await input(page).fill("xyzzy");
    written.push(await snap(page, `05-no-match--${theme}.png`, "none"));

    // No forge provider: every shipped command is unavailable.
    await loadPicker(page, theme, "no-forge");
    await expect(options(page).and(page.locator('[aria-disabled="true"]'))).toHaveCount(2);
    written.push(await snap(page, `06-no-forge--${theme}.png`, 2));

    // Every category band, a disabled row among live ones, and a list that scrolls.
    await loadPicker(page, theme, "wide");
    written.push(await snap(page, `07-wide--${theme}.png`, 7));
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(100);
    written.push(await snap(page, `08-wide-last--${theme}.png`, 7));
    await input(page).fill("issue");
    await page.waitForTimeout(150);
    written.push(await snap(page, `09-wide-search--${theme}.png`, "some"));

    await loadPicker(page, theme, "loading");
    written.push(await snap(page, `10-loading--${theme}.png`, "none"));

    await loadPicker(page, theme, "empty");
    written.push(await snap(page, `11-empty--${theme}.png`, "none"));

    written.push(await snapTrigger(page, theme, false));
    written.push(await snapTrigger(page, theme, true));
  }

  // Forced colours, one theme: the selected row has to survive losing its fill.
  await page.emulateMedia({ forcedColors: "active" });
  await loadPicker(page, "daintree", "wide");
  await page.keyboard.press("ArrowDown");
  written.push(await snap(page, `14-forced-colors--daintree.png`, 7));
  await page.emulateMedia({ forcedColors: "none" });

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * 13 + 1);
  console.log(`[command-picker-shots] wrote ${written.length} captures to ${OUT_DIR}`);
});
