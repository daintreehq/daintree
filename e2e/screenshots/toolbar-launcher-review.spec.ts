/**
 * Toolbar-and-launcher visual-review harness.
 *
 * The two siblings each go deep on one half: `toolbar-strip-review` on the
 * strip's grouping and overflow engine, `launcher-review` on the launcher's
 * rows. This one is about the seam between them — the `+` launcher, the things
 * pinned out of it (agents, panels, recipes), the split-button presets, and the
 * overflow menu that catches them — judged as one assembled surface, at both
 * ends of the customisation range: the stock toolbar a new user sees, and a
 * heavily pinned one.
 *
 * Pins go through the launcher's own pin control and the agent-pins bridge, the
 * seams a user's clicks reach, never a hand-written id: a recipe's pin id is
 * project-scoped, and minting it here would test the harness, not the app.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set.
 *
 *   DAINTREE_SHOT_THEME=daintree DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots toolbar-launcher-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. daintree, bondi)
 *   DAINTREE_SHOT_DIR    required — absolute output dir outside the repo
 *   DAINTREE_SHOT_TAG    optional suffix to keep before/after rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (see STEPS below)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<theme>/<NN-slug>[-tag].png
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SHOT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const OUTPUT_DIR = path.join(SHOT_DIR || "unset", THEME || "unset");

const STRIP = '[role="toolbar"][aria-label="Main toolbar"]';
const TOOLBAR_LAUNCHER = '[data-toolbar-button-id="launcher"] button';
const DOCK_LAUNCHER = '[aria-label="Open launcher"]';
const SEARCH_BOX = '[aria-label="Search agents, panels, and recipes"]';
const OPTION = '[role="option"]';
const OVERFLOW_TRIGGER = (side: "left" | "right") =>
  `[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"][data-visible="true"]`;
const BUTTON = (id: string) => `[data-toolbar-button-id="${id}"]`;

const WIDE = { width: 1680, height: 1050 };
const PROJECT_NAME = "Helios Dashboard";

const DEFAULT_RIGHT = [
  "voice-recording",
  "forge-stats",
  "plugin-tray",
  "canopy",
  "notification-center",
  "copy-tree",
  "resume-sessions",
  "command-palette",
  "settings",
  "problems",
];
const CUSTOM_LEFT = ["launcher", "terminal", "browser", "file-browser", "dev-server"];

const RECIPES = [
  { id: "inrepo-review", name: "Review PR", prompt: "/review" },
  { id: "inrepo-work", name: "Work issue", prompt: "/work {{number}}" },
  {
    id: "inrepo-migrate",
    name: "Migrate remaining JavaScript modules to TypeScript",
    prompt: "/migrate",
  },
];

const STEPS = [
  { name: "minimal-rest", slug: "01-minimal-rest" },
  { name: "minimal-launcher", slug: "02-minimal-launcher-open" },
  { name: "custom-rest", slug: "03-custom-rest" },
  { name: "custom-launcher", slug: "04-custom-launcher-open" },
  { name: "custom-hover-recipe", slug: "05-custom-hover-recipe" },
  { name: "custom-agent-split", slug: "06-custom-agent-split-open" },
  { name: "custom-context-menu", slug: "07-custom-context-menu" },
  { name: "custom-overflow", slug: "08-custom-overflow" },
  { name: "custom-overflow-menu", slug: "09-custom-overflow-menu-open" },
  { name: "custom-narrow", slug: "10-custom-narrow" },
  { name: "dock-and-toolbar", slug: "11-dock-and-toolbar-launchers" },
  { name: "dock-search", slug: "12-dock-search-mixed" },
] as const;

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

/**
 * Recipes and project presets live on disk in the repo, the seams the app loads
 * them from. Recipe names are deliberately uneven: a toolbar of pinned recipes
 * only shows whether it can tell them apart when their names differ.
 */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-tlshots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = () => 0;\n");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "helios", scripts: { dev: "vite" } }, null, 2) + "\n"
  );

  const recipesDir = path.join(dir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  for (const recipe of RECIPES) {
    writeFileSync(
      path.join(recipesDir, `${recipe.id}.json`),
      JSON.stringify(
        {
          id: recipe.id,
          name: recipe.name,
          terminals: [
            { type: "claude", title: recipe.name, env: {}, initialPrompt: recipe.prompt },
          ],
          createdAt: 1775381905486,
          showInEmptyState: false,
        },
        null,
        2
      ) + "\n"
    );
  }

  const presetsDir = path.join(dir, ".daintree", "presets", "claude");
  mkdirSync(presetsDir, { recursive: true });
  for (const preset of [
    { id: "team-plan", name: "Plan first" },
    { id: "team-sonnet", name: "Sonnet" },
  ]) {
    writeFileSync(
      path.join(presetsDir, `${preset.id}.json`),
      JSON.stringify(preset, null, 2) + "\n"
    );
  }

  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

function shotPath(slug: string): string {
  return path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
}

/**
 * What each side of the strip shows and hides, beside every PNG: pixels can't
 * tell an evicted button from a clipped one, or name which recipe a glyph is.
 */
async function dumpState(page: Page, slug: string): Promise<void> {
  const state = await page.evaluate((strip) => {
    const root = document.querySelector<HTMLElement>(strip);
    if (!root) return null;
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-toolbar-button-id]")).map(
      (el) => {
        const r = el.getBoundingClientRect();
        const btn = el.querySelector("button");
        return {
          id: el.getAttribute("data-toolbar-button-id"),
          hidden: el.getAttribute("aria-hidden") === "true",
          label: btn?.getAttribute("aria-label") ?? null,
          x: Math.round(r.x),
          w: Math.round(r.width),
        };
      }
    );
    return {
      viewport: window.innerWidth,
      items,
      overflow: ["left", "right"].map((side) => ({
        side,
        visible:
          root
            .querySelector(`[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"]`)
            ?.getAttribute("data-visible") === "true",
      })),
    };
  }, STRIP);
  writeFileSync(path.join(OUTPUT_DIR, `${slug}${TAG}.json`), JSON.stringify(state, null, 2));
}

async function snapClip(
  page: Page,
  slug: string,
  clip: { x: number; y: number; width: number; height: number }
): Promise<void> {
  await settle(page);
  await dumpState(page, slug);
  const file = shotPath(slug);
  const viewport = page.viewportSize() ?? WIDE;
  await page.screenshot({
    path: file,
    type: "png",
    scale: "device",
    animations: "disabled",
    caret: "hide",
    clip: {
      x: clip.x,
      y: clip.y,
      width: Math.min(clip.width, viewport.width - clip.x),
      height: Math.min(clip.height, viewport.height - clip.y),
    },
  });
  if (!existsSync(file)) throw new Error(`screenshot did not land at ${file}`);
}

/** The strip, full width, plus a sliver of what sits under it. */
async function snapStrip(page: Page, slug: string): Promise<void> {
  const box = await page.locator(STRIP).first().boundingBox();
  if (!box) throw new Error("no bounding box for the toolbar");
  const viewport = page.viewportSize() ?? WIDE;
  await snapClip(page, slug, { x: 0, y: 0, width: viewport.width, height: box.height + 14 });
}

/**
 * The left half of the window down to the open surface's foot: the strip, the
 * menu or popover hanging off it, and what it opens over.
 */
async function snapOpenSurface(page: Page, slug: string, selector: string): Promise<void> {
  const box = await page.locator(selector).last().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const viewport = page.viewportSize() ?? WIDE;
  const width = Math.min(viewport.width, Math.max(980, box.x + box.width + 60));
  await snapClip(page, slug, { x: 0, y: 0, width, height: box.y + box.height + 40 });
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name) && !name.endsWith("-seed")) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[toolbar-launcher-shots] step "${name}" FAILED:`, detail);
    stepFailures.push(`${name}: ${detail}`);
  }
  await closeEverything(page);
}

async function closeEverything(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const open = await page
      .locator('[role="menu"], [role="dialog"][aria-label="Launch"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (!open) break;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200).catch(() => {});
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
  await page.setViewportSize(WIDE).catch(() => {});
  await page.mouse.move(WIDE.width / 2, WIDE.height - 20).catch(() => {});
  await settle(page, 300).catch(() => {});
}

async function reloadAndWait(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
  await page
    .locator(SEL.toolbar.projectSwitcherTrigger)
    .waitFor({ state: "visible", timeout: T_LONG });
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await settle(page, 1200);
}

async function seedLayout(page: Page, left: string[], right: string[]): Promise<void> {
  await page.evaluate(
    ({ left, right }) => {
      localStorage.setItem(
        "daintree-toolbar-preferences",
        JSON.stringify({
          state: { layout: { leftButtons: left, rightButtons: right, pinnedButtons: {} } },
          version: 14,
        })
      );
    },
    { left, right }
  );
  await reloadAndWait(page);
}

async function openLauncher(page: Page, trigger = TOOLBAR_LAUNCHER): Promise<void> {
  await page.locator(trigger).first().click({ timeout: 10_000 });
  await page.locator(SEARCH_BOX).waitFor({ state: "visible", timeout: 8000 });
  await expect.poll(() => page.locator(OPTION).count(), { timeout: 10_000 }).toBeGreaterThan(3);
  await settle(page, 350);
}

/**
 * Pins one launcher row through its own pin control, picking the row whose
 * accessible name starts with the exact display name ("Review" is a panel kind
 * and "Review PR" a recipe; a substring match would take either).
 */
async function pinFromLauncher(page: Page, name: string): Promise<void> {
  await openLauncher(page);
  await page.locator(SEARCH_BOX).fill(name);
  await settle(page, 400);
  const rows = page.locator(`${OPTION}[data-row-kind="item"]`);
  const labels = await rows.evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label") ?? "")
  );
  const target = labels.findIndex((label) => label === name || label.startsWith(`${name},`));
  if (target === -1) {
    throw new Error(`no launcher row named "${name}" — saw ${JSON.stringify(labels.slice(0, 6))}`);
  }
  const pin = rows.nth(target).locator("[data-launcher-pin]");
  if ((await pin.getAttribute("data-pinned")) !== "true") {
    await pin.click({ force: true });
    await expect(pin).toHaveAttribute("data-pinned", "true", { timeout: 5000 });
  }
  await closeEverything(page);
}

test("toolbar and launcher review — minimal and customised", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the toolbar-launcher-review capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the toolbar-launcher-review capture");
  if (!SHOT_DIR || !path.isAbsolute(SHOT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  test.setTimeout(900_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const fakeBinDir = installFakeAgent(repo.dir);
  // Prefix avoids "daintree-e2e", which launchApp's pre-launch hygiene pkills.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-tlshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "helios");
    await page.evaluate(async (name) => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id) await window.electron.project.update(cur.id, { emoji: "☀️", name });
    }, PROJECT_NAME);
    await setAppTheme(page, THEME);
    await page.setViewportSize(WIDE);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    // The stock toolbar: what a new user sees before customising anything.
    await step(page, "minimal-rest", async () => {
      await snapStrip(page, "01-minimal-rest");
    });

    await step(page, "minimal-launcher", async () => {
      await openLauncher(page);
      await snapOpenSurface(
        page,
        "02-minimal-launcher-open",
        '[role="dialog"][aria-label="Launch"]'
      );
    });

    // The heavily customised toolbar: every panel button, a pinned agent with
    // presets (so its split chevron draws), and three pinned recipes.
    await step(page, "custom-seed", async () => {
      await seedLayout(page, CUSTOM_LEFT, DEFAULT_RIGHT);
      await page.evaluate(async () => {
        await window.electron.agentToolbarPins.set("claude", true);
      });
      await expect(page.locator(BUTTON("claude"))).toBeVisible({ timeout: 15_000 });
      // A panel kind with no built-in button pins through the launcher-item
      // path, so it renders through a different component than Terminal does.
      await pinFromLauncher(page, "Review");
      for (const recipe of RECIPES) {
        await pinFromLauncher(page, recipe.name);
      }
      await expect
        .poll(() => page.locator(`${STRIP} [data-toolbar-button-id^="launcher:recipe:"]`).count(), {
          timeout: 10_000,
          message: "pinned recipes never reached the toolbar",
        })
        .toBe(RECIPES.length);
    });

    await step(page, "custom-rest", async () => {
      await snapStrip(page, "03-custom-rest");
    });

    await step(page, "custom-launcher", async () => {
      await openLauncher(page);
      await snapOpenSurface(
        page,
        "04-custom-launcher-open",
        '[role="dialog"][aria-label="Launch"]'
      );
    });

    // A pinned recipe's tooltip — the only place an icon-only recipe says which
    // recipe it is.
    await step(page, "custom-hover-recipe", async () => {
      const recipe = page.locator(`${STRIP} [data-toolbar-button-id^="launcher:recipe:"] button`);
      await recipe.first().hover();
      const tip = page.locator('[role="tooltip"]').first();
      await tip.waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 300);
      await snapOpenSurface(page, "05-custom-hover-recipe", '[role="tooltip"]');
    });

    await step(page, "custom-agent-split", async () => {
      const chevron = page.locator(`${BUTTON("claude")} button`).last();
      await chevron.click();
      await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 300);
      await snapOpenSurface(page, "06-custom-agent-split-open", '[role="menu"]');
    });

    await step(page, "custom-context-menu", async () => {
      const recipe = page.locator(`${STRIP} [data-toolbar-button-id^="launcher:recipe:"] button`);
      await recipe.first().click({ button: "right" });
      await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 300);
      await snapOpenSurface(page, "07-custom-context-menu", '[role="menu"]');
    });

    await step(page, "custom-overflow", async () => {
      await page.setViewportSize({ width: 1180, height: 900 });
      await settle(page, 800);
      await expect(page.locator(OVERFLOW_TRIGGER("left"))).toBeVisible({ timeout: 5000 });
      await snapStrip(page, "08-custom-overflow");
    });

    await step(page, "custom-overflow-menu", async () => {
      await page.setViewportSize({ width: 1180, height: 900 });
      await settle(page, 800);
      await page.locator(OVERFLOW_TRIGGER("left")).click();
      await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 300);
      await snapOpenSurface(page, "09-custom-overflow-menu-open", '[role="menu"]');
    });

    await step(page, "custom-narrow", async () => {
      await page.setViewportSize({ width: 900, height: 800 });
      await settle(page, 800);
      // An eviction hands focus to the overflow trigger, whose tooltip then
      // covers the strip; this shot is about the row, so clear both.
      await page.keyboard.press("Escape").catch(() => {});
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page, 400);
      await snapStrip(page, "10-custom-narrow");
    });

    // Both launchers: the toolbar's opens into the grid, the dock's into the
    // dock. Whole window, with the dock launcher open, so the two `+` buttons
    // and where each one's rows land can be compared in one frame.
    await step(page, "dock-and-toolbar", async () => {
      await page.locator(SEL.toolbar.openTerminal).first().click();
      await page
        .locator(SEL.panel.gridPanel)
        .first()
        .waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 1500);
      const minimize = page.locator(SEL.panel.minimize).first();
      await minimize.waitFor({ state: "visible", timeout: 5000 });
      await minimize.click();
      await settle(page, 1000);
      await openLauncher(page, DOCK_LAUNCHER);
      await snapClip(page, "11-dock-and-toolbar-launchers", { x: 0, y: 0, ...WIDE });
    });

    // Search drops the band headings, so whatever the dock's browse view said
    // about where recipes and grid-only panels land has to survive on the rows.
    await step(page, "dock-search", async () => {
      await openLauncher(page, DOCK_LAUNCHER);
      await page.locator(SEARCH_BOX).fill("Review");
      await expect.poll(() => page.locator(OPTION).count(), { timeout: 5000 }).toBeGreaterThan(1);
      await snapClip(page, "12-dock-search-mixed", { x: 0, y: 0, ...WIDE });
    });

    const expected = STEPS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name)).map(
      (s) => `${s.slug}${TAG}.png`
    );
    const present = new Set(readdirSync(OUTPUT_DIR));
    const missing = expected.filter((f) => !present.has(f));
    expect(stepFailures, `toolbar-launcher capture steps failed in "${THEME}"`).toEqual([]);
    expect(missing, `toolbar-launcher captures missing from ${OUTPUT_DIR}`).toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
