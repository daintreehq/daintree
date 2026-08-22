/**
 * Documentation screenshots — the empty-canvas launcher, the resume palette,
 * and a worktree's resource-environment popover.
 *
 * Grouped because two of the three are driven by the same seeded file: the
 * agent session journal. The launcher's resume line and the resume palette
 * both read it, and neither renders anything without it.
 */

import { test, expect, type Page } from "@playwright/test";
import { rmSync, writeFileSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays, POLISH_CSS } from "../helpers/docsCapture";
import { bootDocsApp, DIALOG_PAD } from "../helpers/docsBoot";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { launchDocsAgent, worktreeIdFor } from "../helpers/docsAgents";
import { writeResourceConfig, createWorktree } from "../helpers/resource-lifecycle";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("launcher");

/**
 * Closed agent sessions.
 *
 * Two rules decide what these render as. A record whose `projectId` does not
 * match the live project is filtered out entirely, so it is read from the app
 * rather than derived. And staleness is decided by `worktreeId`, not `cwd`: a
 * `worktreeId` that resolves to nothing in the live map is what earns the
 * "Worktree removed" badge, while a `null` one resolves from `cwd` and never
 * goes stale.
 */
function seedSessionJournal(userDataDir: string, projectId: string, repoDir: string): void {
  const now = Date.now();
  const wt = (branch: string) =>
    `${DOCS_DEMO_ROOT}/atlas-ledger-worktrees/${branch.replace(/\//g, "-")}`;
  const records = [
    { sessionId: "s-1", agentId: "claude", worktreeId: null, projectId,
      title: "Fix same-day statement ordering", savedAt: now - 22 * 60_000,
      agentModelId: "claude-sonnet-4-5", cwd: wt("feature/reconciliation"),
      branch: "feature/reconciliation" },
    { sessionId: "s-2", agentId: "codex", worktreeId: null, projectId,
      title: "Add a rounding-drift regression test", savedAt: now - 3 * 3_600_000,
      agentModelId: "gpt-5-codex", cwd: repoDir, branch: "main" },
    { sessionId: "s-3", agentId: "claude", worktreeId: null, projectId,
      title: "Draft the multi-currency migration", savedAt: now - 26 * 3_600_000,
      agentModelId: "claude-opus-4-1", cwd: wt("feature/multi-currency"),
      branch: "feature/multi-currency" },
    { sessionId: "s-4", agentId: "gemini", worktreeId: null, projectId,
      title: "Summarise the reconciliation spike", savedAt: now - 3 * 86_400_000,
      agentModelId: "gemini-2.5-pro", cwd: repoDir, branch: "main" },
    { sessionId: "s-5", agentId: "claude", worktreeId: null, projectId,
      title: "Audit the posting invariants", savedAt: now - 4 * 86_400_000,
      agentModelId: "claude-sonnet-4-5", cwd: wt("feature/reconciliation"),
      branch: "feature/reconciliation" },
    { sessionId: "s-6", agentId: "claude", worktreeId: "wt-experiment-removed", projectId,
      title: "Prototype the settlement queue", savedAt: now - 5 * 86_400_000,
      agentModelId: "claude-opus-4-1", cwd: wt("experiment") },
  ];
  writeFileSync(
    path.join(userDataDir, "agent-session-history.json"),
    JSON.stringify(records, null, 2)
  );
}

/** A global recipe, so the launcher's recipe section shows more than one scope. */
async function seedGlobalRecipe(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.electron.globalRecipes.addRecipe({
      id: "global-morning-sweep",
      name: "Morning sweep",
      createdAt: Date.UTC(2026, 4, 18, 8, 0),
      lastUsedAt: Date.UTC(2026, 5, 12, 8, 5),
      showInEmptyState: true,
      terminals: [
        {
          type: "claude",
          title: "Overnight diff",
          initialPrompt: "Summarise every commit on this branch since yesterday, then stop.",
          exitBehavior: "keep",
        },
        { type: "terminal", title: "Tests", command: "npm test", exitBehavior: "keep" },
      ],
    } as never);
  });
  await page.waitForTimeout(1_500);
}

test.describe.serial("Documentation Screenshots — Launcher", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  // ---------------------------------------------------------------------------
  // Scene L1 — the empty canvas and the resume palette
  // ---------------------------------------------------------------------------
  test("scene-l1-launcher", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    const binDir = installFakeAgent(path.dirname(repo.dir));

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        env: fakeAgentEnv(binDir),
        // The launcher column scrolls, and the rotating tip is last with a
        // top margin — below the fold at 820.
        windowSize: { width: 1280, height: 980 },
        reloadAfterBoot: true,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await seedGlobalRecipe(page);

      const projectId = await page.evaluate(async () => {
        const p = await window.electron.project.getCurrent();
        return p?.id ?? "";
      });
      if (!projectId) throw new Error("no current project");
      seedSessionJournal(profile, projectId, repo.dir);
      // The empty-grid resume line is already mounted and there is no watcher
      // on the journal, so it has to be re-read.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await page.waitForTimeout(T_MEDIUM);

      await cap.shot("recipes/launch-and-share/recipes-empty-canvas-launcher", async () => {
        await resetOverlays(page);
        // The rotating tip only renders once an agent has been launched at
        // least once in this project. Launch one and dock it: a docked panel
        // still counts, and the grid stays empty so the launcher stays up.
        const panelId = await launchDocsAgent(page, { name: "Reconciliation review" });
        const panel = page.locator(`[data-panel-id="${panelId}"]`);
        await panel.locator(SEL.panel.minimize).click();
        await expect(page.locator(SEL.panel.gridPanel)).toHaveCount(0, { timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.requireSurface(page, "text=Morning sweep", "launcher recipe section");
        await cap.snapWindow(page, "recipes/launch-and-share/recipes-empty-canvas-launcher");
      });

      await cap.shot(
        "session-management/resume-agents-and-history/session-management-resume-palette",
        async () => {
          await resetOverlays(page);
          await page.keyboard.press("Meta+KeyK");
          await page.keyboard.press("Meta+KeyR");
          const palette = page.locator('[role="dialog"][aria-label="Resume session"]').first();
          await expect(palette).toBeVisible({ timeout: T_LONG });
          // Prove the stale row landed: it is the one the page is about.
          await expect(palette.getByText(/Worktree removed/i).first()).toBeVisible({
            timeout: T_LONG,
          });
          await page.waitForTimeout(T_SHORT);
          await cap.snapElement(
            page,
            palette,
            "session-management/resume-agents-and-history/session-management-resume-palette",
            DIALOG_PAD
          );
          await page.keyboard.press("Escape");
        }
      );
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene L2 — a worktree's resource-environment popover
  // ---------------------------------------------------------------------------
  test("scene-l2-environment", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    // The docs page says this needs Docker. It does not: the shared helper
    // writes a resource lifecycle backed by a small node script, which is what
    // the app's own resource-ops suite runs against.
    writeResourceConfig(repo.dir);

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        windowSize: { width: 1280, height: 980 },
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await cap.shot("worktrees/remote-compute/worktrees-environment-popover", async () => {
        await resetOverlays(page);
        await createWorktree(page, "feature/sandbox-check");
        await page.waitForTimeout(T_LONG);

        // The trigger does not exist until the resource has reported a status
        // at least once. A fresh worktree has never been checked, which is why
        // the earlier version of this scene clicked a control that was really
        // the inert fallback icon — same corner of the card, no popover behind
        // it. Prime the state the fake lifecycle script reads, then ask for a
        // status explicitly rather than waiting out the 30s poll.
        writeFileSync(
          path.join(repo.dir, ".daintree", "resource-state.json"),
          JSON.stringify({ status: "running", endpoint: "https://sandbox-7f2a.fly.dev" })
        );
        const worktreeId = await worktreeIdFor(page, "feature/sandbox-check");
        await page.evaluate(
          (id) =>
            window.__daintreeDispatchAction?.(
              "worktree.resource.status",
              { worktreeId: id },
              { source: "user" }
            ),
          worktreeId
        );

        const card = page.locator(SEL.worktree.card("feature/sandbox-check")).first();
        // `data-resource-status` is the deterministic gate: the trigger cannot
        // be in the DOM before it flips.
        await expect
          .poll(() => card.getAttribute("data-resource-status"), { timeout: T_LONG * 3 })
          .toBe("running");
        await card.hover();
        await card.locator('[aria-label$="environment status"]').first().click();
        const popover = page
          .locator("[data-radix-popper-content-wrapper]")
          .filter({ hasText: "Check Status" })
          .last();
        await expect(popover).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(
          page,
          popover,
          "worktrees/remote-compute/worktrees-environment-popover",
          12
        );
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
