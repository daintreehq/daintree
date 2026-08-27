/**
 * Worktrees sidebar control-zone visual-review harness.
 *
 * Boots a repo with a main worktree plus several feature worktrees, then writes
 * PNGs of every state the fixed control zone at the top of the sidebar carries
 * design weight in — header at rest / hover / keyboard focus, the search field
 * empty / typed / long / no-match, one and several active filter axes, the
 * filter popover collapsed / expanded / active, the loading and only-main
 * variants, and the zone at minimum, default and generous sidebar widths — so
 * a redesign can be judged against real rendered pixels.
 *
 * Opt-in only, like theme-review: skips itself unless DAINTREE_SHOT_SIDEBAR is
 * set, so the marketing screenshots workflow never executes it.
 *
 *   DAINTREE_SHOT_SIDEBAR=1 npx playwright test --project=screenshots worktree-sidebar-rail
 *
 * Env knobs:
 *   DAINTREE_SHOT_SIDEBAR    required — any truthy value runs the state capture
 *   DAINTREE_SHOT_THEME      theme id for the state capture (default: daintree)
 *   DAINTREE_SHOT_THEMES     comma-separated ids for the cross-theme sweep
 *                            (default: every built-in theme)
 *   DAINTREE_SHOT_TAG        optional suffix so review rounds sit side by side
 *   DAINTREE_SHOT_ONLY       comma-separated step filter (see step names below)
 *
 * Output: artifacts/sidebar-shots/<theme>/<NN-slug>[-tag].png (gitignored).
 *
 * Verification contract: every step asserts the state it drove actually
 * rendered BEFORE writing a file, and a step that throws records a failure
 * instead of writing one. The test fails at the end with the list of states it
 * could not capture, so a green run means every PNG on disk is real.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { addAndSwitchToProject } from "../helpers/workflows";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_SIDEBAR;
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const STATE_THEME = process.env.DAINTREE_SHOT_THEME ?? "daintree";

/** Every built-in theme, light and dark, in id order. */
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

const SWEEP_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ALL_THEMES.join(","))
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const SIDEBAR = SEL.sidebar.aside;
/** SEL.sidebar.resizeHandle matches the label exactly; the real one is
 *  "Resize sidebar (double-click to reset)". */
const RESIZE_HANDLE = '[aria-label^="Resize sidebar"]';
/**
 * Radix keeps a closing popover mounted through its exit animation, and it
 * precedes the new one in DOM order — so a bare testid + `.first()` can
 * resolve to the stale copy, which still renders the state it closed with.
 * Every popover assertion here addresses the one that is actually open.
 */
const OPEN_POPOVER = `${SEL.worktree.filterPopover}[data-state="open"]`;
/** Tall enough to hold the header, the rail, the status line and the first card. */
const ZONE_HEIGHT = 420;
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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

interface Fixture {
  dir: string;
  cleanup: () => void;
}

/**
 * Feature branches chosen so the rail has something to do: several match
 * "auth", one is long enough to test truncation at 200px, and the prefixes
 * spread across the popover's Branch Type taxonomy.
 */
const FEATURES = [
  { branch: "feature/oauth-device-flow", dirty: true, commits: 2 },
  { branch: "feature/streaming-token-budget", dirty: false, commits: 1 },
  { branch: "fix/auth-refresh-retry-backoff-jitter", dirty: true, commits: 3 },
  { branch: "chore/bump-electron-42-and-chromium-148", dirty: false, commits: 1 },
  { branch: "refactor/worktree-port-broker", dirty: true, commits: 1 },
  { branch: "docs/plugin-authoring-guide", dirty: false, commits: 1 },
];

/** Repo with a main worktree plus the feature worktrees above. */
function createRailRepo(prefix: string, features: typeof FEATURES): Fixture {
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
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n\n- sidebar rail pass\n");

  for (const f of features) {
    const slug = f.branch.replace(/[/]/g, "-");
    const wtDir = path.join(wtRoot, slug);
    git(`branch ${f.branch}`, dir);
    git(`worktree add ${JSON.stringify(wtDir)} ${f.branch}`, dir);
    for (let i = 0; i < f.commits; i++) {
      writeFileSync(path.join(wtDir, `change-${i}.md`), `change ${i} on ${f.branch}\n`);
      git("add -A", wtDir);
      git(`commit -m "work ${i} on ${slug}"`, wtDir);
    }
    if (f.dirty) {
      writeFileSync(path.join(wtDir, "wip.txt"), "in progress\n");
      writeFileSync(path.join(wtDir, "src", "index.ts"), `// ${slug}\nexport const x = 1;\n`);
    }
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

/** Current rendered width of the sidebar column. */
async function sidebarWidth(page: Page): Promise<number> {
  return Math.round((await page.locator(SIDEBAR).first().boundingBox())?.width ?? -1);
}

/**
 * Resize the sidebar to an absolute logical width using the separator's own
 * keyboard affordance — ArrowLeft/ArrowRight move in fixed 10px steps, so the
 * end width is exact. A synthetic pointer drag depends on hit geometry that
 * did not hold here, and silently landed back on the default width.
 */
async function setSidebarWidth(page: Page, width: number): Promise<void> {
  const handle = page.locator(RESIZE_HANDLE).first();
  await handle.focus();
  for (let i = 0; i < 60; i++) {
    const current = await sidebarWidth(page);
    if (Math.abs(current - width) < 5) break;
    await page.keyboard.press(current > width ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(30);
  }
  // Blur the separator: it paints its own focus indicator, which would sit in
  // every width capture as a stray coloured rule down the sidebar edge.
  await handle.evaluate((el: HTMLElement) => el.blur());
  await settle(page, 350);
  await expect
    .poll(async () => sidebarWidth(page), {
      timeout: 5000,
      message: `sidebar should resize to ${width}px`,
    })
    .toBe(width);
}

/** Park the pointer well away from the sidebar so no hover state leaks in. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(1200, 700);
  await settle(page, 250);
}

/** Drop focus so a "rest" capture does not inherit the previous step's ring. */
async function blurAll(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page, 200);
}

/**
 * Measured geometry of the control zone, written beside the PNGs.
 *
 * A review argued from CSS arithmetic gets the nesting wrong; these are the
 * boxes the browser actually laid out, in CSS pixels relative to the sidebar's
 * own left edge, so claims about insets, control heights and the zone's total
 * cost are checkable rather than estimated.
 */
async function collectMetrics(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const aside = document.querySelector('aside[aria-label="Sidebar"]');
    if (!aside) return { error: "no sidebar" };
    const origin = aside.getBoundingClientRect();
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: +(r.left - origin.left).toFixed(1),
        right: +(origin.right - r.right).toFixed(1),
        top: +(r.top - origin.top).toFixed(1),
        width: +r.width.toFixed(1),
        height: +r.height.toFixed(1),
      };
    };
    const heading = aside.querySelector("h2");
    const header = heading?.closest("div.group\\/header") ?? heading?.parentElement?.parentElement;
    const input = aside.querySelector('[aria-label="Search worktrees"]');
    const field = input?.closest('[role="search"]') ?? null;
    const glyph = field?.querySelector("svg") ?? null;
    const trigger = aside.querySelector('[aria-label="Filter and sort worktrees"]');
    const rail = trigger?.closest("div.shrink-0") ?? null;
    const firstCard = aside.querySelector("[data-worktree-is-main]");
    return {
      sidebarWidth: +origin.width.toFixed(1),
      header: box(header ?? null),
      heading: box(heading ?? null),
      rail: box(rail),
      field: box(field),
      searchGlyph: box(glyph),
      filterTrigger: box(trigger),
      firstCard: box(firstCard),
      zoneHeightToFirstCard: firstCard
        ? +(firstCard.getBoundingClientRect().top - origin.top).toFixed(1)
        : null,
      dividers: Array.from(aside.querySelectorAll("div"))
        .filter((el) => {
          const cs = getComputedStyle(el);
          return (
            cs.borderBottomWidth !== "0px" &&
            cs.borderBottomStyle !== "none" &&
            el.getBoundingClientRect().top - origin.top < 260
          );
        })
        .map((el) => ({
          y: +(el.getBoundingClientRect().bottom - origin.top).toFixed(1),
          color: getComputedStyle(el).borderBottomColor,
          cls: el.className.toString().slice(0, 60),
        })),
    };
  });
}

class Capture {
  readonly failures: string[] = [];
  readonly missing: string[] = [];
  readonly notes: string[] = [];

  note(text: string): void {
    this.notes.push(text);
  }
  private written = 0;
  private readonly only: string[];

  constructor(
    private readonly page: Page,
    private outputDir: string
  ) {
    this.only = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
  }

  setOutputDir(dir: string): void {
    this.outputDir = dir;
    mkdirSync(dir, { recursive: true });
  }

  get count(): number {
    return this.written;
  }

  /**
   * Drive a state, assert it rendered, then write the PNG. A step that throws
   * records a failure and writes nothing — never a plausible-looking artifact
   * for a state that did not happen.
   */
  async step(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.only.length > 0 && !this.only.includes(name)) return;
    try {
      await fn();
    } catch (error) {
      this.failures.push(`${name}: ${String(error).slice(0, 1200)}`);
    }
  }

  /**
   * A state the harness cannot drive deterministically (a transient the app
   * owns, like the loading skeleton). A miss is recorded in MISSING.txt beside
   * the PNGs so the review is told the state is absent, rather than failing the
   * whole run or — worse — writing a stand-in.
   */
  async optionalStep(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.only.length > 0 && !this.only.includes(name)) return;
    try {
      await fn();
    } catch (error) {
      this.missing.push(`${name}: ${String(error).slice(0, 300)}`);
    }
  }

  /** Full-height sidebar column. */
  async snapSidebar(slug: string): Promise<void> {
    await settle(this.page);
    await this.page
      .locator(SIDEBAR)
      .first()
      .screenshot({ path: this.file(slug), type: "png", animations: "disabled", caret: "hide" });
    this.written++;
  }

  /** Just the control zone plus the top of the first card. */
  async snapZone(slug: string): Promise<void> {
    await settle(this.page);
    const box = await this.page.locator(SIDEBAR).first().boundingBox();
    if (!box) throw new Error("sidebar has no bounding box");
    await this.page.screenshot({
      path: this.file(slug),
      type: "png",
      animations: "disabled",
      caret: "hide",
      clip: { x: box.x, y: box.y, width: box.width, height: Math.min(ZONE_HEIGHT, box.height) },
    });
    this.written++;
  }

  /** An overlay that escapes the sidebar's bounds — the filter popover. */
  async snapLocator(slug: string, locator: Locator): Promise<void> {
    await settle(this.page);
    await locator.screenshot({ path: this.file(slug), type: "png" });
    this.written++;
  }

  /** The sidebar and the popover together, so their relationship is visible. */
  async snapRegion(slug: string, width: number, height: number): Promise<void> {
    await settle(this.page);
    const box = await this.page.locator(SIDEBAR).first().boundingBox();
    if (!box) throw new Error("sidebar has no bounding box");
    await this.page.screenshot({
      path: this.file(slug),
      type: "png",
      animations: "disabled",
      caret: "hide",
      clip: { x: box.x, y: box.y, width, height },
    });
    this.written++;
  }

  private file(slug: string): string {
    return path.join(this.outputDir, `${slug}${TAG}.png`);
  }
}

/** Type into the search field and wait for the visible list to react. */
async function typeQuery(page: Page, query: string): Promise<void> {
  const input = page.locator(SEL.worktree.searchInput).first();
  await input.click();
  await input.fill(query);
  await settle(page, 500);
}

/**
 * Clear the query AND wait out its persistence debounce.
 *
 * The visible filter clears instantly but the localStorage write is debounced
 * 500ms, so a theme switch (which reloads the renderer) inside that window
 * rehydrates the old query — which is how fourteen "rest" frames in the first
 * theme sweep came back with `auth` still typed.
 */
async function clearQuery(page: Page): Promise<void> {
  const input = page.locator(SEL.worktree.searchInput).first();
  await input.fill("");
  await expect(page.locator(SIDEBAR).getByLabel("Clear search")).toHaveCount(0, { timeout: 5000 });
  await page.waitForTimeout(QUERY_PERSIST_SETTLE_MS);
  await settle(page, 200);
}

/**
 * Open the filter popover and wait for its content. Idempotent: the trigger is
 * a toggle, so a popover left open by a failed step would be CLOSED by a naive
 * click, cascading one failure into every later popover step.
 */
async function openFilterPopover(page: Page): Promise<Locator> {
  const popover = page.locator(OPEN_POPOVER).first();
  if (!(await popover.isVisible().catch(() => false))) {
    await page.locator(SEL.worktree.filterButton).first().click();
  }
  await expect(popover).toBeVisible({ timeout: 6000 });
  await settle(page, 400);
  return popover;
}

async function closeFilterPopover(page: Page): Promise<void> {
  if ((await page.locator(OPEN_POPOVER).count()) === 0) return;
  await page.keyboard.press("Escape");
  await expect(page.locator(OPEN_POPOVER)).toHaveCount(0, { timeout: 5000 });
  await settle(page, 250);
}

/**
 * A button inside the popover, addressed by its rendered text.
 *
 * NOT `getByText` / `getByRole`: `Button` wraps its label in a
 * `display: contents` span, which has no box, so Playwright reads the label
 * element as invisible and a click on it never becomes actionable. `:has-text`
 * on the `<button>` itself matches the element that does have a box.
 */
function popoverButton(popover: Locator, label: string): Locator {
  return popover.locator(`button:has-text(${JSON.stringify(label)})`).first();
}

/**
 * Assert a string is really in the open popover, quoting what IS there when it
 * is not — a bare "element not found" says nothing about which state rendered.
 */
async function expectInPopover(popover: Locator, text: string): Promise<void> {
  // textContent, not innerText: the popover clips and scrolls, and innerText's
  // "rendered text" approximation is exactly the wrong oracle for asking
  // whether something is in the DOM at all.
  const body = (await popover.textContent().catch(() => "")) ?? "";
  if (!body.replace(/\s+/g, " ").toLowerCase().includes(text.toLowerCase())) {
    throw new Error(
      `popover missing "${text}". Popover buttons were: ` +
        (await popover
          .evaluate((el) =>
            Array.from(el.querySelectorAll("button"))
              .map((b) => (b.textContent ?? "").trim())
              .join(" | ")
          )
          .catch(() => "<unreadable>"))
    );
  }
}

/** Scroll an overflowing popover to its end so the footer is in frame. */
async function scrollPopoverToEnd(popover: Locator): Promise<void> {
  await popover.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

async function openProjectFixture(ctx: AppContext, repoDir: string, theme: string): Promise<Page> {
  const page = await openAndOnboardProject(ctx.app, ctx.window, repoDir, "Helios Dashboard");
  if (theme) await setAppTheme(page, theme);
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
  await page.locator(SEL.worktree.searchInput).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 2000);
  await dismissBlockingPalette(page);
  return page;
}

test("worktrees sidebar rail — state matrix", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SIDEBAR is required for the sidebar rail capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SIDEBAR to run the sidebar rail capture");

  const outputDir = path.resolve(process.cwd(), "artifacts", "sidebar-shots", STATE_THEME);
  mkdirSync(outputDir, { recursive: true });
  const repo = createRailRepo("daintree-railshots-", FEATURES);
  const soloRepo = createRailRepo("daintree-railsolo-", []);
  // Prefix deliberately avoids "daintree-e2e": launchApp's pre-launch hygiene
  // pkills that pattern, and a concurrent capture session would otherwise
  // SIGKILL this one mid-launch. launchApp skips auto-cleanup for
  // caller-provided dirs, so remove it in the finally.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-railshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openProjectFixture(ctx, repo.dir, STATE_THEME);
    const cap = new Capture(page, outputDir);

    // 0. Measured geometry, so the review argues from laid-out boxes rather
    //    than from CSS arithmetic over nested padding.
    await cap.step("metrics", async () => {
      await parkPointer(page);
      const metrics = await collectMetrics(page);
      writeFileSync(path.join(outputDir, "METRICS.json"), JSON.stringify(metrics, null, 2) + "\n");
    });

    // 1. Rest — the shot the whole refinement is judged on.
    await cap.step("rest", async () => {
      await parkPointer(page);
      await expect(page.locator(SIDEBAR).getByRole("heading", { name: "Worktrees" })).toBeVisible();
      await expect(page.locator(SEL.worktree.searchInput)).toBeVisible();
      await cap.snapSidebar("10-rest-sidebar");
      await cap.snapZone("11-rest-zone");
    });

    // 2. Header hover — the reveal the three secondary actions live behind.
    await cap.step("header-hover", async () => {
      await page.locator(SIDEBAR).getByRole("heading", { name: "Worktrees" }).hover();
      await settle(page, 400);
      await expect(page.locator(SEL.worktree.openOverviewButton)).toBeVisible();
      await cap.snapZone("12-header-hover");
      await parkPointer(page);
    });

    // 3. Keyboard focus walking backwards out of the search field into the
    //    header cluster — the reveal path a keyboard user actually takes.
    await cap.step("header-focus", async () => {
      await page.locator(SEL.worktree.searchInput).first().click();
      await page.keyboard.press("Shift+Tab"); // create-worktree "+"
      await settle(page, 250);
      await expect(page.locator(SEL.worktree.newWorktreeButton)).toBeFocused();
      await cap.snapZone("13-focus-create");
      await page.keyboard.press("Shift+Tab"); // refresh
      await page.keyboard.press("Shift+Tab"); // fleet arm
      await page.keyboard.press("Shift+Tab"); // overview
      await settle(page, 250);
      await expect(page.locator(SEL.worktree.openOverviewButton)).toBeFocused();
      await cap.snapZone("14-focus-overview");
      await page.locator(SEL.worktree.searchInput).first().click();
      await page.keyboard.press("Escape");
      await parkPointer(page);
    });

    // 4. Search field focused and empty.
    await cap.step("search-focus", async () => {
      await page.locator(SEL.worktree.searchInput).first().click();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await settle(page, 300);
      await expect(page.locator(SEL.worktree.searchInput)).toBeFocused();
      await cap.snapZone("20-search-focus");
    });

    // 5. Typed query — clear button, status line, filtered list.
    await cap.step("search-typed", async () => {
      await typeQuery(page, "auth");
      await expect(page.locator(SIDEBAR).getByLabel("Clear search")).toBeVisible();
      await cap.snapSidebar("21-search-typed-sidebar");
      await cap.snapZone("22-search-typed-zone");
    });

    // 6. Long query — the field's truncation behaviour and the status line's.
    await cap.step("search-long", async () => {
      await typeQuery(page, "feature/streaming-token-budget-with-a-very-long-tail");
      await expect(page.locator(SIDEBAR).getByLabel("Clear search")).toBeVisible();
      await cap.snapZone("23-search-long");
    });

    // 7. No match — the zero-result branch under the rail.
    await cap.step("search-nomatch", async () => {
      await typeQuery(page, "zzzqqq");
      await expect(page.locator(SIDEBAR).getByLabel("Clear search")).toBeVisible();
      await cap.snapSidebar("24-search-nomatch");
      await clearQuery(page);
    });

    // 8. One facet filter — the neutral count on the trigger, and the status line.
    await cap.step("filters-one", async () => {
      const popover = await openFilterPopover(page);
      await popover.getByRole("button", { name: "Status" }).first().click();
      await settle(page, 300);
      await popover
        .getByRole("button", { name: /^Dirty/ })
        .first()
        .click();
      await settle(page, 400);
      await closeFilterPopover(page);
      await parkPointer(page);
      await expect(page.locator(SEL.worktree.filterButton)).toContainText("1");
      await cap.snapSidebar("30-filter-one-sidebar");
      await cap.snapZone("31-filter-one-zone");
    });

    // 9. Several axes — count, status line and "Clear all" all present at once.
    await cap.step("filters-many", async () => {
      const popover = await openFilterPopover(page);
      await popover.getByRole("button", { name: "Branch Type" }).first().click();
      await settle(page, 300);
      await popover
        .getByRole("button", { name: /^Feature/ })
        .first()
        .click();
      await popover
        .getByRole("button", { name: /^Fix|^Bugfix/ })
        .first()
        .click();
      await settle(page, 400);
      await closeFilterPopover(page);
      await typeQuery(page, "auth");
      await parkPointer(page);
      await expect(page.locator(SIDEBAR).getByRole("button", { name: "Clear all" })).toBeVisible();
      await cap.snapSidebar("32-filters-many-sidebar");
      await cap.snapZone("33-filters-many-zone");
    });

    // 10. Popover with active filters — section counts, per-section Clear, footer.
    //     Asserted on the sections it must contain end to end, NOT on the footer
    //     button: whether the footer renders here is one of the things the
    //     review is looking at, so the harness must not presuppose it.
    await cap.step("popover-active", async () => {
      await expect(page.locator(SEL.worktree.filterButton)).toContainText("3");
      const popover = await openFilterPopover(page);
      await expectInPopover(popover, "Sort by");
      await expectInPopover(popover, "Dev server");
      await cap.snapLocator("40-popover-active", popover);
      await cap.snapRegion("41-popover-active-in-context", 760, 900);
      await scrollPopoverToEnd(popover);
      await cap.snapLocator("45-popover-active-footer", popover);
      // The footer is one of the things under review, so it is observed and
      // reported rather than asserted — a missing footer must show up as a
      // finding about the popover, not as a harness failure that writes nothing.
      cap.note(
        `popover footer with 3 active filters: ` +
          ((await popoverButton(popover, "Clear all filters").count()) > 0 ? "present" : "ABSENT")
      );
      await closeFilterPopover(page);
    });

    // 11. Popover at rest — nothing active. Cleared by toggling the same chips
    //     back off rather than through the footer, so this step does not depend
    //     on the footer the step above is investigating.
    await cap.step("popover-rest", async () => {
      await clearQuery(page);
      const popover = await openFilterPopover(page);
      for (const chip of [/^Dirty/, /^Feature/, /^Bugfix/]) {
        await popover
          .getByRole("button", { name: chip })
          .first()
          .click()
          .catch(() => {});
        await settle(page, 250);
      }
      await expect(page.locator(SEL.worktree.filterButton)).not.toContainText(/\d/);
      await cap.snapLocator("42-popover-rest", popover);
      await cap.snapRegion("43-popover-rest-in-context", 760, 900);
    });

    // 12. Popover expanded — chips, counts, and the zero-count dimming.
    await cap.step("popover-expanded", async () => {
      const popover = await openFilterPopover(page);
      for (const section of ["Status", "Branch Type", "Sessions"]) {
        const toggle = popover.getByRole("button", { name: section }).first();
        // Click only when collapsed: these sections keep their own open state
        // across a filter clear, so an unconditional click closes them instead.
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
          await settle(page, 250);
        }
      }
      await expect(popover.getByRole("button", { name: /^Feature/ })).toBeVisible();
      await cap.snapLocator("44-popover-expanded", popover);
      await closeFilterPopover(page);
      await parkPointer(page);
    });

    // 13. Narrow sidebar — the width everything has to survive.
    await cap.step("width-min", async () => {
      await setSidebarWidth(page, 200);
      await blurAll(page);
      await parkPointer(page);
      await expect(page.locator(SIDEBAR).getByRole("heading", { name: "Worktrees" })).toBeVisible();
      await cap.snapSidebar("50-width-200-rest");
      await typeQuery(page, "auth");
      await parkPointer(page);
      await cap.snapZone("51-width-200-typed");
      await clearQuery(page);
    });

    // 14. Narrow + hover — the header cluster's worst case for crowding.
    await cap.step("width-min-hover", async () => {
      await blurAll(page);
      await page.locator(SIDEBAR).getByRole("heading", { name: "Worktrees" }).hover();
      await settle(page, 400);
      await expect(page.locator(SEL.worktree.openOverviewButton)).toBeVisible();
      await cap.snapZone("52-width-200-hover");
      await parkPointer(page);
    });

    // 15. Generous sidebar — how the rail reads with room to spare.
    await cap.step("width-wide", async () => {
      await setSidebarWidth(page, 480);
      await blurAll(page);
      await parkPointer(page);
      await cap.snapSidebar("53-width-480-rest");
      await cap.snapZone("54-width-480-zone");
      await setSidebarWidth(page, 350);
    });

    // 16. Loading skeleton — caught on reload. The window is short and belongs
    //     to the app, not the harness, so CPU throttling widens it and a miss is
    //     recorded rather than faked.
    await cap.optionalStep("loading", async () => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 12 });
      try {
        const reload = page.reload({ waitUntil: "domcontentloaded" });
        const skeleton = page.getByLabel("Loading worktrees").first();
        await skeleton.waitFor({ state: "visible", timeout: 20_000 });
        await cap.snapSidebar("60-loading");
        await reload;
      } finally {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
        await cdp.detach().catch(() => {});
      }
      await page.locator(SEL.worktree.searchInput).waitFor({ state: "visible", timeout: T_LONG });
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await settle(page, 1500);
    });

    // 17. Only the main worktree — the branch where the rail does not render.
    await cap.step("only-main", async () => {
      const solo = await addAndSwitchToProject(ctx!.app, page, soloRepo.dir, "Solo");
      await solo.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(solo);
      await solo.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
      await settle(solo, 2000);
      await dismissBlockingPalette(solo);
      await parkPointer(solo);
      await expect(solo.locator(SIDEBAR).getByRole("heading", { name: "Worktrees" })).toBeVisible();
      await expect(solo.locator(SEL.worktree.searchInput)).toHaveCount(0);
      const soloCap = new Capture(solo, outputDir);
      await soloCap.snapSidebar("61-only-main");
      await soloCap.snapZone("62-only-main-zone");
    });

    const notesFile = path.join(outputDir, "NOTES.txt");
    if (cap.notes.length > 0) {
      writeFileSync(notesFile, cap.notes.map((n) => `- ${n}`).join("\n") + "\n");
    } else if (existsSync(notesFile)) {
      rmSync(notesFile);
    }

    const missingFile = path.join(outputDir, "MISSING.txt");
    if (cap.missing.length > 0) {
      writeFileSync(missingFile, cap.missing.map((m) => `- ${m}`).join("\n") + "\n");
    } else if (existsSync(missingFile)) {
      rmSync(missingFile);
    }

    if (cap.failures.length > 0) {
      throw new Error(
        `sidebar rail capture: ${cap.failures.length} state(s) failed and were not written:\n` +
          cap.failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    soloRepo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const written = readdirSync(outputDir).filter((f) => f.endsWith(".png"));
  expect(written.length, `expected sidebar-rail PNGs in ${outputDir}`).toBeGreaterThanOrEqual(20);
});

test("worktrees sidebar rail — theme sweep", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SIDEBAR is required for the sidebar rail theme sweep",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SIDEBAR to run the sidebar rail theme sweep");

  const outputRoot = path.resolve(process.cwd(), "artifacts", "sidebar-shots", "themes");
  mkdirSync(outputRoot, { recursive: true });
  const repo = createRailRepo("daintree-railtheme-", FEATURES);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-railtheme-ud-"));
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  let written = 0;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openProjectFixture(ctx, repo.dir, "");
    const cap = new Capture(page, outputRoot);

    for (const theme of SWEEP_THEMES) {
      try {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await page.locator(SEL.worktree.searchInput).waitFor({ state: "visible", timeout: T_LONG });
        await settle(page, 1200);
        await parkPointer(page);
        cap.setOutputDir(outputRoot);
        await expect(
          page.locator(SIDEBAR).getByRole("heading", { name: "Worktrees" })
        ).toBeVisible();
        // A rest frame must actually be at rest: the clear button only exists
        // when a query is live, so its absence is the proof.
        await expect(page.locator(SIDEBAR).getByLabel("Clear search")).toHaveCount(0);
        await cap.snapZone(`${theme}-rest`);
        await typeQuery(page, "auth");
        await parkPointer(page);
        await expect(page.locator(SIDEBAR).getByLabel("Clear search")).toBeVisible();
        await cap.snapZone(`${theme}-typed`);
        await clearQuery(page);
        written += 2;
      } catch (error) {
        failures.push(`${theme}: ${String(error).slice(0, 300)}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `sidebar rail theme sweep: ${failures.length} theme(s) failed:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const files = readdirSync(outputRoot).filter((f) => f.endsWith(".png"));
  expect(files.length, `expected ${written} theme-sweep PNGs in ${outputRoot}`).toBe(written);
});
