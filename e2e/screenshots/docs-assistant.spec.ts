/**
 * Documentation screenshots — the Daintree Assistant panel.
 *
 * The Assistant's conversation is a PTY running an external CLI that talks to
 * a hosted backend, so there is nothing to photograph offline until something
 * plays that part. `installFakeAssistant` writes a `daintree-assistant` binary
 * onto the same PATH prepend the fake agents use; from Daintree's side it is
 * indistinguishable from the real one, because every surface in these two
 * shots is driven by a mechanism the fake actually exercises:
 *
 *  - the header state indicator, off OSC 9;4 heartbeats through the same
 *    ActivityMonitor → AgentStateService chain as any agent pane;
 *  - the footer activity strip, off real MCP dispatches made with the bearer
 *    Daintree injects into the CLI's environment;
 *  - the figure rail, off real `help.displayImage` calls, whose thumbnails the
 *    renderer fetches from daintree.org. That last one needs network.
 *
 * Two timing rules from the strip decide when the shutter can fall: an
 * in-flight row is withheld for 400ms, and a settled *success* decays back to
 * "Recent activity" after 5s. So the fake keeps calling, and the shot is taken
 * against a live row rather than a remembered one.
 */

import { test, expect, type Page } from "@playwright/test";
import { rmSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays } from "../helpers/docsCapture";
import { bootDocsApp } from "../helpers/docsBoot";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { installFakeAssistant } from "../helpers/fakeAssistant";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("assistant");

/** Two images the docs site really serves, so the rail has something to draw. */
const FIGURES = [
  {
    url: "https://daintree.org/docs/worktrees/cards/worktrees-row-status-signals.png",
    caption: "A worktree card's row status signals",
  },
  {
    url: "https://daintree.org/docs/review-hub/review-hub-working-tree.png",
    caption: "The Review Hub the card opens",
  },
];

/**
 * The panel is always mounted — when closed it is slid off-canvas by a
 * transform, so `toBeVisible()` passes on a panel nobody can see. `inert` is
 * the honest signal.
 */
const PANEL_OPEN = "#daintree-assistant-panel:not([inert])";

/**
 * Seed the persisted panel store before the renderer reads it.
 *
 * `preferredAgentId` is what points the launcher at our fake binary, and it
 * survives rehydration because the registry lists `daintree-assistant` as a
 * stable assistant agent — no CLI has to exist yet for that check to pass.
 * `introDismissed` keeps the Shift+Enter tip banner out of the frame.
 */
async function seedPanelPrefs(page: Page, width: number): Promise<void> {
  await page.evaluate((w) => {
    localStorage.setItem(
      "help-panel-storage",
      JSON.stringify({
        state: {
          width: w,
          preferredAgentId: "daintree-assistant",
          autoLaunchEnabled: false,
          introDismissed: true,
          hibernateSessions: {},
        },
        version: 5,
      })
    );
  }, width);
}

/** Launch the assistant into the panel and wait for the PTY to be live. */
async function startAssistant(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__daintreeDispatchAction?.(
      "help.launchAgent",
      { agentId: "daintree-assistant" },
      { source: "user" }
    );
  });
  await expect(page.locator(PANEL_OPEN)).toBeVisible({ timeout: T_LONG * 2 });
  // The footer only mounts once there is a terminal, and the activity strip
  // only renders once there is a session — so the strip's own trigger is the
  // single gate that means "the CLI is up and talking MCP".
  await expect(page.getByRole("button", { name: "Recent tool calls" })).toBeVisible({
    timeout: T_LONG * 3,
  });
}

test.describe.serial("Documentation Screenshots — Assistant", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  test("scene-a1-assistant", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    const binDir = installFakeAgent(path.dirname(repo.dir));

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      // ---------------------------------------------------------------------
      // The panel itself — no figures, so the rail stays out of the frame and
      // the shot is about the conversation, the header and the footer.
      // ---------------------------------------------------------------------
      installFakeAssistant(binDir);

      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        env: fakeAgentEnv(binDir),
        // Wide enough that the pushed-over grid is still legible beside a
        // roomy panel — the push, not the panel alone, is the point.
        windowSize: { width: 1600, height: 1000 },
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await seedPanelPrefs(page, 560);
      await page.evaluate(async () => {
        // A panel hidden for five minutes has its PTY killed; a capture run is
        // slower than a spec and this scene keeps one alive across two shots.
        await window.electron.helpAssistant.setSettings({ idleHibernateMinutes: 0 } as never);
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await page.waitForTimeout(T_MEDIUM);

      await cap.shot("daintree-assistant/daintree-assistant-panel", async () => {
        await resetOverlays(page);
        await startAssistant(page);
        // Let the scripted exchange print and the first tool call settle, but
        // stay inside the strip's 5s success decay so it is showing a result
        // rather than having fallen back to "Recent activity".
        await page.waitForTimeout(2_500);
        await cap.requireSurface(
          page,
          '[data-testid="assistant-header-state-indicator"]',
          "assistant header state indicator"
        );
        await cap.snapWindow(page, "daintree-assistant/daintree-assistant-panel");
      });

      // ---------------------------------------------------------------------
      // The figure rail. It needs a *second* session, because figures are
      // pinned per help session and the first one was launched by a fake with
      // no figures configured.
      // ---------------------------------------------------------------------
      await cap.shot("daintree-assistant/daintree-assistant-figure-rail", async () => {
        installFakeAssistant(binDir, { figures: FIGURES });
        // Shrink the window for this one. The rail is pinned above the footer
        // at the panel's foot, so a tall window puts half a screen of empty
        // terminal between the reply and the thumbnails it references — which
        // is the one relationship the shot exists to show.
        await ctx!.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.setSize(1600, 760);
          win?.center();
        });
        await page.waitForTimeout(T_MEDIUM);
        // A new session clears the figure counter and the store's figures, so
        // the rail starts empty and fills from these calls alone.
        await page.evaluate(() => {
          window.__daintreeDispatchAction?.(
            "help.launchAgent",
            { agentId: "daintree-assistant" },
            { source: "user" }
          );
        });
        const rail = page.locator('[data-testid="figure-rail"]');
        await expect(rail).toBeVisible({ timeout: T_LONG * 3 });
        await expect(rail.locator('[data-testid="figure-thumbnail"]')).toHaveCount(FIGURES.length, {
          timeout: T_LONG * 2,
        });
        // A thumbnail paints only on the image's own load event, and a
        // half-drawn rail is exactly the shot not worth having.
        await expect(rail.getByText("image #2")).toBeVisible({ timeout: T_LONG * 2 });
        await page.waitForTimeout(T_SHORT);
        const panel = page.locator("#daintree-assistant-panel");
        await cap.snapElement(page, panel, "daintree-assistant/daintree-assistant-figure-rail", 0);
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
