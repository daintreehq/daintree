/**
 * Documentation screenshots — Troubleshooting & Diagnostics.
 *
 * Split out of `docs-shots.spec.ts` because two of these five states are only
 * reachable from a *pre-seeded profile*: safe mode and the crash-recovery
 * dialog are both decided during boot, from files the app reads before the
 * first frame. That means a dedicated `userDataDir` per scene, which the
 * shared workspace scenes deliberately avoid.
 *
 * Nothing here crashes the app. The docs pages tell a reader to force-quit
 * three times in thirty minutes; the capture instead writes the state that
 * force-quitting would have produced, which is deterministic, offline, and
 * about ninety seconds faster.
 *
 * Safe mode and the crash dialog are mutually exclusive by design — the boot
 * handler drops a pending crash when the guard is in safe mode — so they get
 * one launch each.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays, settleFrame } from "../helpers/docsCapture";
import { bootDocsApp, DOCS_WINDOW, DOCS_WINDOW_TALL, DIALOG_PAD } from "../helpers/docsBoot";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("troubleshooting");

/**
 * Profile dirs for the seeded scenes.
 *
 * The prefix must not contain `daintree-e2e`: launchApp's pre-launch hygiene
 * pkills any Electron whose profile path matches that, and would kill this
 * run's own app. `bootDocsApp` asserts this too, but naming it here is what
 * stops someone "tidying" the prefix later.
 */
function docsProfile(kind: string): string {
  return mkdtempSync(path.join(tmpdir(), `daintree-docsshot-${kind}-`));
}

/**
 * Two errors in the error store, which is what puts a red count on the
 * toolbar's Problems button and fills the dock's Problems tab.
 *
 * They must differ: the store drops an identical message+type+source inside a
 * 500ms window, so two calls with one string would leave a badge reading 1.
 */
async function injectProblems(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__DAINTREE_E2E_ADD_ERROR__?.(
      "Failed to fetch origin/main: could not read Username for 'https://github.com'"
    );
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.__DAINTREE_E2E_ADD_ERROR__?.("Terminal 'dev server' exited with code 1");
  });
  await page.waitForTimeout(T_SHORT);
}

test.describe.serial("Documentation Screenshots — Troubleshooting", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  // ---------------------------------------------------------------------------
  // Scene T1 — the diagnostics surfaces a reader reaches from the toolbar
  // ---------------------------------------------------------------------------
  test("scene-t1-diagnostics", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    let ctx: AppContext | undefined;
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
      });
      ctx = booted.ctx;
      const { page } = booted;

      // The Problems button is only mounted when developer tools are on, or
      // when the watcher is already degraded. Turn it on rather than relying
      // on a degraded watcher we cannot stage.
      await page.evaluate(() => {
        window.__daintreeDispatchAction?.(
          "preferences.showDeveloperTools.set",
          { show: true },
          { source: "user" }
        );
      });
      await expect(page.locator('[aria-label^="Problems:"]')).toBeVisible({ timeout: T_MEDIUM });

      await injectProblems(page);

      // Injecting the first error auto-opens the dock on the Problems tab.
      // Toggle only if that did not happen, so we never close it by accident.
      const dock = page.locator(SEL.diagnostics.dock);
      if (!(await dock.isVisible({ timeout: T_SHORT }).catch(() => false))) {
        await page.evaluate(() => {
          window.__daintreeDispatchAction?.("panel.toggleDiagnostics", undefined, {
            source: "user",
          });
        });
      }
      await expect(dock).toBeVisible({ timeout: T_LONG });
      await expect(page.locator(SEL.diagnostics.tab("problems"))).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await page.waitForTimeout(T_MEDIUM);

      await cap.shot("troubleshooting/troubleshooting-diagnostics-entry-points", async () => {
        await cap.requireSurface(page, SEL.diagnostics.dock, "diagnostics dock");
        // The amber watcher pip has no offline trigger: the only writers are a
        // real ENOSPC/EMFILE from the workspace-host utility process, over a
        // MessagePort no test can reach. The element is always mounted and
        // gated purely on `data-visible`, so flipping the attribute renders
        // the identical pixels the real state would. Done last, immediately
        // before the shot, so no re-render can reset it first.
        await page.evaluate(() => {
          document
            .querySelector('[data-testid="watcher-degraded-badge"]')
            ?.setAttribute("data-visible", "true");
        });
        await page.waitForTimeout(250);
        await cap.snapWindow(page, "troubleshooting/troubleshooting-diagnostics-entry-points");
      });

      // Same staged state, tighter framing. The version that shipped in v3
      // opened the dock with no errors at all, so the tab strip carried no
      // Problems badge and the pane behind it was empty — it never matched
      // its own caption.
      await cap.shot("troubleshooting/diagnostics/diagnostics-dock-tabs", async () => {
        await cap.requireSurface(page, SEL.diagnostics.tabList, "diagnostics tab strip");
        // The v4 attempt shipped a crop of the right region with nothing in
        // it: the dock's own `bg/95 backdrop-blur-sm` over an unpainted body,
        // so the shot was the blurred workspace showing through. A visible tab
        // strip was not enough of a gate — assert a row of the table the shot
        // is actually of, and let it settle.
        await expect(dock.getByText("Terminal 'dev server' exited with code 1")).toBeVisible({
          timeout: T_LONG,
        });
        await expect(dock.getByText("Problems")).toBeVisible({ timeout: T_MEDIUM });
        await settleFrame(page);
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(page, dock, "troubleshooting/diagnostics/diagnostics-dock-tabs", 8);
      });

      await cap.shot("troubleshooting/diagnostics/diagnostics-review-dialog", async () => {
        await resetOverlays(page);
        await page.evaluate(() => {
          window.__daintreeDispatchAction?.(
            "diagnostics.openReview",
            { scope: { source: "settings.troubleshooting" } },
            { source: "user" }
          );
        });
        const dialog = page.locator('[data-testid="diagnostics-review-dialog"]');
        // Opening runs an IPC collect round-trip before the dialog paints.
        await expect(dialog).toBeVisible({ timeout: T_LONG });

        // All three prebuilt redactions start off, and the placeholder asks
        // for the toggles to be doing something. Turn two on.
        await dialog.locator('label:has-text("Strip email addresses")').click();
        await dialog.locator('label:has-text("Strip absolute file paths")').click();
        // The Find & Replace row ships with an empty `find` and a prefilled
        // `[REDACTED]`; an empty row photographs as an unfinished form.
        await dialog.locator('input[placeholder="Find text"]').first().fill("acme-internal");

        await expect(dialog.getByRole("button", { name: "Save Bundle" })).toBeVisible();
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          dialog.locator("> div").first(),
          "troubleshooting/diagnostics/diagnostics-review-dialog",
          DIALOG_PAD
        );
        await resetOverlays(page);
      });

      // Memory badge last: it needs a real workload, and the six seconds it
      // takes to settle should not delay the cheap shots above.
      await cap.shot("troubleshooting/diagnostics/diagnostics-memory-badge-popover", async () => {
        await resetOverlays(page);
        await page.locator(SEL.toolbar.openTerminal).click();
        const panel = page.locator(SEL.panel.gridPanel).first();
        await expect(panel).toBeVisible({ timeout: T_LONG });
        await panel.click();
        // The badge only mounts once the project has a live PTY, and the
        // "Terminal workloads" row only appears once that PTY has a child
        // holding measurable resident memory. No backdoor exists for either.
        await page.keyboard.type(
          `node -e "const a=[];for(let i=0;i<1.5e6;i++)a.push({i,s:'x'.repeat(40)});console.log('holding',a.length);setInterval(()=>{},1e3)"\n`,
          { delay: 8 }
        );
        await page.waitForTimeout(6_000);

        // The trigger has no aria-label and no test id, so its text is the
        // only stable handle. Worth an issue against the app.
        const badge = page
          .locator(SEL.sidebar.aside)
          .locator("button")
          .filter({ hasText: /\d+ projects? active/ })
          .first();
        await expect(badge).toBeVisible({ timeout: 30_000 });
        await badge.click();

        const popover = page
          .locator('[role="dialog"]')
          .filter({ hasText: "Daintree app memory" })
          .first();
        await expect(popover).toBeVisible({ timeout: T_MEDIUM });
        // Gate on the real measurement, not the skeleton: the workloads row
        // is the one that proves the pty-host sweep actually returned.
        await expect(popover.getByText("Terminal workloads")).toBeVisible({ timeout: 20_000 });
        await expect(popover.getByText(/Workloads = dev servers/)).toBeVisible({
          timeout: T_MEDIUM,
        });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          popover,
          "troubleshooting/diagnostics/diagnostics-memory-badge-popover",
          20
        );
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Scene T2 — safe mode, from a seeded crash-loop guard
  // ---------------------------------------------------------------------------
  test("scene-t2-safe-mode", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    const userDataDir = docsProfile("safemode");
    let ctx: AppContext | undefined;
    try {
      const now = Date.now();
      // Three launches inside the 30-minute window with no clean exit is the
      // definition of safe mode. `crashes` here is cosmetic — the guard
      // recomputes it from `launches` — but a mismatched file reads as a lie.
      writeFileSync(
        path.join(userDataDir, "crash-loop-state.json"),
        JSON.stringify({
          version: 1,
          crashes: 3,
          launches: [now - 22 * 60_000, now - 9 * 60_000, now - 2 * 60_000],
          cleanExit: false,
          lastReset: now - 60 * 60_000,
        })
      );
      // Without quarantined panels the banner has no details, and the "Show
      // details" button — which is where the crash-count meta line actually
      // lives — never renders at all.
      writeFileSync(
        path.join(userDataDir, "panel-suspect-ledger.json"),
        JSON.stringify({
          version: 1,
          panels: {
            "panel-dev-server": {
              consecutiveSuspectCount: 2,
              cleanLaunchesSince: 0,
              lastSuspectAt: now - 2 * 60_000,
              title: "npm run dev",
              kind: "terminal",
              worktreeId: "feature/reconciliation",
            },
            "panel-preview": {
              consecutiveSuspectCount: 2,
              cleanLaunchesSince: 0,
              lastSuspectAt: now - 2 * 60_000,
              title: "Dev Preview",
              kind: "dev-preview",
              worktreeId: "main",
            },
          },
        })
      );

      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        userDataDir,
        keepGlobalBanner: true,
      });
      ctx = booted.ctx;
      const { page } = booted;

      await cap.shot("troubleshooting/crash-recovery/troubleshooting-safe-mode-banner", async () => {
        const banner = page.locator('[role="status"]').filter({ hasText: /Safe mode/ }).first();
        await expect(banner).toBeVisible({ timeout: T_LONG });
        // The crash-count meta line is inside the popover, not under the
        // title — the banner renders its compact single-row layout.
        await banner.getByRole("button", { name: "Show details" }).click();
        await expect(page.getByText(/crashes detected, last/)).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapWindow(
          page,
          "troubleshooting/crash-recovery/troubleshooting-safe-mode-banner"
        );
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene T3 — the crash-recovery dialog, from a seeded marker and backup
  // ---------------------------------------------------------------------------
  test("scene-t3-crash-dialog", async () => {
    const userDataDir = docsProfile("crash");
    let ctx: AppContext | undefined;
    try {
      const now = Date.now();
      const crashTs = now - 4 * 60_000;

      // Exactly one prior crash. At zero the suspect panel is not
      // pre-deselected; at two or more the "Restore automatically next time"
      // switch is replaced by an "Auto-restore paused" line. The placeholder
      // asks for both, so the count has to be 1.
      writeFileSync(
        path.join(userDataDir, "crash-loop-state.json"),
        JSON.stringify({
          version: 1,
          crashes: 1,
          launches: [now - 6 * 60_000],
          cleanExit: false,
          lastReset: now - 60 * 60_000,
        })
      );
      // Opt out of silent auto-restore, or the app restores in the background
      // and the dialog never renders.
      writeFileSync(
        path.join(userDataDir, "config.json"),
        JSON.stringify({ crashRecovery: { autoRestoreOnCrash: false } })
      );
      // `isPackaged: true` matters: an unpackaged marker with no crash log is
      // discarded as an orphaned dev marker and the whole scene boots clean.
      // A stale heartbeat with no crash log classifies as external-kill,
      // which titles the dialog "Daintree was forced to close".
      writeFileSync(
        path.join(userDataDir, "running.lock"),
        JSON.stringify({
          sessionStartMs: now - 5 * 60_000,
          appVersion: "0.0.0-docs",
          platform: process.platform,
          isPackaged: true,
          lastHeartbeatMs: now - 4 * 60_000,
        })
      );

      mkdirSync(path.join(userDataDir, "backups"), { recursive: true });
      writeFileSync(
        path.join(userDataDir, "backups", "session-state.json"),
        JSON.stringify({
          capturedAt: crashTs,
          appState: {
            terminals: [
              {
                id: "panel-term-1",
                kind: "terminal",
                title: "npm run dev",
                cwd: "~/Code/atlas-ledger",
                location: "grid",
                createdAt: crashTs - 9 * 60_000,
              },
              {
                id: "panel-agent-1",
                kind: "agent",
                title: "Reconciliation review",
                cwd: "~/Code/atlas-ledger",
                location: "grid",
                createdAt: crashTs - 7 * 60_000,
                agentState: "waiting",
              },
              {
                // The suspect: created ten seconds before the crash, inside
                // the 30s window, so it is flagged and pre-deselected.
                id: "panel-preview-1",
                kind: "dev-preview",
                title: "Dev Preview — localhost:5173",
                cwd: "~/Code/atlas-ledger",
                location: "grid",
                createdAt: crashTs - 10_000,
              },
            ],
          },
        })
      );

      // The gate renders before any workspace exists, so there is no folder
      // to open and no project to name.
      const booted = await bootDocsApp({
        repoDir: "",
        displayName: "",
        emoji: "",
        userDataDir,
        skipProjectOpen: true,
        waitForSelector: SEL.crashRecovery.dialog,
        // Taller than the shared window on purpose. The dialog is capped at
        // 75vh, and at 820px that leaves the panel list short enough to scroll
        // internally — which clipped the suspect row, the one row the shot
        // exists to show. The dialog is captured as an element, so the extra
        // height costs nothing in the final image.
        windowSize: DOCS_WINDOW_TALL,
      });
      ctx = booted.ctx;
      const { page } = booted;

      await cap.shot(
        "troubleshooting/crash-recovery/troubleshooting-crash-recovery-dialog",
        async () => {
          const dialog = page.locator(SEL.crashRecovery.dialog);
          await expect(dialog).toBeVisible({ timeout: T_LONG });
          // Assert the staged state rather than trusting it. Every one of
          // these is a way the seed can drift into a shot that looks fine and
          // shows the wrong thing.
          await expect(dialog).toContainText("Daintree was forced to close");
          await expect(page.locator(SEL.crashRecovery.suspectBadge("panel-preview-1"))).toBeVisible();
          await expect(
            page.locator(SEL.crashRecovery.panelCheckbox("panel-preview-1"))
          ).not.toBeChecked();
          await expect(page.locator(SEL.crashRecovery.autoRestoreCheckbox)).toBeVisible();
          // Three panels, not four: the list has its own max height, and a
          // fourth row pushed the suspect — the row the shot exists to show —
          // under an internal scroll.
          await expect(dialog).toContainText("2 of 3 selected");

          // The dialog autofocuses "Select all", and a focus ring on a control
          // nobody pressed reads as a mis-click in a documentation image.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page.waitForTimeout(T_MEDIUM);
          // The AppDialog root is `fixed inset-0`, so its bounding box is the
          // whole window — capturing it yields a full-window shot that is
          // mostly backdrop. The visible card is its first child.
          await cap.snapElement(
            page,
            dialog.locator("> div").first(),
            "troubleshooting/crash-recovery/troubleshooting-crash-recovery-dialog",
            DIALOG_PAD
          );
        }
      );
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
