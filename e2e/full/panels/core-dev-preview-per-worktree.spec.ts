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
 *     binds to it, and prints "http://localhost:{PORT}" — the upstream URL the
 *     service watches for. The panel address bar displays the stable
 *     `dp-*.localhost:{proxyPort}` proxy origin.
 *   - devServerCommand is set via IPC before any panels are opened so both
 *     panels auto-start without a page reload.
 */

import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount, getGridPanelIds, clickToolbarButton } from "../../helpers/panels";
import { saveCurrentProjectSettings } from "../../helpers/projectSettings";
import { switchWorktree } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const FEATURE_BRANCH = "feature/test-branch";
const DEV_PREVIEW_ADDRESS_BAR_RE = /^(?:https?:\/\/)?(?:localhost|dp-[a-z0-9-]+\.localhost):\d+$/;
const DEV_PREVIEW_PROXY_HOST_RE = /^(?:localhost|dp-[a-z0-9-]+\.localhost)$/;

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
let fixtureCleanup: (() => void) | undefined;
let featureWorktreeDir: string;

// Origins read from address bars during tests — shared across assertions.
let urlMain = "";
let urlFeature = "";
let upstreamUrlMain = "";
let upstreamUrlFeature = "";

// Worktree IDs resolved via IPC — used for getByWorktree assertions.
let mainWorktreeId = "";
let featureWorktreeId = "";

function parseDisplayOrigin(displayUrl: string): string {
  const parsed = new URL(displayUrl.includes("://") ? displayUrl : `http://${displayUrl}`);
  expect(parsed.protocol).toBe("http:");
  expect(parsed.hostname).toMatch(DEV_PREVIEW_PROXY_HOST_RE);
  expect(parsed.port).toMatch(/^\d+$/);
  return parsed.origin;
}

function parseUpstreamOrigin(predictedUrl: string | null | undefined): string {
  expect(predictedUrl).toBeTruthy();
  const parsed = new URL(predictedUrl ?? "");
  expect(parsed.protocol).toBe("http:");
  expect(parsed.hostname).toBe("localhost");
  expect(parsed.port).toMatch(/^\d+$/);
  return parsed.origin;
}

test.describe.serial("Core: Dev Preview — Per-Worktree Port Registry", () => {
  test.beforeAll(async () => {
    // Create a repo with a pre-built feature worktree.
    const { dir, cleanup } = createFixtureRepo({ name: "dev-preview-wt", withFeatureBranch: true });
    fixtureDir = dir;
    fixtureCleanup = cleanup;

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
    await saveCurrentProjectSettings(ctx.window, { devServerCommand: "node dev-server.cjs" });

    // Resolve the stable worktree IDs we'll use for IPC assertions later.
    // The workspace scanner discovers the feature worktree asynchronously, so
    // poll until both the main and feature worktrees are present before
    // capturing their IDs.
    const page = ctx.window;
    await expect
      .poll(
        async () => {
          const worktrees = await page.evaluate(() => window.electron.worktree.getAll());
          const mainWt = worktrees.find((w: { isMainWorktree?: boolean }) => w.isMainWorktree);
          const featureWt = worktrees.find((w: { branch?: string }) => w.branch === FEATURE_BRANCH);
          mainWorktreeId = mainWt?.id ?? "";
          featureWorktreeId = featureWt?.id ?? "";
          return Boolean(mainWorktreeId && featureWorktreeId);
        },
        { timeout: T_LONG }
      )
      .toBe(true);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Test 1 ─────────────────────────────────────────────────────────────────

  test("main-worktree panel reaches Running and shows a predictedUrl", async () => {
    const { window } = ctx;

    // Confirm we start on the main worktree (default view).
    const mainRow = window.locator(SEL.worktree.mainRow);
    await expect(mainRow).toHaveAttribute("aria-current", "true", { timeout: T_LONG });

    const countBefore = await getGridPanelCount(window);
    await clickToolbarButton(window, SEL.toolbar.openDevPreview, T_MEDIUM);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

    // Wait for the console bar's Running badge.
    // Scope to the first (only) console bar to avoid ambiguity.
    const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..").first();
    const statusBadge = consoleBar.locator('[role="status"]');
    await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

    // Read the address bar origin and store it for later comparison.
    // Note: the address bar displays a host-port form (for example,
    // "dp-*.localhost:43000") — protocol is stripped via getDisplayUrl().
    const addressBar = window.locator(SEL.browser.addressBar).first();
    await expect(addressBar).toHaveValue(DEV_PREVIEW_ADDRESS_BAR_RE, { timeout: T_MEDIUM });
    const displayUrl = (await addressBar.inputValue()).trim();
    urlMain = parseDisplayOrigin(displayUrl);
  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────

  test("feature-worktree panel reaches Running with a DIFFERENT port", async () => {
    const { window } = ctx;

    // Switch to the feature worktree — panels opened here inherit its ID.
    await switchWorktree(window, FEATURE_BRANCH);

    const idsBefore = await getGridPanelIds(window);
    await clickToolbarButton(window, SEL.toolbar.openDevPreview, T_MEDIUM);
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBe(idsBefore.length + 1);

    // Identify the newly-created panel by diffing IDs rather than relying on
    // DOM order, then scope all assertions to that panel.
    const idsAfter = await getGridPanelIds(window);
    const featurePanelId = idsAfter.find((id) => !idsBefore.includes(id));
    expect(featurePanelId).toBeTruthy();
    const featurePanel = window.locator(`[data-panel-id="${featurePanelId}"]`);

    // Wait for this panel's console bar to reach Running.
    const consoleBar = featurePanel.locator('[aria-controls^="console-drawer-"]').locator("..");
    const statusBadge = consoleBar.locator('[role="status"]');
    await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

    // Read the feature panel's URL.
    const addressBar = featurePanel.locator(SEL.browser.addressBar);
    await expect(addressBar).toHaveValue(DEV_PREVIEW_ADDRESS_BAR_RE, {
      timeout: T_MEDIUM,
    });
    const displayUrlFeature = (await addressBar.inputValue()).trim();
    urlFeature = parseDisplayOrigin(displayUrlFeature);

    // The two panels MUST have different stable origins. They may share the
    // same reverse-proxy port, so compare the whole origin, not just the port.
    expect(urlFeature).not.toBe(urlMain);
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────

  test("getByWorktree IPC returns the correct session for each worktree", async () => {
    const { window } = ctx;

    if (!mainWorktreeId || !featureWorktreeId) {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "Required element or state not available in this launch",
      });

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
    expect(mainSession?.worktreeId).toBe(mainWorktreeId);
    expect(featureSession?.worktreeId).toBe(featureWorktreeId);

    // The IPC session tracks the upstream localhost URL printed by the dev server.
    // The UI address bar uses the stable dev-preview proxy origin.
    upstreamUrlMain = parseUpstreamOrigin(mainSession?.predictedUrl);
    upstreamUrlFeature = parseUpstreamOrigin(featureSession?.predictedUrl);
    expect(upstreamUrlFeature).not.toBe(upstreamUrlMain);

    // Sanity: the two sessions must have different panel IDs.
    expect(mainSession?.panelId).not.toBe(featureSession?.panelId);
  });

  // ── Test 4 ─────────────────────────────────────────────────────────────────

  test("stopping feature-worktree panel leaves main-worktree session intact", async () => {
    const { window } = ctx;

    if (!mainWorktreeId || !featureWorktreeId) {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "Required element or state not available in this launch",
      });

      test.skip();
      return;
    }

    // Close the feature worktree panel (last grid panel) to stop its server.
    const panelsBefore = await getGridPanelIds(window);
    const featurePanelId = panelsBefore[panelsBefore.length - 1];
    if (!featurePanelId) {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "Required element or state not available in this launch",
      });

      test.skip();
      return;
    }

    const featurePanel = window.locator(`[data-panel-id="${featurePanelId}"]`);
    await featurePanel.locator(SEL.panel.close).click({ force: true });
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_MEDIUM })
      .toBe(panelsBefore.length - 1);

    // Feature worktree: stopByPanel deletes the session, so getByWorktree must
    // return null once the service finishes processing the panel-close event.
    await expect
      .poll(
        () =>
          window.evaluate(
            (id: string) => window.electron.devPreview.getByWorktree({ worktreeId: id }),
            featureWorktreeId
          ),
        { timeout: T_MEDIUM }
      )
      .toBeNull();

    // Main worktree: session untouched — still running with the same URL.
    const mainAfter = await window.evaluate(
      (id: string) => window.electron.devPreview.getByWorktree({ worktreeId: id }),
      mainWorktreeId
    );
    expect(mainAfter?.status).toBe("running");
    expect(mainAfter?.predictedUrl).toBe(upstreamUrlMain);
  });
});
