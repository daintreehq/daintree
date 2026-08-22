/**
 * Documentation screenshots — Dev Preview.
 *
 * The preview runs the daintree.org site itself. That is deliberate: a preview
 * pane showing a real page is the whole claim of the feature, and a fixture
 * page would photograph as a placeholder.
 *
 * The site is opened from a detached git worktree under the demo root, with
 * `node_modules` symlinked from the working checkout, so the capture neither
 * dirties the repository nor pays for an install. Set DAINTREE_DOCS_SITE to
 * point somewhere else.
 *
 * One scene, strictly serial: the dev server costs more to start than every
 * other shot in the suite put together, so all three states ride one boot.
 *
 * The guest is a `<webview>`, not a WebContentsView, so it composites into the
 * host page and a normal page screenshot captures the rendered site. The
 * marketing reel's blank preview pane was a readiness bug, not a limit of the
 * capture: it waited for the panel, not for the page.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, rmSync } from "fs";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays, POLISH_CSS } from "../helpers/docsCapture";
import { bootDocsApp, DIALOG_PAD } from "../helpers/docsBoot";
import { openDevPreview } from "../helpers/panels";
import { saveCurrentProjectSettings } from "../helpers/projectSettings";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("dev-preview");

const SITE_DIR = process.env.DAINTREE_DOCS_SITE ?? `${DOCS_DEMO_ROOT}/daintree-site`;

/** Wait until the embedded guest has actually painted the site. */
async function waitForGuest(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const view = document.querySelector("webview") as
            | (HTMLElement & { getURL?: () => string })
            | null;
          if (!view) return "no-webview";
          const src = view.getAttribute("src") ?? "";
          const url = typeof view.getURL === "function" ? view.getURL() : "";
          return url || src || "blank";
        }),
      { timeout: 120_000, intervals: [1000, 2000] }
    )
    .toMatch(/^https?:\/\//);
  // The URL resolves the moment navigation starts. Give the site a beat to
  // lay out — a screenshot taken on first paint is a white rectangle, which
  // is exactly how the marketing capture of this pane shipped empty.
  await page.waitForTimeout(6_000);
}

test.describe.serial("Documentation Screenshots — Dev Preview", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  test("scene-d1-dev-preview", async () => {
    test.skip(
      !existsSync(SITE_DIR),
      `no site checkout at ${SITE_DIR} — create one with \`git worktree add\` and link node_modules`
    );

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: SITE_DIR,
        displayName: "Daintree Site",
        emoji: "🌴",
        windowSize: { width: 1440, height: 900 },
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      // Dev Preview has no command detection — it reads
      // `projectSettings.devServerCommand` and starts nothing without one.
      //
      // `--host 127.0.0.1` is load-bearing. Vite binds `[::1]` by default, so
      // an IPv4 connection to the dev server is refused, the dev-preview proxy
      // gets nothing, and the pane paints white while the status pill still
      // reads RUNNING. That is exactly how the marketing capture of this
      // surface shipped blank.
      await saveCurrentProjectSettings(page, {
        devServerCommand: "npm run dev -- --host 127.0.0.1",
      } as never);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await page.waitForTimeout(T_MEDIUM);

      await cap.shot("dev-preview/dev-preview-running", async () => {
        await resetOverlays(page);
        // Must go through the helper: browser and dev-server panels left the
        // default toolbar, so on a fresh profile they exist only in the tray.
        await openDevPreview(page);
        await waitForGuest(page);
        await cap.requireSurface(page, "webview", "dev preview guest");
        await cap.snapWindow(page, "dev-preview/dev-preview-running");
      });

      await cap.shot("dev-preview/tools/dev-preview-device-emulation", async () => {
        // The viewport control is a toolbar button on the panel itself.
        const viewport = page
          .locator('[aria-label*="viewport" i], [aria-label*="device" i]')
          .first();
        await expect(viewport).toBeVisible({ timeout: T_LONG });
        await viewport.click();
        // The preset list names real devices; take whichever iPhone is
        // offered rather than pinning a model number that moves every year.
        const preset = page
          .locator('[role="menuitem"], [role="option"], button')
          .filter({ hasText: /iPhone/ })
          .first();
        await expect(preset).toBeVisible({ timeout: T_LONG });
        await preset.click();
        // Changing the preset swaps the user agent, which reloads the guest.
        // Eight seconds was not enough — the frame photographed with only the
        // site header painted and a fragment of the hero spilling outside it.
        // Wait for the reload to settle the same way the first shot does.
        await waitForGuest(page);
        await page.waitForTimeout(6_000);
        await cap.snapWindow(page, "dev-preview/tools/dev-preview-device-emulation");
      });

      await cap.shot("dev-preview/tools/dev-preview-diagnostics-tab", async () => {
        await page.locator(SEL.devPreview.consoleToggle).first().click();
        const tab = page
          .locator('[role="tab"]')
          .filter({ hasText: /Diagnostics/i })
          .first();
        await expect(tab).toBeVisible({ timeout: T_LONG });
        await tab.click();
        await page.waitForTimeout(T_MEDIUM);
        const panel = page.locator(SEL.panel.gridPanel).first();
        const box = await panel.boundingBox();
        if (!box) throw new Error("dev preview panel has no layout");
        // Band the bottom of the panel: the drawer is the subject, and the
        // page above it is the same pixels as the previous shot.
        const height = Math.min(360, box.height);
        await cap.snapBand(page, "dev-preview/tools/dev-preview-diagnostics-tab", {
          x: box.x,
          y: box.y + box.height - height,
          width: box.width,
          height,
        });
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
