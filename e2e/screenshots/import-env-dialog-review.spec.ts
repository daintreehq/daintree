/**
 * Import-.env dialog visual-review harness.
 *
 * Boots a minimal fixture repo, walks to Settings → CLI Agents → the agent's
 * global env editor, opens Import .env and writes PNGs of every state the paste
 * and conflict-review steps carry design weight in — empty paste, a clean
 * parse, parse errors, duplicate pasted keys, mixed valid/invalid, one conflict
 * and many, both merge modes, empty and overlong values, keyboard focus, high
 * contrast and forced colors — so the two steps can be judged against real
 * rendered pixels (#11973).
 *
 * Opt-in only, like theme-review and add-preset-dialog-review: skips itself
 * unless DAINTREE_SHOT_IMPORTENV is set, so the marketing screenshots workflow
 * never executes it.
 *
 *   DAINTREE_SHOT_IMPORTENV=1 npx playwright test --project=screenshots import-env-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_IMPORTENV  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME      optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG        optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY       comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_SWEEP      set to run the all-themes sweep instead of the state matrix
 *   DAINTREE_SHOT_OUT        optional absolute output dir (default artifacts/import-env-shots)
 *
 * Output: artifacts/import-env-shots/<NN-slug>[-tag].png (gitignored).
 *
 * Steps never swallow their own failures, and every capture asserts text that
 * only appears once the state is genuinely reached — a state that cannot be
 * built throws rather than leaving a plausible-but-wrong PNG behind. The run
 * writes MANIFEST.txt so the caller can count captures without trusting the
 * exit code.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { navigateToAgentSettings } from "../helpers/presets";
import { SEL } from "../helpers/selectors";

const ENABLED = !!process.env.DAINTREE_SHOT_IMPORTENV;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SWEEP = !!process.env.DAINTREE_SHOT_SWEEP;
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "import-env-shots");

/**
 * Every built-in theme. Declared locally rather than imported from a sibling
 * review spec: importing a spec file registers its tests into this one.
 */
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

/** The testid sits on the backdrop; the dialog panel is its first child. */
const DIALOG = '[data-testid="import-env-dialog"]';
const PANEL = `${DIALOG} > div`;
const TEXTAREA = '[data-testid="import-env-textarea"]';
const CONFLICT_LIST = '[data-testid="import-env-conflict-list"]';
/**
 * The element that actually scrolls. Written as a selector list so the harness
 * survives the list gaining a dedicated scroll wrapper: `querySelector` returns
 * the first match in DOCUMENT order, and a wrapper necessarily precedes the
 * `ul` it wraps.
 */
const CONFLICT_LIST_SCROLLER = `${CONFLICT_LIST} [data-testid="import-env-conflict-scroller"], ${CONFLICT_LIST} ul`;
const ENV_EDITOR = '[data-testid="global-env-editor"]';

/** Freeze animations and hide carets so captures are deterministic. */
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

/**
 * The env the dialog is importing INTO. Every conflict state below is built by
 * pasting values that collide with these, so the fixture has to carry the edge
 * cases the comparison has to render: a long secret, a short word, and a key
 * whose existing value is the empty string.
 */
const EXISTING_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-api03-Hk7v2QpLm9xR4tYbN1cZ",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  NODE_ENV: "development",
  LOG_LEVEL: "info",
  HTTP_PROXY: "",
  MAX_THINKING_TOKENS: "16384",
};

const PASTE = {
  /** Clean parse, nothing collides — the "just import it" path. */
  clean: ["# staging overrides", "FEATURE_FLAGS=beta,canary", "export REGION=eu-west-1", ""].join(
    "\n"
  ),

  /** Errors only, so the parse-problem region is the whole story. */
  errors: [
    "GOOD_KEY=fine",
    "this line has no equals sign",
    "2BAD_KEY=starts with a digit",
    'UNTERMINATED="oops',
    "=missing the key",
  ].join("\n"),

  /** Valid lines, a duplicate, AND an error — the state the summary hides in. */
  mixed: [
    "# pulled from the staging box",
    "NODE_ENV=production",
    "NODE_ENV=staging",
    'export GREETING="hello world"',
    "oops this line is wrong",
    "LOG_LEVEL=debug",
  ].join("\n"),

  /** No errors, one duplicate — the only path where the summary shows it. */
  duplicates: ["FEATURE_FLAGS=beta", "FEATURE_FLAGS=beta,canary", "REGION=eu-west-1"].join("\n"),

  /** Exactly one collision, plus one genuinely new key. */
  oneConflict: ["NODE_ENV=production", "REGION=eu-west-1"].join("\n"),

  /**
   * Five collisions and one new key. Covers an existing empty value, an
   * incoming empty value, and a long secret replaced by another long secret.
   */
  manyConflicts: [
    "ANTHROPIC_API_KEY=sk-ant-api03-Zq8w3EhTn5vB7mJdX2fK",
    "ANTHROPIC_BASE_URL=https://gateway.internal.example.com/v1/anthropic",
    "NODE_ENV=production",
    "LOG_LEVEL=",
    "HTTP_PROXY=http://corp-proxy.internal:3128",
    "REGION=eu-west-1",
  ].join("\n"),

  /** One collision where both sides are far wider than the dialog. */
  longValues: [
    "ANTHROPIC_BASE_URL=https://gateway.internal.example.com/v1/anthropic/proxy?tenant=platform-engineering&region=eu-west-1&trace=1",
  ].join("\n"),
};

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Minimal repo — the dialog lives in Settings, so no worktree topology is needed. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-importenv-shots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
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

/**
 * Seed the agent's global env through the real settings seam, then reload so
 * the renderer rebuilds from persisted state rather than a live patch.
 * `presetId: undefined` keeps the scope editor on Default, which is the branch
 * that renders the global env editor.
 */
async function seedGlobalEnv(
  page: Page,
  agentId: string,
  env: Record<string, string>
): Promise<void> {
  await page.evaluate(
    async ({ targetAgentId, nextEnv }) => {
      type AgentEntry = Record<string, unknown>;
      type AgentSettings = { agents?: Record<string, AgentEntry | undefined> };
      const settings = (await window.electron.agentSettings.get()) as AgentSettings;
      const entry = settings.agents?.[targetAgentId] ?? {};
      await window.electron.agentSettings.set(targetAgentId, {
        ...entry,
        globalEnv: nextEnv,
        presetId: undefined,
      } as never);
    },
    { targetAgentId: agentId, nextEnv: env }
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: POLISH_CSS });
  await dismissBlockingPalette(page).catch(() => undefined);
}

/** Walk to the agent's global env editor and open the Import .env dialog. */
async function openDialog(page: Page, agentId: string): Promise<void> {
  await navigateToAgentSettings(page, agentId);
  const section = page.locator(SEL.preset.section);
  await expect(section).toBeVisible({ timeout: 15_000 });
  const editor = section.locator(ENV_EDITOR);
  await expect(
    editor,
    "the global env editor is not on screen — the scope editor is probably not on Default"
  ).toBeVisible({ timeout: 10_000 });
  const importButton = editor.locator('[data-testid="env-editor-import"]');
  await importButton.scrollIntoViewIfNeeded().catch(() => undefined);
  await importButton.click({ force: true });
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  await settle(page, 500);
}

async function typePaste(page: Page, text: string): Promise<void> {
  // `fill` rather than `type`: the parse is a pure function of the whole value,
  // and keystroke-by-keystroke entry captures nothing extra while adding
  // seconds per state.
  await page.locator(TEXTAREA).fill(text);
  await settle(page, 400);
}

/** Advance to the conflict step via the real primary action, not a state poke. */
async function goToConflicts(page: Page): Promise<void> {
  const primary = page.locator(`${PANEL} [data-confirm-role="confirm"]`);
  await expect(
    primary,
    "primary action does not offer the conflict step — the paste produced no collisions"
  ).toContainText("conflict", { timeout: 5000 });
  await primary.click({ force: true });
  await expect(page.locator(CONFLICT_LIST)).toBeVisible({ timeout: 5000 });
  await settle(page, 400);
}

async function closeDialog(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await dialog.getByRole("button", { name: "Close dialog" }).click({ force: true });
  await expect(dialog).not.toBeVisible({ timeout: 5000 });
}

/**
 * Walk focus with real Tab presses until it lands on a node matching
 * `predicate`, so `:focus-visible` actually applies. Chromium only sets it when
 * focus arrives by keyboard, so a programmatic `.focus()` captures a frame that
 * looks exactly like rest and reads as "there is no focus ring" when there is.
 */
/**
 * Walk focus with real Tab presses until it lands on the named control, so
 * `:focus-visible` actually applies. Chromium only sets it when focus arrives
 * by keyboard, so a programmatic `.focus()` captures a frame that looks exactly
 * like rest and reads as "there is no focus ring" when there is.
 */
async function tabUntil(page: Page, target: "textarea" | "radio"): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    await settle(page, 120);
    const hit = await page.evaluate((kind) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.matches(":focus-visible")) return false;
      if (kind === "textarea") return el.tagName === "TEXTAREA";
      return el.tagName === "INPUT" && (el as HTMLInputElement).type === "radio";
    }, target);
    if (hit) return;
  }
  throw new Error(`Tab never reached a keyboard-focused ${target}`);
}

/**
 * Report how much of the conflict preview is reachable without scrolling, and
 * whether the scroll container is keyboard-focusable. Reported, not asserted:
 * how many rows should fit is a design judgement, but a list rendering fewer
 * rows than its own header counts — with nothing on screen saying so — is the
 * input to that judgement, and a screenshot cannot supply it.
 */
async function measureConflictOverflow(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const scroller = document.querySelector(sel);
    if (!scroller) return "no conflict scroller found";
    const rows = Array.from(scroller.querySelectorAll("li"));
    const box = scroller.getBoundingClientRect();
    const fullyVisible = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= box.top - 1 && b.bottom <= box.bottom + 1;
    }).length;
    const overflow = scroller.scrollHeight - scroller.clientHeight;
    const focusable = (scroller as HTMLElement).tabIndex >= 0;
    const role = scroller.getAttribute("role") ?? "none";
    // The dialog body scrolls independently. If it ALSO overflows, the preview
    // has two scroll owners and its own bottom border sits below a second fold
    // — which is the same hidden-content defect the inner scroller fixes,
    // reappearing one level up.
    const body = document.querySelector(
      '[data-testid="import-env-dialog"] .flex-1.overflow-y-auto'
    );
    const bodyOverflow = body ? body.scrollHeight - body.clientHeight : -1;
    return `conflict list: ${fullyVisible}/${rows.length} rows fully visible, ${overflow}px hidden below the fold, scroller tabIndex=${(scroller as HTMLElement).tabIndex} (keyboard-reachable: ${focusable}), role=${role} | dialog body overflow: ${bodyOverflow}px (0 = single scroll owner)`;
  }, CONFLICT_LIST_SCROLLER);
}

const written: string[] = [];

/**
 * Capture one state.
 *
 * `requiredText` is asserted AFTER the settle and immediately before the
 * screenshot: it is what stops the harness writing a plausible-looking PNG of a
 * dialog that never reached the state the filename claims.
 */
async function snap(
  page: Page,
  slug: string,
  requiredText: string[],
  locator: string = PANEL
): Promise<void> {
  await settle(page);
  const target = page.locator(locator).first();
  await expect(target, `"${slug}": capture target is not visible — refusing to write`).toBeVisible({
    timeout: 5000,
  });
  for (const text of requiredText) {
    await expect(
      target,
      `"${slug}": expected ${JSON.stringify(text)} on screen — refusing to write`
    ).toContainText(text, { timeout: 5000 });
  }
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await target.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  written.push(path.basename(file));
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

/**
 * Run a named capture step. Deliberately does NOT swallow errors — a step that
 * cannot reach its state fails the run, because a silently missing capture
 * sends the whole review off reviewing a screen that does not exist.
 */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  await test.step(name, fn);
}

async function boot(): Promise<{
  ctx: AppContext;
  page: Page;
  cleanup: () => Promise<void>;
}> {
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-importenvshot-"));
  const ctx = await launchApp({
    userDataDir,
    screenshotScale: SCALE,
    windowSize: { width: 1680, height: 1050 },
    extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
  });
  const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
  if (THEME) await setAppTheme(page, THEME);
  await page.addStyleTag({ content: POLISH_CSS });
  await dismissBlockingPalette(page).catch(() => undefined);
  await settle(page, 1500);
  return {
    ctx,
    page,
    cleanup: async () => {
      if (ctx.app) await closeApp(ctx.app);
      repo.cleanup();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

function writeManifest(): void {
  const manifest = path.join(OUTPUT_DIR, `MANIFEST${TAG}.txt`);
  appendFileSync(manifest, written.join("\n") + "\n");
}

test("import-env dialog review — paste and conflict states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_IMPORTENV is required for the import-env capture",
  });
  test.skip(
    !ENABLED || SWEEP,
    "Set DAINTREE_SHOT_IMPORTENV, and unset SWEEP, for the state matrix"
  );

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const { page, cleanup } = await boot();
  try {
    await seedGlobalEnv(page, "claude", EXISTING_ENV);

    // ---- Paste step. The state a user actually opens into, then each way the
    // paste can land.
    await step("empty", async () => {
      await openDialog(page, "claude");
      await snap(page, "10-paste-empty", ["Import .env", "Paste variables"]);
      await snap(page, "11-paste-empty-window", ["Import .env"], "body");
      await closeDialog(page);
    });

    await step("focus", async () => {
      await openDialog(page, "claude");
      await tabUntil(page, "textarea");
      await snap(page, "15-paste-focus-textarea", ["Paste variables"]);
      await closeDialog(page);
    });

    await step("clean", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.clean);
      await snap(page, "20-paste-clean", ["2 variables detected", "Import 2 variables"]);
      await closeDialog(page);
    });

    await step("errors", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.errors);
      await snap(page, "25-paste-errors", ["parse error", "Missing '='"]);
      await closeDialog(page);
    });

    await step("mixed", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.mixed);
      await snap(page, "30-paste-mixed", ["parse error", "oops this line is wrong"]);
      await closeDialog(page);
    });

    await step("duplicates", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.duplicates);
      await snap(page, "35-paste-duplicates", ["duplicate key", "2 variables detected"]);
      await closeDialog(page);
    });

    await step("conflicts-detected", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.manyConflicts);
      await snap(page, "40-paste-conflicts-detected", ["5 conflicts", "Review 5 conflicts"]);
      await closeDialog(page);
    });

    // ---- Conflict step.
    await step("one-conflict", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.oneConflict);
      await goToConflicts(page);
      await snap(page, "50-conflicts-one", ["Keep existing", "NODE_ENV", "development"]);
      await closeDialog(page);
    });

    await step("many-conflicts", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.manyConflicts);
      await goToConflicts(page);
      await snap(page, "55-conflicts-many-keep", ["Keep existing", "ANTHROPIC_API_KEY"]);
      await snap(page, "56-conflicts-many-window", ["Keep existing"], "body");
      // How much of the preview is actually on screen. A destructive preview
      // that renders fewer rows than its own header counts is hiding part of
      // what it is previewing, and a screenshot alone cannot prove it — the
      // rows below the fold look exactly like no rows at all.
      console.log(`[import-env-shots] ${await measureConflictOverflow(page)}`);
      // Scroll the list to the bottom and capture again. If the frame changes,
      // content was hidden; if it does not, nothing was.
      await page
        .locator(CONFLICT_LIST_SCROLLER)
        .first()
        .evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
      await settle(page, 400);
      await snap(page, "57-conflicts-many-scrolled", ["Keep existing"]);
      // Back to the top first: the scrolled-to-bottom capture above would
      // otherwise leave this frame showing a different slice of the list, and
      // the two merge modes have to be comparable frame to frame.
      await page
        .locator(CONFLICT_LIST_SCROLLER)
        .first()
        .evaluate((el) => {
          el.scrollTop = 0;
        });
      await page.locator('[data-testid="import-env-mode-overwrite"]').click({ force: true });
      await settle(page, 400);
      await snap(page, "60-conflicts-many-overwrite", [
        "Overwrite conflicts",
        "Import, overwrite conflicts",
      ]);
      await closeDialog(page);
    });

    await step("conflict-focus", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.manyConflicts);
      await goToConflicts(page);
      await tabUntil(page, "radio");
      await snap(page, "65-conflicts-focus", ["Keep existing"]);
      await closeDialog(page);
    });

    await step("long-values", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.longValues);
      await goToConflicts(page);
      await snap(page, "70-conflicts-long-values", ["ANTHROPIC_BASE_URL"]);
      await closeDialog(page);
    });

    // ---- The accessibility media states, on the two screens carrying the most
    // custom colour: the parse-problem region and the comparison list.
    await step("contrast", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.manyConflicts);
      await goToConflicts(page);
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 400);
      await snap(page, "80-conflicts-high-contrast", ["Keep existing", "ANTHROPIC_API_KEY"]);
      await page.emulateMedia({ contrast: null, forcedColors: "active" });
      await settle(page, 400);
      await snap(page, "81-conflicts-forced-colors", ["Keep existing", "ANTHROPIC_API_KEY"]);
      await page.emulateMedia({ forcedColors: null });
      await settle(page, 300);
      await closeDialog(page);
    });

    await step("contrast-errors", async () => {
      await openDialog(page, "claude");
      await typePaste(page, PASTE.errors);
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 400);
      await snap(page, "85-paste-errors-high-contrast", ["parse error"]);
      await page.emulateMedia({ contrast: null, forcedColors: "active" });
      await settle(page, 400);
      await snap(page, "86-paste-errors-forced-colors", ["parse error"]);
      await page.emulateMedia({ forcedColors: null });
      await settle(page, 300);
      await closeDialog(page);
    });
  } finally {
    writeManifest();
    await cleanup();
  }
});

test("import-env dialog review — every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_IMPORTENV and DAINTREE_SHOT_SWEEP are required for the theme sweep",
  });
  test.skip(
    !ENABLED || !SWEEP,
    "Set DAINTREE_SHOT_IMPORTENV and DAINTREE_SHOT_SWEEP for the sweep"
  );

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const { page, cleanup } = await boot();
  try {
    await seedGlobalEnv(page, "claude", EXISTING_ENV);

    for (const theme of ALL_THEMES) {
      await test.step(theme, async () => {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS });
        await dismissBlockingPalette(page).catch(() => undefined);
        await openDialog(page, "claude");
        await typePaste(page, PASTE.manyConflicts);
        await goToConflicts(page);
        await snap(page, `90-theme-${theme}`, ["Keep existing", "ANTHROPIC_API_KEY"]);
        await closeDialog(page);
      });
    }
  } finally {
    writeManifest();
    await cleanup();
  }
});
