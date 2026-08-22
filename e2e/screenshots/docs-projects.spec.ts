/**
 * Documentation screenshots — projects, the switcher, Pulse and onboarding.
 *
 * Four scenes, split by what each needs rather than by docs page:
 *
 *  P1  first-run dialogs, which need a folder that is NOT a repository
 *  P2  Pulse, which needs months of backdated commit history
 *  P3  the switcher, which needs several registered projects and scratches
 *  P4  the empty-canvas launcher, which needs all five of its sections to
 *      have something to show at once
 */

import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import {
  createAtlasLedgerRepo,
  attachLocalOrigin,
  attachGithubOrigin,
  seedPulseHistory,
  backdateRootCommit,
  DOCS_DEMO_ROOT,
} from "../helpers/docsFixtures";
import { createCapture, resetOverlays, POLISH_CSS } from "../helpers/docsCapture";
import { bootDocsApp, DOCS_WINDOW_WIDE, DIALOG_PAD } from "../helpers/docsBoot";
import { activateE2EPlugin } from "../helpers/plugins";
import { createDemoRepo, type DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("projects");

async function dispatch(page: Page, id: string, payload?: unknown): Promise<void> {
  await page.evaluate(
    async (args) => {
      const fn = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            p: unknown,
            o: { source: string }
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
 * Replace the `forge:get-project-health` handler with a fixed snapshot.
 *
 * The health chips are the only part of the Pulse card that needs a forge, and
 * a real one needs a token and a network. Swapping the handler is the same
 * technique `githubHelpers.stubRepoStats` already uses for the toolbar counts.
 */
async function stubProjectHealth(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, payload) => {
      ipcMain.removeHandler(payload.channel);
      ipcMain.handle(payload.channel, async () => payload.response);
    },
    {
      channel: "forge:get-project-health",
      response: {
        hasRemote: true,
        loading: false,
        ciStatus: "success",
        issueCount: 12,
        prCount: 3,
        latestRelease: {
          tagName: "v3.1.0",
          publishedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
          url: "https://github.com/daintreehq/daintree/releases/tag/v3.1.0",
        },
        securityAlerts: { visible: false, count: 0 },
        mergeVelocity: { mergedCounts: { 60: 9, 120: 17, 180: 24 } },
        repoUrl: "https://github.com/daintreehq/daintree",
        lastUpdated: Date.now(),
      },
    }
  );
}

/**
 * Push a project-stats map straight into the renderer.
 *
 * Without one, a scratch row falls through to a dormant status the switcher
 * deliberately renders as nothing — so the section photographs as three names
 * and no status lines. The service only broadcasts when its own computed map
 * changes, so an injected map is not overwritten by the next poll.
 */
async function pushProjectStats(
  app: ElectronApplication,
  stats: Record<string, Record<string, unknown>>
): Promise<void> {
  await app.evaluate(({ webContents }, payload) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) {
        try {
          wc.send("project:stats-updated", payload);
        } catch {
          // A view mid-teardown is not worth failing a capture over.
        }
      }
    }
  }, stats);
}

const IDLE_STATS = {
  activeAgentCount: 0,
  waitingAgentCount: 0,
  blockedAgentCount: 0,
  processCount: 0,
  completedAgentCount: 0,
  unacknowledgedCompletedAgentCount: 0,
  snoozedAgentCount: 0,
};

/** Closed agent sessions, for the resume launcher and the launcher's resume line. */
function seedSessionJournal(
  userDataDir: string,
  projectId: string,
  repoDir: string
): void {
  const now = Date.now();
  const wtRecon = `${DOCS_DEMO_ROOT}/atlas-ledger-worktrees/feature-reconciliation`;
  const wtCurrency = `${DOCS_DEMO_ROOT}/atlas-ledger-worktrees/feature-multi-currency`;
  const records = [
    { sessionId: "s-1", agentId: "claude", worktreeId: null, projectId,
      title: "Fix same-day statement ordering", savedAt: now - 22 * 60_000,
      agentModelId: "claude-sonnet-4-5", cwd: wtRecon, branch: "feature/reconciliation" },
    { sessionId: "s-2", agentId: "codex", worktreeId: null, projectId,
      title: "Add a rounding-drift regression test", savedAt: now - 3 * 3_600_000,
      agentModelId: "gpt-5-codex", cwd: repoDir, branch: "main" },
    { sessionId: "s-3", agentId: "claude", worktreeId: null, projectId,
      title: "Draft the multi-currency migration", savedAt: now - 26 * 3_600_000,
      agentModelId: "claude-opus-4-1", cwd: wtCurrency, branch: "feature/multi-currency" },
    { sessionId: "s-4", agentId: "gemini", worktreeId: null, projectId,
      title: "Summarise the reconciliation spike", savedAt: now - 3 * 86_400_000,
      agentModelId: "gemini-2.5-pro", cwd: repoDir, branch: "main" },
    { sessionId: "s-5", agentId: "claude", worktreeId: null, projectId,
      title: "Audit the posting invariants", savedAt: now - 4 * 86_400_000,
      agentModelId: "claude-sonnet-4-5", cwd: wtRecon, branch: "feature/reconciliation" },
    // The greyed row. Staleness is decided by worktreeId, not by cwd: a
    // worktreeId that resolves to nothing in the live map is what earns the
    // "Worktree removed" badge.
    { sessionId: "s-6", agentId: "claude", worktreeId: "wt-experiment-removed", projectId,
      title: "Prototype the settlement queue", savedAt: now - 5 * 86_400_000,
      agentModelId: "claude-opus-4-1",
      cwd: `${DOCS_DEMO_ROOT}/atlas-ledger-worktrees/experiment` },
  ];
  writeFileSync(
    path.join(userDataDir, "agent-session-history.json"),
    JSON.stringify(records, null, 2)
  );
}

test.describe.serial("Documentation Screenshots — Projects", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  // ---------------------------------------------------------------------------
  // Scene P1 — the first-run dialogs
  // ---------------------------------------------------------------------------
  test("scene-p1-first-run", async () => {
    // A plain folder with no .git, under the demo root so the path in the
    // dialog reads like somewhere a person keeps work.
    const plain = path.join(DOCS_DEMO_ROOT, "sketchpad");
    rmSync(plain, { recursive: true, force: true });
    mkdirSync(path.join(plain, "notes"), { recursive: true });
    writeFileSync(path.join(plain, "notes", "ideas.md"), "# Ideas\n\n- ledger reconciliation\n");

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: plain,
        displayName: "Sketchpad",
        emoji: "🗒️",
        skipProjectOpen: true,
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      // One capture, two slugs: /docs/projects and /docs/getting-started both
      // ask for this dialog, and the no-duplicate-states rule says capture it
      // once and import it twice.
      const nonGit = async (slug: string) => {
        const dlg = page
          .locator('[role="dialog"], [role="alertdialog"]')
          .filter({ hasText: /Initialize repository/i })
          .first();
        // Open the folder only if the dialog is not already up. The second
        // slug re-photographs the same dialog rather than reopening it —
        // clicking "Open folder" again lands on a button the dialog covers.
        if (!(await dlg.isVisible({ timeout: 1_000 }).catch(() => false))) {
          await mockOpenDialog(ctx!.app, plain);
          await page.getByRole("button", { name: "Open folder" }).click();
        }
        await expect(dlg).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(page, dlg.locator("> div").first(), slug, DIALOG_PAD);
      };

      await cap.shot("projects/projects-non-git-folder-dialog", () =>
        nonGit("projects/projects-non-git-folder-dialog")
      );
      await cap.shot("getting-started/first-project/getting-started-non-git-folder-choice", () =>
        nonGit("getting-started/first-project/getting-started-non-git-folder-choice")
      );

      await cap.shot("projects/projects-git-init-dialog", async () => {
        const choice = page
          .locator('[role="dialog"], [role="alertdialog"]')
          .filter({ hasText: /Initialize repository/i })
          .first();
        await choice.getByRole("button", { name: /Initialize repository/i }).click();
        const setup = page
          .locator('[role="dialog"], [role="alertdialog"]')
          .filter({ hasText: /gitignore|initial commit/i })
          .first();
        await expect(setup).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          setup.locator("> div").first(),
          "projects/projects-git-init-dialog",
          DIALOG_PAD
        );
        // Never confirm: it would write a repository into the fixture folder.
        await page.keyboard.press("Escape");
      });

      await cap.shot("getting-started/first-launch/getting-started-wizard-agents-step", async () => {
        await resetOverlays(page);
        await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"));
        });
        const dlg = page.locator('[role="dialog"]').filter({ hasText: /Agent/i }).first();
        await expect(dlg).toBeVisible({ timeout: T_LONG });
        // The availability probe fills the Installed / Not installed labels
        // asynchronously; a shot taken before it lands shows skeletons.
        await expect(dlg.getByText(/Not installed|Installed/).first()).toBeVisible({
          timeout: T_LONG,
        });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          dlg.locator("> div").first(),
          "getting-started/first-launch/getting-started-wizard-agents-step",
          DIALOG_PAD
        );
        await page.keyboard.press("Escape");
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      rmSync(plain, { recursive: true, force: true });
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene P2 — Project Pulse
  // ---------------------------------------------------------------------------
  test("scene-p2-pulse", async () => {
    // A single-worktree repo of its own: the root commit has to be backdated
    // before any branch points at it, and atlas-ledger's worktrees are created
    // during construction.
    const repo: DemoRepo = createDemoRepo({
      slug: "atlas-ledger",
      files: {
        "README.md": "# 📒 atlas-ledger\n\nDouble-entry ledger service.\n",
        "src/journal/posting.ts": "// A posting is one half of a double-entry pair.\n",
      },
    });
    backdateRootCommit(repo.dir, 50);
    seedPulseHistory(repo.dir);
    attachGithubOrigin(repo, "https://github.com/daintreehq/daintree.git");

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

      await cap.shot("projects/project-pulse/project-pulse-strip", async () => {
        await resetOverlays(page);
        const strip = page.locator('[data-testid="project-pulse-strip"], button:has-text("Project pulse")').first();
        await expect(strip).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(page, strip, "projects/project-pulse/project-pulse-strip", 16);
      });

      await cap.shot("projects/project-pulse/project-pulse-card", async () => {
        await activateE2EPlugin(ctx!.app, "daintree.github").catch(() => {});
        await stubProjectHealth(ctx!.app);
        const strip = page.locator('[data-testid="project-pulse-strip"], button:has-text("Project pulse")').first();
        await strip.click();
        // Gate on the heatmap, not on the strip: clicking the strip is what
        // expands it, and without this the shot silently re-captured the
        // collapsed one-line strip.
        await expect(page.locator(SEL.pulse.heatmap)).toBeVisible({ timeout: T_LONG });
        // `.last()` on a legend-containing div lands on an inner wrapper, which
        // is why this used to crop through the header and lose the card's
        // title and its range controls. Anchor on the heading instead and take
        // the outermost div that holds both it and the legend.
        const card = page
          .locator("div")
          .filter({ has: page.getByText(/Project Pulse$/) })
          .filter({ has: page.locator(SEL.pulse.legend) })
          .first();
        await expect(card).toBeVisible({ timeout: T_LONG });
        // Force a health re-fetch so the stub is what the chips render from.
        await page.locator('[aria-label="Refresh"]').first().click().catch(() => {});
        await expect(page.getByText("passing").first()).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(page, card, "projects/project-pulse/project-pulse-card", 16);
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene P3 — the project switcher
  // ---------------------------------------------------------------------------
  test("scene-p3-switcher", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    // Five more registered projects, so the "Other projects" band clears the
    // four-row threshold that mounts its sort control.
    const others = ["harbor-freight", "tidewater-api", "quarry-ui", "beacon-cli", "salt-flats"].map(
      (slug) => {
        const dir = path.join(DOCS_DEMO_ROOT, slug);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "README.md"), `# ${slug}\n`);
        execSync("git init -b main && git add -A && git commit -m 'initial commit'", {
          cwd: dir,
          stdio: "ignore",
          env: { ...process.env, GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@daintree.dev",
                 GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@daintree.dev" },
        });
        return { slug, dir };
      }
    );

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      const names: Record<string, string> = {
        "harbor-freight": "Harbor Freight",
        "tidewater-api": "Tidewater API",
        "quarry-ui": "Quarry UI",
        "beacon-cli": "Beacon CLI",
        "salt-flats": "Salt Flats",
      };
      const registered = await page.evaluate(async (list) => {
        const out: Array<{ id: string; slug: string }> = [];
        for (const p of list) {
          const added = await window.electron.project.add(p.dir, {
            identity: { name: p.name, emoji: p.emoji },
          } as never);
          out.push({ id: (added as { id?: string })?.id ?? "", slug: p.slug });
        }
        return out;
      }, others.map((o, i) => ({ ...o, name: names[o.slug], emoji: ["🚚", "🌊", "⛏️", "🔦", "🧂"][i] })));

      // Four scratch workspaces, one of them nearly expired.
      const scratches = await page.evaluate(async () => {
        const made: Array<{ id: string; name: string }> = [];
        for (const n of [
          "Rewrite the importer",
          "Spike: currency rounding",
          undefined,
          "Try the new heatmap range",
        ]) {
          const s = await window.electron.scratch.create(n as never);
          made.push({ id: (s as { id: string }).id, name: (s as { name: string }).name });
        }
        await window.electron.scratch.update(made[1].id, {
          lastOpened: Date.now() - 26 * 86_400_000,
        } as never);
        return made;
      });

      // One project parked, so the switcher shows the suspended line.
      const parked = registered[0];
      if (parked?.id) {
        await page.evaluate(async (id) => {
          await window.electron.project.update(id, {
            status: "closed",
            autoParkedAt: Date.now() - 3_600_000,
          } as never);
        }, parked.id);
      }

      // Status lines for the scratch rows. Inject before the palette is first
      // opened: its open-time pull is seed-only and will not overwrite these,
      // but it freezes band membership while open.
      await pushProjectStats(ctx.app, {
        [scratches[0].id]: { ...IDLE_STATS, waitingAgentCount: 1, processCount: 1,
                             oldestWaitingSince: Date.now() - 4 * 60_000 },
        [scratches[1].id]: { ...IDLE_STATS, activeAgentCount: 2, processCount: 2,
                             latestWorkingSince: Date.now() - 6 * 60_000 },
        [scratches[2].id]: { ...IDLE_STATS, completedAgentCount: 1,
                             unacknowledgedCompletedAgentCount: 1, processCount: 1,
                             latestUnacknowledgedCompletionAt: Date.now() - 12 * 60_000 },
      });
      await page.waitForTimeout(T_MEDIUM);

      const openSwitcher = async () => {
        await resetOverlays(page);
        await page.keyboard.press("Meta+Alt+KeyP");
        // The switcher dialog element IS the card — it is sized and styled
        // directly, not a full-screen backdrop wrapping one. So capture it,
        // not its first child: `> div` is the header alone, which is how the
        // first three switcher shots came out 111px tall.
        const palette = page.locator('[role="dialog"][aria-label="Project switcher"]').first();
        await expect(palette).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        return palette;
      };

      await cap.shot("projects/switcher/switcher-sort-control", async () => {
        const palette = await openSwitcher();
        const trigger = palette.locator('[data-testid="other-projects-sort-trigger"]').first();
        await expect(trigger).toBeVisible({ timeout: T_LONG });
        await trigger.click();
        await expect(page.getByRole("menuitemradio", { name: /Most used/i })).toBeVisible({
          timeout: T_MEDIUM,
        });
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(
          page,
          palette,
          "projects/switcher/switcher-sort-control",
          DIALOG_PAD
        );
        await page.keyboard.press("Escape");
      });

      await cap.shot("projects/scratch-workspaces/scratch-workspaces-switcher-section", async () => {
        const palette = await openSwitcher();
        // Re-push with the palette open. The open-time bulk pull is seed-only
        // — it skips any id it already has — so a push made before the first
        // open is preserved, but one made before the *store* existed is not.
        // Pushing here is what actually puts a status line under each row.
        await pushProjectStats(ctx!.app, {
          [scratches[0].id]: { ...IDLE_STATS, waitingAgentCount: 1, processCount: 1,
                               oldestWaitingSince: Date.now() - 4 * 60_000 },
          [scratches[1].id]: { ...IDLE_STATS, activeAgentCount: 2, processCount: 2,
                               latestWorkingSince: Date.now() - 6 * 60_000 },
          [scratches[2].id]: { ...IDLE_STATS, completedAgentCount: 1,
                               unacknowledgedCompletedAgentCount: 1, processCount: 1,
                               latestUnacknowledgedCompletionAt: Date.now() - 12 * 60_000 },
        });
        await page.waitForTimeout(T_MEDIUM);
        // Scroll to the *end* of the section, not its heading: "Delete all
        // scratch workspaces" sits below the create button and was falling
        // outside the frame, so the shot showed a section that looked like it
        // had no bulk action.
        await palette
          .getByText("Delete all scratch workspaces")
          .first()
          .scrollIntoViewIfNeeded()
          .catch(async () => {
            await palette.getByText("Scratch", { exact: false }).first().scrollIntoViewIfNeeded();
          });
        await expect(palette.getByText("New scratch workspace")).toBeVisible({ timeout: T_LONG });
        await expect(palette.getByText("Delete all scratch workspaces")).toBeVisible({
          timeout: T_LONG,
        });
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(
          page,
          palette,
          "projects/scratch-workspaces/scratch-workspaces-switcher-section",
          DIALOG_PAD
        );
      });

      await cap.shot("projects/scratch-workspaces/scratch-workspaces-delete-all-confirm", async () => {
        await page.getByText("Delete all scratch workspaces").first().click();
        const confirm = page
          .locator('[role="alertdialog"], [role="dialog"]')
          .filter({ hasText: /Delete \d+ scratch workspaces/i })
          .first();
        await expect(confirm).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(
          page,
          confirm.locator("> div").first(),
          "projects/scratch-workspaces/scratch-workspaces-delete-all-confirm",
          DIALOG_PAD
        );
        await page.keyboard.press("Escape");
      });

      await cap.shot("session-management/project-memory/session-management-free-memory", async () => {
        const palette = await openSwitcher();
        // "Sleep project" replaced "Free memory". It shows for any project
        // that is neither missing nor already closed — including the active
        // one — so right-click the active row, which is guaranteed present
        // regardless of which extra registrations succeeded.
        const live = palette.getByText("Atlas Ledger").first();
        await live.click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: /Sleep project/i })).toBeVisible({
          timeout: T_LONG,
        });
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(
          page,
          palette,
          "session-management/project-memory/session-management-free-memory",
          DIALOG_PAD
        );
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      for (const o of others) rmSync(o.dir, { recursive: true, force: true });
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
