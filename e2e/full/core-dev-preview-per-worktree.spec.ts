/**
 * E2E tests for the per-worktree dev server port registry.
 *
 * Coverage:
 *   1. Two dev preview panels opened on different worktrees receive different
 *      ports — they run concurrently without collision.
 *   2. The IPC getByWorktree channel returns the correct session for each
 *      worktree ID, confirming the full stack (preload → handler → service).
 *   3. Stopping one worktree's dev server does not affect the other.
 *
 * Design notes:
 *   - Uses a real Electron app with a real fixture git repo + worktree.
 *   - dev-server.cjs reads PORT from the env injected by DevPreviewSessionService,
 *     binds to it, and prints "http://localhost:{PORT}" — the standard URL
 *     detection pattern the service watches for.
 *   - devServerCommand is set via IPC before any panels are opened so both
 *     panels auto-start without a page reload.
 */

import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount, getGridPanelIds } from "../helpers/panels";
import { switchWorktree } from "../helpers/workflows";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../helpers/timeouts";

const FEATURE_BRANCH = "feature/test-branch";

/** Minimal HTTP server that binds to the PORT env var and prints its URL. */
const DEV_SERVER_SCRIPT = `
const http = require('http');
const port = parseInt(process.env.PORT || '0', 10);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body><h1>Worktree Dev Server</h1></body></html>');
});
server.listen(port, '127.0.0.1', () => {
  console.log('http://localhost:' + server.address().port);
});
`;

let ctx: AppContext;
let fixtureDir: string;
let featureWorktreeDir: string;

// URLs read from address bars during tests — shared across assertions.
let urlMain = "";
let urlFeature = "";

// Worktree IDs resolved via IPC — used for getByWorktree assertions.
let mainWorktreeId = "";
let featureWorktreeId = "";

test.describe.serial("Core: Dev Preview — Per-Worktree Port Registry", () => {
  test.beforeAll(async () => {
    // Create a repo with a pre-built feature worktree.
    fixtureDir = createFixtureRepo({ name: "dev-preview-wt", withFeatureBranch: true });

    // Derive the worktree path created by createFixtureRepo.
    featureWorktreeDir = path.join(
      path.dirname(fixtureDir),
      path.basename(fixtureDir) + "-worktrees",
      "feature-test-branch"
    );

    // Write the dev server script to both tree roots so `node dev-server.cjs`
    // works regardless of which worktree the panel's CWD points to.
    writeFileSync(path.join(fixtureDir, "dev-server.cjs"), DEV_SERVER_SCRIPT);
    writeFileSync(path.join(featureWorktreeDir, "dev-server.cjs"), DEV_SERVER_SCRIPT);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Dev Preview Worktree Test"
    );

    // Set the project-level devServerCommand BEFORE opening any panels so
    // both panels auto-start on open (no reload required).
    await ctx.window.evaluate(async () => {
      const current = await window.electron.project.getCurrent();
      if (!current?.id) return;
      const settings = await window.electron.project.getSettings(current.id);
      await window.electron.project.saveSettings(current.id, {
        ...settings,
        devServerCommand: "node dev-server.cjs",
      });
    });

    // Resolve the stable worktree IDs we'll use for IPC assertions later.
    const worktrees = await ctx.window.evaluate(() => window.electron.worktree.getAll());
    const mainWt = worktrees.find((w: { isMainWorktree?: boolean }) => w.isMainWorktree);
    const featureWt = worktrees.find((w: { branch?: string }) => w.branch === FEATURE_BRANCH);

    mainWorktreeId = mainWt?.id ?? "";
    featureWorktreeId = featureWt?.id ?? "";
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Test 1 ─────────────────────────────────────────────────────────────────

  test("main-worktree panel reaches Running and shows an assignedUrl", async () => {
    const { window } = ctx;

    // Confirm we start on the main worktree (default view).
    const mainCard = window.locator(SEL.worktree.mainCard);
    await expect(mainCard).toHaveAttribute("aria-label", /selected/, { timeout: T_LONG });

    const devBtn = window.locator(SEL.toolbar.openDevPreview);
    if (!(await devBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    const countBefore = await getGridPanelCount(window);
    await devBtn.click();
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

    // Wait for the console bar's Running badge.
    // Scope to the first (only) console bar to avoid ambiguity.
    const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..").first();
    const statusBadge = consoleBar.locator('[role="status"]');
    await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

    // Read the address bar URL and store for later comparison.
    // Note: the address bar displays a host-port form (e.g. "localhost:7514")
    // — protocol is stripped via getDisplayUrl(). Reconstruct the canonical
    // URL so it matches the IPC `assignedUrl` shape later.
    const addressBar = window.locator(SEL.browser.addressBar).first();
    await expect(addressBar).toHaveValue(/localhost:\d+/, { timeout: T_MEDIUM });
    const displayUrl = (await addressBar.inputValue()).trim();
    expect(displayUrl).toMatch(/^localhost:\d+$/);
    urlMain = displayUrl.startsWith("http") ? displayUrl : `http://${displayUrl}`;
    expect(urlMain).toMatch(/^http:\/\/localhost:\d+$/);
  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────

  test("feature-worktree panel reaches Running with a DIFFERENT port", async () => {
    const { window } = ctx;

    // Switch to the feature worktree — panels opened here inherit its ID.
    await switchWorktree(window, FEATURE_BRANCH);

    const devBtn = window.locator(SEL.toolbar.openDevPreview);
    if (!(await devBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    const countBefore = await getGridPanelCount(window);
    await devBtn.click();
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

    // Wait for the SECOND (newest) console bar to reach Running.
    const consoleBars = window.locator('[aria-controls^="console-drawer-"]').locator("..");
    const newestBar = consoleBars.last();
    const statusBadge = newestBar.locator('[role="status"]');
    await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

    // Read the feature panel's URL.
    const addressBars = window.locator(SEL.browser.addressBar);
    await expect(addressBars.last()).toHaveValue(/localhost:\d+/, { timeout: T_MEDIUM });
    const displayUrlFeature = (await addressBars.last().inputValue()).trim();
    expect(displayUrlFeature).toMatch(/^localhost:\d+$/);
    urlFeature = displayUrlFeature.startsWith("http")
      ? displayUrlFeature
      : `http://${displayUrlFeature}`;
    expect(urlFeature).toMatch(/^http:\/\/localhost:\d+$/);

    // The two panels MUST be on different ports.
    expect(urlFeature).not.toBe(urlMain);
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────

  test("getByWorktree IPC returns the correct session for each worktree", async () => {
    const { window } = ctx;

    if (!mainWorktreeId || !featureWorktreeId) {
      test.skip();
      return;
    }

    // Resolve both sessions through the full IPC stack.
    const mainSession = await window.evaluate(
      (id: string) => window.electron.devPreview.getByWorktree({ worktreeId: id }),
      mainWorktreeId
    );
    const featureSession = await window.evaluate(
      (id: string) => window.electron.devPreview.getByWorktree({ worktreeId: id }),
      featureWorktreeId
    );

    // Both sessions must be running.
    expect(mainSession?.status).toBe("running");
    expect(featureSession?.status).toBe("running");

    // Each session's assignedUrl must match what we observed in the address bar.
    expect(mainSession?.assignedUrl).toBe(urlMain);
    expect(featureSession?.assignedUrl).toBe(urlFeature);

    // Sanity: the two sessions must have different panel IDs.
    expect(mainSession?.panelId).not.toBe(featureSession?.panelId);
  });

  // ── Test 4 ─────────────────────────────────────────────────────────────────

  test("stopping feature-worktree panel leaves main-worktree session intact", async () => {
    const { window } = ctx;

    if (!mainWorktreeId || !featureWorktreeId) {
      test.skip();
      return;
    }

    // Close the feature worktree panel (last grid panel) to stop its server.
    const panelsBefore = await getGridPanelIds(window);
    const featurePanelId = panelsBefore[panelsBefore.length - 1];
    if (!featurePanelId) {
      test.skip();
      return;
    }

    const featurePanel = window.locator(`[data-panel-id="${featurePanelId}"]`);
    await featurePanel.locator(SEL.panel.close).click({ force: true });
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_MEDIUM })
      .toBe(panelsBefore.length - 1);

    // Allow the service a moment to process the stopByPanel.
    await window.waitForTimeout(500);

    // Feature worktree: session gone (null) or explicitly stopped.
    const featureAfter = await window.evaluate(
      (id: string) => window.electron.devPreview.getByWorktree({ worktreeId: id }),
      featureWorktreeId
    );
    // stopByPanel deletes the session, so getByWorktree must return null.
    expect(featureAfter).toBeNull();

    // Main worktree: session untouched — still running with the same URL.
    const mainAfter = await window.evaluate(
      (id: string) => window.electron.devPreview.getByWorktree({ worktreeId: id }),
      mainWorktreeId
    );
    expect(mainAfter?.status).toBe("running");
    expect(mainAfter?.assignedUrl).toBe(urlMain);
  });
});
