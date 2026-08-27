/**
 * Canvas-home visual-review harness.
 *
 * Drives `ContentGridEmptyState` — what the panel grid shows when a workspace
 * has a launch target but nothing open — through every state that carries
 * design weight, and writes a PNG of the canvas for each. The surface composes
 * six independently-gated sections (identity, recipes, resume, quick actions,
 * project pulse, teaching tip), so its hierarchy can only be judged against
 * rendered pixels: which sections are present is a runtime question, and the
 * vertical position of the primary launch affordance moves with the answer.
 *
 * Sibling of `launcher-review.spec.ts`, which goes deep on the `+` launcher
 * palette. This one owns the canvas behind it.
 *
 * NOT covered: the four no-launch-target recovery states ("Select a worktree",
 * "Open a project folder", "Worktree deleted", and the deleted-worktree ghost).
 * Each needs the app parked in a state the real UI auto-corrects out of — a
 * deleted worktree auto-switches selection back to main, and its ghost row only
 * survives while it still owns a live terminal. They are plain `EmptyState`
 * renders with no conditional composition, so they are reviewed from source.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set, so neither the
 * marketing screenshots workflow nor a bare `--project=screenshots` runs it.
 *
 *   DAINTREE_SHOT_THEME=daintree npx playwright test --project=screenshots canvas-home-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. daintree, bondi)
 *   DAINTREE_SHOT_TAG    optional suffix to keep before/after rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (see STEPS below)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: artifacts/canvas-home-shots/<theme>/<NN-slug>[-tag].png (gitignored).
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { createHash } from "crypto";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, refreshActiveWindow, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "canvas-home-shots", THEME || "unset");

const CANVAS = "#panel-grid";
const PALETTE_SEARCH = 'button:has-text("Search agents")';
const PULSE_STRIP = 'button[aria-label^="Show project activity"]';

const WIDE = { width: 1680, height: 1050 };

/**
 * Every shot this harness owes, in capture order. Kept as data rather than
 * spelled only inside the steps so the run can count what actually landed on
 * disk against what was promised — an exit code alone has never been evidence
 * that a capture harness produced anything.
 */
const STEPS = [
  { name: "rest", slug: "01-rest" },
  { name: "with-tip", slug: "02-with-tip" },
  { name: "focus", slug: "03-focus-palette" },
  { name: "pulse", slug: "04-pulse-expanded" },
  { name: "short", slug: "05-short-canvas" },
  { name: "narrow", slug: "06-narrow-canvas" },
  { name: "forced-colors", slug: "07-forced-colors" },
  { name: "contrast-more", slug: "08-contrast-more" },
  { name: "recipes-many", slug: "09-recipes-many" },
  { name: "no-recipes", slug: "10-no-recipes" },
  { name: "quietest", slug: "11-quietest" },
  { name: "long-identity", slug: "12-long-identity" },
  { name: "scratch", slug: "13-scratch" },
] as const;

// Freeze animations and hide carets so captures are deterministic. Every
// section of this surface enters on a staggered fade; a mid-transition frame
// reads as a design flaw that isn't there.
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

function git(cmd: string, cwd: string, env?: Record<string, string>): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore", env: { ...process.env, ...env } });
}

interface RecipeSeed {
  id: string;
  name: string;
  pinned: boolean;
}

const BASE_RECIPES: RecipeSeed[] = [
  { id: "ship-review", name: "Review & ship", pinned: true },
  { id: "work-issue", name: "Work an issue", pinned: true },
  { id: "migrate-ts", name: "Migrate remaining JavaScript modules to TypeScript", pinned: false },
];

const EXTRA_RECIPES: RecipeSeed[] = [
  { id: "dev-stack", name: "Dev stack", pinned: false },
  { id: "pair-debug", name: "Pair debug", pinned: false },
  { id: "docs-sweep", name: "Docs sweep", pinned: false },
  { id: "perf-audit", name: "Perf audit", pinned: false },
  { id: "release-cut", name: "Cut a release candidate", pinned: false },
];

function writeRecipes(dir: string, recipes: RecipeSeed[]): void {
  const recipesDir = path.join(dir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  for (const recipe of recipes) {
    writeFileSync(
      path.join(recipesDir, `${recipe.id}.json`),
      JSON.stringify(
        {
          id: recipe.id,
          name: recipe.name,
          terminals: [
            { type: "claude", title: recipe.name, env: {}, initialPrompt: `/${recipe.id}` },
          ],
          createdAt: 1775381905486,
          showInEmptyState: recipe.pinned,
        },
        null,
        2
      ) + "\n"
    );
  }
}

function clearRecipes(dir: string): void {
  const recipesDir = path.join(dir, ".daintree", "recipes");
  if (existsSync(recipesDir)) rmSync(recipesDir, { recursive: true, force: true });
  mkdirSync(recipesDir, { recursive: true });
}

/**
 * A repo carrying the on-disk state this surface reads: `.daintree/recipes/`
 * for the recipe band, a commit history spread across weeks so Project Pulse
 * has a real ribbon and streak to draw, and sibling worktrees so the branch
 * line and the worktree-recovery states have something to resolve against.
 *
 * Recipe names are deliberately uneven in length. A card whose name always
 * fits hides exactly the truncation behaviour this review is about.
 */
function createRepo(): { dir: string; wtRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-canvas-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");

  // Commits spread back across five weeks, densest in the last few days, so
  // the pulse ribbon shows a real gradient and a live streak rather than one
  // solid block. Both author and committer dates are set — the pulse scan
  // reads the log, and a same-second history draws as a single cell.
  const dayMs = 86_400_000;
  const now = Date.now();
  const daysAgo = [34, 31, 28, 21, 20, 14, 13, 12, 6, 5, 4, 3, 2, 1, 0];
  daysAgo.forEach((day, index) => {
    writeFileSync(path.join(dir, "src", `mod-${index}.ts`), `export const m${index} = ${index};\n`);
    const stamp = new Date(now - day * dayMs).toISOString();
    git("add -A", dir);
    git(`commit -m "feat: module ${index}"`, dir, {
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    });
  });

  writeRecipes(dir, BASE_RECIPES);
  git("add -A", dir);
  git('commit -m "chore: recipes"', dir);

  for (const branch of ["feature/oauth-device-flow", "fix/retry-backoff-jitter"]) {
    const wtDir = path.join(wtRoot, branch.replace(/[/]/g, "-"));
    git(`branch ${branch}`, dir);
    git(`worktree add ${JSON.stringify(wtDir)} ${branch}`, dir);
  }

  return {
    dir,
    wtRoot,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Pre-seed the closed-session journal so `ResumeSessionLine` has something to
 * offer. This is the file main itself reads (`agent-session-history.json` in
 * userData) — written before launch so the first `list()` sees it, rather than
 * stubbing the IPC the renderer calls.
 *
 * `projectId`/`worktreeId` are deliberately null: the runtime ids don't exist
 * until the project is opened, and `buildResumeSessionItems` re-homes a
 * record by longest-prefix `cwd` match against the live worktree map, which is
 * the same path the real journal takes for pre-selection terminals.
 */
function seedSessionHistory(userDataDir: string, cwd: string): void {
  const hourMs = 3_600_000;
  const now = Date.now();
  const records = [
    {
      sessionId: "sess-oauth-refresh",
      agentId: "claude",
      worktreeId: null,
      projectId: null,
      title: "Wire the OAuth device-flow refresh path",
      savedAt: now - 2 * hourMs,
      agentModelId: "anthropic/claude-opus-4-8",
      cwd,
      branch: "main",
    },
    {
      sessionId: "sess-retry-jitter",
      agentId: "claude",
      worktreeId: null,
      projectId: null,
      title: "Add jitter to the retry backoff",
      savedAt: now - 26 * hourMs,
      agentModelId: "anthropic/claude-sonnet-4-8",
      cwd,
      branch: "main",
    },
    {
      sessionId: "sess-heatmap",
      agentId: "claude",
      worktreeId: null,
      projectId: null,
      title: "Pulse heatmap cell alignment",
      savedAt: now - 50 * hourMs,
      cwd,
      branch: "main",
    },
  ];
  writeFileSync(
    path.join(userDataDir, "agent-session-history.json"),
    JSON.stringify(records, null, 2) + "\n"
  );
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Wait for the canvas home to be the thing on screen, then settle. The palette
 * search button is the one control every launch-target state renders, so it is
 * the marker that the surface — not a panel, not a skeleton — is present.
 */
async function waitForCanvasHome(page: Page): Promise<void> {
  await page.locator(CANVAS).waitFor({ state: "visible", timeout: T_LONG });
  await page.locator(PALETTE_SEARCH).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 700);
}

/** Reload and bring the app back to a settled canvas home. */
async function reload(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await waitForCanvasHome(page);
}

/**
 * Clip to the canvas itself — the box `ContentGridEmptyState` is handed and has
 * to compose within. Its height is what decides whether the primary launch
 * affordance sits above the fold, so a full-page or element-tight crop would
 * both answer the wrong question.
 *
 * Throws when the file did not land. A harness that writes a success artifact
 * it has not verified is worse than one that fails.
 */
async function snapCanvas(page: Page, slug: string): Promise<void> {
  await settle(page);
  const box = await page.locator(CANVAS).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${CANVAS}`);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
  if (!existsSync(file)) throw new Error(`screenshot did not land at ${file}`);
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];

/**
 * Run a capture step. A failure never stops the remaining shots — one missing
 * state should not cost the whole sweep — but it IS recorded, and the test
 * fails at the end.
 */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[canvas-home-shots] step "${name}" FAILED:`, detail);
    stepFailures.push(`${name}: ${detail}`);
  }
}

test("canvas home review — every state of the empty grid", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the canvas-home-review capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the canvas-home-review capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const fakeBinDir = installFakeAgent(repo.dir);
  // Prefix deliberately avoids "daintree-e2e" — launchApp's pre-launch hygiene
  // pkills that pattern, and parallel theme captures would SIGKILL each other.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-canvasshot-"));

  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    // Seed the resume journal against the path main actually reads. Electron
    // derives `userData` from `--user-data-dir` rather than being it, so ask
    // the app instead of assuming — a file written beside the real one is
    // indistinguishable from a surface that has nothing to resume.
    const userDataPath = await ctx.app.evaluate(async ({ app }) => app.getPath("userData"));
    // realpath, not the mkdtemp path: on macOS the temp dir is a symlink, the
    // app stores the resolved `/private/...` form, and `buildResumeSessionItems`
    // re-homes a record by longest-prefix match — so an unresolved cwd matches
    // no worktree and the resume line silently renders nothing.
    seedSessionHistory(userDataPath, realpathSync(repo.dir));

    let page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
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
    await waitForCanvasHome(page);
    await dismissBlockingPalette(page);

    // 1. The returning-user rest state: identity, recipes, resume, quick
    // actions and the pulse strip, with no teaching tip yet (no agent has been
    // launched in this workspace).
    await step("rest", async () => {
      await snapCanvas(page, "01-rest");
    });

    // 2. Every section at once. Launching an agent and docking it flips
    // `hasEverLaunchedAgent`, which is what gates the rotating tip — the
    // maximal column, and the tallest the surface ever gets at rest.
    await step("with-tip", async () => {
      // The chip on the canvas, not the toolbar's plain terminal: the tip is
      // gated on a panel carrying an agent id, which `terminal.new` never sets.
      await page.locator('button:has-text("Claude")').first().click({ timeout: 10_000 });
      await page
        .locator(SEL.panel.gridPanel)
        .first()
        .waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 2500);
      const minimize = page.locator(SEL.panel.minimize).first();
      await minimize.waitFor({ state: "visible", timeout: 8000 });
      await minimize.click();
      await waitForCanvasHome(page);
      await snapCanvas(page, "02-with-tip");
    });

    // 3. Keyboard focus on the palette search button. This surface is reached
    // by keyboard as often as by pointer, and the focus ring is the only thing
    // that tells a keyboard user where the launch entry is.
    await step("focus", async () => {
      // Tabbed, never `.focus()`: Chromium only sets `:focus-visible` for
      // keyboard-driven focus, so a programmatic focus photographs the rest
      // state and calls it a focus ring.
      await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
      let reached = false;
      for (let press = 0; press < 40 && !reached; press++) {
        await page.keyboard.press("Tab");
        reached = await page
          .locator(PALETTE_SEARCH)
          .evaluate((el) => el === document.activeElement)
          .catch(() => false);
      }
      if (!reached) throw new Error("Tab never reached the palette search button");
      await settle(page, 300);
      await snapCanvas(page, "03-focus-palette");
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 200);
    });

    // 4. Project Pulse expanded — the one section that can grow by several
    // hundred pixels on click, pushing everything below it down.
    await step("pulse", async () => {
      await page.locator(PULSE_STRIP).click({ timeout: 8000 });
      await settle(page, 1200);
      await snapCanvas(page, "04-pulse-expanded");
      await page
        .locator('button:has-text("Collapse")')
        .click({ timeout: 5000 })
        .catch(() => {});
      await settle(page, 500);
    });

    // 5. A short canvas. The column is vertically centered inside a scroller,
    // so a laptop-height window is where "the highest-value action begins
    // below the initial viewport" either happens or doesn't.
    await step("short", async () => {
      await page.setViewportSize({ width: WIDE.width, height: 760 });
      await settle(page, 900);
      await snapCanvas(page, "05-short-canvas");
      await page.setViewportSize(WIDE);
      await settle(page, 600);
    });

    // 6. A narrow canvas. The quick-action chips wrap, the recipe grid drops
    // columns, and the identity line has to truncate against the same width.
    await step("narrow", async () => {
      await page.setViewportSize({ width: 900, height: WIDE.height });
      await settle(page, 900);
      await snapCanvas(page, "06-narrow-canvas");
      await page.setViewportSize(WIDE);
      await settle(page, 600);
    });

    // 7-8. The two accessibility media modes. `forced-colors: active` throws
    // the theme's tokens away and redraws from system keywords, and
    // `prefers-contrast: more` swaps in the high-contrast block — a column
    // whose hierarchy is carried purely by opacity collapses in both.
    await step("forced-colors", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 600);
      await snapCanvas(page, "07-forced-colors");
      await page.emulateMedia({ forcedColors: "none" });
      await settle(page, 400);
    });

    await step("contrast-more", async () => {
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 600);
      await snapCanvas(page, "08-contrast-more");
      await page.emulateMedia({ contrast: "no-preference" });
      await settle(page, 400);
    });

    // 9. Eight recipes. Past six the runner swaps its card grid for a
    // searchable list with its own search field — a second search box on a
    // surface that already has one, and the tallest the recipe band gets.
    await step("recipes-many", async () => {
      writeRecipes(repo.dir, [...BASE_RECIPES, ...EXTRA_RECIPES]);
      await reload(page);
      await snapCanvas(page, "09-recipes-many");
    });

    // 10. No recipes at all — `RecipeRunnerEmpty`, which is what a project
    // that has never made one shows in the band's place.
    await step("no-recipes", async () => {
      clearRecipes(repo.dir);
      await reload(page);
      await snapCanvas(page, "10-no-recipes");
    });

    // 11. The quietest a project workspace gets: no recipes, nothing to
    // resume. What is left is the spine every state shares.
    await step("quietest", async () => {
      await page.evaluate(async () => {
        await window.electron.agentSessionHistory.clear();
      });
      await reload(page);
      await snapCanvas(page, "11-quietest");
    });

    // 12. Extreme identity density — a long project name, a long branch and a
    // deep path, all competing for the same centered width.
    await step("long-identity", async () => {
      writeRecipes(repo.dir, BASE_RECIPES);
      await page.evaluate(async () => {
        const cur = await window.electron.project.getCurrent();
        if (cur?.id)
          await window.electron.project.update(cur.id, {
            name: "Helios Dashboard — Platform Reliability & Observability",
          });
      });
      await reload(page);
      await snapCanvas(page, "12-long-identity");
    });

    // 13. A scratch workspace: a launch target with no worktree, no branch, no
    // recipes, no pulse and no project settings — the same component with half
    // its sections gone.
    await step("scratch", async () => {
      await page.evaluate(async () => {
        const scratch = await window.electron.scratch.create("Scratch pad");
        if (scratch?.id) await window.electron.scratch.switch(scratch.id);
      });
      // Every workspace gets its own WebContentsView, so the switch does not
      // re-render the page this handle points at — it strands it on the view
      // the workspace just left. Re-acquire, or the next capture photographs
      // the previous workspace and looks perfectly plausible.
      page = await refreshActiveWindow(ctx!.app, page);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      await waitForCanvasHome(page);
      await snapCanvas(page, "13-scratch");
    });

    // Count what landed against what was promised. The exit code says only
    // that no step threw; this says the sweep actually produced its artifacts.
    const expected = STEPS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name)).map(
      (s) => `${s.slug}${TAG}.png`
    );
    const present = new Set(readdirSync(OUTPUT_DIR));
    const missing = expected.filter((f) => !present.has(f));

    // Two states that render byte-identically mean one of them never actually
    // happened — a step that drove nothing still writes a perfectly plausible
    // PNG of the state before it, which is the worst artifact a capture
    // harness can produce. Same-viewport states only: a resize changes every
    // pixel, so cross-size pairs can never collide and would only add noise.
    const SAME_VIEWPORT = new Set(expected.filter((f) => !/0[56]-/.test(f)));
    const byHash = new Map<string, string[]>();
    for (const file of SAME_VIEWPORT) {
      if (!present.has(file)) continue;
      const hash = createHash("sha256")
        .update(readFileSync(path.join(OUTPUT_DIR, file)))
        .digest("hex");
      byHash.set(hash, [...(byHash.get(hash) ?? []), file]);
    }
    const duplicates = [...byHash.values()].filter((files) => files.length > 1);

    expect(stepFailures, `canvas-home capture steps failed in "${THEME}"`).toEqual([]);
    expect(missing, `canvas-home captures missing from ${OUTPUT_DIR}`).toEqual([]);
    expect(duplicates, `identical canvas-home captures — a step drove nothing`).toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
