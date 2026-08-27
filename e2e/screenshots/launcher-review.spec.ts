/**
 * Launcher visual-review harness.
 *
 * Drives the `+` launcher palette (`DockLaunchButton`) through every state that
 * carries design weight and writes a tightly-cropped PNG of each, so the row's
 * metadata hierarchy can be judged against rendered pixels rather than against
 * the class strings that produce them.
 *
 * Sibling of `palette-review.spec.ts`, which captures one shot of this surface
 * as part of a family sweep. This one goes deep on the single surface: both
 * placements, grouped browse against mixed search, the preset expansion, the
 * hover and selection states that reveal the trailing controls, the pinned and
 * shortcut-bearing rows, and the two accessibility media modes that redraw the
 * row from something other than the theme's own tokens.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set, so neither the
 * marketing screenshots workflow nor a bare `--project=screenshots` runs it.
 *
 *   DAINTREE_SHOT_THEME=daintree npx playwright test --project=screenshots launcher-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. daintree, bondi)
 *   DAINTREE_SHOT_TAG    optional suffix to keep before/after rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (see STEPS below)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: artifacts/launcher-shots/<theme>/<NN-slug>[-tag].png (gitignored).
 */

import { expect, test, type Page } from "@playwright/test";
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

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "launcher-shots", THEME || "unset");

const DOCK_TRIGGER = '[aria-label="Open launcher"]';
const TOOLBAR_TRIGGER = '[data-toolbar-button-id="launcher"] button';
const SURFACE = '[role="dialog"][aria-label="Launch"]';
const SEARCH_BOX = '[aria-label="Search agents, panels, and recipes"]';
const LISTBOX = '[role="listbox"][aria-label="Launcher results"]';
const OPTION = '[role="option"]';

/**
 * Every shot this harness owes, in capture order. Kept as data rather than
 * spelled only inside the steps so the run can count what actually landed on
 * disk against what was promised — an exit code alone has never been evidence
 * that a capture harness produced anything.
 */
const STEPS = [
  { name: "browse-top", slug: "01-browse-top" },
  { name: "browse-mid", slug: "02-browse-mid" },
  { name: "browse-bottom", slug: "03-browse-bottom" },
  { name: "search-mixed", slug: "04-search-mixed" },
  { name: "search-narrow", slug: "05-search-narrow" },
  { name: "presets", slug: "06-presets-expanded" },
  { name: "hover", slug: "07-row-hover" },
  { name: "pinned", slug: "08-row-pinned" },
  { name: "capture", slug: "09-shortcut-capture" },
  { name: "empty", slug: "10-empty" },
  { name: "toolbar", slug: "11-toolbar-placement" },
  { name: "narrow", slug: "12-narrow-window" },
  { name: "forced-colors", slug: "13-forced-colors" },
  { name: "contrast-more", slug: "14-contrast-more" },
] as const;

// Freeze animations and hide carets so captures are deterministic. The palette
// zooms and fades on entry; a mid-transition frame reads as a design flaw that
// isn't there.
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
 * A repo carrying the on-disk state the launcher reads: `.daintree/recipes/`
 * for the recipe band and `.daintree/presets/<agentId>/` for the project preset
 * group. Both are the real seams the app loads from — a store-level stub would
 * skip the scope resolution that decides half the qualifiers under review.
 *
 * Recipe names are deliberately uneven in length. A row whose name always fits
 * hides exactly the truncation behaviour this review is about.
 */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-launcher-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = () => 0;\n");

  const recipesDir = path.join(dir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  const recipes = [
    { id: "inrepo-review", name: "Review", prompt: "/review" },
    { id: "inrepo-work", name: "Work", prompt: "/work {{number}}" },
    {
      id: "inrepo-migrate",
      name: "Migrate remaining JavaScript modules to TypeScript",
      prompt: "/migrate",
    },
  ];
  for (const recipe of recipes) {
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

  // Two named project presets on one agent, so the expansion renders its
  // provenance heading and a non-current choice beside the current one.
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

  for (const branch of ["feature/oauth-device-flow", "fix/retry-backoff-jitter"]) {
    const wtDir = path.join(wtRoot, branch.replace(/[/]/g, "-"));
    git(`branch ${branch}`, dir);
    git(`worktree add ${JSON.stringify(wtDir)} ${branch}`, dir);
  }

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Clip to the palette plus a margin, so the capture carries the surface edge,
 * its shadow and what sits immediately behind it — the three things that make a
 * floating surface read as elevated. An element screenshot crops exactly at the
 * border and hides all of it.
 *
 * Throws when the file did not land. A harness that writes a success artifact it
 * has not verified is worse than one that fails.
 */
async function snapSurface(page: Page, slug: string, selector = SURFACE, pad = 40): Promise<void> {
  await settle(page);
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
  if (!existsSync(file)) throw new Error(`screenshot did not land at ${file}`);
}

/**
 * Run a capture step. A failure never stops the remaining shots — one missing
 * state should not cost the whole sweep — but it IS recorded, and the test fails
 * at the end. The launcher is always closed afterwards, so a step that dies
 * mid-flight cannot leave a palette open on top of the next one.
 */
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[launcher-shots] step "${name}" FAILED:`, detail);
    stepFailures.push(`${name}: ${detail}`);
  }
  await closeLauncher(page).catch(() => {});
}

/** Opens a terminal and minimises it so the dock — and its launcher — renders. */
let dockReady = false;
async function ensureDock(page: Page): Promise<void> {
  if (dockReady) return;
  await page.locator(SEL.toolbar.openTerminal).click();
  await page.locator(SEL.panel.gridPanel).first().waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 1500);
  const minimize = page.locator(SEL.panel.minimize).first();
  await minimize.waitFor({ state: "visible", timeout: 5000 });
  await minimize.click();
  await settle(page, 1000);
  dockReady = true;
}

async function openLauncher(page: Page, trigger = DOCK_TRIGGER): Promise<void> {
  // A step that failed mid-flight can leave the popover open, and it is modal —
  // Radix parks a dismissable layer over everything behind it, so the trigger
  // click for the NEXT step times out on an element it can see but cannot
  // reach. Close first, always.
  await closeLauncher(page);
  await page.locator(trigger).first().click({ timeout: 10_000 });
  await page.locator(SEARCH_BOX).waitFor({ state: "visible", timeout: 8000 });
  // The agent inventory resolves asynchronously; capturing before it lands
  // photographs "Checking agents…" instead of the bands under review.
  await expect.poll(() => page.locator(OPTION).count(), { timeout: 10_000 }).toBeGreaterThan(3);
  await settle(page, 350);
}

async function closeLauncher(page: Page): Promise<void> {
  // Up to four presses, checked between each. The launcher spends the first
  // Escape clearing the query and the second closing, and a row that is
  // recording a shortcut vetoes one before either of those — so a fixed count
  // is not enough to guarantee the surface is gone.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (
      !(await page
        .locator(SEARCH_BOX)
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
  if (
    await page
      .locator(SEARCH_BOX)
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error("launcher would not close");
  }
}

/**
 * Scrolls the results list to a fraction of its height and settles.
 *
 * Walks up to the first genuinely scrollable ancestor rather than naming one:
 * the palette body is a `ScrollShadow`, whose overflow element is an internal
 * detail, and a selector aimed at it would silently scroll nothing the day that
 * wrapper changes shape.
 */
async function scrollList(page: Page, fraction: number): Promise<void> {
  const scrolled = await page.locator(LISTBOX).evaluate((el, f) => {
    let node: HTMLElement | null = el as HTMLElement;
    while (node) {
      if (node.scrollHeight - node.clientHeight > 4) {
        node.scrollTop = (node.scrollHeight - node.clientHeight) * f;
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }, fraction);
  if (!scrolled) throw new Error("results list has no scrollable ancestor");
  await settle(page, 250);
}

test("launcher review — every state of the row", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the launcher-review capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the launcher-review capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  // Prefix deliberately avoids "daintree-e2e" — launchApp's pre-launch hygiene
  // pkills that pattern, and parallel theme captures would SIGKILL each other.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-launchershot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id)
        await window.electron.project.update(cur.id, { emoji: "☀️", name: "Helios Dashboard" });
    });
    await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 2000);
    await dismissBlockingPalette(page);
    await ensureDock(page);

    // 1-3. Grouped browse, top to bottom. The bands are the whole point of the
    // browse mode and they do not fit in one frame: the launchable agents sit
    // at the top, panels and recipes in the middle, and the setup/available
    // bands — the ones nobody scrolls to and therefore nobody has looked at —
    // at the bottom.
    await step(page, "browse-top", async () => {
      await openLauncher(page);
      await snapSurface(page, "01-browse-top");
    });

    await step(page, "browse-mid", async () => {
      await openLauncher(page);
      await scrollList(page, 0.45);
      await snapSurface(page, "02-browse-mid");
    });

    await step(page, "browse-bottom", async () => {
      await openLauncher(page);
      await scrollList(page, 1);
      await snapSurface(page, "03-browse-bottom");
    });

    // 4. Mixed search — the mode where a type qualifier genuinely earns its
    // width, because one flat "Search results" band holds agents, panels and
    // recipes together. "re" matches across all three.
    await step(page, "search-mixed", async () => {
      await openLauncher(page);
      await page.locator(SEARCH_BOX).fill("re");
      await expect.poll(() => page.locator(OPTION).count(), { timeout: 5000 }).toBeGreaterThan(2);
      await snapSurface(page, "04-search-mixed");
    });

    // 5. A narrow result set, so the rows can be read individually rather than
    // as a block of texture.
    await step(page, "search-narrow", async () => {
      await openLauncher(page);
      await page.locator(SEARCH_BOX).fill("claude");
      await expect.poll(() => page.locator(OPTION).count(), { timeout: 5000 }).toBeGreaterThan(0);
      await snapSurface(page, "05-search-narrow");
    });

    // 6. Preset expansion. ArrowRight on a row that has presets splices its
    // choices in as indented sibling rows; the parent/child relationship is
    // carried by indentation alone, which is exactly the kind of thing that
    // only shows up in pixels.
    await step(page, "presets", async () => {
      await openLauncher(page);
      const parent = page.locator('[role="option"][data-row-kind="item"]').first();
      await parent.hover();
      await settle(page, 200);
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => page.locator('[role="option"][data-row-kind="preset"]').count(), {
          timeout: 5000,
        })
        .toBeGreaterThan(1);
      await snapSurface(page, "06-presets-expanded");
    });

    // 7. Hover — the state that reveals the shortcut-edit and pin controls in
    // their reserved slots. Half the launcher's trailing rail is invisible
    // until this happens, so a review that never hovers reviews half a row.
    await step(page, "hover", async () => {
      await openLauncher(page);
      // `page.mouse.move` to the row's centre rather than `locator.hover()`:
      // the popover is modal and Radix's dismissable layer fails Playwright's
      // "receives pointer events" actionability check on the rows beneath it,
      // even though a real pointer reaches them. The app listens on
      // `onPointerEnter`, which a raw mouse move fires just the same.
      const box = await page.locator(OPTION).nth(1).boundingBox();
      if (!box) throw new Error("no bounding box for the row to hover");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await settle(page, 400);
      await snapSurface(page, "07-row-hover");
    });

    // 8. A pinned row. The pin is the one trailing control that stays visible
    // at rest, so it is the one that competes with the row's name for the
    // whole time the launcher is open.
    await step(page, "pinned", async () => {
      await openLauncher(page);
      const pinnable = page.locator(`${OPTION} button[aria-pressed="false"]`).first();
      await pinnable.waitFor({ state: "attached", timeout: 5000 });
      await pinnable.click({ force: true });
      await settle(page, 500);
      await page.mouse.move(10, 10);
      await settle(page, 300);
      await snapSurface(page, "08-row-pinned");
    });

    // 9. The in-place shortcut recorder, which replaces the row rather than
    // rendering inside it.
    await step(page, "capture", async () => {
      await openLauncher(page);
      const edit = page.locator('[data-testid^="launcher-shortcut-edit-"]').first();
      await edit.waitFor({ state: "attached", timeout: 5000 });
      await edit.click({ force: true });
      await settle(page, 400);
      await snapSurface(page, "09-shortcut-capture");
      await page.keyboard.press("Escape");
      await settle(page, 200);
    });

    // 10. Empty state.
    await step(page, "empty", async () => {
      await openLauncher(page);
      await page.locator(SEARCH_BOX).fill("zzzzqqqq");
      await settle(page, 400);
      await snapSurface(page, "10-empty");
    });

    // 11. Toolbar placement. Same content, opposite anchor — the rows must read
    // the same opening downward from the toolbar as they do opening upward from
    // the dock.
    await step(page, "toolbar", async () => {
      await openLauncher(page, TOOLBAR_TRIGGER);
      await snapSurface(page, "11-toolbar-placement");
    });

    // 12. Narrow window. The surface is a fixed 484px until the viewport drops
    // below it, at which point `max-w-[calc(100vw-2rem)]` takes over and every
    // trailing element competes with the name for real. This is the state that
    // decides whether the truncation priority is right.
    await step(page, "narrow", async () => {
      await page.setViewportSize({ width: 440, height: 900 });
      await settle(page, 800);
      // The DOCK trigger, not the toolbar one: below about 520px the toolbar
      // collapses its buttons into an overflow menu and the launcher is no
      // longer a clickable element on it. The dock's `+` survives the squeeze.
      await openLauncher(page);
      await snapSurface(page, "12-narrow-window", SURFACE, 8);
      await closeLauncher(page);
      await page.setViewportSize({ width: 1680, height: 1050 });
      await settle(page, 600);
    });

    // 13-14. The two accessibility media modes. `forced-colors: active` throws
    // the theme's tokens away and redraws from system keywords, and
    // `prefers-contrast: more` swaps in the high-contrast block — a row whose
    // hierarchy is carried purely by opacity collapses in both.
    await step(page, "forced-colors", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 400);
      await openLauncher(page);
      await snapSurface(page, "13-forced-colors");
      await closeLauncher(page);
      await page.emulateMedia({ forcedColors: "none" });
      await settle(page, 300);
    });

    await step(page, "contrast-more", async () => {
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 400);
      await openLauncher(page);
      await snapSurface(page, "14-contrast-more");
      await closeLauncher(page);
      await page.emulateMedia({ contrast: "no-preference" });
      await settle(page, 300);
    });

    // Count what landed against what was promised. The exit code says only that
    // no step threw; this says the sweep actually produced its artifacts.
    const expected = STEPS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name)).map(
      (s) => `${s.slug}${TAG}.png`
    );
    const present = new Set(readdirSync(OUTPUT_DIR));
    const missing = expected.filter((f) => !present.has(f));

    expect(stepFailures, `launcher capture steps failed in "${THEME}"`).toEqual([]);
    expect(missing, `launcher captures missing from ${OUTPUT_DIR}`).toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
