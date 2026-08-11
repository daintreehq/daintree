/**
 * Marketing screenshot pipeline — Microsoft Store + website reel.
 *
 * Run on demand via .github/workflows/screenshots.yml. Each test opens a
 * separate demo repo, drives a deterministic UI state, and writes a PNG to
 * artifacts/screenshots/. Scale + window size are env-driven so the same
 * spec produces 1080p, 2x, or 3x output without code changes.
 *
 * Scenes:
 *   1. 🌊 surge-checkout         — hero: Claude agent at work
 *   2. 🎨 brush-cms              — worktree dashboard with mixed states
 *   3. 🌴 daintree-site          — dev preview live (daintree.org proxy)
 *   4. 🚀 launchpad-analytics    — action palette open
 *   5. 🛰️ orbital-sync           — multi-agent (Claude + OpenCode)
 *   6. 🍳 mise-en-place          — settings / agent overview
 *
 * Sanitization rules baked in:
 *   - No API-key shapes (ANTHROPIC_API_KEY is set via IPC, never visible in UI)
 *   - No real-user paths (folder basenames are project slugs)
 *   - No third-party code (all demo content is original)
 *   - Microsoft Store Policy 11.16 AI disclosure is handled in store metadata
 */

import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import {
  launchApp,
  closeApp,
  mockOpenDialog,
  refreshActiveWindow,
  type AppContext,
} from "../helpers/launch";
import { dismissTelemetryConsent } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { isToolbarButtonReachable, openDevPreview } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { configureClaudeAuthEnv, hasClaudeApiKey } from "../helpers/claudeAuth";
import { writeTerminalInput, getTerminalText } from "../helpers/terminal";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import {
  createSurgeCheckoutRepo,
  createBrushCmsRepo,
  createDaintreeSiteRepo,
  createLaunchpadAnalyticsRepo,
  createOrbitalSyncRepo,
  createMiseEnPlaceRepo,
  type DemoRepo,
} from "../helpers/screenshotFixtures";

const SCREENSHOT_SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const WINDOW_WIDTH = Number(process.env.DAINTREE_SCREENSHOT_WIDTH ?? 1920);
const WINDOW_HEIGHT = Number(process.env.DAINTREE_SCREENSHOT_HEIGHT ?? 1080);
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "screenshots");

mkdirSync(OUTPUT_DIR, { recursive: true });

/** Inject pre-screenshot CSS: hide scrollbars, freeze animations. */
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
 * Wait for two animation frames so any final layout/paint settles.
 * Cheaper and more deterministic than waitForTimeout(N).
 */
async function settleFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

interface CaptureContext {
  ctx: AppContext;
  page: Page;
}

async function bootProject(
  repo: DemoRepo,
  options: { displayName?: string; emoji?: string } = {}
): Promise<CaptureContext> {
  const ctx = await launchApp({
    screenshotScale: SCREENSHOT_SCALE,
    windowSize: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
  });

  await mockOpenDialog(ctx.app, repo.dir);
  await ctx.window.getByRole("button", { name: "Open folder" }).click();

  let page = await refreshActiveWindow(ctx.app, ctx.window);
  await dismissTelemetryConsent(page);
  await dismissBlockingPalette(page);
  ctx.window = page;

  // Inject anti-flake CSS once per scene.
  try {
    await page.addStyleTag({ content: POLISH_CSS });
  } catch (error) {
    if (!String(error).includes("Target page, context or browser has been closed")) {
      throw error;
    }
    page = await refreshActiveWindow(ctx.app, page);
    ctx.window = page;
    await page.addStyleTag({ content: POLISH_CSS });
  }

  // Configure Claude auth if available, even for scenes that don't launch
  // agents — keeps the env consistent and lets us iterate by extending a
  // scene to include an agent without touching boot logic.
  if (hasClaudeApiKey()) {
    await configureClaudeAuthEnv(page);
  }

  // Marketing polish: set a proper display name + emoji on the project so
  // the title bar / project switcher / project header read like a real
  // user's project rather than a kebab-case folder slug.
  if (options.displayName || options.emoji) {
    await page.evaluate(
      async (overrides) => {
        const current = await window.electron.project.getCurrent();
        if (!current?.id) return;
        await window.electron.project.update(current.id, {
          ...(overrides.displayName ? { name: overrides.displayName } : {}),
          ...(overrides.emoji ? { emoji: overrides.emoji } : {}),
        });
      },
      { displayName: options.displayName, emoji: options.emoji }
    );
    // Settle so the new name/emoji propagates to the title bar before any
    // screenshot is taken.
    await page.waitForTimeout(T_SETTLE);
  }

  page = await refreshActiveWindow(ctx.app, page);
  ctx.window = page;
  return { ctx, page };
}

async function teardown(ctx: AppContext): Promise<void> {
  try {
    await closeApp(ctx.app);
  } catch {
    // best-effort
  }
}

async function snap(page: Page, slug: string): Promise<string> {
  await settleFrame(page);
  const filePath = path.join(OUTPUT_DIR, `${slug}.png`);
  await page.screenshot({
    path: filePath,
    type: "png",
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    timeout: 120_000, // generous — windows-latest sometimes needs >30s
  });
  return filePath;
}

async function launchClaude(app: ElectronApplication, page: Page): Promise<Locator> {
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();
  const panel = page.locator(SEL.agent.panel).first();
  await expect(panel).toBeVisible({ timeout: 60_000 });
  void app;
  return panel;
}

async function launchOpenCode(page: Page): Promise<Locator> {
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("OpenCode")).first().click();
  const panel = page.locator(SEL.opencodeAgent.panel).first();
  await expect(panel).toBeVisible({ timeout: 60_000 });
  return panel;
}

/**
 * Send a prompt into the agent's hybrid editor / terminal. Mirrors the
 * platform-specific input path used by claude-online.spec.ts.
 */
async function sendPrompt(page: Page, panel: Locator, prompt: string): Promise<void> {
  const cmEditor = panel.locator(SEL.terminal.cmEditor);
  const isVisible = await cmEditor.isVisible({ timeout: T_SHORT }).catch(() => false);
  if (isVisible && process.platform !== "win32") {
    await cmEditor.click({ force: true });
    await page.keyboard.type(prompt, { delay: 15 });
    await page.keyboard.press("Enter");
    return;
  }
  await writeTerminalInput(page, panel, `${prompt}\r`);
}

/**
 * Wait for the agent panel to reach a ready/welcome state.
 *
 * Handles common boot prompts: Claude's "trust" + "api key" dialogs and
 * OpenCode's "/connect" provider setup. Caller passes the regex set that
 * indicates ready — typically [/welcome/i] for Claude, or the OpenCode-
 * specific banners.
 */
async function waitForAgentReady(
  panel: Locator,
  page: Page,
  matches: RegExp[] = [/welcome/i],
  options: { kind?: "claude" | "opencode" } = {}
): Promise<void> {
  const kind = options.kind ?? "claude";
  const budget = kind === "opencode" ? 360_000 : 270_000;
  const deadline = Date.now() + (process.platform === "win32" ? budget : 120_000);
  while (Date.now() < deadline) {
    await dismissTelemetryConsent(page);
    const text = await getTerminalText(panel).catch(() => "");
    if (matches.some((re) => re.test(text))) return;
    const lower = text.toLowerCase();
    if (lower.includes("trust")) {
      await writeTerminalInput(page, panel, "\r");
      await page.waitForTimeout(2000);
    } else if (lower.includes("api key")) {
      await writeTerminalInput(page, panel, "\x1b[A\r");
      await page.waitForTimeout(2000);
    } else if (kind === "opencode" && (lower.includes("/connect") || lower.includes("provider"))) {
      await writeTerminalInput(page, panel, "\r");
      await page.waitForTimeout(2000);
    } else {
      await page.waitForTimeout(1000);
    }
  }
  throw new Error("Agent never reached ready state");
}

/**
 * Wait for the agent to actually respond — not just echo the prompt.
 *
 * Strategy: poll the terminal text and look for response markers (Claude's
 * `⏺` tool-use glyphs, numbered-list starts, code-block fences, common
 * response openings). Also accept a substantial line-count gain over the
 * baseline as a fallback signal.
 *
 * Returns true if a real response was observed. If the agent never responds
 * within maxWaitMs, returns false rather than throwing — a screenshot run
 * should still snap whatever is on screen — but the caller MUST surface the
 * stall as a test annotation so a worthless blank-panel capture is flagged in
 * CI artifacts rather than passing silently.
 */
async function waitForAgentResponse(
  panel: Locator,
  page: Page,
  baseline: string,
  options: {
    /** Wait at least this long even if response markers appear, so the response has time to grow. */
    minWaitMs?: number;
    /** Hard upper bound on the wait. */
    maxWaitMs?: number;
  } = {}
): Promise<boolean> {
  const minWait = options.minWaitMs ?? 25_000;
  const maxWait = options.maxWaitMs ?? 180_000;
  const start = Date.now();
  const baselineLines = baseline.split("\n").length;
  const responseMarker =
    /(⏺|✓|✗|^I('ll| can| see)\b|^Let me\b|^Here('s| is)\b|^\d+\.\s+\w|```|^Step\s+\d+)/im;

  let markerSeenAt = 0;
  while (Date.now() - start < maxWait) {
    const text = await getTerminalText(panel).catch(() => "");
    const newSection = text.slice(baseline.length);

    if (markerSeenAt === 0 && responseMarker.test(newSection)) {
      markerSeenAt = Date.now();
    }

    const elapsed = Date.now() - start;
    if (markerSeenAt > 0 && elapsed >= minWait) {
      // We've seen a response start AND waited long enough for it to grow.
      return true;
    }

    // Fallback: substantial line gain even without a recognizable marker.
    const lineGain = text.split("\n").length - baselineLines;
    if (lineGain >= 12 && elapsed >= minWait) return true;

    await page.waitForTimeout(1500);
  }
  return false;
}

/** Annotate (don't fail) when an agent stalled, so the blank capture is flagged. */
function annotateAgentResponse(responded: boolean, label: string, maxWaitMs: number): void {
  if (responded) return;
  test.info().annotations.push({
    type: "agent-stalled",
    description: `${label} did not produce a response within ${maxWaitMs}ms — screenshot may be blank`,
  });
}

// ---------------------------------------------------------------------------
// Scene 1 — 🌊 surge-checkout : Hero, Claude agent at work
// ---------------------------------------------------------------------------

test.describe.serial("Marketing Screenshots — Daintree Store Reel", () => {
  test("scene-1-hero-surge-checkout", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "ANTHROPIC_API_KEY is required for the agent scenes",
    });

    test.skip(!hasClaudeApiKey(), "ANTHROPIC_API_KEY is required for the agent scenes");

    const repo = createSurgeCheckoutRepo();
    let captured: CaptureContext | undefined;
    try {
      captured = await bootProject(repo, {
        displayName: "Surge Checkout",
        emoji: "🌊",
      });
      const { ctx, page } = captured;

      const claudePanel = await launchClaude(ctx.app, page);
      await waitForAgentReady(claudePanel, page);

      // Scroll past the welcome banner so the visible panel is just the
      // conversation. Two `/clear`-like newlines pushes the banner off-screen
      // without invoking a real slash command (which could change behaviour).
      const baseline = await getTerminalText(claudePanel).catch(() => "");
      const prompt =
        "Read src/checkout.ts and src/refund.ts, then propose a 4-step plan for adding " +
        "an idempotent partial-refund flow. Output the plan as a numbered list, then stop.";
      await sendPrompt(page, claudePanel, prompt);
      // Hero shot — wait long enough for actual streamed output (tool-use
      // blocks + numbered list), not just the "thinking" marker.
      const responded = await waitForAgentResponse(claudePanel, page, baseline, {
        minWaitMs: 120_000,
        maxWaitMs: 300_000,
      });
      annotateAgentResponse(responded, "Claude (hero)", 300_000);
      await dismissBlockingPalette(page);

      await snap(page, "01-hero-surge-checkout");
    } finally {
      if (captured) await teardown(captured.ctx);
      repo.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scene 2 — 🎨 brush-cms : Worktree dashboard
  // -------------------------------------------------------------------------
  test("scene-2-worktree-dashboard-brush-cms", async () => {
    const repo = createBrushCmsRepo();
    let captured: CaptureContext | undefined;
    try {
      captured = await bootProject(repo, {
        displayName: "Brush CMS",
        emoji: "🎨",
      });
      const { page } = captured;

      // Make sure the sidebar is open + the worktree section is expanded
      // (it's the default state but let's be explicit).
      const sidebar = page.locator(SEL.sidebar.aside);
      await expect(sidebar).toBeAttached({ timeout: T_LONG });

      // Wait for worktree items to appear.
      const worktreeItems = page.locator(
        '[data-worktree-branch], [data-worktree-is-main="true"], aside[aria-label="Sidebar"] a'
      );
      await worktreeItems.first().waitFor({ state: "visible", timeout: T_LONG });

      // Wait for the worktree list to stabilise (the poll paints status badges
      // incrementally) so the capture shows a settled set rather than a
      // mid-refresh count.
      await expect.poll(() => worktreeItems.count(), { timeout: T_LONG }).toBeGreaterThanOrEqual(1);
      await page.waitForTimeout(T_SETTLE);
      await dismissBlockingPalette(page);

      await snap(page, "02-worktrees-brush-cms");
    } finally {
      if (captured) await teardown(captured.ctx);
      repo.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scene 3 — 🍱 daintree-site : Dev preview live
  // -------------------------------------------------------------------------
  test("scene-3-dev-preview-daintree-site", async () => {
    const repo = createDaintreeSiteRepo();
    let captured: CaptureContext | undefined;
    try {
      captured = await bootProject(repo, {
        displayName: "Daintree Site",
        emoji: "🌴",
      });
      const { ctx, page } = captured;

      // Configure the dev server command via IPC first — needs a reload to
      // take effect, and the reload would kill any agent panel we'd opened.
      // So: settings → reload → THEN agent + preview.
      await page.evaluate(async () => {
        const current = await window.electron.project.getCurrent();
        if (!current?.id) return;
        const settings = await window.electron.project.getSettings(current.id);
        await window.electron.project.saveSettings(current.id, {
          ...settings,
          devServerCommand: "node dev-server.cjs",
        });
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await dismissTelemetryConsent(page);
      await page.addStyleTag({ content: POLISH_CSS });

      // Launch a Claude panel and send a real edit prompt so the screenshot
      // shows "agent driving live preview" rather than just "dev preview".
      const claudePanel = await launchClaude(ctx.app, page);
      await waitForAgentReady(claudePanel, page);
      const claudeBaseline = await getTerminalText(claudePanel).catch(() => "");
      await sendPrompt(
        page,
        claudePanel,
        "Update the hero copy in src/components/Hero.astro to lead with the worktree dashboard and multi-agent story. Show me the diff before saving."
      );
      const devResponded = await waitForAgentResponse(claudePanel, page, claudeBaseline, {
        minWaitMs: 90_000,
        maxWaitMs: 240_000,
      });
      annotateAgentResponse(devResponded, "Claude (dev preview)", 240_000);

      // Open the dev preview panel. Reachability rather than a direct locator:
      // since #11667 `dev-server` is not a default toolbar button, so on this
      // scene's fresh profile it is reached through the panel tray — a direct
      // probe would silently skip the panel and produce a screenshot of the
      // wrong scene.
      if (await isToolbarButtonReachable(page, SEL.toolbar.openDevPreview, T_MEDIUM)) {
        await openDevPreview(page);
      }

      // Wait for the panel to reach a "Running" state if possible — gracefully
      // capture what we can if the runner can't bind a port, but annotate the
      // stall so a screenshot of an idle preview is flagged rather than passing
      // off as "dev preview live".
      const consoleBar = page.locator('[aria-controls^="console-drawer-"]').locator("..");
      const statusBadge = consoleBar.locator('[role="status"]').first();
      const devServerRunning = await statusBadge
        .filter({ hasText: /Running|Listening|Live/i })
        .waitFor({ state: "visible", timeout: T_LONG })
        .then(() => true)
        .catch(() => false);
      if (!devServerRunning) {
        test.info().annotations.push({
          type: "dev-server-not-running",
          description: "Dev server never reached Running state — preview may be idle in capture",
        });
      }

      await settleFrame(page);
      await dismissBlockingPalette(page);
      await snap(page, "03-dev-preview-daintree-site");
    } finally {
      if (captured) await teardown(captured.ctx);
      repo.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scene 4 — 🚀 launchpad-analytics : Action palette open
  // -------------------------------------------------------------------------
  test("scene-4-action-palette-launchpad-analytics", async () => {
    const repo = createLaunchpadAnalyticsRepo();
    let captured: CaptureContext | undefined;
    try {
      captured = await bootProject(repo, {
        displayName: "Launchpad Analytics",
        emoji: "🚀",
      });
      const { page } = captured;

      // Summon the action palette. Double-Shift is the standard binding.
      await page.keyboard.press("Shift");
      await page.keyboard.press("Shift");
      const palette = page.locator(SEL.actionPalette.dialog);
      const opened = await palette.isVisible({ timeout: T_SHORT }).catch(() => false);
      if (!opened) {
        // Fallback to Cmd/Ctrl+K if double-Shift didn't fire (CI input quirks).
        await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
      }
      await expect(palette).toBeVisible({ timeout: T_LONG });

      // Filter to Daintree-specific actions rather than generic GitHub
      // commands — communicates what's unique about this app.
      await page.locator(SEL.actionPalette.searchInput).fill("claude");
      // Wait for results to actually render so the capture isn't an empty list.
      await expect(page.locator(SEL.actionPalette.options).first()).toBeVisible({
        timeout: T_MEDIUM,
      });
      await page.waitForTimeout(T_SETTLE);

      await snap(page, "04-action-palette-launchpad");
    } finally {
      if (captured) await teardown(captured.ctx);
      repo.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scene 5 — 🛰️ orbital-sync : Multi-agent (Claude + OpenCode)
  // -------------------------------------------------------------------------
  test("scene-5-multi-agent-orbital-sync", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "ANTHROPIC_API_KEY is required for the multi-agent scene",
    });

    test.skip(!hasClaudeApiKey(), "ANTHROPIC_API_KEY is required for the multi-agent scene");

    const repo = createOrbitalSyncRepo();
    let captured: CaptureContext | undefined;
    try {
      captured = await bootProject(repo, {
        displayName: "Orbital Sync",
        emoji: "🛰️",
      });
      const { ctx, page } = captured;

      const claudePanel = await launchClaude(ctx.app, page);
      await waitForAgentReady(claudePanel, page);

      const opencodePanel = await launchOpenCode(page);
      await waitForAgentReady(
        opencodePanel,
        page,
        [/ask anything/i, /build\s+opencode/i, /\d+\.\d+\.\d+$/m],
        { kind: "opencode" }
      );

      // Drive both agents in parallel-ish — Claude on the implementation,
      // OpenCode on the tests. They'll run for tens of seconds each; we
      // shoot during the working window.
      const claudeBaseline = await getTerminalText(claudePanel).catch(() => "");
      await sendPrompt(
        page,
        claudePanel,
        "In src/retry/policy.ts, add a circuit-breaker that trips after 5 consecutive failures. Outline the API first."
      );

      const opencodeBaseline = await getTerminalText(opencodePanel).catch(() => "");
      await sendPrompt(
        page,
        opencodePanel,
        "Write vitest tests for src/retry/backoff.ts. Cover the jitter range and the 30s cap."
      );

      // Both agents are running by now — wait for each to start streaming.
      // 180s upper bound per agent on Windows cold launches.
      const claudeResponded = await waitForAgentResponse(claudePanel, page, claudeBaseline, {
        minWaitMs: 90_000,
        maxWaitMs: 240_000,
      });
      annotateAgentResponse(claudeResponded, "Claude (multi-agent)", 240_000);
      const opencodeResponded = await waitForAgentResponse(opencodePanel, page, opencodeBaseline, {
        minWaitMs: 90_000,
        maxWaitMs: 240_000,
      });
      annotateAgentResponse(opencodeResponded, "OpenCode (multi-agent)", 240_000);

      await dismissBlockingPalette(page);
      await snap(page, "05-multi-agent-orbital-sync");
    } finally {
      if (captured) await teardown(captured.ctx);
      repo.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Scene 6 — 🍳 mise-en-place : Recipe library
  // -------------------------------------------------------------------------
  test("scene-6-agent-overview-mise-en-place", async () => {
    const repo = createMiseEnPlaceRepo();
    let captured: CaptureContext | undefined;
    try {
      captured = await bootProject(repo, {
        displayName: "Mise en Place",
        emoji: "🍳",
      });
      const { page } = captured;

      // Give the project view a moment to fully paint — paint-gate races
      // have been observed on cold Windows CI launches with no intervening
      // user action between project-open and the next interaction.
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await page.waitForTimeout(T_SETTLE);

      // Open settings via keyboard shortcut. The toolbar button can be
      // hidden by paint-gate races on a cold launch — Ctrl+, works
      // regardless of toolbar visibility.
      await page.keyboard.press("Control+,");
      const settingsHeading = page.locator(SEL.settings.heading);
      // Fallback to click if the shortcut didn't fire. The click itself is NOT
      // swallowed — if the button exists but won't open settings the UI is
      // broken and the run should surface it.
      if (!(await settingsHeading.isVisible({ timeout: T_SHORT }).catch(() => false))) {
        const openSettings = page.locator(SEL.toolbar.openSettings);
        await openSettings.waitFor({ state: "visible", timeout: T_LONG });
        await openSettings.click({ timeout: T_LONG });
      }
      await expect(settingsHeading).toBeVisible({ timeout: T_LONG });
      const recipesTab = page.locator(SEL.projectSettings.recipesTab);
      if (await recipesTab.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await recipesTab.click();
      } else {
        test.info().annotations.push({
          type: "recipes-tab-missing",
          description: "Recipes tab not found — capturing default settings tab instead",
        });
      }

      await page.waitForTimeout(T_SETTLE);
      await snap(page, "06-agent-overview-mise-en-place");
    } finally {
      if (captured) await teardown(captured.ctx);
      repo.cleanup();
    }
  });

  // Hero asset scene removed — scene 1 doubles as the hero. Run-2 observed
  // page.screenshot timeouts on a 7th cold launch (resource exhaustion). 6
  // screenshots is also right in the Microsoft Store devtools sweet spot.
});
