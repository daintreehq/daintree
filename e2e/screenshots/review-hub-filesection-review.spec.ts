/**
 * Review Hub `FileSection` visual-review harness (#11984).
 *
 * `FileSection` renders the Staged and Changes section headers — title, file count,
 * churn, filter field, view menu, and a bulk action whose label changes with selection
 * and filtering — plus the rows and the three local empty states. Every one of those
 * decisions is a pixel decision at a real panel width, so the refinement is judged on
 * rendered output rather than on the JSX.
 *
 * The fixture repo is deliberately unpleasant: eighteen unstaged files against six
 * staged, deep nested paths, four-digit churn, and a generated-file population big
 * enough that hiding it empties a whole section. Sparse fixtures hide exactly the
 * defects worth finding here (label truncation, trailing-rail shove, count wrap).
 *
 * Steps, and what each is evidence for:
 *
 *   rest        both sections at rest — the shot the whole issue is about.
 *   filter      an active query, and a query that matches nothing.
 *   selection   multi-select in each section — the widest bulk label the UI can reach.
 *   viewmenu    the view dropdown, at defaults and with every setting non-default.
 *   density     compact rows against the same header chrome.
 *   generated   the "only generated files" empty state, reached by hiding them.
 *   emptystaged "Nothing staged" — the section header with a zero count and no bulk action.
 *   narrow      the window squeezed to where the header has to give something up.
 *   keyboard    focus rings on the filter field and on a row.
 *   contrast    forced-colors and prefers-contrast: more.
 *
 * Opt-in only, like confirm-dialog-review: skips itself unless DAINTREE_SHOT_FILESECTION
 * is set, so the marketing screenshots workflow never executes it.
 *
 *   DAINTREE_SHOT_FILESECTION=1 npx playwright test --project=screenshots review-hub-filesection
 *
 * Env knobs:
 *   DAINTREE_SHOT_FILESECTION  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME        optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG          optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY         comma-separated step filter (see step names above)
 *   DAINTREE_SHOT_OUT          optional absolute output dir (default: artifacts/filesection-shots)
 *
 * Output: <out>/<NN-slug>[-tag].png (gitignored).
 */

import { test, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_FILESECTION;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "filesection-shots");

const WIDE = { width: 1680, height: 1050 };
const NARROW = { width: 900, height: 1050 };

/** The two sections, and the file list that holds both. */
const STAGED = '[data-testid="review-hub-file-section-staged"]';
const UNSTAGED = '[data-testid="review-hub-file-section-unstaged"]';
const FILE_LIST = '[role="listbox"][aria-label="Changed files"]';

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

/** Deterministic filler so churn numbers are large and stable across runs. */
function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1};`).join("\n") + "\n";
}

/**
 * Baseline committed tree, then a working state with SIX staged files against
 * EIGHTEEN unstaged ones.
 *
 * The split has to be built with `git add` before the hub opens: the hub
 * auto-stages everything on open, but only when nothing is staged yet
 * (`ReviewHubContent` skips the effect on `status.staged.length > 0`), so
 * pre-staging is what keeps a mixed state mixed.
 */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-filesection-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);

  const write = (rel: string, body: string): void => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  // ---- committed baseline -------------------------------------------------
  write("README.md", "# Helios Dashboard\n");
  write("package.json", JSON.stringify({ name: "helios", version: "1.0.0" }, null, 2) + "\n");
  write("package-lock.json", lines("  //lock", 900));
  write("src/renderer/orchestration/OrchestrationPreferencesPanel.tsx", lines("panel", 220));
  write("src/renderer/orchestration/useOrchestrationScheduler.ts", lines("sched", 140));
  write("src/main/services/workspace/WorkspaceReconciliationService.ts", lines("recon", 260));
  write("src/main/services/workspace/reconciliationTelemetry.ts", lines("telem", 90));
  write("src/shared/config/agents/anthropic/claudeCodeAgentDefinition.ts", lines("agent", 180));
  write("src/legacy/deprecatedStagingBridge.ts", lines("legacy", 60));
  write("docs/architecture/notification-system.md", lines("- doc", 120));
  write("dist/assets/vendor.bundle.js", lines("/*v*/", 700));
  write("dist/assets/app.bundle.js", lines("/*a*/", 500));
  write("coverage/lcov.info", lines("DA:", 400));
  write("src/api/__generated__/schemaTypes.ts", lines("gen", 300));
  write("src/api/__generated__/operationHooks.ts", lines("hook", 240));
  write("src/renderer/components/CommandPalette/CommandPaletteResultRow.tsx", lines("row", 160));
  write("src/renderer/components/CommandPalette/commandPaletteScoring.ts", lines("score", 130));
  write("src/renderer/hooks/useDeferredWorkspaceSnapshot.ts", lines("snap", 110));
  write("src/renderer/store/worktreeTopologyStore.ts", lines("topo", 200));
  write("src/test/fixtures/worktreeTopology.fixture.ts", lines("fix", 95));
  write("e2e/full/worktree/core-worktree-topology-reconciliation.spec.ts", lines("spec", 170));
  write("scripts/perf/scenarios/worktreeSidebarScroll.ts", lines("perf", 85));
  write(".github/workflows/stabilize.yml", lines("#  ", 70));

  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  git("checkout develop", dir);
  git("checkout -b feature/orchestration-preferences", dir);
  git('commit --allow-empty -m "start feature"', dir);

  // ---- staged: 6 files, four-digit churn, one deletion, one deep add ------
  write("src/renderer/orchestration/OrchestrationPreferencesPanel.tsx", lines("panel-v2", 640));
  write("src/renderer/orchestration/useOrchestrationScheduler.ts", lines("sched-v2", 310));
  write("docs/architecture/notification-system.md", lines("- doc v2", 260));
  write("package-lock.json", lines("  //lock-v2", 1480));
  write(
    "src/renderer/orchestration/preferences/sections/advanced/OrchestrationConcurrencyLimitsSection.tsx",
    lines("limits", 190)
  );
  rmSync(path.join(dir, "src/legacy/deprecatedStagingBridge.ts"));
  git("add -A", dir);

  // ---- unstaged: 18 files, six of them generated -------------------------
  write("src/main/services/workspace/WorkspaceReconciliationService.ts", lines("recon-v2", 520));
  write("src/main/services/workspace/reconciliationTelemetry.ts", lines("telem-v2", 210));
  write("src/shared/config/agents/anthropic/claudeCodeAgentDefinition.ts", lines("agent-v2", 340));
  write("src/renderer/components/CommandPalette/CommandPaletteResultRow.tsx", lines("row-v2", 300));
  write("src/renderer/components/CommandPalette/commandPaletteScoring.ts", lines("score-v2", 250));
  write("src/renderer/hooks/useDeferredWorkspaceSnapshot.ts", lines("snap-v2", 190));
  write("src/renderer/store/worktreeTopologyStore.ts", lines("topo-v2", 430));
  write("src/test/fixtures/worktreeTopology.fixture.ts", lines("fix-v2", 175));
  write("e2e/full/worktree/core-worktree-topology-reconciliation.spec.ts", lines("spec-v2", 330));
  write("scripts/perf/scenarios/worktreeSidebarScroll.ts", lines("perf-v2", 145));
  write(".github/workflows/stabilize.yml", lines("#  v2", 130));
  write("src/renderer/components/Worktree/ReviewHub/sectionHeaderDensity.ts", lines("new", 120));
  // generated population — hiding these empties the section entirely below.
  write("dist/assets/vendor.bundle.js", lines("/*v2*/", 1230));
  write("dist/assets/app.bundle.js", lines("/*a2*/", 880));
  write("coverage/lcov.info", lines("DA:v2", 610));
  write("src/api/__generated__/schemaTypes.ts", lines("gen-v2", 470));
  write("src/api/__generated__/operationHooks.ts", lines("hook-v2", 390));
  write("src/renderer/store/__generated__/topologySelectors.generated.ts", lines("sel", 260));

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

const written: string[] = [];

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  written.push(path.basename(file));
}

/** Both sections in one frame — the comparison the issue is actually about. */
async function snapList(page: Page, slug: string): Promise<void> {
  await snap(page, slug, FILE_LIST);
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(target.width, target.height);
  }, size);
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — the other shots are still worth having. But the
// run must still FAIL, or a silent exit 0 with an empty output directory reads as success.
const failures: string[] = [];
async function step(name: string, fn: () => Promise<void>, reset: () => Promise<void>) {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[filesection-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await reset().catch((error) => {
      failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
    });
  }
}

/** Scoped handles for one section's controls. */
function controls(page: Page, root: string) {
  return {
    filter: page.locator(`${root} input[type="text"]`),
    viewButton: page.locator(`${root} [aria-label="View options"]`),
    bulk: page.locator(
      `${root} [data-testid="review-hub-stage-section-button"], ${root} [data-testid="review-hub-unstage-section-button"]`
    ),
  };
}

async function openViewMenu(page: Page, root: string): Promise<void> {
  await controls(page, root).viewButton.click();
  await page.locator('[role="menu"]').waitFor({ state: "visible", timeout: 5000 });
  await settle(page, 250);
}

async function closeMenus(page: Page): Promise<void> {
  for (let i = 0; i < 2; i++) {
    if (
      !(await page
        .locator('[role="menu"]')
        .first()
        .isVisible()
        .catch(() => false))
    )
      break;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 150);
  }
}

async function clearFilters(page: Page): Promise<void> {
  for (const root of [STAGED, UNSTAGED]) {
    const input = controls(page, root).filter;
    if (await input.isVisible().catch(() => false)) {
      await input.fill("").catch(() => {});
    }
  }
  // `fill` leaves focus in the last field, which paints a focus ring on every
  // later "rest" shot and makes rest look like an interaction. Hand focus back
  // to the list so rest actually is rest.
  await page
    .locator(FILE_LIST)
    .focus()
    .catch(() => {});
  await settle(page, 250);
}

/**
 * Add one row to the multi-select.
 *
 * Always modifier-clicks. A PLAIN click on a row is not "select" — `handleRowClick`
 * treats it as "open this file's diff", which layers a second dialog over the hub.
 */
async function selectRow(page: Page, filePath: string, modifier: "Meta" | "Shift" = "Meta") {
  const row = page.locator(`[data-testid="file-stage-row-${filePath}"]`).first();
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.click({ modifiers: [modifier] });
  await settle(page, 150);
}

/**
 * Drop the selection — and ONLY then.
 *
 * The hub's Escape handler is a precedence ladder: open diff → base-branch diff →
 * selection → close the dialog. An unconditional Escape therefore closes the hub the
 * moment nothing is selected, which silently ends the capture. So: press it only while
 * a selected row is actually on screen, and re-check afterwards.
 */
async function clearSelection(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const selected = await page
      .locator("[data-selected]")
      .count()
      .catch(() => 0);
    if (selected === 0) break;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

/** Re-open the hub if a stray Escape or a failed step closed it. */
async function ensureHubOpen(page: Page): Promise<void> {
  const hub = page.locator(SEL.reviewHub.container);
  if (await hub.isVisible().catch(() => false)) {
    // A per-file diff can sit above the hub; close it without touching the hub.
    const diff = page.locator(SEL.reviewHub.diffDialog);
    if (await diff.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 250);
    }
    if (
      await page
        .locator(FILE_LIST)
        .isVisible()
        .catch(() => false)
    )
      return;
  } else {
    await dismissBlockingPalette(page);
    await page.locator(SEL.worktree.reviewHubButton).first().click();
    await hub.waitFor({ state: "visible", timeout: T_MEDIUM });
  }
  const toggle = hub.locator(SEL.reviewHub.fileListToggle);
  await toggle.waitFor({ state: "visible", timeout: T_MEDIUM });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.locator(FILE_LIST).waitFor({ state: "visible", timeout: T_MEDIUM });
  await settle(page, 400);
}

test("review hub file-section review — header density across states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FILESECTION is required for the file-section capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_FILESECTION to run the file-section capture");

  failures.length = 0;
  written.length = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-filesectionshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    // Open Review & Commit and expand the file list (#7890 collapses it on open).
    const reviewBtn = page.locator(SEL.worktree.reviewHubButton).first();
    await reviewBtn.waitFor({ state: "visible", timeout: T_LONG });
    await reviewBtn.click();
    const hub = page.locator(SEL.reviewHub.container);
    await hub.waitFor({ state: "visible", timeout: T_MEDIUM });

    const toggle = hub.locator(SEL.reviewHub.fileListToggle);
    await toggle.waitFor({ state: "visible", timeout: T_MEDIUM });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await page.locator(FILE_LIST).waitFor({ state: "visible", timeout: T_MEDIUM });
    await settle(page, 800);

    // A reset that returns to the documented rest state rather than assuming it.
    const rest = async (): Promise<void> => {
      await closeMenus(page);
      await clearFilters(page);
      await clearSelection(page);
      await setWindowSize(ctx!.app, WIDE);
      await page.emulateMedia({ forcedColors: "none", contrast: "no-preference" }).catch(() => {});
      await settle(page, 300);
      await ensureHubOpen(page);
    };

    await step(
      "rest",
      async () => {
        await snapList(page, "10-rest-both-sections");
        await snap(page, "11-rest-staged-header", STAGED);
        await snap(page, "12-rest-changes-header", UNSTAGED);
        await snap(page, "13-rest-window");
      },
      rest
    );

    await step(
      "filter",
      async () => {
        await controls(page, UNSTAGED).filter.fill("renderer");
        await settle(page, 400);
        await snapList(page, "20-filter-active");
        await snap(page, "21-filter-active-changes", UNSTAGED);
        await controls(page, UNSTAGED).filter.fill("zzzznomatch");
        await settle(page, 400);
        await snapList(page, "22-filter-no-match");
        // Both sections filtered at once — two active queries stacked.
        await controls(page, STAGED).filter.fill("orchestration");
        await controls(page, UNSTAGED).filter.fill("store");
        await settle(page, 400);
        await snapList(page, "23-filter-both-sections");
      },
      rest
    );

    await step(
      "selection",
      async () => {
        await selectRow(page, "src/renderer/store/worktreeTopologyStore.ts");
        await selectRow(page, "src/renderer/hooks/useDeferredWorkspaceSnapshot.ts");
        await selectRow(page, "src/main/services/workspace/reconciliationTelemetry.ts");
        await snapList(page, "30-selection-changes");
        await snap(page, "31-selection-changes-header", UNSTAGED);
        await clearSelection(page);
        await selectRow(page, "docs/architecture/notification-system.md");
        await selectRow(page, "package-lock.json");
        await snapList(page, "32-selection-staged");
        await snap(page, "33-selection-staged-header", STAGED);
        // Selection AND an active filter — the two label drivers at once.
        await clearSelection(page);
        await controls(page, UNSTAGED).filter.fill("src");
        await settle(page, 400);
        await selectRow(page, "src/renderer/store/worktreeTopologyStore.ts");
        await snap(page, "34-selection-plus-filter", UNSTAGED);
      },
      rest
    );

    await step(
      "viewmenu",
      async () => {
        await openViewMenu(page, UNSTAGED);
        await snap(page, "40-view-menu-defaults");
        await closeMenus(page);
        // Drive every setting away from its default, then show the trigger at rest —
        // the question is whether the collapsed control admits it holds state.
        await openViewMenu(page, UNSTAGED);
        await page.getByRole("menuitemradio", { name: "Churn" }).click();
        await openViewMenu(page, UNSTAGED);
        await page.getByRole("menuitemradio", { name: "Compact" }).click();
        await openViewMenu(page, UNSTAGED);
        await page.getByRole("menuitemcheckbox", { name: "Show generated files" }).click();
        await openViewMenu(page, UNSTAGED);
        await snap(page, "41-view-menu-all-non-default");
        await closeMenus(page);
        await snapList(page, "42-non-default-view-at-rest");
        await snap(page, "43-non-default-changes-header", UNSTAGED);
      },
      rest
    );

    await step(
      "density",
      async () => {
        for (const root of [STAGED, UNSTAGED]) {
          await openViewMenu(page, root);
          await page.getByRole("menuitemradio", { name: "Compact" }).click();
          await settle(page, 200);
        }
        await snapList(page, "50-compact-both-sections");
      },
      async () => {
        for (const root of [STAGED, UNSTAGED]) {
          await openViewMenu(page, root).catch(() => {});
          await page
            .getByRole("menuitemradio", { name: "Comfortable" })
            .click()
            .catch(() => {});
        }
        await rest();
      }
    );

    // Hide generated files in a section whose visible population is entirely
    // generated — the "Only generated files changed" empty state.
    await step(
      "generated",
      async () => {
        await controls(page, UNSTAGED).filter.fill("dist/");
        await settle(page, 400);
        await snapList(page, "60-generated-shown");
        await openViewMenu(page, UNSTAGED);
        const checkbox = page.getByRole("menuitemcheckbox", { name: "Show generated files" });
        if ((await checkbox.getAttribute("aria-checked")) === "true") await checkbox.click();
        else await closeMenus(page);
        await settle(page, 400);
        await snapList(page, "61-generated-hidden-empty");
        await snap(page, "62-generated-hidden-changes", UNSTAGED);
      },
      rest
    );

    await step(
      "emptystaged",
      async () => {
        await controls(page, STAGED).bulk.click();
        await page
          .locator(SEL.reviewHub.noStagedFiles)
          .waitFor({ state: "visible", timeout: T_MEDIUM });
        await settle(page, 500);
        await snapList(page, "70-nothing-staged");
        await snap(page, "71-nothing-staged-header", STAGED);
        // One file back, so the header renders a singular count next to a live bulk action.
        // Uses the row's own stage control — a row click would open its diff instead.
        await page
          .locator(SEL.reviewHub.stageButton("src/renderer/store/worktreeTopologyStore.ts"))
          .click();
        await settle(page, 900);
        await snap(page, "72-one-file-staged", STAGED);
      },
      rest
    );

    await step(
      "narrow",
      async () => {
        await setWindowSize(ctx!.app, NARROW);
        await settle(page, 800);
        await snapList(page, "80-narrow-both-sections");
        await snap(page, "81-narrow-changes-header", UNSTAGED);
        await snap(page, "82-narrow-window");
        await selectRow(page, "src/renderer/store/worktreeTopologyStore.ts");
        await selectRow(page, "src/renderer/hooks/useDeferredWorkspaceSnapshot.ts");
        await snap(page, "83-narrow-selection-header", UNSTAGED);
        await clearSelection(page);
        await controls(page, UNSTAGED).filter.fill("renderer");
        await settle(page, 400);
        await snap(page, "84-narrow-filter-header", UNSTAGED);
      },
      rest
    );

    await step(
      "keyboard",
      async () => {
        await controls(page, UNSTAGED).filter.focus();
        await settle(page, 250);
        await snap(page, "90-focus-filter-field", UNSTAGED);
        await page.keyboard.press("Tab");
        await settle(page, 250);
        await snap(page, "91-focus-view-button", UNSTAGED);
        await page.keyboard.press("Tab");
        await settle(page, 250);
        await snap(page, "92-focus-bulk-action", UNSTAGED);
        // Roving row focus inside the listbox.
        await page.locator(FILE_LIST).focus();
        for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
        await settle(page, 300);
        await snapList(page, "93-keyboard-row-focus");
      },
      rest
    );

    await step(
      "contrast",
      async () => {
        await page.emulateMedia({ contrast: "more" });
        await settle(page, 500);
        await snapList(page, "94-prefers-contrast-more");
        await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
        await settle(page, 500);
        await snapList(page, "95-forced-colors-active");
        await snap(page, "96-forced-colors-changes", UNSTAGED);
      },
      rest
    );
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    try {
      repo.cleanup();
    } catch {
      /* best effort */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  // Count the artifacts rather than trusting the step loop: a harness that exits 0 with
  // an empty output directory is worse than one that fails.
  const onDisk = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`))
    : [];
  console.log(`[filesection-shots] wrote ${written.length} shot(s), ${onDisk.length} on disk`);

  if (failures.length > 0) {
    throw new Error(
      `[filesection-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`
    );
  }
  if (written.length === 0) {
    throw new Error("[filesection-shots] no screenshots were written");
  }
  if (onDisk.length < written.length) {
    throw new Error(
      `[filesection-shots] wrote ${written.length} shot(s) but only ${onDisk.length} landed on disk`
    );
  }
});
