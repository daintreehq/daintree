/**
 * Keyboard shortcuts and command overrides visual-review harness.
 *
 * `settings-pages-review` captures every settings page at rest. These two pages carry
 * most of their design weight in states a rest capture never reaches: a row being
 * rebound, a captured combo that collides with another action, a customised binding,
 * a search with no results, the reset-all confirmation, an expanded command with its
 * defaults or prompt editor, a prompt that fails validation, a disabled command. This
 * harness drives each of them through the shipping UI and the real action dispatch
 * seam (`keybinding.setOverride`), in a dark and a light theme in one launch.
 *
 *   DAINTREE_SHOT_SETTINGS_KEYBOARD=1 DAINTREE_SHOT_DIR=/tmp/out \
 *     npx playwright test --project=screenshots settings-keyboard-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SETTINGS_KEYBOARD  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR                required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES             comma-separated theme ids (default `,bondi`; empty = app default)
 *
 * A manifest.json beside the PNGs lists every state written, and the run fails unless
 * the files on disk match it and every state's own precondition held when it was shot.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";

const ENABLED = !!process.env.DAINTREE_SHOT_SETTINGS_KEYBOARD;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ",bondi").split(",");

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CLOSE = '[aria-label="Close settings"]';
const navItem = (tab: string) => `.settings-sidebar [role="tab"][data-tab="${tab}"]`;
const KEYBOARD_PANEL = "#settings-panel-keyboard";
const COMMANDS_PANEL = "#settings-panel-project\\:commands";

const PROJECT_NAME = "Helios Dashboard";
const WIDE = { width: 1680, height: 1050 };

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

// Seeded customisations, so the rest state shows a modified binding and an unbound one.
const OVERRIDES: { actionId: string; combo: string[] }[] = [
  { actionId: "nav.quickSwitcher", combo: ["Cmd+Alt+P"] },
  { actionId: "nav.focusRegion.next", combo: [] },
];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-settings-keyboard-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
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

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
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

/** Reopen the tab when a failed step's recovery closed the dialog under the next one. */
async function ensureAt(page: Page, tab: string): Promise<void> {
  const selected = await page
    .locator(navItem(tab))
    .getAttribute("aria-selected", { timeout: 500 })
    .catch(() => null);
  if (selected !== "true") await openSettingsAt(page, tab);
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .locator(CLOSE)
    .click()
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

/** Scroll the page's own scrollport so `selector` sits `where` in view, or to the top. */
async function scrollPanel(
  page: Page,
  panel: string,
  target: { selector?: string; where?: "start" | "center" | "end"; top?: number }
): Promise<void> {
  await page.evaluate(
    ({ panel, target }) => {
      const panelEl = document.querySelector<HTMLElement>(panel);
      if (!panelEl) throw new Error(`no panel ${panel}`);
      let scroller: HTMLElement | null = panelEl.parentElement;
      while (scroller) {
        const oy = getComputedStyle(scroller).overflowY;
        if ((oy === "auto" || oy === "scroll") && scroller.clientHeight > 0) break;
        scroller = scroller.parentElement;
      }
      if (!scroller) throw new Error("no scroll container above the tab panel");
      if (target.selector) {
        const el = panelEl.querySelector<HTMLElement>(target.selector);
        if (!el) throw new Error(`no ${target.selector} in ${panel}`);
        el.scrollIntoView({ block: target.where ?? "center" });
      } else if (target.top === Number.POSITIVE_INFINITY || target.top === -1) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        scroller.scrollTop = target.top ?? 0;
      }
    },
    { panel, target: { ...target, top: target.top === Infinity ? -1 : target.top } }
  );
  await settle(page, 200);
}

interface ManifestEntry {
  file: string;
  state: string;
  theme: string;
}

const manifest: ManifestEntry[] = [];
const failures: string[] = [];

async function shoot(page: Page, state: string, theme: string): Promise<void> {
  await page.mouse.move(2, 2);
  await settle(page, 250);
  const file = `${state}--${theme || "default"}.png`;
  await page
    .locator(CARD)
    .first()
    .screenshot({
      path: path.join(OUTPUT_DIR, file),
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
  manifest.push({ file, state, theme: theme || "default" });
}

/** Like `shoot`, but keeps the pointer where the state put it (hover states). */
async function shootHover(page: Page, state: string, theme: string): Promise<void> {
  await settle(page, 250);
  const file = `${state}--${theme || "default"}.png`;
  await page
    .locator(CARD)
    .first()
    .screenshot({ path: path.join(OUTPUT_DIR, file), type: "png", caret: "hide" });
  manifest.push({ file, state, theme: theme || "default" });
}

let activePage: Page | null = null;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).slice(0, 400)}`);
    // A palette or confirm left open by the failed step would swallow every click
    // in the steps after it; clear it so one failure costs one state, not the run.
    if (activePage) {
      await dismissBlockingPalette(activePage).catch(() => {});
      await activePage.keyboard.press("Escape").catch(() => {});
    }
  }
}

async function captureKeyboard(page: Page, theme: string): Promise<void> {
  const panel = page.locator(KEYBOARD_PANEL);
  const rows = panel.locator('[data-testid="shortcut-row"]');
  const search = panel.getByRole("textbox", { name: "Search shortcuts" });

  await step("keyboard-rest", async () => {
    await openSettingsAt(page, "keyboard");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await scrollPanel(page, KEYBOARD_PANEL, { top: 0 });
    await shoot(page, "kb-01-rest-top", theme);
  });

  await step("keyboard-modified", async () => {
    await ensureAt(page, "keyboard");
    const row = rows.filter({ hasText: "Open Quick Switcher" }).first();
    await expect(row).toBeVisible();
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await settle(page, 200);
    await shoot(page, "kb-02-modified-and-unbound", theme);
    await row.hover();
    await shootHover(page, "kb-03-modified-row-hover", theme);
  });

  await step("keyboard-bottom", async () => {
    await ensureAt(page, "keyboard");
    await scrollPanel(page, KEYBOARD_PANEL, { top: Infinity });
    await shoot(page, "kb-04-rest-bottom", theme);
  });

  await step("keyboard-search", async () => {
    await ensureAt(page, "keyboard");
    await scrollPanel(page, KEYBOARD_PANEL, { top: 0 });
    await search.fill("worktree");
    await settle(page, 300);
    expect(await rows.count()).toBeGreaterThan(0);
    await shoot(page, "kb-05-search-results", theme);
    await search.fill("zzqx");
    await settle(page, 300);
    expect(await rows.count()).toBe(0);
    await shoot(page, "kb-06-search-empty", theme);
    await search.fill("");
    await settle(page, 300);
  });

  await step("keyboard-edit", async () => {
    await ensureAt(page, "keyboard");
    const row = rows.filter({ hasText: "Close focused terminal" }).first();
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await row.hover();
    await row
      .getByRole("button", { name: /^Edit|Change shortcut|Rebind/ })
      .first()
      .click();
    await settle(page, 300);
    await shoot(page, "kb-07-edit-idle", theme);

    const record = page.getByRole("button", { name: /record/i }).first();
    if (await record.isVisible().catch(() => false)) await record.click();
    await settle(page, 200);
    await shoot(page, "kb-08-edit-recording", theme);

    // Cmd+B is Toggle sidebar's default: a live binding whose action is harmless if
    // the keystroke leaks past the recorder.
    await page.keyboard.press("Meta+KeyB");
    await page.waitForTimeout(1600);
    await settle(page, 300);
    await expect(page.getByText(/conflict|already used|Also bound|in use/i).first()).toBeVisible({
      timeout: 5000,
    });
    await shoot(page, "kb-09-edit-conflict", theme);

    // A free combo from a fresh edit: the clean captured state with Save available.
    await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await settle(page, 200);
    await row.hover();
    await row
      .getByRole("button", { name: /^Edit|Change shortcut|Rebind/ })
      .first()
      .click();
    await settle(page, 200);
    const recordAgain = page.getByRole("button", { name: /record/i }).first();
    if (await recordAgain.isVisible().catch(() => false)) await recordAgain.click();
    await settle(page, 200);
    await page.keyboard.press("Meta+Shift+Alt+KeyY");
    await page.waitForTimeout(1600);
    await settle(page, 300);
    await shoot(page, "kb-10-edit-captured", theme);

    await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await settle(page, 200);
  });

  await step("keyboard-reset-all", async () => {
    await ensureAt(page, "keyboard");
    await scrollPanel(page, KEYBOARD_PANEL, { top: 0 });
    await page
      .getByRole("button", { name: /^Reset all/i })
      .first()
      .click();
    await expect(
      page
        .getByRole("alertdialog")
        .or(page.getByRole("dialog", { name: /Reset/ }))
        .first()
    ).toBeVisible({
      timeout: 5000,
    });
    await settle(page, 300);
    await page.mouse.move(2, 2);
    await settle(page, 200);
    const file = `kb-11-reset-all-confirm--${theme || "default"}.png`;
    await page.screenshot({ path: path.join(OUTPUT_DIR, file), type: "png", caret: "hide" });
    manifest.push({ file, state: "kb-11-reset-all-confirm", theme: theme || "default" });
    await page.keyboard.press("Escape");
    await settle(page, 300);
  });

  await closeSettings(page);
}

async function captureCommands(page: Page, theme: string): Promise<void> {
  const panel = page.locator(COMMANDS_PANEL);

  await step("commands-rest", async () => {
    await openSettingsAt(page, "project:commands");
    await expect(panel.getByText("github:create-issue").first()).toBeVisible({ timeout: 20_000 });
    await settle(page, 400);
    await shoot(page, "cmd-01-rest", theme);
  });

  await step("commands-defaults", async () => {
    await ensureAt(page, "project:commands");
    await panel
      .getByRole("button", { name: /Expand|github:create-issue/ })
      .first()
      .click();
    await settle(page, 300);
    await shoot(page, "cmd-02-expanded-defaults", theme);
    const field = panel.getByRole("textbox", { name: /labels/i }).first();
    await field.fill("enhancement,ui");
    await settle(page, 300);
    await shoot(page, "cmd-03-default-set", theme);
  });

  await step("commands-prompt", async () => {
    await ensureAt(page, "project:commands");
    await panel
      .getByRole("radio", { name: /Custom prompt/ })
      .first()
      .click();
    await settle(page, 300);
    await shoot(page, "cmd-04-prompt-empty", theme);
    await panel.locator("textarea").first().fill("Create an issue about {title} with {nope}");
    await settle(page, 300);
    await shoot(page, "cmd-05-prompt-invalid", theme);
    await panel
      .locator("textarea")
      .first()
      .fill("Create an issue titled {title} and tag it {labels}");
    await settle(page, 300);
    await shoot(page, "cmd-06-prompt-valid", theme);
  });

  await step("commands-disabled", async () => {
    await ensureAt(page, "project:commands");
    await panel
      .getByRole("button", { name: /Collapse/ })
      .first()
      .click()
      .catch(() => {});
    const toggles = panel.locator(
      'button[aria-label="Command enabled"], [role="switch"][aria-label*="work-issue"], [role="switch"]'
    );
    await toggles.last().click();
    await settle(page, 300);
    await shoot(page, "cmd-07-disabled", theme);
  });

  await step("commands-filters", async () => {
    await ensureAt(page, "project:commands");
    await panel.getByRole("radio", { name: "Overridden" }).first().click();
    await settle(page, 300);
    await shoot(page, "cmd-08-filter-overridden", theme);
    await panel.getByRole("radio", { name: "All" }).first().click();
    await panel.getByRole("textbox", { name: "Search commands" }).fill("zzqx");
    await settle(page, 300);
    await shoot(page, "cmd-09-search-empty", theme);
    await panel.getByRole("textbox", { name: "Search commands" }).fill("");
  });

  // Put the project back the way the next theme expects to find it.
  await step("commands-cleanup", async () => {
    await ensureAt(page, "project:commands");
    for (let i = 0; i < 4; i++) {
      const reset = panel.getByRole("button", { name: /^Reset .*default/i }).first();
      if (!(await reset.isVisible().catch(() => false))) break;
      await reset.click();
      await settle(page, 200);
    }
  });

  await closeSettings(page);
}

test("keyboard shortcuts and command overrides — every design-weight state", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SETTINGS_KEYBOARD is required for the keyboard settings capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SETTINGS_KEYBOARD to run the keyboard settings capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-keyboardshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await setWindowSize(ctx.app, WIDE);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);
    activePage = page;

    for (const override of OVERRIDES) {
      const result = await page.evaluate(
        (o) =>
          window.__daintreeDispatchAction?.("keybinding.setOverride", o, { source: "user" }) ??
          Promise.resolve({ ok: false }),
        override
      );
      if (!(result as { ok: boolean }).ok)
        throw new Error(`could not seed override ${override.actionId}`);
    }

    for (const theme of THEMES) {
      if (theme) await setAppTheme(page, theme);
      else await page.reload({ waitUntil: "domcontentloaded" });
      await page.addStyleTag({ content: POLISH_CSS });
      await dismissBlockingPalette(page);
      await settle(page, 800);
      await captureKeyboard(page, theme);
      await captureCommands(page, theme);
    }
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  console.log(
    `[settings-keyboard-shots] ${manifest.length - missing.length}/${manifest.length} PNGs → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`settings-keyboard capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBeGreaterThan(0);
});
