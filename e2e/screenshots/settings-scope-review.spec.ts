/**
 * SettingsDialog scope-orientation visual-review harness (#11986).
 *
 * The dialog is the two-column settings shell that switches between global and
 * project-scoped navigation. Its design question — while you are reading or editing a
 * form, can you still tell whether the change lands on Daintree or on *this project* —
 * is a question about what is on screen, so it can only be answered on rendered pixels.
 *
 * Every state is driven through a real seam:
 *   - navigation via the `daintree:open-settings-tab` deep-link event the toolbar,
 *     recovery banners and the theme-browser bridge all use;
 *   - the project name via the `project.update` action, the same one the project's own
 *     General tab dispatches on rename;
 *   - loading / load-failure / autosave-failure through the app's own fault registry
 *     (`DAINTREE_E2E_FAULT_MODE=1`), which delays or throws on a real channel in front
 *     of the shipping handler, so the real hook, the real Doherty gate and the real
 *     banners run on top of them.
 * Nothing about the dialog is mocked, so a shot is evidence about shipping code.
 *
 * Scope is never driven by clicking the scope control itself: the deep link sets the
 * scope through `scopeForTab`, which keeps the harness working across a redesign of
 * that control.
 *
 *   DAINTREE_SHOT_SETTINGS_SCOPE=1 npx playwright test --project=screenshots settings-scope-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SETTINGS_SCOPE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME           optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG             optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY            comma-separated state filter (see STATES below)
 *   DAINTREE_SHOT_DIR             output directory override
 *   DAINTREE_SHOT_SWEEP           only capture the states marked `sweep` (theme sweep)
 *
 * Switching themes in place is unreliable under a screenshot harness, so a sweep boots
 * once per theme:
 *
 *   for t in daintree table-mountain; do
 *     DAINTREE_SHOT_SETTINGS_SCOPE=1 DAINTREE_SHOT_SWEEP=1 DAINTREE_SHOT_THEME=$t \
 *     npx playwright test --project=screenshots settings-scope-review
 *   done
 *
 * Output: artifacts/settings-scope-shots/<slug>--<theme>[-tag].png (gitignored).
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { injectFault, injectDelay, clearFault } from "../helpers/ipcFaults";

const ENABLED = !!process.env.DAINTREE_SHOT_SETTINGS_SCOPE;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SWEEP_ONLY = !!process.env.DAINTREE_SHOT_SWEEP;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "settings-scope-shots");

const GET_SETTINGS_CHANNEL = "project:get-settings";
const SAVE_SETTINGS_CHANNEL = "project:save-settings";

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
// AppDialog puts role="dialog" on the full-viewport scrim, so cropping to DIALOG
// frames the whole window. The card is its child — that is the surface under review.
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const SIDEBAR = ".settings-sidebar";
const CLOSE = '[aria-label="Close settings"]';
const SEARCH = '[aria-label="Search settings"]';
const navItem = (tab: string) => `[role="tab"][data-tab="${tab}"]`;

/** The name the fixture project carries for every state but the long-name one. */
const SHORT_NAME = "Helios Dashboard";
/** Long enough to force whatever truncation the shell has, and to expose it if it has none. */
const LONG_NAME = "acme-platform-infrastructure-monorepo-services";

const WIDE = { width: 1680, height: 1050 };
const NARROW = { width: 1024, height: 780 };

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

/** A small real repo — the settings shell only needs a project to exist and be open. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-settings-scope-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const version = 1;\n");
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
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(s.width, s.height);
  }, size);
}

async function dispatchAction(page: Page, id: string, args: unknown): Promise<void> {
  await page.evaluate(
    async ({ actionId, actionArgs }) => {
      const dispatch = window.__daintreeDispatchAction;
      if (typeof dispatch !== "function") throw new Error("Action dispatch hook not available");
      await dispatch(actionId, actionArgs, { source: "test" });
    },
    { actionId: id, actionArgs: args }
  );
}

async function renameProject(page: Page, name: string): Promise<void> {
  const projectId = await page.evaluate(async () => {
    const current = await window.electron.project.getCurrent();
    return current?.id ?? null;
  });
  if (!projectId) throw new Error("no current project to rename");
  await dispatchAction(page, "project.update", { projectId, updates: { name } });
  await settle(page, 300);
}

/**
 * Reload the project view and put back the capture polish the reload dropped. Used only
 * by the states that must be produced by a boot-time read.
 */
async function reloadRenderer(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator('[aria-label="Toggle Sidebar"]')
    .waitFor({ state: "visible", timeout: 30_000 });
  await dismissBlockingPalette(page);
  await page.addStyleTag({ content: POLISH_CSS });
  await settle(page, 400);
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
  await settle(page, 200);
}

/**
 * Open (or re-target) the dialog through the deep-link event. `scopeForTab` derives the
 * scope from the tab id, so this drives scope without touching the scope control.
 */
async function openSettingsAt(
  page: Page,
  target: { tab: string; subtab?: string; sectionId?: string }
): Promise<void> {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
  }, target);
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(navItem(target.tab)).waitFor({ state: "visible", timeout: 20_000 });
}

/**
 * Long enough that the "loading" state is still on screen when the shot is taken, short
 * enough that the hung request settles before the next state needs the channel — the
 * renderer keeps a per-project singleflight entry until the promise resolves.
 */
const HANG_MS = 25_000;

interface ScopeState {
  slug: string;
  /** Deep-link target that both opens the dialog and selects the scope. */
  target: { tab: string; subtab?: string; sectionId?: string };
  /** Text that must be on screen after the state renders. */
  expectText?: string[];
  /** Nav item that must be selected. */
  expectSelected?: string;
  /** Included in the per-theme sweep. */
  sweep?: boolean;
  /** `"dialog"` crops to the shell; `"sidebar"` also writes a sidebar-only crop. */
  extraCrop?: "sidebar";
  /** Renamed to this before the state opens; defaults to SHORT_NAME. */
  projectName?: string;
  /**
   * Reload the renderer after `arrange` and before the dialog opens, so the state is
   * produced by the app's boot-time read rather than by a refetch that never happens.
   */
  needsRendererReload?: boolean;
  arrange?: (page: Page, app: ElectronApplication) => Promise<void>;
  restore?: (page: Page, app: ElectronApplication) => Promise<void>;
}

const STATES: ScopeState[] = [
  {
    // The baseline: global scope at rest. Everything the user sees telling them the
    // change they are about to make is application-wide.
    slug: "02-global-rest",
    target: { tab: "general" },
    expectSelected: "general",
    extraCrop: "sidebar",
    sweep: true,
  },
  {
    // The state the issue is about. Both scopes have a "General"; this one is the
    // project's, and the shot is the evidence for how hard that is to tell.
    slug: "03-project-rest",
    target: { tab: "project:general" },
    expectSelected: "project:general",
    extraCrop: "sidebar",
    sweep: true,
  },
  {
    // Scrolled into the form, which is where the issue says orientation is lost:
    // whatever names the scope has to survive the content pane being read.
    slug: "04-project-scrolled",
    target: { tab: "project:automation" },
    expectSelected: "project:automation",
    arrange: async (page) => {
      await page
        .locator(`${DIALOG} .overflow-auto, ${DIALOG} [class*="overflow-y"]`)
        .last()
        .evaluate((el) => {
          el.scrollTop = 400;
        })
        .catch(() => {});
      await page.mouse.wheel(0, 400);
    },
  },
  {
    // A long project name. Predictable truncation with a full-value affordance, or a
    // shell that breaks — the shot decides which.
    slug: "05-project-long-name",
    target: { tab: "project:general" },
    expectSelected: "project:general",
    projectName: LONG_NAME,
    extraCrop: "sidebar",
    sweep: true,
  },
  {
    // A deep link straight into a project tab, the way a recovery banner or the
    // toolbar's project-settings action lands. Nothing preceded it to establish scope.
    slug: "06-deeplink-project",
    target: { tab: "project:code-forge" },
    expectSelected: "project:code-forge",
  },
  {
    // The same landing, global side.
    slug: "07-deeplink-global",
    target: { tab: "keyboard" },
    expectSelected: "keyboard",
  },
  {
    // Search inside global scope: the result chips say Global, and the content header
    // says "Search Results" — the scope of what you are looking at is only in the chips.
    slug: "08-search-global",
    target: { tab: "general" },
    arrange: async (page) => {
      await page.locator(SEARCH).fill("theme");
      await page.waitForTimeout(500);
    },
    expectText: ["result"],
    restore: async (page) => {
      await page.locator(SEARCH).fill("");
    },
  },
  {
    // The cross-scope case the issue names: searching from global scope surfaces
    // project-scope entries. Both chips are on screen at once.
    slug: "09-search-cross-scope",
    target: { tab: "general" },
    arrange: async (page) => {
      await page.locator(SEARCH).fill("branch prefix");
      await page.waitForTimeout(600);
    },
    expectText: ["result"],
    sweep: true,
    restore: async (page) => {
      await page.locator(SEARCH).fill("");
    },
  },
  {
    // Search inside project scope.
    slug: "10-search-project",
    target: { tab: "project:general" },
    arrange: async (page) => {
      await page.locator(SEARCH).fill("worktree");
      await page.waitForTimeout(600);
    },
    expectText: ["result"],
    restore: async (page) => {
      await page.locator(SEARCH).fill("");
    },
  },
  {
    // Project settings still loading. The issue notes the message sits inside content,
    // away from the control that names the scope.
    slug: "11-project-loading",
    target: { tab: "project:general" },
    expectText: ["Loading settings"],
    // `projectSettingsStore.loadSettings` only raises `isLoading` when the store has no
    // snapshot for the project, and `useProjectSettings` only calls it when the store's
    // projectId differs. Reopening the dialog therefore never reloads. The one honest
    // way to this state is a renderer that boots with the read already slow.
    needsRendererReload: true,
    arrange: async (_page, app) => injectDelay(app, GET_SETTINGS_CHANNEL, HANG_MS),
    restore: async (_page, app) => clearFault(app, GET_SETTINGS_CHANNEL),
  },
  {
    // Project settings failed to load.
    slug: "12-project-load-error",
    target: { tab: "project:general" },
    expectText: ["Failed to load settings"],
    // Same reason as 11: the store caches per project and never refetches for the
    // dialog, so the failure has to happen on the boot read.
    needsRendererReload: true,
    arrange: async (_page, app) =>
      injectFault(app, GET_SETTINGS_CHANNEL, "EACCES: permission denied", "EACCES"),
    restore: async (_page, app) => clearFault(app, GET_SETTINGS_CHANNEL),
  },
  {
    // Autosave failed. Same question: is the failure visually attached to the project
    // it belongs to, or floating in a content pane that never names one?
    slug: "13-project-autosave-error",
    target: { tab: "project:general" },
    arrange: async (page, app) => {
      await injectFault(app, SAVE_SETTINGS_CHANNEL, "ENOSPC: no space left on device", "ENOSPC");
      // Dev server command lives in ProjectSettings, so editing it drives the real
      // debounced `project:save-settings` autosave — not the project-record rename.
      const field = page.locator(`${DIALOG} [aria-label="Dev server command"]`);
      await field.waitFor({ state: "visible", timeout: 15_000 });
      await field.click();
      await field.pressSequentially("npm run dev");
      await page.waitForTimeout(2000);
    },
    restore: async (_page, app) => clearFault(app, SAVE_SETTINGS_CHANNEL),
  },
  {
    // A validation error in project scope: does the sidebar's warning dot read as
    // "this project has a problem", or just "something somewhere is wrong"?
    slug: "14-project-validation",
    target: { tab: "project:automation" },
    extraCrop: "sidebar",
    arrange: async (page) => {
      const pattern = page.locator(
        `${DIALOG} input[placeholder="e.g. {parent-dir}/{base-folder}-worktrees/{branch-slug}"]`
      );
      await pattern.waitFor({ state: "visible", timeout: 15_000 });
      await pattern.fill("{not-a-real-token}/x");
      await page.waitForTimeout(600);
    },
  },
  {
    // Modified-from-default dots in the global sidebar, alongside the scope control.
    slug: "15-global-modified",
    target: { tab: "general" },
    extraCrop: "sidebar",
    arrange: async (page) => {
      await dispatchAction(page, "preferences.showDeveloperTools.set", { show: true });
      await dispatchAction(page, "terminalConfig.setPerformanceMode", { performanceMode: true });
      await page.waitForTimeout(400);
    },
    restore: async (page) => {
      await dispatchAction(page, "preferences.showDeveloperTools.set", { show: false }).catch(
        () => {}
      );
      await dispatchAction(page, "terminalConfig.setPerformanceMode", {
        performanceMode: false,
      }).catch(() => {});
    },
  },
  {
    // Keyboard: the scope control's own focus ring. A keyboard user's only signal that
    // the thing naming the scope is operable at all.
    slug: "16-scope-focus",
    target: { tab: "project:general" },
    extraCrop: "sidebar",
    arrange: async (page) => {
      // `:focus-visible` does not match a programmatic focus() — only a real key event
      // makes the browser treat focus as keyboard-driven. Land in the sidebar, then Tab
      // until focus is inside the scope control's row.
      await page.locator(SEARCH).click();
      await page.keyboard.press("Shift+Tab");
      for (let i = 0; i < 10; i++) {
        const landed = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return null;
          const inScopeControl = !!el.closest('[aria-label="Settings scope"]');
          return inScopeControl ? { visible: el.matches(":focus-visible") } : null;
        });
        if (landed) {
          if (!landed.visible) throw new Error("scope control focused but :focus-visible missed");
          return;
        }
        await page.keyboard.press("Shift+Tab");
      }
      throw new Error("could not reach the scope control by keyboard from the search input");
    },
  },
  {
    slug: "17-narrow",
    target: { tab: "project:general" },
    projectName: LONG_NAME,
    arrange: async (_page, app) => setWindowSize(app, NARROW),
    restore: async (_page, app) => setWindowSize(app, WIDE),
  },
  {
    slug: "18-forced-colors",
    target: { tab: "project:general" },
    extraCrop: "sidebar",
    arrange: async (page) => {
      await page.emulateMedia({ forcedColors: "active" });
    },
    restore: async (page) => {
      await page.emulateMedia({ forcedColors: "none" });
    },
  },
  {
    slug: "19-contrast-more",
    target: { tab: "project:general" },
    extraCrop: "sidebar",
    arrange: async (page) => {
      await page.emulateMedia({ contrast: "more" });
    },
    restore: async (page) => {
      await page.emulateMedia({ contrast: "no-preference" });
    },
  },
];

async function verify(page: Page, state: ScopeState): Promise<void> {
  await expect(page.locator(DIALOG), `${state.slug}: settings dialog did not open`).toBeVisible({
    timeout: 15_000,
  });

  if (state.expectSelected) {
    await expect(
      page.locator(navItem(state.expectSelected)),
      `${state.slug}: nav item "${state.expectSelected}" is not selected`
    ).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
  }

  for (const text of state.expectText ?? []) {
    await expect(
      page.locator(DIALOG).getByText(text, { exact: false }).first(),
      `${state.slug}: expected "${text}" on screen`
    ).toBeVisible({ timeout: 10_000 });
  }
}

async function snap(page: Page, slug: string, locator: string | null): Promise<void> {
  const target = locator === null ? page : page.locator(locator).first();
  await target.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}--${THEME_SLUG}${TAG}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

/* A failed state must not abort the run — the rest are still worth having. But the run
   must still FAIL: a silent exit 0 over a short output directory reads as success. */
const failures: string[] = [];
let captured = 0;

test("settings dialog scope review — global, project, search, deep link and trouble states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SETTINGS_SCOPE is required for the settings-scope capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SETTINGS_SCOPE to run the settings-scope capture");

  failures.length = 0;
  captured = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-settingsscopeshot-"));
  let ctx: AppContext | undefined;

  const wantsNoProject = ONLY.length === 0 || ONLY.includes("01-no-project");
  const planned = STATES.filter(
    (s) => (ONLY.length === 0 || ONLY.includes(s.slug)) && (!SWEEP_ONLY || s.sweep)
  );

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
    });
    // launchApp only sizes the window when it owns the userDataDir, and this run
    // supplies its own — size it here or every shot is whatever the OS defaulted to.
    await setWindowSize(ctx.app, WIDE);

    // ── 01: no project open ────────────────────────────────────────────────
    // Captured before onboarding, on the real no-project window, because that is the
    // only place `projectId` is genuinely null.
    if (wantsNoProject && !SWEEP_ONLY) {
      const welcome = ctx.window;
      try {
        await dismissBlockingPalette(welcome);
        await welcome.addStyleTag({ content: POLISH_CSS });
        await openSettingsAt(welcome, { tab: "general" });
        await settle(welcome, 600);
        await expect(
          welcome.locator(`${SIDEBAR} [aria-label="Settings scope"]`),
          "01-no-project: a scope control rendered with no project open"
        ).toHaveCount(0, { timeout: 5000 });
        await snap(welcome, "01-no-project--dialog", CARD);
        captured++;
        await snap(welcome, "01-no-project--sidebar", SIDEBAR);
        captured++;
      } catch (error) {
        failures.push(`01-no-project: ${String(error).slice(0, 400)}`);
      } finally {
        await closeSettings(welcome).catch(() => {});
      }
    }

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, SHORT_NAME);
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await renameProject(page, SHORT_NAME);
    await settle(page, 600);

    let currentName = SHORT_NAME;

    for (const state of planned) {
      const app = ctx.app;
      try {
        await closeSettings(page);

        const wantName = state.projectName ?? SHORT_NAME;
        if (wantName !== currentName) {
          await renameProject(page, wantName);
          currentName = wantName;
        }

        if (state.needsRendererReload) {
          if (state.arrange) await state.arrange(page, app);
          await reloadRenderer(page);
          await openSettingsAt(page, state.target);
        } else {
          await openSettingsAt(page, state.target);
          await settle(page, 700);
          if (state.arrange) await state.arrange(page, app);
        }
        await settle(page, 600);

        await verify(page, state);

        await snap(page, `${state.slug}--dialog`, CARD);
        captured++;
        if (state.extraCrop === "sidebar") {
          await snap(page, `${state.slug}--sidebar`, SIDEBAR);
          captured++;
        }
      } catch (error) {
        const detail = String(error).slice(0, 400);
        console.warn(`[settings-scope-shots] state "${state.slug}" failed:`, detail);
        failures.push(`${state.slug}: ${detail}`);
      } finally {
        if (state.restore) {
          await state.restore(page, app).catch((error) => {
            failures.push(`${state.slug} (restore): ${String(error).slice(0, 200)}`);
          });
        }
        if (state.needsRendererReload) {
          // The reloaded renderer holds a failed/pending settings store that never
          // refetches. Reload once more, with the fault cleared, so the states after
          // this one see a healthy project again.
          await closeSettings(page).catch(() => {});
          await reloadRenderer(page).catch((error) => {
            failures.push(`${state.slug} (recover): ${String(error).slice(0, 200)}`);
          });
        }
      }
    }
  } finally {
    if (ctx) await closeApp(ctx).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // The exit code is only meaningful if it accounts for what actually landed on disk.
  const expected =
    planned.reduce((n, s) => n + (s.extraCrop === "sidebar" ? 2 : 1), 0) +
    (wantsNoProject && !SWEEP_ONLY ? 2 : 0);
  console.log(`[settings-scope-shots] ${captured}/${expected} PNGs → ${OUTPUT_DIR}`);
  if (failures.length > 0) {
    throw new Error(`settings-scope capture failed:\n  ${failures.join("\n  ")}`);
  }
  expect(captured, `expected ${expected} PNGs, wrote ${captured}`).toBe(expected);
});
