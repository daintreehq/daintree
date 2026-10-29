/**
 * Worktrees sidebar empty-list visual-review harness.
 *
 * Boots a repo with a main worktree plus several feature worktrees and no
 * agents, so every quick-state bucket reads zero, then writes PNGs of each
 * branch the list area falls into when it has nothing to show: a drained
 * Working / Attention / Finished tab, a search that matches nothing, a tab that
 * hides matches a search or facet found elsewhere, and a facet plus search that
 * matches nothing at all — at the default width and at the 200px floor, plus a
 * cross-theme sweep of the two states that carry the most design weight.
 *
 * Opt-in only, like theme-review: skips itself unless DAINTREE_SHOT_SIDEBAR_EMPTY
 * is set, so the marketing screenshots workflow never executes it.
 *
 *   DAINTREE_SHOT_SIDEBAR_EMPTY=1 npx playwright test --project=screenshots worktree-sidebar-empty
 *
 * Env knobs:
 *   DAINTREE_SHOT_SIDEBAR_EMPTY  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            output directory (default: artifacts/sidebar-empty-shots)
 *   DAINTREE_SHOT_THEME          theme id for the state matrix (default: daintree)
 *   DAINTREE_SHOT_THEMES         comma-separated ids for the cross-theme sweep
 *                                (default: every built-in theme; "none" skips it)
 *
 * Output: <dir>/<NN-slug>.png, <dir>/themes/<theme>-<slug>.png, and STATES.json
 * with the list area's rendered text, buttons and geometry for every shot.
 *
 * Verification contract: every step asserts the state it drove actually
 * rendered (the checked tab, the live query, the absence of feature rows)
 * BEFORE writing a file, and a step that throws records a failure instead of
 * writing one. The test fails at the end listing every state it could not
 * capture, so a green run means every PNG on disk is real.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { ensureFilterSectionOpen } from "../helpers/workflows";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_SIDEBAR_EMPTY;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const STATE_THEME = process.env.DAINTREE_SHOT_THEME ?? "daintree";
const OUTPUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "sidebar-empty-shots")
);

const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const SWEEP_THEMES =
  process.env.DAINTREE_SHOT_THEMES === "none"
    ? []
    : (process.env.DAINTREE_SHOT_THEMES ?? ALL_THEMES.join(","))
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

const SIDEBAR = SEL.sidebar.aside;
const FEATURE_ROW =
  '[data-worktree-row]:not([data-worktree-is-main="true"]):not(:has([data-worktree-is-main="true"]))';
const OPEN_POPOVER = `${SEL.worktree.filterPopover}[data-state="open"]`;
/** Header, rail, main card, tab strip and the empty state beneath them. */
const REGION_HEIGHT = 620;
/** Comfortably past WorktreeSidebarSearchBar's 500ms query-persist debounce. */
const QUERY_PERSIST_SETTLE_MS = 900;

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

const FEATURES = [
  { branch: "feature/oauth-device-flow", dirty: true },
  { branch: "feature/streaming-token-budget", dirty: false },
  { branch: "fix/auth-refresh-retry-backoff-jitter", dirty: true },
  { branch: "chore/bump-electron-42-and-chromium-148", dirty: false },
  { branch: "refactor/worktree-port-broker", dirty: true },
  { branch: "docs/plugin-authoring-guide", dirty: false },
];

type Tab = "All" | "Working" | "Attention" | "Finished";

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = (): number => 0;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  // Main is dirty, so a Dirty facet keeps the main card on screen.
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n");

  for (const f of FEATURES) {
    const slug = f.branch.replace(/[/]/g, "-");
    const wtDir = path.join(wtRoot, slug);
    git(`branch ${f.branch}`, dir);
    git(`worktree add ${JSON.stringify(wtDir)} ${f.branch}`, dir);
    writeFileSync(path.join(wtDir, "change.md"), `change on ${f.branch}\n`);
    git("add -A", wtDir);
    git(`commit -m "work on ${slug}"`, wtDir);
    if (f.dirty) writeFileSync(path.join(wtDir, "wip.txt"), "in progress\n");
  }

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 450): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function sidebarWidth(page: Page): Promise<number> {
  return Math.round((await page.locator(SIDEBAR).first().boundingBox())?.width ?? -1);
}

/** Keyboard-resize the sidebar; the separator moves in exact 10px steps. */
async function setSidebarWidth(page: Page, width: number): Promise<void> {
  const handle = page.locator(SEL.sidebar.resizeHandle).first();
  await handle.focus();
  for (let i = 0; i < 60; i++) {
    const current = await sidebarWidth(page);
    if (Math.abs(current - width) < 5) break;
    await page.keyboard.press(current > width ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(30);
  }
  await handle.evaluate((el: HTMLElement) => el.blur());
  await settle(page, 350);
  await expect
    .poll(async () => Math.abs((await sidebarWidth(page)) - width), { timeout: 5000 })
    .toBeLessThan(5);
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(1200, 700);
  await settle(page, 250);
}

async function blurAll(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page, 150);
}

function tabRadio(page: Page, tab: Tab) {
  return page
    .locator(SIDEBAR)
    .getByRole("radio", { name: new RegExp(`^${tab},`) })
    .first();
}

/** Idempotent: clicking the checked segment toggles back to All. */
async function selectTab(page: Page, tab: Tab): Promise<void> {
  const radio = tabRadio(page, tab);
  if ((await radio.getAttribute("aria-checked")) !== "true") await radio.click();
  await expect(radio).toHaveAttribute("aria-checked", "true", { timeout: 5000 });
  await settle(page, 400);
}

async function typeQuery(page: Page, query: string): Promise<void> {
  const input = page.locator(SEL.worktree.searchInput).first();
  await input.click();
  await input.fill(query);
  await expect(page.locator(SIDEBAR).getByLabel("Clear search")).toBeVisible();
  await settle(page, 500);
}

async function clearQuery(page: Page): Promise<void> {
  const input = page.locator(SEL.worktree.searchInput).first();
  await input.fill("");
  await expect(page.locator(SIDEBAR).getByLabel("Clear search")).toHaveCount(0, { timeout: 5000 });
  await page.waitForTimeout(QUERY_PERSIST_SETTLE_MS);
}

async function toggleDirtyFacet(page: Page): Promise<void> {
  const popover = page.locator(OPEN_POPOVER).first();
  await page.locator(SEL.worktree.filterButton).first().click();
  await expect(popover).toBeVisible({ timeout: 6000 });
  await ensureFilterSectionOpen(popover, "Status");
  await settle(page, 300);
  await popover
    .getByRole("button", { name: /^Dirty/ })
    .first()
    .click();
  await settle(page, 300);
  await page.keyboard.press("Escape");
  await expect(page.locator(OPEN_POPOVER)).toHaveCount(0, { timeout: 5000 });
}

/** Back to All, no query, no facets — asserted, so no state leaks forward. */
async function resetFilters(page: Page): Promise<void> {
  if ((await page.locator(SIDEBAR).getByLabel("Clear search").count()) > 0) await clearQuery(page);
  // The tab counts toward the trigger's number, so it goes first; whatever is
  // left on the trigger after that is the Dirty facet.
  await selectTab(page, "All");
  if (/\d/.test((await page.locator(SEL.worktree.filterButton).first().textContent()) ?? "")) {
    await toggleDirtyFacet(page);
  }
  await expect(page.locator(SEL.worktree.filterButton).first()).not.toContainText(/\d/);
  await blurAll(page);
}

/** No feature rows on screen: the list area really is in an empty branch. */
async function expectNoFeatureRows(page: Page): Promise<void> {
  await expect(page.locator(SIDEBAR).locator(FEATURE_ROW)).toHaveCount(0, {
    timeout: 5000,
  });
}

interface StateRecord {
  slug: string;
  sidebarWidth: number;
  listText: string;
  buttons: { text: string; width: number; height: number; left: number; top: number }[];
  emptyStateBox: { top: number; height: number; width: number } | null;
  mainCardVisible: boolean;
  tabBarBottom: number | null;
}

async function describeListArea(page: Page, slug: string): Promise<StateRecord> {
  const record = await page.evaluate(() => {
    const aside = document.querySelector('aside[aria-label="Sidebar"]');
    if (!aside) throw new Error("no sidebar");
    const origin = aside.getBoundingClientRect();
    const grid = aside.querySelector('[role="grid"]');
    const list = grid?.querySelector(':scope > div[role="presentation"].relative') ?? null;
    const empty = list?.firstElementChild ?? null;
    const tabs = aside.querySelector('[role="radiogroup"][aria-label="Quick state filter"]');
    const rel = (r: DOMRect) => ({
      left: +(r.left - origin.left).toFixed(1),
      top: +(r.top - origin.top).toFixed(1),
      width: +r.width.toFixed(1),
      height: +r.height.toFixed(1),
    });
    return {
      sidebarWidth: +origin.width.toFixed(1),
      listText: ((empty as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim(),
      buttons: Array.from(list?.querySelectorAll("button") ?? []).map((b) => ({
        text: (b.textContent ?? "").trim(),
        ...rel(b.getBoundingClientRect()),
      })),
      emptyStateBox: empty ? rel(empty.getBoundingClientRect()) : null,
      mainCardVisible: !!aside.querySelector('[data-worktree-is-main="true"]'),
      tabBarBottom: tabs ? +(tabs.getBoundingClientRect().bottom - origin.top).toFixed(1) : null,
    };
  });
  return { slug, ...record };
}

class Capture {
  readonly failures: string[] = [];
  readonly records: StateRecord[] = [];
  written = 0;

  constructor(private readonly page: Page) {}

  async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.failures.push(`${name}: ${String(error).slice(0, 1200)}`);
    }
  }

  async snap(dir: string, slug: string, opts: { full?: boolean } = {}): Promise<void> {
    await parkPointer(this.page);
    await settle(this.page);
    const box = await this.page.locator(SIDEBAR).first().boundingBox();
    if (!box) throw new Error("sidebar has no bounding box");
    mkdirSync(dir, { recursive: true });
    await this.page.screenshot({
      path: path.join(dir, `${slug}.png`),
      type: "png",
      animations: "disabled",
      caret: "hide",
      clip: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: opts.full ? box.height : Math.min(REGION_HEIGHT, box.height),
      },
    });
    this.records.push(await describeListArea(this.page, slug));
    this.written++;
  }
}

async function openProjectFixture(ctx: AppContext, repoDir: string, theme: string): Promise<Page> {
  const page = await openAndOnboardProject(ctx.app, ctx.window, repoDir, "Helios Dashboard");
  if (theme) await setAppTheme(page, theme);
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
  await page.locator(SEL.worktree.searchInput).waitFor({ state: "visible", timeout: T_LONG });
  // Virtuoso may not mount every row, so wait for "several", not an exact count.
  await expect
    .poll(async () => page.locator(SIDEBAR).locator(FEATURE_ROW).count(), { timeout: T_LONG })
    .toBeGreaterThanOrEqual(4);
  await settle(page, 2000);
  await dismissBlockingPalette(page);
  return page;
}

test("worktrees sidebar empty list — state matrix and theme sweep", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SIDEBAR_EMPTY is required for the sidebar empty-list capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SIDEBAR_EMPTY to run the sidebar empty-list capture");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo("daintree-emptyshots-");
  // Not "daintree-e2e": launchApp's pre-launch hygiene pkills that pattern.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-emptyshot-ud-"));
  let ctx: AppContext | undefined;
  let cap: Capture | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openProjectFixture(ctx, repo.dir, STATE_THEME);
    cap = new Capture(page);
    const c = cap;
    const defaultWidth = await sidebarWidth(page);

    await c.step("rest", async () => {
      await resetFilters(page);
      await expect(page.locator(SIDEBAR).locator(FEATURE_ROW).first()).toBeVisible();
      await c.snap(OUTPUT_DIR, "00-rest-all");
    });

    const drained: [Tab, string][] = [
      ["Working", "01-working-drained"],
      ["Attention", "02-attention-drained"],
      ["Finished", "03-finished-drained"],
    ];
    for (const [tab, slug] of drained) {
      await c.step(slug, async () => {
        await resetFilters(page);
        await selectTab(page, tab);
        await expectNoFeatureRows(page);
        await c.snap(OUTPUT_DIR, slug);
      });
    }

    await c.step("01-working-drained-full", async () => {
      await resetFilters(page);
      await selectTab(page, "Working");
      await expectNoFeatureRows(page);
      await c.snap(OUTPUT_DIR, "04-working-drained-full", { full: true });
    });

    // A search that matches nothing, on the All tab.
    await c.step("search-nomatch", async () => {
      await resetFilters(page);
      await typeQuery(page, "zzzqqq");
      await expectNoFeatureRows(page);
      await expect(page.locator(SEL.worktree.mainCard)).toHaveCount(0);
      await c.snap(OUTPUT_DIR, "05-search-nomatch");
    });

    // The search found worktrees, but none of them is in the selected tab.
    await c.step("tab-hides-search-matches", async () => {
      await resetFilters(page);
      await typeQuery(page, "auth");
      await expect(page.locator(SIDEBAR).locator(FEATURE_ROW).first()).toBeVisible();
      await selectTab(page, "Working");
      await expectNoFeatureRows(page);
      await c.snap(OUTPUT_DIR, "06-tab-hides-search-matches");
    });

    // A facet found three dirty worktrees, none of them working; main stays up.
    await c.step("tab-hides-facet-matches", async () => {
      await resetFilters(page);
      await toggleDirtyFacet(page);
      await expect(page.locator(SIDEBAR).locator(FEATURE_ROW)).toHaveCount(3);
      await selectTab(page, "Working");
      await expectNoFeatureRows(page);
      await expect(page.locator(SEL.worktree.mainCard)).toBeVisible();
      await c.snap(OUTPUT_DIR, "07-tab-hides-facet-matches");
    });

    // A facet plus a search that together match nothing anywhere.
    await c.step("facet-search-nomatch", async () => {
      await resetFilters(page);
      await toggleDirtyFacet(page);
      await typeQuery(page, "plugin");
      await expectNoFeatureRows(page);
      await expect(page.locator(SEL.worktree.mainCard)).toHaveCount(0);
      await c.snap(OUTPUT_DIR, "08-facet-search-nomatch");
    });

    // The search matches only the main card, with a state tab selected.
    await c.step("main-only-match", async () => {
      await resetFilters(page);
      await selectTab(page, "Working");
      await typeQuery(page, "main");
      await expect(page.locator(SEL.worktree.mainCard)).toBeVisible();
      await expectNoFeatureRows(page);
      await c.snap(OUTPUT_DIR, "09-main-only-match");
    });

    // The 200px floor: every state above has to survive it.
    await c.step("width-200", async () => {
      await resetFilters(page);
      await setSidebarWidth(page, 200);
      await selectTab(page, "Working");
      await expectNoFeatureRows(page);
      await c.snap(OUTPUT_DIR, "10-working-drained-200");
      await selectTab(page, "Attention");
      await expectNoFeatureRows(page);
      await c.snap(OUTPUT_DIR, "11-attention-drained-200");
      await resetFilters(page);
      await typeQuery(page, "zzzqqq");
      await expectNoFeatureRows(page);
      await c.snap(OUTPUT_DIR, "12-search-nomatch-200");
      await resetFilters(page);
      await typeQuery(page, "auth");
      await selectTab(page, "Working");
      await expectNoFeatureRows(page);
      await c.snap(OUTPUT_DIR, "13-tab-hides-search-matches-200");
      // An identifier with no break opportunity, wider than the column.
      await resetFilters(page);
      await typeQuery(page, "refreshTokenRotationBackoffJitterPolicy");
      await expectNoFeatureRows(page);
      await c.snap(OUTPUT_DIR, "15-long-query-nomatch-200");
      await resetFilters(page);
      await setSidebarWidth(page, defaultWidth);
    });

    // Keyboard: Tab from the search field to the first control in the list area.
    await c.step("keyboard-focus", async () => {
      await resetFilters(page);
      await typeQuery(page, "zzzqqq");
      await expectNoFeatureRows(page);
      const listButtons = page
        .locator(SIDEBAR)
        .locator('[role="grid"] > div[role="presentation"].relative button');
      if ((await listButtons.count()) > 0) {
        await listButtons.first().focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(listButtons.first()).toBeFocused();
      }
      await settle(page, 200);
      const box = await page.locator(SIDEBAR).first().boundingBox();
      if (!box) throw new Error("sidebar has no bounding box");
      await page.screenshot({
        path: path.join(OUTPUT_DIR, "14-search-nomatch-focus.png"),
        type: "png",
        animations: "disabled",
        caret: "hide",
        clip: { x: box.x, y: box.y, width: box.width, height: Math.min(REGION_HEIGHT, box.height) },
      });
      c.records.push(await describeListArea(page, "14-search-nomatch-focus"));
      c.written++;
      await resetFilters(page);
    });

    const themeDir = path.join(OUTPUT_DIR, "themes");
    for (const theme of SWEEP_THEMES) {
      await c.step(`theme-${theme}`, async () => {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await page.locator(SEL.worktree.searchInput).waitFor({ state: "visible", timeout: T_LONG });
        await settle(page, 1200);
        await resetFilters(page);
        await selectTab(page, "Working");
        await expectNoFeatureRows(page);
        await c.snap(themeDir, `${theme}-working-drained`);
        await resetFilters(page);
        await typeQuery(page, "zzzqqq");
        await expectNoFeatureRows(page);
        await c.snap(themeDir, `${theme}-search-nomatch`);
        await clearQuery(page);
      });
    }

    writeFileSync(path.join(OUTPUT_DIR, "STATES.json"), JSON.stringify(c.records, null, 2) + "\n");

    if (c.failures.length > 0) {
      throw new Error(
        `sidebar empty-list capture: ${c.failures.length} state(s) failed and were not written:\n` +
          c.failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const pngs = [
    ...readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")),
    ...(existsSync(path.join(OUTPUT_DIR, "themes"))
      ? readdirSync(path.join(OUTPUT_DIR, "themes")).filter((f) => f.endsWith(".png"))
      : []),
  ];
  expect(pngs.length, `expected ${cap?.written ?? 0} PNGs in ${OUTPUT_DIR}`).toBe(cap?.written);
});
