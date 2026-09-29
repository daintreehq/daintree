/**
 * Form field family — text inputs, selects and search boxes in Settings and dialogs.
 *
 * The question this harness answers is whether a field is one control wherever it
 * appears: a select beside an input on a settings rail, a dialog's form field, a
 * hand-rolled number box, a search box holding a query. So it captures the pages
 * those fields live on, and then each field kind at rest and under keyboard focus,
 * clipped tight enough to compare edges and rings side by side.
 *
 * One launch per run. The theme is switched through the real app-theme IPC, and
 * every surface is reached the way a user reaches it (settings deep link, the
 * plugin-manager event, the toolbar's new-worktree button).
 *
 *   DAINTREE_SHOT_FIELDS=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots fields-selects-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FIELDS   required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR     required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES   comma-separated theme ids (default: daintree,bondi)
 *
 * Output: <state>--<theme>.png plus manifest.json. Every frame is checked against
 * the state it claims (focus owner, typed value) before it is written, and the run
 * fails unless the files on disk match the manifest.
 */

import { expect, test, type Page, type Locator } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_FIELDS;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi").split(",").filter(Boolean);

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const navItem = (tab: string) => `.settings-sidebar [role="tab"][data-tab="${tab}"]`;
const panel = (tab: string) => `#settings-panel-${tab.replace(/:/g, "\\:")}`;

/** Pages whose fields this fix touches, captured as the first screens of the page. */
const PAGES: { tab: string; slices: number }[] = [
  { tab: "terminal", slices: 2 },
  { tab: "mcp", slices: 3 },
  { tab: "voice", slices: 2 },
  { tab: "assistant", slices: 3 },
  { tab: "agents", slices: 2 },
  { tab: "plugin-actions", slices: 2 },
  { tab: "project:general", slices: 2 },
  { tab: "project:context", slices: 1 },
];

const manifest: string[] = [];
const failures: string[] = [];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-fields-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "package.json"), '{"name":"helios","scripts":{"dev":"vite"}}\n');
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).slice(0, 300)}`);
  }
}

async function shot(page: Page, file: string, target: Locator, pad = 16): Promise<void> {
  await settle(page);
  const box = await target.boundingBox();
  if (!box) throw new Error(`${file}: target has no box`);
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, file),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, vp.width - x),
      height: Math.min(box.height + pad * 2, vp.height - y),
    },
  });
  manifest.push(file);
}

/**
 * Keyboard focus, so `:focus-visible` matches the way it does for a Tab press:
 * Chromium keys programmatic focus off the last input modality, so a modifier
 * press first makes the `.focus()` read as keyboard-driven.
 */
async function keyboardFocus(page: Page, target: Locator): Promise<void> {
  await page.keyboard.press("Shift");
  await target.focus();
  const ok = await target.evaluate(
    (el) => el === document.activeElement && el.matches(":focus-visible")
  );
  if (!ok) throw new Error("target did not take keyboard focus");
}

async function openSettingsAt(page: Page, tab: string): Promise<void> {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
    },
    { tab }
  );
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(navItem(tab))).toHaveAttribute("aria-selected", "true", {
    timeout: 15_000,
  });
  await settle(page, 700);
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .locator('[aria-label="Close settings"]')
    .click()
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

async function scrollerFor(page: Page, tab: string): Promise<{ step: number; max: number }> {
  return page.evaluate((panelId) => {
    document
      .querySelectorAll("[data-shot-scroller]")
      .forEach((el) => el.removeAttribute("data-shot-scroller"));
    const p = document.getElementById(panelId);
    if (!p) throw new Error(`no panel #${panelId}`);
    let el: HTMLElement | null = p.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
      el = el.parentElement;
    }
    if (!el) throw new Error("no scroller");
    el.setAttribute("data-shot-scroller", "");
    el.scrollTop = 0;
    return { step: Math.floor(el.clientHeight * 0.85), max: el.scrollHeight - el.clientHeight };
  }, `settings-panel-${tab}`);
}

async function capturePage(page: Page, tab: string, slices: number, theme: string): Promise<void> {
  await openSettingsAt(page, tab);
  const { step: stride, max } = await scrollerFor(page, tab);
  const count = Math.min(slices, Math.max(1, Math.ceil(max / stride) + 1));
  for (let i = 0; i < count; i++) {
    await page.evaluate((top) => {
      const el = document.querySelector<HTMLElement>("[data-shot-scroller]");
      if (el) el.scrollTop = top;
    }, i * stride);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(
      page,
      `page-${tab.replace(":", "_")}-p${i + 1}--${theme}.png`,
      page.locator(CARD).first(),
      0
    );
  }
}

/**
 * A select and an input on the same settings page, each at rest and under keyboard
 * focus, clipped to its own group so the two edges and rings can be laid side by side.
 */
async function captureRailPair(page: Page, theme: string): Promise<void> {
  const tab = "project:context";
  await openSettingsAt(page, tab);
  const kinds = [
    { name: "select", control: 'button[role="combobox"]' },
    { name: "input", control: 'input[data-slot="input"]' },
  ];
  for (const kind of kinds) {
    const control = page.locator(`${panel(tab)} ${kind.control}`).first();
    await control.waitFor({ state: "visible", timeout: 10_000 });
    await control.scrollIntoViewIfNeeded();
    const group = page
      .locator(`${panel(tab)} .settings-card`)
      .filter({ has: page.locator(kind.control) })
      .first();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, `rail-${kind.name}-rest--${theme}.png`, group, 12);
    await keyboardFocus(page, control);
    await shot(page, `rail-${kind.name}-focus--${theme}.png`, group, 12);
  }
}

/** The audit-log filter bar: search boxes beside the result and time-range selects. */
async function captureAuditFilters(page: Page, theme: string): Promise<void> {
  await openSettingsAt(page, "mcp");
  const bar = page.locator(`${panel("mcp")} [role="search"]`).first();
  await bar.waitFor({ state: "visible", timeout: 10_000 });
  await bar.scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shot(page, `audit-filters-rest--${theme}.png`, bar, 12);
  const select = bar.locator('select, button[role="combobox"]').first();
  await keyboardFocus(page, select);
  await shot(page, `audit-filters-select-focus--${theme}.png`, bar, 12);
}

async function captureWorktreeDialog(page: Page, theme: string): Promise<void> {
  await page.locator(SEL.worktree.newWorktreeButton).click();
  const palette = page.locator(SEL.worktree.quickCreatePalette);
  if (await palette.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.locator(SEL.worktree.quickCreateCustomize).click();
  }
  const dialog = page.locator(SEL.worktree.newDialog);
  await dialog.waitFor({ state: "visible", timeout: 8000 });
  await settle(page, 600);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shot(page, `worktree-dialog-rest--${theme}.png`, dialog, 0);
  const input = dialog.locator("input[type=text], input:not([type])").first();
  await keyboardFocus(page, input);
  await shot(page, `worktree-dialog-input-focus--${theme}.png`, dialog, 0);

  // The base-branch picker holding a query: the popover search strip, its clear
  // control, and what the first Escape does to the query and the picker.
  await dialog.locator('button[role="combobox"][aria-haspopup="listbox"]').first().click();
  const pickerInput = page.locator('[role="dialog"] input[role="combobox"]').last();
  await pickerInput.waitFor({ state: "visible", timeout: 8000 });
  await pickerInput.fill("ma");
  await expect(pickerInput).toHaveValue("ma");
  await settle(page, 400);
  await shot(page, `branch-picker-query--${theme}.png`, dialog, 0);
  await page.keyboard.press("Escape");
  await settle(page, 300);
  const pickerOpen = await pickerInput.isVisible().catch(() => false);
  writeFileSync(
    path.join(OUTPUT_DIR, `branch-picker-escape--${theme}.json`),
    JSON.stringify(
      {
        pickerOpen,
        valueAfterEscape: pickerOpen ? await pickerInput.inputValue() : null,
        dialogOpen: await dialog.isVisible(),
      },
      null,
      2
    )
  );
  if (pickerOpen) await page.keyboard.press("Escape");
  await settle(page, 300);

  for (let i = 0; i < 3 && (await dialog.isVisible().catch(() => false)); i++) {
    await page.keyboard.press("Escape");
    const discard = page.getByRole("button", { name: "Discard", exact: true });
    if (await discard.isVisible({ timeout: 500 }).catch(() => false)) await discard.click();
    await settle(page, 300);
  }
}

/** Voice input's provider fields only render while dictation is on. */
async function captureVoiceFields(page: Page, theme: string): Promise<void> {
  await openSettingsAt(page, "voice");
  const toggle = page.locator(`${panel("voice")} [role="switch"]`).first();
  await toggle.waitFor({ state: "visible", timeout: 10_000 });
  if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await settle(page, 700);
  const keySelector = 'input[autocomplete="new-password"]';
  const key = page.locator(`${panel("voice")} ${keySelector}`).first();
  await key.waitFor({ state: "visible", timeout: 10_000 });
  await key.scrollIntoViewIfNeeded();
  const group = page
    .locator(`${panel("voice")} .settings-card`)
    .filter({ has: page.locator(keySelector) })
    .first();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shot(page, `voice-key-rest--${theme}.png`, group, 12);
  await keyboardFocus(page, key);
  await shot(page, `voice-key-focus--${theme}.png`, group, 12);
  await toggle.click();
  await settle(page, 300);
}

const MANAGER = '[data-testid="plugin-manager-view"]';

async function capturePluginManager(page: Page, theme: string): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:open-plugin-manager")));
  const manager = page.locator(MANAGER);
  await manager.waitFor({ state: "visible", timeout: 10_000 });
  await settle(page, 800);
  const search = manager.locator(".search-field-input").first();
  await search.fill("git");
  await expect(search).toHaveValue("git");
  await keyboardFocus(page, search);
  const field = manager.locator(".search-field").first();
  await shot(page, `plugin-manager-search-query--${theme}.png`, field, 24);
  // Escape with a query should clear it and keep the view open.
  await page.keyboard.press("Escape");
  await settle(page, 300);
  const stillOpen = await manager.isVisible().catch(() => false);
  const value = stillOpen ? await search.inputValue().catch(() => "") : "";
  writeFileSync(
    path.join(OUTPUT_DIR, `plugin-manager-escape--${theme}.json`),
    JSON.stringify({ stillOpen, valueAfterEscape: value }, null, 2)
  );
  if (!stillOpen) {
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("daintree:open-plugin-manager"))
    );
    await manager.waitFor({ state: "visible", timeout: 10_000 });
    await settle(page, 600);
  }

  await manager.locator("button", { hasText: "Install plugin" }).first().click();
  await settle(page, 300);
  await page.locator('[role="menuitem"]', { hasText: "Install from URL" }).first().click();
  const urlDialog = page.locator('[role="dialog"]').filter({ hasText: "Install from URL" }).last();
  const urlInput = page.locator('input[aria-label="Plugin URL"]');
  await urlInput.waitFor({ state: "visible", timeout: 8000 });
  await settle(page, 400);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shot(page, `install-url-rest--${theme}.png`, urlDialog.locator("> div").first(), 0);
  await keyboardFocus(page, urlInput);
  await shot(page, `install-url-focus--${theme}.png`, urlDialog.locator("> div").first(), 0);
  for (let i = 0; i < 4 && (await manager.isVisible().catch(() => false)); i++) {
    await page.keyboard.press("Escape");
    await settle(page, 250);
  }
}

test.describe("fields and selects review", () => {
  test.setTimeout(900_000);

  test("captures the field family", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_FIELDS is required for the field-family capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_FIELDS=1 to run the field-family capture");
    if (!OUTPUT_DIR) throw new Error("DESIGN_CAPTURE_DIR is required");
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const repo = createRepo();
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-fieldsshot-"));
    let ctx: AppContext | undefined;
    try {
      ctx = await launchApp({ userDataDir });
      await ctx.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1440, 960);
      });
      let page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
      for (const theme of THEMES) {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS });
        await dismissBlockingPalette(page);
        await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
        await settle(page, 800);

        for (const p of PAGES)
          await step(`${theme} page ${p.tab}`, () => capturePage(page, p.tab, p.slices, theme));
        await step(`${theme} rail pair`, () => captureRailPair(page, theme));
        await step(`${theme} audit filters`, () => captureAuditFilters(page, theme));
        await step(`${theme} voice fields`, () => captureVoiceFields(page, theme));
        await closeSettings(page);
        await step(`${theme} worktree dialog`, () => captureWorktreeDialog(page, theme));
        await step(`${theme} plugin manager`, () => capturePluginManager(page, theme));
      }
      page = ctx.window;
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      rmSync(userDataDir, { recursive: true, force: true });
    }

    writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
    const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
    const missing = manifest.filter((f) => !onDisk.has(f));
    console.log(
      `[fields-shots] ${manifest.length - missing.length}/${manifest.length} PNGs → ${OUTPUT_DIR}`
    );
    if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
    if (failures.length > 0) throw new Error(`fields capture failed:\n  ${failures.join("\n  ")}`);
    expect(manifest.length).toBeGreaterThan(0);
  });
});
