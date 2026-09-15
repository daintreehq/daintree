/**
 * Settings → General pane visual-review harness.
 *
 * General is the pane the Settings dialog opens on, so it is the settings screen a user
 * sees most. Its design questions — can I tell at a glance whether I am set up, can I
 * find one agent among eighteen, does anything on this pane earn the pixels it occupies
 * — are all questions about what is on screen, so they can only be answered on rendered
 * pixels.
 *
 * Every state is driven through a real seam:
 *   - navigation via the `daintree:open-settings-tab` deep link the toolbar, recovery
 *     banners and the theme-browser bridge all use, with `subtab` selecting Overview /
 *     Hibernation / Display;
 *   - agent availability by stubbing the three `system:*-cli-availability` IPC channels
 *     the real detector answers on. Everything above the IPC boundary — the client, the
 *     store, the hook, the component — is the shipping code path running on top of a
 *     roster the host machine does not happen to have;
 *   - loading / failure through the app's fault registry (`DAINTREE_E2E_FAULT_MODE=1`),
 *     which delays or throws on a real channel in front of the shipping handler.
 * Nothing about the pane is mocked, so a shot is evidence about shipping code.
 *
 * Stubbing at the boundary rather than seeding the store's localStorage cache is
 * deliberate: `cliAvailability.get` calls the IPC client directly, so a cache seed would
 * be silently overwritten by the host machine's real roster and the shot would be of
 * whatever agents this Mac happens to have installed.
 *
 *   DAINTREE_SHOT_GENERAL=1 npx playwright test --project=screenshots general-settings-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_GENERAL   required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME     optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG       optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY      comma-separated state filter (see STATES below)
 *   DAINTREE_SHOT_DIR       output directory override
 *   DAINTREE_SHOT_SWEEP     only capture the states marked `sweep` (theme sweep)
 *
 * Switching themes in place is unreliable under a screenshot harness, so a sweep boots
 * once per theme:
 *
 *   for t in daintree table-mountain; do
 *     DAINTREE_SHOT_GENERAL=1 DAINTREE_SHOT_SWEEP=1 DAINTREE_SHOT_THEME=$t \
 *     npx playwright test --project=screenshots general-settings-review
 *   done
 *
 * Output: artifacts/general-settings-shots/<slug>--<theme>[-tag].png (gitignored).
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
import { injectFault, injectStub, clearFault } from "../helpers/ipcFaults";

const ENABLED = !!process.env.DAINTREE_SHOT_GENERAL;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SWEEP_ONLY = !!process.env.DAINTREE_SHOT_SWEEP;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "general-settings-shots");

const REFRESH_CHANNEL = "system:refresh-cli-availability";
const GET_CHANNEL = "system:get-cli-availability";
const DETAILS_CHANNEL = "system:get-agent-cli-details";

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
// AppDialog puts role="dialog" on the full-viewport scrim, so cropping to DIALOG frames
// the whole window. The card is its child — that is the surface under review.
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CONTENT = `${DIALOG} [role="tabpanel"]`;
const CLOSE = '[aria-label="Close settings"]';
const SEARCH = '[aria-label="Search settings"]';
const navItem = (tab: string) => `[role="tab"][data-tab="${tab}"]`;

const PROJECT_NAME = "Helios Dashboard";

const WIDE = { width: 1680, height: 1050 };
// The dialog is a fixed-width `size="4xl"` card (~896 CSS px), so a 1024px window still
// renders it at full width. This is narrow enough that the card has to give way.
const NARROW = { width: 760, height: 700 };

/**
 * A realistic machine: most agents installed and working, a handful wanting something.
 * Deliberately mixes all four states the list can render, because the whole design
 * question is whether they are distinguishable from one another at a glance.
 */
const MIXED_AVAILABILITY: Record<string, string> = {
  claude: "ready",
  opencode: "unauthenticated",
  gemini: "ready",
  antigravity: "ready",
  codex: "ready",
  grok: "ready",
  cursor: "unauthenticated",
  goose: "unauthenticated",
  kimi: "unauthenticated",
  amp: "installed",
  crush: "blocked",
  aider: "ready",
  copilot: "missing",
  interpreter: "missing",
  kiro: "missing",
  mistral: "missing",
  qwen: "missing",
};

/** Everything working. The question this answers: what does the list say when it has nothing to say. */
const ALL_READY: Record<string, string> = Object.fromEntries(
  Object.keys(MIXED_AVAILABILITY).map((id) => [id, "ready"])
);

/** A fresh machine with no agent CLIs at all — the first-run empty state. */
const NONE_INSTALLED: Record<string, string> = Object.fromEntries(
  Object.keys(MIXED_AVAILABILITY).map((id) => [id, "missing"])
);

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
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-general-shots-"));
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

/**
 * Answer every availability channel with `availability`. All three are stubbed together
 * because the store's `initialize` calls `refresh` and `getDetails`, while the General
 * pane's own `cliAvailability.get` dispatch calls `get` — a partial stub would leave one
 * of them answering with the host machine's real roster.
 */
async function stubAvailability(
  app: ElectronApplication,
  availability: Record<string, string>,
  delayMs?: number
): Promise<void> {
  await injectStub(app, GET_CHANNEL, availability, delayMs);
  await injectStub(app, REFRESH_CHANNEL, availability, delayMs);
  await injectStub(app, DETAILS_CHANNEL, {}, delayMs);
}

async function clearAvailability(app: ElectronApplication): Promise<void> {
  await clearFault(app, GET_CHANNEL);
  await clearFault(app, REFRESH_CHANNEL);
  await clearFault(app, DETAILS_CHANNEL);
}

/**
 * The store persists each answer to localStorage and hydrates from it on boot, so a
 * previous state's roster would flash — or stick — on the next one. Clear it alongside
 * the stub. Must track `CACHE_STORAGE_KEY` in src/store/cliAvailabilityStore.ts.
 */
async function clearAvailabilityCache(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.localStorage.removeItem("daintree:cliAvailability:v3");
  });
}

/**
 * Long enough that a loading state is still on screen when the shot is taken, short
 * enough that the hung request settles before the suite ends.
 */
const HANG_MS = 120_000;

/** Reload the project view and put back the capture polish the reload dropped. */
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

/** Open (or re-target) the dialog through the deep-link event. */
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

interface GeneralState {
  slug: string;
  target: { tab: string; subtab?: string; sectionId?: string };
  /** Text that must be on screen after the state renders. */
  expectText?: string[];
  /** Text that must NOT be on screen — catches a state that silently fell back. */
  expectNoText?: string[];
  /** Included in the per-theme sweep. */
  sweep?: boolean;
  /**
   * Roster the availability channels answer with. Omitted means the channels are left
   * alone, so the state renders against whatever this machine really has — only useful
   * for the states that are about a channel failing rather than about its content.
   */
  availability?: Record<string, string>;
  /** Hold the stubbed answer this long, to photograph the pre-resolve state. */
  availabilityDelayMs?: number;
  /** Also write a content-pane-only crop, tighter than the whole dialog card. */
  extraCrop?: "content";
  /**
   * Run `arrange` before the renderer reloads rather than after the dialog opens. Needed
   * by the states whose whole point is what the app does on its *boot* read of a channel
   * — a fault injected after the read has already landed proves nothing.
   */
  arrangeBeforeBoot?: boolean;
  arrange?: (page: Page, app: ElectronApplication) => Promise<void>;
  restore?: (page: Page, app: ElectronApplication) => Promise<void>;
}

const STATES: GeneralState[] = [
  {
    // The headline state and the one the review is really about: a realistic machine,
    // every status the list can render present at once, eighteen agents deep.
    slug: "01-overview-mixed",
    target: { tab: "general", subtab: "overview" },
    availability: MIXED_AVAILABILITY,
    expectText: ["System status", "Login required"],
    extraCrop: "content",
    sweep: true,
  },
  {
    // Scrolled past the identity card into the list. The About card occupies the top of
    // the viewport, so this is what the pane looks like once a user has paid for it.
    slug: "02-overview-scrolled",
    target: { tab: "general", subtab: "overview" },
    availability: MIXED_AVAILABILITY,
    extraCrop: "content",
    arrange: async (page) => {
      await page
        .locator(CONTENT)
        .last()
        .evaluate((el) => {
          const scroller = el.closest<HTMLElement>(".overflow-auto, .overflow-y-auto") ?? el;
          scroller.scrollTop = 420;
        })
        .catch(() => {});
      await page.mouse.wheel(0, 420);
    },
  },
  {
    // Everything works. Today this renders as a list of bare names with no chrome at
    // all, so the shot asks whether "all good" is actually communicated or just implied.
    slug: "03-overview-all-ready",
    target: { tab: "general", subtab: "overview" },
    availability: ALL_READY,
    expectText: ["System status"],
    expectNoText: ["Login required"],
    extraCrop: "content",
    sweep: true,
  },
  {
    // First run: nothing installed. The empty state and its two escape hatches.
    slug: "04-overview-none-installed",
    target: { tab: "general", subtab: "overview" },
    availability: NONE_INSTALLED,
    extraCrop: "content",
  },
  {
    // Detection still in flight, with no cache to fall back on. The house rule says
    // settings tabs render chrome immediately and populate on resolve — this is the shot
    // that proves whether they do.
    slug: "05-overview-loading",
    target: { tab: "general", subtab: "overview" },
    availability: MIXED_AVAILABILITY,
    availabilityDelayMs: HANG_MS,
    extraCrop: "content",
  },
  {
    // Detection failed outright.
    slug: "06-overview-probe-failed",
    target: { tab: "general", subtab: "overview" },
    extraCrop: "content",
    arrangeBeforeBoot: true,
    arrange: async (_page, app) => {
      await injectFault(app, GET_CHANNEL, "EACCES: permission denied", "EACCES");
      await injectFault(app, REFRESH_CHANNEL, "EACCES: permission denied", "EACCES");
    },
    restore: async (_page, app) => {
      await clearFault(app, GET_CHANNEL);
      await clearFault(app, REFRESH_CHANNEL);
    },
  },
  {
    // The second sub-tab. Content a user only finds if they think to look for it.
    slug: "07-hibernation",
    target: { tab: "general", subtab: "hibernation" },
    availability: MIXED_AVAILABILITY,
    extraCrop: "content",
    sweep: true,
  },
  {
    // The third sub-tab.
    slug: "08-display",
    target: { tab: "general", subtab: "display" },
    availability: MIXED_AVAILABILITY,
    extraCrop: "content",
    sweep: true,
  },
  {
    // Keyboard: the sub-tab bar's own focus ring, and whether a keyboard user can tell
    // which of the two nested tablists they are driving.
    slug: "09-subtab-focus",
    target: { tab: "general", subtab: "overview" },
    availability: MIXED_AVAILABILITY,
    extraCrop: "content",
    arrange: async (page) => {
      // `:focus-visible` does not match a programmatic focus() — only a real key event
      // makes the browser treat focus as keyboard-driven. Land in the search field, then
      // Tab forward until focus is inside the General sub-tab bar.
      await page.locator(SEARCH).click();
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab");
        const landed = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return null;
          const bar = el.closest('[role="tablist"]');
          if (!bar) return null;
          // The sidebar tablist is inside .settings-sidebar; the sub-tab bar is not.
          if (bar.closest(".settings-sidebar")) return null;
          return { visible: el.matches(":focus-visible") };
        });
        if (landed) {
          if (!landed.visible) throw new Error("sub-tab focused but :focus-visible missed");
          return;
        }
      }
      throw new Error("could not reach the General sub-tab bar by keyboard from search");
    },
  },
  {
    // Keyboard focus landing on an agent row. The rows are buttons that navigate; this
    // asks whether anything on screen says so.
    slug: "10-agent-row-focus",
    target: { tab: "general", subtab: "overview" },
    availability: MIXED_AVAILABILITY,
    extraCrop: "content",
    arrange: async (page) => {
      const row = page.locator(`${DIALOG} [aria-label^="Go to "]`).first();
      await row.waitFor({ state: "visible", timeout: 15_000 });
      await row.evaluate((el: HTMLElement) => el.focus());
      // Force the keyboard-driven focus the browser would infer from a real Tab.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
    },
  },
  {
    slug: "11-narrow",
    target: { tab: "general", subtab: "overview" },
    availability: MIXED_AVAILABILITY,
    arrange: async (_page, app) => setWindowSize(app, NARROW),
    restore: async (_page, app) => setWindowSize(app, WIDE),
  },
  {
    slug: "12-forced-colors",
    target: { tab: "general", subtab: "overview" },
    availability: MIXED_AVAILABILITY,
    extraCrop: "content",
    arrange: async (page) => {
      await page.emulateMedia({ forcedColors: "active" });
    },
    restore: async (page) => {
      await page.emulateMedia({ forcedColors: "none" });
    },
  },
  {
    slug: "13-contrast-more",
    target: { tab: "general", subtab: "overview" },
    availability: MIXED_AVAILABILITY,
    extraCrop: "content",
    arrange: async (page) => {
      await page.emulateMedia({ contrast: "more" });
    },
    restore: async (page) => {
      await page.emulateMedia({ contrast: "no-preference" });
    },
  },
];

async function verify(page: Page, state: GeneralState): Promise<void> {
  await expect(page.locator(DIALOG), `${state.slug}: settings dialog did not open`).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator(navItem("general")),
    `${state.slug}: the General nav item is not selected`
  ).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });

  for (const text of state.expectText ?? []) {
    await expect(
      page.locator(DIALOG).getByText(text, { exact: false }).first(),
      `${state.slug}: expected "${text}" on screen`
    ).toBeVisible({ timeout: 10_000 });
  }
  for (const text of state.expectNoText ?? []) {
    await expect(
      page.locator(DIALOG).getByText(text, { exact: false }),
      `${state.slug}: "${text}" should not be on screen`
    ).toHaveCount(0, { timeout: 10_000 });
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

test("general settings pane review — overview, agent status, hibernation, display and trouble states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_GENERAL is required for the general-settings capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_GENERAL to run the general-settings capture");

  failures.length = 0;
  captured = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-generalshot-"));
  let ctx: AppContext | undefined;

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

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await settle(page, 600);

    for (const state of planned) {
      const app = ctx.app;
      try {
        await closeSettings(page);

        // Availability is decided before the renderer boots, because the store reads the
        // channels once on init and never refetches for the dialog. The persisted cache
        // goes too, or the previous state's roster hydrates over this one.
        await clearAvailability(app);
        await clearAvailabilityCache(page);
        if (state.availability) {
          await stubAvailability(app, state.availability, state.availabilityDelayMs);
        }
        if (state.arrange && state.arrangeBeforeBoot) await state.arrange(page, app);
        await reloadRenderer(page);

        await openSettingsAt(page, state.target);
        await settle(page, 800);
        if (state.arrange && !state.arrangeBeforeBoot) await state.arrange(page, app);
        await settle(page, 600);

        await verify(page, state);

        await snap(page, `${state.slug}--dialog`, CARD);
        captured++;
        if (state.extraCrop === "content") {
          await snap(page, `${state.slug}--content`, CONTENT);
          captured++;
        }
      } catch (error) {
        const detail = String(error).slice(0, 400);
        console.warn(`[general-settings-shots] state "${state.slug}" failed:`, detail);
        failures.push(`${state.slug}: ${detail}`);
      } finally {
        if (state.restore) {
          await state.restore(page, app).catch((error) => {
            failures.push(`${state.slug} (restore): ${String(error).slice(0, 200)}`);
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
  const expected = planned.reduce((n, s) => n + (s.extraCrop === "content" ? 2 : 1), 0);
  console.log(`[general-settings-shots] ${captured}/${expected} PNGs → ${OUTPUT_DIR}`);
  if (failures.length > 0) {
    throw new Error(`general-settings capture failed:\n  ${failures.join("\n  ")}`);
  }
  expect(captured, `expected ${expected} PNGs, wrote ${captured}`).toBe(expected);
});
