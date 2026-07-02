import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { openPluginManager, closePluginManager } from "../../helpers/plugins";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

async function expectForgeSegmentRegistered(
  locator: ReturnType<AppContext["window"]["locator"]>,
  label: RegExp
): Promise<void> {
  await expect(locator).toHaveCount(1, { timeout: T_MEDIUM });
  await expect(locator).toHaveAttribute("aria-label", label);
}

/**
 * Forge stats pill lifecycle across the two paths that regressed when plugin
 * loading moved into the post-first-interactive deferred queue (#10346) and
 * forge resolution became plugin-registry-backed (#10343/#10347):
 *
 * 1. Cold boot with a PERSISTED project — the toolbar mounts and resolves the
 *    forge provider before the deferred `PluginService.initialize()` populates
 *    the registry. Without the `waitForInit()` gate on `forge:resolve-provider`
 *    the renderer caches `{entry: null}` for the session and the pill never
 *    appears. (The other GitHub specs onboard their project AFTER boot, which
 *    re-resolves on projectId change and so never exercised this path.)
 *
 * 2. Live disable → enable of `daintree.github` — built-ins transition live
 *    (#9304): the toggle must tear down / re-register the forge provider and
 *    broadcast `plugin:provenance-changed`, flipping the pill off and back on
 *    without a restart.
 *
 * The fixture remote points at github.com so hostname matching resolves the
 * provider; no token is seeded — pill VISIBILITY is gated only on provider
 * resolution, never on auth or fetched counts.
 */
test.describe.serial("Panels: Forge stats pill lifecycle", () => {
  let userDataDir: string;
  let fixtureDir: string;
  let fixtureCleanup: () => void;
  let noForgeCleanup: (() => void) | undefined;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-forge-stats-"));
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "forge-stats",
      withGitHubRemote: true,
    }));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    fixtureCleanup?.();
    noForgeCleanup?.();
  });

  test("pill appears after onboarding a GitHub-remote project", async () => {
    ctx = await launchApp({ userDataDir });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Forge Stats");

    await expectForgeSegmentRegistered(ctx.window.locator(SEL.github.statPillIssues), /issues/i);
  });

  test("pill disappears and reappears across a live plugin disable/enable", async () => {
    // Built-ins transition LIVE (#9304) — drive the real Settings toggle, not
    // bare IPC, so the whole user path is covered: switch → plugin:set-enabled
    // → _applyEnabledToggle (unload/re-register + activate) → provenance
    // broadcast → every mounted useResolvedForgeProvider instance re-resolves.
    const window = ctx!.window;
    const pill = window.locator(SEL.github.statPillIssues);
    const toggle = window.getByRole("switch", { name: "Enable GitHub" });

    await openPluginManager(window);
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    // Live transition: no restart gate for built-ins.
    await expect(window.getByText("Restart required to apply plugin changes")).not.toBeVisible();
    await closePluginManager(window);
    await expect(pill).toHaveCount(0, { timeout: T_MEDIUM });
    // Issue/PR segments are forge data and collapse with the plugin; the
    // commit count is local git, so the commits-only pill stays.
    await expectForgeSegmentRegistered(window.locator(SEL.github.statPillCommits), /commits/i);

    await openPluginManager(window);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await closePluginManager(window);
    await expectForgeSegmentRegistered(pill, /issues/i);
  });

  test("pill appears on cold boot with a persisted project (no interaction)", async () => {
    // Close session 1; relaunch against the same userDataDir so the project
    // restores at boot and the toolbar resolves the provider at mount time —
    // the exact ordering that races the deferred plugin initialize().
    const pid = ctx!.app.process().pid;
    await closeApp(ctx!.app);
    if (pid) await waitForProcessExit(pid).catch(() => {});

    ctx = await launchApp({ userDataDir });
    const window = ctx.window;

    await expect(window.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText("forge-stats", {
      timeout: T_LONG,
    });
    await expectForgeSegmentRegistered(window.locator(SEL.github.statPillIssues), /issues/i);
  });

  test("a repo with no forge remote shows the commits-only pill", async () => {
    // No origin at all: provider resolution settles to null, the issue/PR
    // segments never render, and the commit count (local git) carries the
    // pill alone. This is also the shape remote-less E2E fixtures get.
    const { dir, cleanup } = createFixtureRepo({ name: "no-forge" });
    noForgeCleanup = cleanup;
    ctx!.window = await addAndSwitchToProject(ctx!.app, ctx!.window, dir, "no-forge");
    const window = ctx!.window;

    await expectForgeSegmentRegistered(window.locator(SEL.github.statPillCommits), /commits/i);
    await expect(window.locator(SEL.github.statPillIssues)).toHaveCount(0);
    await expect(window.locator(SEL.github.statPillPrs)).toHaveCount(0);
  });
});
