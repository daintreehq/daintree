/**
 * Settings → Appearance visual-review harness — the states the page sweep never reaches.
 *
 * `settings-pages-review.spec.ts` walks every page at rest. The Appearance tab's design
 * weight sits in states a fresh profile never shows: system matching on with its dark and
 * light pairs, every setting moved off its default, an accent that fails contrast, the
 * terminal scheme list filtered to light or to nothing, and a rejected font size. This
 * spec drives each one through the real controls and captures the dialog card around it,
 * across several built-in themes in one launch.
 *
 *   DAINTREE_SHOT_APPEARANCE=1 DAINTREE_SHOT_DIR=/tmp/out \
 *     npx playwright test --project=screenshots settings-appearance-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_APPEARANCE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES      comma-separated theme ids (default: daintree,bondi,bali,namib)
 *   DAINTREE_SHOT_STATES      comma-separated state filter (default: every state)
 *
 * Writes `{state}--{theme}.png` plus manifest.json, and fails unless every planned
 * state landed on disk for every theme.
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

const ENABLED = !!process.env.DAINTREE_SHOT_APPEARANCE;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,bali,namib")
  .split(",")
  .filter(Boolean);
const ONLY_STATES = (process.env.DAINTREE_SHOT_STATES ?? "").split(",").filter(Boolean);

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CLOSE = '[aria-label="Close settings"]';
const PANEL = "#settings-panel-terminalAppearance";
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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-appearance-shots-"));
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

async function openAppearance(page: Page, subtab: "app" | "terminal"): Promise<void> {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
    },
    { tab: "terminalAppearance", subtab }
  );
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  const tab = page.locator(`${PANEL} [role="tablist"] [role="tab"][data-tab="${subtab}"]`);
  await tab.waitFor({ state: "visible", timeout: 15_000 });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await settle(page, 600);
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator(CLOSE)
    .click({ timeout: 2000 })
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

/** Scroll the page so `selector` sits near the top of the dialog's scrollport. */
async function scrollTo(page: Page, selector: string | null): Promise<void> {
  await page.evaluate(
    ({ panel, target }) => {
      const panelEl = document.querySelector(panel);
      let el: HTMLElement | null = panelEl?.parentElement ?? null;
      while (el) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
        el = el.parentElement;
      }
      if (!el) throw new Error("no scroll container above the appearance panel");
      if (!target) {
        el.scrollTop = 0;
        return;
      }
      const t = document.querySelector(target);
      if (!t) throw new Error(`scroll target missing: ${target}`);
      const delta = t.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop = Math.max(0, el.scrollTop + delta - 24);
    },
    { panel: PANEL, target: selector }
  );
  await settle(page, 250);
}

async function resetAppearance(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = window.electron.appTheme;
    await api.setFollowSystem(false);
    await api.setAccentColorOverride(null);
    await api.setColorVisionMode("default");
  });
}

interface ShotState {
  id: string;
  subtab: "app" | "terminal";
  /** Selector to scroll to the top of the scrollport before capture; null = page top. */
  scroll: string | null;
  /** Drive the state through the real controls. Must leave it verifiably in place. */
  enter?: (page: Page) => Promise<void>;
  /** Undo what `enter` changed that a reload does not. */
  leave?: (page: Page) => Promise<void>;
}

const STATES: ShotState[] = [
  { id: "app-rest", subtab: "app", scroll: null },
  {
    id: "app-rest-lower",
    subtab: "app",
    scroll: "#appearance-color-vision",
  },
  {
    id: "app-follow-system",
    subtab: "app",
    scroll: null,
    enter: async (page) => {
      const sw = page.locator(`${PANEL} [role="switch"]`).first();
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "true");
      await expect(page.getByText("Light theme", { exact: true })).toBeVisible();
    },
  },
  {
    id: "app-modified",
    subtab: "app",
    scroll: "#appearance-theme",
    enter: async (page) => {
      await page.locator('[data-testid="accent-color-override-input"]').fill("#d9822b");
      await expect(
        page.getByRole("button", { name: "Reset accent color to the theme's" })
      ).toBeVisible();
      await page.locator(`${PANEL} [role="radio"]`, { hasText: "Compact" }).click();
      await page
        .locator('#appearance-color-vision [role="radio"]', { hasText: "Red-green" })
        .click();
      await expect(
        page.locator('#appearance-color-vision [role="radio"][aria-checked="true"]')
      ).toHaveText("Red-green");
    },
    leave: async (page) => {
      await page.locator(`${PANEL} [role="radio"]`, { hasText: "Normal" }).click();
    },
  },
  {
    id: "app-low-contrast-accent",
    subtab: "app",
    scroll: "#appearance-theme",
    enter: async (page) => {
      const isLight = await page.evaluate(
        () => document.documentElement.getAttribute("data-color-mode") === "light"
      );
      await page
        .locator('[data-testid="accent-color-override-input"]')
        .fill(isLight ? "#f4f1e8" : "#2a2a2e");
      await expect(page.getByText(/Low contrast/)).toBeVisible();
    },
  },
  {
    id: "app-dark-theme-open",
    subtab: "app",
    scroll: "#appearance-theme",
    enter: async (page) => {
      const sw = page.locator(`${PANEL} [role="switch"]`).first();
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "true");
      await page.locator(`${PANEL} button[role="combobox"]`).first().click();
      await expect(page.getByRole("option").first()).toBeVisible();
    },
    leave: async (page) => {
      await page.keyboard.press("Escape");
    },
  },
  { id: "terminal-rest", subtab: "terminal", scroll: null },
  { id: "terminal-rest-lower", subtab: "terminal", scroll: "#appearance-font-family" },
  {
    id: "terminal-modified",
    subtab: "terminal",
    scroll: "#appearance-font-family",
    enter: async (page) => {
      await page.locator(`${PANEL} [role="option"][aria-label="Dracula"]`).click();
      await page
        .locator('[aria-label="Terminal font family"] [role="radio"]', { hasText: "System" })
        .click();
      const input = page.locator("#appearance-font-size input");
      await input.fill("16");
      await input.blur();
      await expect(page.locator(PANEL)).toContainText("Dracula at 16 px");
    },
    leave: async (page) => {
      await page.evaluate(async () => {
        const run = window.__daintreeDispatchAction;
        await run?.("terminalConfig.setFontSize", { fontSize: 12 }, { source: "test" });
        await run?.(
          "terminalConfig.setFontFamily",
          {
            fontFamily:
              '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          },
          { source: "test" }
        );
        await window.electron.terminalConfig.setColorScheme("match-app-theme");
      });
    },
  },
  {
    id: "terminal-scheme-focus",
    subtab: "terminal",
    scroll: null,
    enter: async (page) => {
      await page.getByLabel("Filter color schemes").focus();
      // Tab past the filter and the tone switch lands on the grid's single stop.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(page.locator(`${PANEL} [role="option"]:focus`)).toHaveCount(1);
    },
  },
  {
    id: "terminal-light-filter",
    subtab: "terminal",
    scroll: null,
    enter: async (page) => {
      await page.locator(PANEL).getByText("Light", { exact: true }).first().click();
      await settle(page, 300);
    },
  },
  {
    id: "terminal-filter-empty",
    subtab: "terminal",
    scroll: null,
    enter: async (page) => {
      await page.getByLabel("Filter color schemes").fill("zzzz");
      await settle(page, 200);
    },
  },
  {
    id: "terminal-font-error",
    subtab: "terminal",
    scroll: "#appearance-font-family",
    enter: async (page) => {
      const input = page.locator("#appearance-font-size input");
      await input.fill("40");
      await input.blur();
      await expect(page.locator(PANEL)).toContainText("between 8 and 24");
    },
  },
];

interface ManifestEntry {
  file: string;
  state: string;
  theme: string;
}

test("settings appearance review — states × themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_APPEARANCE is required for the appearance capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_APPEARANCE to run the appearance capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const states = STATES.filter((s) => ONLY_STATES.length === 0 || ONLY_STATES.includes(s.id));
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-appearanceshot-"));
  const manifest: ManifestEntry[] = [];
  const failures: string[] = [];
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await setWindowSize(ctx.app, WIDE);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");

    for (const theme of THEMES) {
      for (const state of states) {
        const file = `${state.id}--${theme}.png`;
        try {
          // Every state starts from defaults on a fresh render of the theme, so one
          // state's leftovers can never leak into the next capture.
          await resetAppearance(page);
          await setAppTheme(page, theme);
          await page.addStyleTag({ content: POLISH_CSS });
          await dismissBlockingPalette(page);
          await openAppearance(page, state.subtab);
          if (state.enter) await state.enter(page);
          // A rest state must not carry a focus ring left over from the previous state's
          // keyboard close; driven states keep focus where the interaction put it.
          else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await scrollTo(page, state.scroll);
          await settle(page, 400);
          await page
            .locator(CARD)
            .first()
            .screenshot({
              path: path.join(OUTPUT_DIR, file),
              type: "png",
              animations: "disabled",
              caret: "hide",
            });
          manifest.push({ file, state: state.id, theme });
          if (state.leave) await state.leave(page);
        } catch (error) {
          failures.push(`${file}: ${String(error).slice(0, 400)}`);
        } finally {
          await closeSettings(page);
        }
      }
    }
    await resetAppearance(page);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(
    path.join(OUTPUT_DIR, "appearance-manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  const expected = states.length * THEMES.length;
  console.log(
    `[appearance-shots] ${manifest.length - missing.length}/${expected} PNGs → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (manifest.length !== expected) failures.push(`captured ${manifest.length} of ${expected}`);
  if (failures.length > 0)
    throw new Error(`appearance capture failed:\n  ${failures.join("\n  ")}`);
});
