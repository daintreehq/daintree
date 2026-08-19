/**
 * Documentation screenshots for the Code Forge surfaces.
 *
 * Separate from `docs-shots.spec.ts` because the precondition is different in
 * kind: everything in that file is reachable offline, whereas an issues panel
 * with nothing in it documents nothing. These captures need a real GitHub
 * token and a real repository, so they are opt-in and self-skip without one.
 *
 *   DAINTREE_DOCS_GITHUB_TOKEN=$(gh auth token) \
 *     npx playwright test --project=screenshots e2e/screenshots/docs-forge.spec.ts
 *
 * The repository is `daintreehq/daintree` — Daintree's own public repo, so the
 * issues in the capture are the project's own and there is no third party's
 * data on screen. The working copy is still the `atlas-ledger` fixture: only
 * the `origin` URL points at GitHub, because that URL is all the forge
 * provider reads to identify a repository. Nothing opens, writes to, or
 * dirties a real checkout, and nothing is ever pushed.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import { launchApp, closeApp, mockOpenDialog, refreshActiveWindow, type AppContext } from "../helpers/launch";
import { dismissTelemetryConsent } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { connectGitHub } from "../helpers/githubHelpers";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachGithubOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";

const REPO_URL = "https://github.com/daintreehq/daintree.git";
const TOKEN = process.env.DAINTREE_DOCS_GITHUB_TOKEN ?? "";
const WINDOW_WIDTH = Number(process.env.DAINTREE_DOCS_WIDTH ?? 1280);
const WINDOW_HEIGHT = Number(process.env.DAINTREE_DOCS_HEIGHT ?? 820);
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "docs-screenshots");

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;
mkdirSync(OUTPUT_DIR, { recursive: true });

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

function outPath(slug: string): string {
  const file = path.join(OUTPUT_DIR, `${slug}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

async function settleFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
}

async function snapWindow(page: Page, slug: string): Promise<void> {
  await settleFrame(page);
  await page.screenshot({
    path: outPath(slug),
    type: "png",
    animations: "disabled",
    caret: "hide",
    timeout: 60_000,
  });
}

const captured: string[] = [];
const missed: Array<{ slug: string; reason: string }> = [];

async function shot(slug: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    captured.push(slug);
    // eslint-disable-next-line no-console
    console.log(`[docs-forge] captured ${slug}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    missed.push({ slug, reason });
    // eslint-disable-next-line no-console
    console.log(`[docs-forge] MISSED  ${slug} — ${reason}`);
  }
}

test.describe.serial("Documentation Screenshots — Code Forge", () => {
  test.afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(
      `[docs-forge] done — ${captured.length} captured, ${missed.length} missed\n` +
        missed.map((m) => `  - ${m.slug}: ${m.reason}`).join("\n")
    );
  });

  test("scene-e-forge", async () => {
    test.skip(
      !TOKEN,
      "DAINTREE_DOCS_GITHUB_TOKEN is required — the issues panel has nothing to show without it"
    );

    const repo = createAtlasLedgerRepo();
    attachGithubOrigin(repo, REPO_URL);
    let ctx: AppContext | undefined;
    try {
      ctx = await launchApp({
        screenshotScale: process.env.DAINTREE_SCREENSHOT_SCALE ?? "2",
        windowSize: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
        // The token seed hook only exists in fault mode.
        env: { DAINTREE_E2E_FAULT_MODE: "1" },
      });

      await mockOpenDialog(ctx.app, repo.dir);
      await ctx.window.getByRole("button", { name: "Open folder" }).click();

      let page = await refreshActiveWindow(ctx.app, ctx.window);
      await dismissTelemetryConsent(page);
      await dismissBlockingPalette(page);
      ctx.window = page;
      // Opening the project swaps the window again. Re-acquire before touching
      // it, or the first evaluate lands on a closed target.
      page = await refreshActiveWindow(ctx.app, page);
      ctx.window = page;
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});

      await page.evaluate(async () => {
        const current = await window.electron.project.getCurrent();
        if (!current?.id) return;
        await window.electron.project.update(current.id, { name: "Daintree", emoji: "🌳" });
      });

      page = await refreshActiveWindow(ctx.app, page);
      ctx.window = page;
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });

      // Seed the real token. `connectGitHub` skips validation and hydrates the
      // renderer store, so every forge surface treats the session as connected
      // — and the subsequent list calls are real requests against the real
      // repository.
      await connectGitHub(ctx.app, page, TOKEN);
      await page.waitForTimeout(T_MEDIUM);

      // --- The issues dropdown ---------------------------------------------
      await shot("code-forge/code-forge-issues-panel", async () => {
        const issuesPill = page.locator(SEL.github.statPillIssues).first();
        await expect(issuesPill).toBeVisible({ timeout: T_LONG });
        await issuesPill.click();
        const list = page.locator(SEL.github.listIssues);
        await expect(list).toBeVisible({ timeout: T_LONG });
        // Wait for rows, not just the shell — an empty panel mid-fetch is the
        // one state this screenshot must not capture.
        await expect
          .poll(() => list.locator('[data-testid^="github-item-"]').count(), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(3);
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "code-forge/code-forge-issues-panel");
      });

      // --- Bulk worktree creation from selected issues ----------------------
      await shot("code-forge/code-forge-bulk-create-dialog", async () => {
        const rows = page.locator(SEL.github.listIssues).locator('[data-testid^="github-item-"]');
        const n = Math.min(await rows.count(), 4);
        for (let i = 0; i < n; i++) {
          const row = rows.nth(i);
          await row.hover();
          await page.waitForTimeout(150);
          await row.click({ position: { x: 20, y: 20 } });
          await page.waitForTimeout(250);
        }
        const bulkBar = page.locator(SEL.github.bulkActionBar);
        await expect(bulkBar).toBeVisible({ timeout: T_MEDIUM });
        await page.locator(SEL.github.bulkCreateButton).click();
        const dialog = page.locator(SEL.github.bulkCreateDialog);
        await expect(dialog).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "code-forge/code-forge-bulk-create-dialog");
        await page.keyboard.press("Escape");
      });

      // --- Pull requests ----------------------------------------------------
      await shot("code-forge/code-forge-pull-requests-panel", async () => {
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(200);
        }
        const prPill = page.locator(SEL.github.statPillPrs).first();
        await expect(prPill).toBeVisible({ timeout: T_MEDIUM });
        await prPill.click();
        const list = page.locator(SEL.github.listPrs);
        await expect(list).toBeVisible({ timeout: T_LONG });
        const merged = page.locator('button:has-text("Merged")').first();
        if (await merged.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await merged.click();
        }
        await expect
          .poll(() => list.locator('[data-testid^="github-item-"]').count(), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(3);
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "code-forge/code-forge-pull-requests-panel");
        await page.keyboard.press("Escape");
      });

      // --- Settings > Code Forge > General ----------------------------------
      await shot("code-forge/code-forge-general-routing", async () => {
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(200);
        }
        // Escape alone left the dropdown's backdrop swallowing the next click.
        await page.mouse.click(WINDOW_WIDTH / 2, WINDOW_HEIGHT - 60);
        await page.waitForTimeout(T_SHORT);
        await page.locator(SEL.toolbar.openSettings).click();
        await expect(page.locator(SEL.settings.heading)).toBeVisible({ timeout: T_LONG });
        const tab = page.locator('.settings-sidebar button:has-text("Code Forge")').first();
        await expect(tab).toBeVisible({ timeout: T_MEDIUM });
        await tab.click();
        await page.waitForTimeout(T_MEDIUM);
        await snapWindow(page, "code-forge/code-forge-general-routing");
      });
    } finally {
      if (ctx) {
        try {
          await closeApp(ctx.app);
        } catch {
          // best-effort
        }
      }
      repo.cleanup();
    }
  });
});
