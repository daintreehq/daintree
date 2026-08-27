/**
 * Add-preset dialog visual-review harness.
 *
 * Boots a minimal fixture repo, walks to Settings → CLI Agents, and writes PNGs
 * of every state the "Start from" chooser carries design weight in — blank,
 * clone with and without a current preset, template with the provider selector,
 * the two-option shape agents without provider templates get, plus hover,
 * keyboard focus, an overlong preset name, high contrast and forced colors — so
 * the dialog can be judged against real rendered pixels (#11972).
 *
 * Opt-in only, like theme-review and worktree-dialog-review: skips itself unless
 * DAINTREE_SHOT_PRESET is set, so the marketing screenshots workflow never
 * executes it.
 *
 *   DAINTREE_SHOT_PRESET=1 npx playwright test --project=screenshots add-preset-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PRESET  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME   optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG     optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY    comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_SWEEP   set to run the all-themes sweep instead of the state matrix
 *   DAINTREE_SHOT_OUT     optional absolute output dir (default artifacts/preset-shots)
 *
 * Output: artifacts/preset-shots/<NN-slug>[-tag].png (gitignored).
 *
 * Steps never swallow their own failures. A state that cannot be reached throws
 * rather than leaving a stale or plausible-but-wrong PNG behind, and the run
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

const ENABLED = !!process.env.DAINTREE_SHOT_PRESET;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SWEEP = !!process.env.DAINTREE_SHOT_SWEEP;
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "preset-shots");

/** The testid sits on the backdrop; the dialog panel is its first child. */
const DIALOG = '[data-testid="add-preset-dialog"]';
const PANEL = `${DIALOG} > div`;

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
 * Every built-in theme. Switching themes reloads the renderer, so the sweep
 * re-walks to the dialog after each switch rather than booting once per theme.
 */
export const ALL_THEMES = [
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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Minimal repo — the dialog lives in Settings, so no worktree topology is needed. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-preset-shots-"));
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
 * Seed an agent's custom presets through the real settings seam, then reload so
 * the renderer rebuilds from persisted state rather than a live patch.
 */
async function seedPresets(
  page: Page,
  agentId: string,
  presets: { id: string; name: string; env?: Record<string, string>; args?: string[] }[],
  selectedId: string | null
): Promise<void> {
  await page.evaluate(
    async ({ targetAgentId, nextPresets, presetId }) => {
      type AgentEntry = Record<string, unknown>;
      type AgentSettings = { agents?: Record<string, AgentEntry | undefined> };
      const settings = (await window.electron.agentSettings.get()) as AgentSettings;
      const entry = settings.agents?.[targetAgentId] ?? {};
      await window.electron.agentSettings.set(targetAgentId, {
        ...entry,
        customPresets: nextPresets,
        presetId: presetId ?? undefined,
      } as never);
    },
    { targetAgentId: agentId, nextPresets: presets, presetId: selectedId }
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: POLISH_CSS });
  await dismissBlockingPalette(page).catch(() => undefined);
}

/** Walk to an agent's settings and open the Add preset dialog. */
async function openDialog(page: Page, agentId: string): Promise<void> {
  await navigateToAgentSettings(page, agentId);
  const section = page.locator(SEL.preset.section);
  await expect(section).toBeVisible({ timeout: 15_000 });
  await section.locator(SEL.preset.addButton).click({ force: true, noWaitAfter: true });
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
  await settle(page, 500);
}

/**
 * Walk focus into the choice group with real Tab presses so `:focus-visible`
 * actually applies, and fail loudly if it never lands there.
 */
async function tabToRadioGroup(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    await settle(page, 150);
    const onRadio = await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | null;
      return el?.tagName === "INPUT" && el.type === "radio" && el.matches(":focus-visible");
    });
    if (onRadio) return;
  }
  throw new Error("Tab never reached a keyboard-focused radio in the choice group");
}

async function closeDialog(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG);
  if (!(await dialog.isVisible().catch(() => false))) return;
  await dialog.getByRole("button", { name: "Cancel" }).click({ force: true });
  await expect(dialog).not.toBeVisible({ timeout: 5000 });
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
 * Run a named capture step. Unlike the older dialog harness this does NOT
 * swallow errors — a step that cannot reach its state fails the run, because a
 * silently missing capture sends the whole review off reviewing a screen that
 * does not exist.
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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-presetshot-"));
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
  appendFileSync(manifest, written.map((f) => f).join("\n") + "\n");
}

test("add-preset dialog review — start-from states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PRESET is required for the add-preset capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PRESET to run the add-preset capture");
  test.skip(SWEEP, "Sweep mode runs the theme test instead");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const { page, cleanup } = await boot();
  try {
    // ---- Shape A: claude, no custom presets. The rest state, and the shape a
    // first-time user actually meets.
    await seedPresets(page, "claude", [], null);

    await step("blank", async () => {
      await openDialog(page, "claude");
      await snap(page, "10-blank-no-current", ["Start from", "Blank", "Clone current"]);
      await snap(page, "11-blank-no-current-window", ["Blank"], "body");
      await closeDialog(page);
    });

    // The provider selector's dependency on "From template" — the state the
    // issue calls visually dishonest.
    await step("template", async () => {
      await openDialog(page, "claude");
      await page.getByText("From template", { exact: true }).click();
      await settle(page, 400);
      await snap(page, "20-template-selected", ["From template", "Provider"]);
      await closeDialog(page);
    });

    // Keyboard focus on the choice group — the affordance a pointer-only
    // review never sees.
    //
    // Tab, never `.focus()`: Chromium only sets `:focus-visible` when focus
    // arrives by keyboard, so a programmatic focus captures a frame that looks
    // exactly like rest and reads as "there is no focus ring" when there is.
    await step("focus", async () => {
      await openDialog(page, "claude");
      await tabToRadioGroup(page);
      await snap(page, "30-focus-visible-blank", ["Blank"]);
      await page.keyboard.press("ArrowDown");
      await settle(page, 300);
      await snap(page, "31-focus-visible-arrowed", ["Clone current"]);
      await closeDialog(page);
    });

    // Hover on a row that is not the selected one — the click-target question.
    await step("hover", async () => {
      await openDialog(page, "claude");
      await page.getByText("Clone current", { exact: true }).hover();
      await settle(page, 300);
      await snap(page, "35-hover-clone", ["Clone current"]);
      await closeDialog(page);
    });

    // High contrast and forced colors, on the state that carries the most
    // custom styling.
    await step("contrast", async () => {
      await openDialog(page, "claude");
      await page.getByText("From template", { exact: true }).click();
      await settle(page, 300);
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 400);
      await snap(page, "40-high-contrast", ["From template", "Provider"]);
      await page.emulateMedia({ contrast: null, forcedColors: "active" });
      await settle(page, 400);
      await snap(page, "41-forced-colors", ["From template", "Provider"]);
      await page.emulateMedia({ forcedColors: null });
      await settle(page, 300);
      await closeDialog(page);
    });

    // ---- Shape B: an agent with no provider templates. Two options, not
    // three — a shape the code path makes easy to forget.
    await step("no-templates", async () => {
      await openDialog(page, "codex");
      await snap(page, "50-no-templates", ["Start from", "Blank", "Clone current"]);
      await closeDialog(page);
    });

    // ---- Shape C: a current preset exists and is selected, so "Clone current"
    // is genuinely available and names its source.
    await step("clone", async () => {
      await seedPresets(
        page,
        "claude",
        [{ id: "shot-preset-1", name: "Z.AI (GLM-5.2)", env: {}, args: [] }],
        "shot-preset-1"
      );
      await openDialog(page, "claude");
      await page.getByText("Clone current", { exact: true }).click();
      await settle(page, 400);
      await snap(page, "60-clone-with-current", ["Clone current", "Z.AI"]);
      await closeDialog(page);
    });

    // ---- Shape D: extreme density. The longest name a user can actually
    // produce, to expose truncation and wrapping.
    await step("long-name", async () => {
      await seedPresets(
        page,
        "claude",
        [
          {
            id: "shot-preset-long",
            name: "OpenRouter — Claude Opus 4.6 with extended thinking and a 1M context window",
            env: {},
            args: [],
          },
        ],
        "shot-preset-long"
      );
      await openDialog(page, "claude");
      await page.getByText("Clone current", { exact: true }).click();
      await settle(page, 400);
      await snap(page, "70-clone-long-name", ["Clone current"]);
      await closeDialog(page);
    });
  } finally {
    writeManifest();
    await cleanup();
  }
});

test("add-preset dialog review — every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PRESET and DAINTREE_SHOT_SWEEP are required for the theme sweep",
  });
  test.skip(!ENABLED || !SWEEP, "Set DAINTREE_SHOT_PRESET and DAINTREE_SHOT_SWEEP for the sweep");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const { page, cleanup } = await boot();
  try {
    await seedPresets(
      page,
      "claude",
      [{ id: "shot-preset-1", name: "Z.AI (GLM-5.2)", env: {}, args: [] }],
      "shot-preset-1"
    );

    for (const theme of ALL_THEMES) {
      await test.step(theme, async () => {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS });
        await dismissBlockingPalette(page).catch(() => undefined);
        await openDialog(page, "claude");
        await page.getByText("From template", { exact: true }).click();
        await settle(page, 400);
        await snap(page, `80-theme-${theme}`, ["From template", "Provider"]);
        await closeDialog(page);
      });
    }
  } finally {
    writeManifest();
    await cleanup();
  }
});
