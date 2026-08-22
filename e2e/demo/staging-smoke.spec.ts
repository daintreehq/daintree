/**
 * Staging harness smoke test — proves the golden-profile round trip.
 *
 * The harness replaces the in-app demo engine: instead of animating a cursor
 * inside the product, it materialises a scene on disk, bakes an app profile
 * once, and restores that profile before each take so a human can drive the
 * mouse and record with their own screen recorder.
 *
 * The claim this spec defends is the one the whole design rests on: a profile
 * captured from one app run, restored into a fresh directory, boots straight
 * back into the same project. If that stops being true, every shot card in
 * every scene is wrong from its first frame.
 *
 * Run locally:
 *   npm run build:e2e
 *   npx playwright test e2e/demo/staging-smoke.spec.ts --project=demo
 */

import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { bakeProfile, restoreProfile } from "../helpers/demoProfile";
import { closeApp, launchApp, waitForActiveProject } from "../helpers/launch";
import { removePathSync } from "../helpers/fixtures";
import { openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import type { DemoScene } from "../helpers/demoScene";

const SCENE: DemoScene = {
  slug: "staging-smoke",
  remote: true,
  files: {
    "README.md": "# staging-smoke\n\nHarness fixture.\n",
    "src/index.ts": "export const ready = true;\n",
  },
  worktrees: [
    {
      branch: "feature/review-me",
      files: { "src/feature.ts": "// committed\n" },
      push: true,
      uncommittedFiles: { "src/feature.ts": "// edited for review\n" },
    },
  ],
};

test("a baked profile restores into a fresh directory and reopens the project", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "daintree-staging-smoke-"));
  const snapshotDir = path.join(workspace, "snapshot");
  const takeDir = path.join(workspace, "take");

  let baked: Awaited<ReturnType<typeof bakeProfile>> | null = null;
  try {
    baked = await bakeProfile({
      scene: SCENE,
      snapshotDir,
      // Panels persist through a 500ms debounce, so this is the state most
      // likely to be lost if the bake closes the app too eagerly. Staging a
      // panel here is what makes the restore assertion below meaningful.
      setup: async ({ page }) => {
        await openTerminal(page);
        await expect(page.locator(SEL.panel.anyPanel)).toHaveCount(1);
      },
    });

    // The bake is only meaningful if the app actually persisted; snapshotProfile
    // enforces this, but assert it here so a failure names the real cause.
    expect(existsSync(path.join(snapshotDir, "daintree.db"))).toBe(true);
    // A dirty-exit marker in the snapshot would put every take behind a
    // pending-crash banner.
    expect(existsSync(path.join(snapshotDir, "running.lock"))).toBe(false);

    // The scene itself has to survive the bake — the restored profile points at
    // these paths by absolute path.
    expect(existsSync(baked.projectPath)).toBe(true);
    const worktree = baked.scene.worktrees[0];
    expect(worktree).toBeDefined();
    expect(existsSync(worktree!.path)).toBe(true);

    restoreProfile(snapshotDir, takeDir);

    // The payoff: a cold launch against the restored profile lands on the
    // project with no dialogs, no folder picker, and no onboarding.
    const context = await launchApp({ userDataDir: takeDir });
    try {
      const page = await waitForActiveProject(
        context.app,
        context.window,
        path.basename(baked.projectPath)
      );
      // Negative half of the same claim: the folder picker is what you see when
      // the profile did NOT carry a project across, so its absence is the
      // difference between "restored" and "started over".
      await expect(page.getByRole("button", { name: "Open folder" })).toHaveCount(0);

      // The panel staged during the bake has to come back, or a take would open
      // on an empty grid and every shot card would be wrong from frame one.
      await expect(page.locator(SEL.panel.anyPanel)).toHaveCount(1);
    } finally {
      await closeApp(context.app);
    }
  } finally {
    baked?.cleanup();
    try {
      removePathSync(workspace);
    } catch {
      // A leftover temp workspace is noise, not a failure.
    }
  }
});
