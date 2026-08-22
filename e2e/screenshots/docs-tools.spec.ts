/**
 * Documentation screenshots — CopyTree, keyboard surfaces, notifications and
 * the Assistant's security settings.
 *
 * Grouped by launch cost rather than by docs page: none of these needs an
 * agent, a remote or a seeded profile, so they all ride one app. The one
 * exception is CopyTree's recents list, which is read fresh from a per-project
 * JSON file — that has to be on disk before the panel first mounts.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays, POLISH_CSS } from "../helpers/docsCapture";
import { bootDocsApp, DOCS_WINDOW_WIDE, DOCS_WINDOW_TALL, DIALOG_PAD } from "../helpers/docsBoot";
import { injectHistoryEntry } from "../helpers/notifications";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("tools");

async function dispatch(page: Page, id: string, payload?: unknown): Promise<void> {
  await page.evaluate(
    async (args) => {
      const fn = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            payload: unknown,
            opts: { source: string }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (!fn) throw new Error("action dispatch bridge unavailable");
      await fn(args.id, args.payload, { source: "user" });
    },
    { id, payload }
  );
  await page.waitForTimeout(T_SHORT);
}

/**
 * Recent CopyTree runs, written straight to the per-project history file.
 *
 * The panel reads this file fresh on every open — there is no append IPC, and
 * no in-memory cache to invalidate. Seeding is also the only way to get varied
 * ages: runs actually performed during a capture all read "just now", and a
 * list of five identical timestamps is not what the page is describing.
 */
function seedCopyTreeHistory(userDataDir: string, projectId: string, worktreeId: string): void {
  const now = Date.now();
  const dir = path.join(userDataDir, "projects", projectId);
  mkdirSync(dir, { recursive: true });
  const record = (
    id: string,
    name: string,
    options: Record<string, unknown>,
    fileCount: number,
    totalSize: number,
    ageMs: number,
    runCount: number
  ) => ({
    id,
    dedupeKey: id,
    name,
    options,
    source: "toolbar",
    worktreeId,
    stats: { fileCount, totalSize, duration: 380 + fileCount },
    createdAt: now - ageMs - 86_400_000,
    lastUsedAt: now - ageMs,
    runCount,
  });
  writeFileSync(
    path.join(dir, "copy-tree-history.json"),
    JSON.stringify({
      _schemaVersion: 1,
      // Newest first: the renderer takes the first five as given and trusts
      // main's ordering.
      records: [
        record("ct-1", "Full context", {}, 128, 486_112, 8 * 60_000, 6),
        record("ct-2", "src/journal", { scopePaths: ["src/journal"] }, 24, 71_400, 2 * 3_600_000, 3),
        record("ct-3", "Modified files", { modified: true }, 6, 18_240, 26 * 3_600_000, 11),
        record("ct-4", "*.test.ts", { filter: ["*.test.ts"] }, 19, 52_900, 3 * 86_400_000, 2),
        record("ct-5", "Changed since main", { changed: "main" }, 11, 34_100, 6 * 86_400_000, 1),
      ],
    })
  );
}

test.describe.serial("Documentation Screenshots — Tools", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  test("scene-x1-tools", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        windowSize: DOCS_WINDOW_TALL,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      // ----------------------------------------------------------------------
      // CopyTree recents — seed, reload, then open the dropdown.
      // ----------------------------------------------------------------------
      await cap.shot("copytree/copytree-recents-dropdown", async () => {
        const ids = await page.evaluate(async () => {
          const project = await window.electron.project.getCurrent();
          return { projectId: project?.id ?? "", projectPath: project?.path ?? "" };
        });
        if (!ids.projectId) throw new Error("no current project");
        seedCopyTreeHistory(profile, ids.projectId, ids.projectPath);
        // The history store initialises once, on the panel's first mount.
        await page.reload({ waitUntil: "domcontentloaded" });
        await page
          .locator(SEL.toolbar.toggleSidebar)
          .waitFor({ state: "visible", timeout: T_LONG });
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await page.waitForTimeout(T_MEDIUM);

        await page.locator(SEL.toolbar.copyContext).click();
        const panel = page.locator("[data-copy-tree-panel]");
        await expect(panel).toBeVisible({ timeout: T_LONG });
        await expect(panel.locator("li").first()).toBeVisible({ timeout: T_MEDIUM });
        // The trigger keeps its tooltip while the pointer rests on it, and the
        // tooltip renders straight over the dropdown.
        await page.mouse.move(20, 400);
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(page, panel, "copytree/copytree-recents-dropdown", 40);
        await resetOverlays(page);
      });

      // ----------------------------------------------------------------------
      // CopyTree test config.
      // ----------------------------------------------------------------------
      await cap.shot("copytree/copytree-test-config-result", async () => {
        await resetOverlays(page);
        await dispatch(page, "app.settings.openTab", { tab: "project:context" });
        await expect(page.locator('h4:has-text("Test configuration")')).toBeVisible({
          timeout: T_LONG,
        });
        const btn = page.locator('button:has-text("Test config")').first();
        await expect(btn).toBeEnabled({ timeout: T_MEDIUM });
        await btn.click();
        const result = page
          .locator('[role="status"]')
          .filter({ hasText: /files would be included/ })
          .first();
        await expect(result).toBeVisible({ timeout: T_LONG });
        await result.scrollIntoViewIfNeeded();
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(page, result, "copytree/copytree-test-config-result", 24);
        await resetOverlays(page);
      });

      // ----------------------------------------------------------------------
      // Assistant security — blast radius.
      // ----------------------------------------------------------------------
      await cap.shot("daintree-assistant/daintree-assistant-blast-radius", async () => {
        await resetOverlays(page);
        await page.evaluate(async () => {
          await window.electron.helpAssistant.setSettings({ tier: "system" } as never);
        });
        await dispatch(page, "app.settings.openTab", { tab: "assistant" });
        // Do not gate on a "Security" heading: the section exists but is not an
        // h3, so the assertion failed on a panel that had rendered correctly.
        // The disclosure row is the thing the shot is of, so wait for that.
        const row = page
          .locator("button[aria-expanded]")
          .filter({ hasText: /actions allowed without prompting/ })
          .first();
        await expect(row).toBeVisible({ timeout: T_LONG });
        await row.scrollIntoViewIfNeeded();
        if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
        await expect(page.getByText("high blast radius").first()).toBeVisible({
          timeout: T_MEDIUM,
        });
        await page.waitForTimeout(T_SHORT);
        const card = row.locator("xpath=..");
        await cap.snapElement(
          page,
          card,
          "daintree-assistant/daintree-assistant-blast-radius",
          20
        );
        await resetOverlays(page);
      });

      // ----------------------------------------------------------------------
      // Keyboard: the reference dialog, then the command HUD.
      // ----------------------------------------------------------------------
      await cap.shot("keyboard-shortcuts/keyboard-shortcuts-reference-dialog", async () => {
        await resetOverlays(page);
        await page.keyboard.press("Meta+Slash");
        const dlg = page
          .locator('[role="dialog"]')
          .filter({ has: page.locator('input[aria-label="Search shortcuts"]') })
          .first();
        await expect(dlg).toBeVisible({ timeout: T_LONG });
        // "worktree" spans more than one category, so the grouping the page
        // describes is actually visible; a single-category query hides it.
        await dlg.locator('input[aria-label="Search shortcuts"]').fill("worktree");
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(
          page,
          dlg.locator("> div").first(),
          "keyboard-shortcuts/keyboard-shortcuts-reference-dialog",
          DIALOG_PAD
        );
        await page.keyboard.press("Escape");
      });

      await cap.shot("keyboard-shortcuts/keyboard-shortcuts-command-hud", async () => {
        await resetOverlays(page);
        await page.keyboard.press("Meta+KeyK");
        const hud = page.locator("[data-command-hud]");
        await expect(hud).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        const box = await hud.boundingBox();
        const size = await page.evaluate(() => ({
          w: window.innerWidth,
          h: window.innerHeight,
        }));
        if (!box) throw new Error("command HUD has no layout");
        // Full width, from a little above the HUD to the window's bottom edge.
        // The claim the shot has to support is that it is anchored to the
        // bottom of the window, which a tight crop of a centred panel cannot
        // show.
        const y = Math.max(0, box.y - 56);
        await cap.snapBand(page, "keyboard-shortcuts/keyboard-shortcuts-command-hud", {
          x: 0,
          y,
          width: size.w,
          height: size.h - y,
        });
        await page.keyboard.press("Escape");
      });

      // ----------------------------------------------------------------------
      // Notification gate summary.
      // ----------------------------------------------------------------------
      await cap.shot(
        "notifications-and-sound/delivery-focus-and-muting/notifications-and-sound-gate-summary",
        async () => {
          await resetOverlays(page);
          await dispatch(page, "app.settings.openTab", { tab: "notifications" });
          await page.waitForTimeout(T_MEDIUM);
          // Completed and Working pulse are already off by default; only
          // Waiting needs switching, and it has to go through the UI so the
          // renderer store mirrors it.
          // Non-fatal: the "Off:" line is a detail of the shot, not its
          // subject. If the toggle cannot be driven, the muted pill and the
          // pause menu are still worth capturing.
          const waiting = page.locator("#notif-waiting");
          if ((await waiting.getAttribute("data-state").catch(() => null)) === "checked") {
            await waiting.click({ timeout: 10_000 }).catch(() => {});
          }
          await resetOverlays(page);

          await injectHistoryEntry(page, {
            type: "success",
            title: "Agent finished",
            message: "feature/reconciliation · 2 files staged",
          } as never);
          await injectHistoryEntry(page, {
            type: "info",
            title: "Worktree created",
            message: "chore/dependency-bump",
          } as never);

          await page.locator(SEL.notifications.bellButton).click();
          const moon = page.locator('button[aria-label="Pause notifications"]');
          await expect(moon).toBeVisible({ timeout: T_LONG });
          // The "Muted until" pill only exists once something is muted, so the
          // menu has to be used before it can be photographed alongside it.
          await moon.click();
          await page.locator('[role="menuitem"]:has-text("For 1 hour")').click();
          await page.waitForTimeout(T_MEDIUM);
          // Muting can re-render the inbox closed. If it did, reopen it with
          // the bell — but only then: clicking the bell while the inbox is
          // still up toggles it shut, which is the same failure by the other
          // route.
          if (!(await moon.isVisible({ timeout: 1_000 }).catch(() => false))) {
            await page.locator(SEL.notifications.bellButton).click();
            await expect(moon).toBeVisible({ timeout: T_LONG });
          }
          await moon.click();
          await expect(page.locator('[role="menu"]:has-text("For 1 hour")')).toBeVisible({
            timeout: T_MEDIUM,
          });
          await page.waitForTimeout(T_SHORT);

          const bell = await page.locator(SEL.notifications.bellButton).boundingBox();
          const size = await page.evaluate(() => ({
            w: window.innerWidth,
            h: window.innerHeight,
          }));
          if (!bell) throw new Error("notification bell has no layout");
          // The inbox and the pause menu are two separate portals; no single
          // element contains both, so band off the trigger.
          const x = Math.max(0, bell.x - 430);
          await cap.snapBand(
            page,
            "notifications-and-sound/delivery-focus-and-muting/notifications-and-sound-gate-summary",
            {
              x,
              y: Math.max(0, bell.y - 10),
              width: Math.min(size.w - x, 540),
              height: Math.min(size.h - bell.y, 440),
            }
          );
          await resetOverlays(page);
        }
      );
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
