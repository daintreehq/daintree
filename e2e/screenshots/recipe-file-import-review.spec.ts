/**
 * Recipe file-import visual-review harness.
 *
 * Drives the Recipe manager's "Import from file…" flow with a project open and
 * writes a PNG of every state that carries design weight, in every theme named:
 *
 *   01 the Import menu, 02 a clean file just picked (and 02b the same in the
 *   window), 03 that file with Global chosen, 04 the scope select open, 05 a
 *   long name with a full set of terminals, 06 a file that would drop
 *   terminals (#15044), 07 a file that isn't a recipe, 08 the clipboard
 *   import it shares its dialog with, 09 the manager after a confirmed import,
 *   10 the refused file once its JSON is fixed, 11 a recipe pasted on the clipboard.
 *
 * The file picker is the only thing replaced: the `recipe:import-file` handler
 * in the MAIN process answers with a scripted file, so the renderer runs
 * its real path — the real IPC envelope, the real store validation, the real
 * in-repo write when there is one.
 *
 * Opt-in only, like the other review harnesses: skips itself unless
 * DAINTREE_SHOT_RECIPE_IMPORT is set.
 *
 *   DAINTREE_SHOT_RECIPE_IMPORT=1 npx playwright test --project=screenshots recipe-file-import-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RECIPE_IMPORT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEMES         comma-separated theme ids (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY           comma-separated step filter (step names below)
 *   DESIGN_CAPTURE_DIR           optional output directory
 *
 * Output: artifacts/recipe-import-shots/<NN-slug>--<theme>.png (gitignored), or
 * DESIGN_CAPTURE_DIR when set.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepoWithRecipes } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_SHORT } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_RECIPE_IMPORT;
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "recipe-import-shots");

const MANAGER = SEL.recipeManager.dialog;
const IMPORT_DIALOG = SEL.recipeManager.importDialog;
/** The dialog role sits on the full-window backdrop; the panel is its first child. */
const MANAGER_PANEL = `${MANAGER} > div`;
const IMPORT_PANEL = `${IMPORT_DIALOG} > div`;

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

const SEEDED = [
  {
    name: "Shared dev",
    terminals: [
      { type: "claude", title: "", command: "", env: {} },
      { type: "terminal", title: "Dev server", command: "npm run dev", env: {} },
    ],
  },
  {
    name: "Release check",
    terminals: [{ type: "terminal", title: "Tests", command: "npm test", env: {} }],
  },
];

/** A picked file as the main process hands it over: its base name and its text. */
const pickedFile = (fileName: string, content: unknown) => ({
  fileName,
  json: JSON.stringify(content, null, 2),
});

const CLEAN_FILE = pickedFile("frontend-review-fleet.json", {
  name: "Frontend review fleet",
  terminals: [
    { type: "claude", title: "Reviewer" },
    { type: "codex", title: "" },
    { type: "terminal", title: "Dev server", command: "npm run dev" },
  ],
  showInEmptyState: false,
});

const LONG_FILE = pickedFile("nightly-regression-triage-monorepo-agents-2026-11-10.json", {
  name: "Nightly regression triage across every package in the monorepo, with agents",
  terminals: [
    { type: "claude", title: "Triage lead" },
    { type: "codex", title: "API package" },
    { type: "gemini", title: "Web package" },
    { type: "terminal", title: "Unit tests", command: "npm test -- --watch" },
    { type: "terminal", title: "E2E", command: "npx playwright test --project=core" },
    { type: "dev-preview", title: "Storybook", devCommand: "npm run storybook" },
    { type: "terminal", title: "", command: "tail -f logs/nightly.log" },
    { type: "terminal", title: "Typecheck", command: "npm run typecheck -- --watch" },
  ],
});

const DROPS_FILE = pickedFile("agent-fleet.json", {
  name: "Agent fleet",
  terminals: [
    { type: "claude", title: "Planner" },
    { type: "terminal", title: "Dev server", command: "npm run dev" },
    { type: "acme-agent", title: "Acme reviewer" },
  ],
});

const NOT_A_RECIPE = pickedFile("daintree-settings.json", {
  theme: "bondi",
  keybindings: { "terminal.new": "Cmd+T" },
});

interface PickedFile {
  fileName: string;
  json: string;
}

async function installFilePickerStub(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const scope = globalThis as unknown as { __recipeShotFile?: PickedFile | null };
    scope.__recipeShotFile ??= null;
    ipcMain.removeHandler("recipe:import-file");
    ipcMain.handle("recipe:import-file", async () => scope.__recipeShotFile ?? null);
  });
}

async function setPickedFile(app: ElectronApplication, file: PickedFile | null): Promise<void> {
  await app.evaluate((_electron, f) => {
    (globalThis as unknown as { __recipeShotFile?: PickedFile | null }).__recipeShotFile = f;
  }, file);
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written: string[] = [];
let themeTag = "";
let fixture: { dir: string; seeded: ReadonlySet<string> } | undefined;
/** Set by the clean step: a build that imports in one click has no scope dialog to photograph. */
let oneClickImport = false;

/**
 * Screenshot, then confirm a non-empty file actually landed. A harness that
 * trusts its own exit code reports success while writing nothing.
 */
async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  const file = path.join(OUTPUT_DIR, `${slug}--${themeTag}.png`);
  if (locator) {
    await page.locator(locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  if (!existsSync(file) || statSync(file).size === 0) {
    throw new Error(`[recipe-import-shots] snap "${slug}" produced no file at ${file}`);
  }
  written.push(path.basename(file));
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const failures: string[] = [];

/**
 * Steps are isolated so one broken state doesn't cost the whole sweep, but
 * every failure is collected and rethrown at the end.
 */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = `${themeTag}/${name}: ${String(error).slice(0, 400)}`;
    console.warn(`[recipe-import-shots] step failed — ${detail}`);
    failures.push(detail);
  }
}

async function openManager(page: Page): Promise<void> {
  await dismissBlockingPalette(page).catch(() => undefined);
  await page.evaluate(() =>
    globalThis.window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"))
  );
  await page.locator(MANAGER).waitFor({ state: "visible", timeout: T_MEDIUM });
  await settle(page, 400);
}

async function openImportMenu(page: Page): Promise<void> {
  await page.locator(MANAGER).locator(SEL.recipeManager.importMenuTrigger).click({ force: true });
  await page.getByRole("menuitem", { name: /Import from file/ }).waitFor({
    state: "visible",
    timeout: T_SHORT,
  });
  await settle(page, 300);
}

/**
 * Picks the scripted file through the real menu item. Resolves to whether the
 * import dialog came up; a one-click import leaves only the manager.
 */
async function importFromFile(page: Page, app: ElectronApplication, file: PickedFile) {
  // A one-click import from an earlier step leaves its file on disk, and a
  // second write of the same name is refused, which would photograph as the
  // refusal path instead of the state being captured.
  if (fixture) clearImportedRecipes(fixture.dir, fixture.seeded);
  await setPickedFile(app, file);
  await openManager(page);
  await openImportMenu(page);
  await page.getByRole("menuitem", { name: /Import from file/ }).click();
  const opened = await page
    .locator(IMPORT_DIALOG)
    .waitFor({ state: "visible", timeout: 2_500 })
    .then(() => true)
    .catch(() => false);
  await settle(page, 600);
  return opened;
}

/**
 * Throws rather than giving up quietly: a dialog stuck open turns every later
 * step into a timeout.
 */
async function closeAll(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if ((await page.locator('[role="dialog"]').count()) === 0) return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
  if ((await page.locator('[role="dialog"]').count()) > 0) {
    throw new Error("dialogs did not close — later steps would cascade");
  }
}

// The project-settings Recipes tab is what runs loadRecipes for the open
// project; e2e hydration does not, so the seeded team recipes need it.
async function loadRecipesViaSettings(page: Page): Promise<void> {
  await dismissBlockingPalette(page).catch(() => undefined);
  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = page.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await palette.locator(SEL.projectSwitcher.projectSettings).click();
  await expect(page.locator(SEL.projectSettings.heading)).toBeVisible({ timeout: T_MEDIUM });
  await page.locator(SEL.projectSettings.recipesTab).click();
  await expect(page.locator("#project-default-recipe")).toBeVisible({ timeout: T_MEDIUM });
  await page.locator(SEL.projectSettings.closeButton).click();
  await expect(page.locator(SEL.projectSettings.heading)).not.toBeVisible({ timeout: T_SHORT });
}

const recipesDir = (repoDir: string) => path.join(repoDir, ".daintree", "recipes");

/** A one-click import writes into the fixture repo; each theme starts from the seed. */
function clearImportedRecipes(repoDir: string, seeded: ReadonlySet<string>): void {
  const dir = recipesDir(repoDir);
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!seeded.has(file)) rmSync(path.join(dir, file), { force: true });
  }
}

async function captureTheme(page: Page, app: ElectronApplication): Promise<void> {
  await step("menu", async () => {
    await openManager(page);
    await openImportMenu(page);
    await snap(page, "01-import-menu");
    await closeAll(page);
  });

  // The canonical state. Before the scope choice existed the file went
  // straight into Team recipes, so the manager is what there is to photograph.
  await step("clean", async () => {
    const opened = await importFromFile(page, app, CLEAN_FILE);
    oneClickImport = !opened;
    if (opened) {
      await snap(page, "02-file-clean", IMPORT_PANEL);
    } else {
      await snap(page, "02-file-clean", MANAGER_PANEL);
    }
    await snap(page, "02b-file-clean-in-window");
    await closeAll(page);
  });

  await step("clean-global", async () => {
    if (oneClickImport) {
      console.warn("[recipe-import-shots] clean-global: skipped — this build imports in one click");
      return;
    }
    const opened = await importFromFile(page, app, CLEAN_FILE);
    if (!opened) {
      console.warn("[recipe-import-shots] clean-global: no scope dialog (one-click import)");
      await closeAll(page);
      return;
    }
    const dialog = page.locator(IMPORT_DIALOG);
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: /Global/ }).click();
    await settle(page, 400);
    await snap(page, "03-file-clean-global", IMPORT_PANEL);
    await closeAll(page);
  });

  await step("scope-open", async () => {
    if (oneClickImport) {
      console.warn("[recipe-import-shots] scope-open: skipped — this build imports in one click");
      return;
    }
    const opened = await importFromFile(page, app, CLEAN_FILE);
    if (!opened) {
      console.warn("[recipe-import-shots] scope-open: no scope dialog (one-click import)");
      await closeAll(page);
      return;
    }
    await page.locator(IMPORT_DIALOG).getByRole("combobox").click();
    await page.getByRole("listbox").waitFor({ state: "visible", timeout: T_SHORT });
    await settle(page, 400);
    await snap(page, "04-scope-select-open");
    await closeAll(page);
  });

  await step("long", async () => {
    const opened = await importFromFile(page, app, LONG_FILE);
    await snap(page, "05-file-long", opened ? IMPORT_PANEL : MANAGER_PANEL);
    await closeAll(page);
  });

  await step("drops", async () => {
    const opened = await importFromFile(page, app, DROPS_FILE);
    if (!opened) throw new Error("a file that drops terminals must open the import dialog");
    await snap(page, "06-file-drops-terminals", IMPORT_PANEL);
    await closeAll(page);
  });

  await step("not-a-recipe", async () => {
    const opened = await importFromFile(page, app, NOT_A_RECIPE);
    if (!opened) throw new Error("a file that isn't a recipe must open the import dialog");
    await snap(page, "07-file-not-a-recipe", IMPORT_PANEL);
    await closeAll(page);
  });

  // The refused file once its JSON is fixed: the summary follows the edit.
  await step("repaired", async () => {
    const opened = await importFromFile(page, app, DROPS_FILE);
    if (!opened) throw new Error("a file that drops terminals must open the import dialog");
    const field = page.locator(IMPORT_DIALOG).getByTestId("recipe-import-textarea");
    await field.fill(DROPS_FILE.json.replace("acme-agent", "codex"));
    await settle(page, 500);
    await snap(page, "10-file-repaired", IMPORT_PANEL);
    await closeAll(page);
  });

  await step("clipboard", async () => {
    await openManager(page);
    await openImportMenu(page);
    await page.getByRole("menuitem", { name: /Import from clipboard/ }).click();
    await page.locator(IMPORT_DIALOG).waitFor({ state: "visible", timeout: T_MEDIUM });
    await settle(page, 500);
    await snap(page, "08-clipboard-import", IMPORT_PANEL);
    await page
      .locator(IMPORT_DIALOG)
      .getByTestId("recipe-import-textarea")
      .fill(JSON.stringify(JSON.parse(CLEAN_FILE.json)));
    await settle(page, 500);
    await snap(page, "11-clipboard-pasted", IMPORT_PANEL);
    await closeAll(page);
  });

  // Last, because it saves: the confirmed import and the manager it returns to.
  await step("imported", async () => {
    if (oneClickImport) {
      console.warn("[recipe-import-shots] imported: skipped — this build imports in one click");
      return;
    }
    const opened = await importFromFile(page, app, CLEAN_FILE);
    if (!opened) throw new Error("a clean file must open the scope dialog");
    await page.locator(IMPORT_DIALOG).getByRole("button", { name: "Import recipe" }).click();
    await page.locator(IMPORT_DIALOG).waitFor({ state: "detached", timeout: T_MEDIUM });
    await settle(page, 600);
    await snap(page, "09-imported-team", MANAGER_PANEL);
    await closeAll(page);
  });
}

test("recipe file import review — every state, every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RECIPE_IMPORT is required for the recipe import capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_RECIPE_IMPORT to run the recipe import capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepoWithRecipes({ name: "helios-dashboard", inRepoRecipes: SEEDED });
  const seeded = new Set(readdirSync(recipesDir(repo.dir)));
  fixture = { dir: repo.dir, seeded };
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-recipeshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 960 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "helios-dashboard");
    await installFilePickerStub(ctx.app);

    for (const theme of THEMES) {
      themeTag = theme;
      clearImportedRecipes(repo.dir, seeded);
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      await settle(page, 1200);
      await loadRecipesViaSettings(page);
      await captureTheme(page, ctx.app);
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`[recipe-import-shots] wrote ${written.length} file(s): ${written.join(", ")}`);
  expect(failures, `capture steps failed:\n${failures.join("\n")}`).toEqual([]);
  expect(written.length, "no screenshots were written").toBeGreaterThan(0);
});
