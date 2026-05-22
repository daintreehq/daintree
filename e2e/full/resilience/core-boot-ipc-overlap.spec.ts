import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openTerminal, getGridPanelIds } from "../../helpers/panels";
import { T_LONG } from "../../helpers/timeouts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Guards #8820: `app:boot` moved from a mount effect to a module-scope promise
// fired at module-eval time, read via React's `use()` behind a Suspense
// boundary. The risk is a cold-start regression — a fresh V8 context must
// re-evaluate the module, re-fire the IPC, and reach interactive UI on every
// launch. These tests exercise that path across a clean relaunch.
async function expectMainUiReady(page: Page, timeout = T_LONG): Promise<void> {
  await expect(page.getByRole("toolbar", { name: "Main toolbar" })).toBeVisible({ timeout });
}

test.describe.serial("Core: Boot IPC overlap", () => {
  let ctx: AppContext | null = null;
  let userDataDir: string;
  let fixtureDir: string;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-boot-ipc-"));
    const { dir, cleanup } = createFixtureRepo({ name: "boot-ipc-overlap" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    try {
      removePathSync(userDataDir);
    } catch {
      // best-effort cleanup
    }
    fixtureCleanup?.();
  });

  test("cold boot reaches interactive UI and restores panels across relaunch", async () => {
    // Session 1: cold boot through the module-scope `app:boot` promise, onboard
    // a project, and add a terminal so there is state to restore.
    const setupCtx = await launchApp({ userDataDir });
    const setupWindow = await openAndOnboardProject(
      setupCtx.app,
      setupCtx.window,
      fixtureDir,
      "Boot IPC Overlap"
    );
    await expectMainUiReady(setupWindow);

    await openTerminal(setupWindow);
    await expect(async () => {
      expect((await getGridPanelIds(setupWindow)).length).toBeGreaterThan(0);
    }).toPass({ timeout: T_LONG });
    const beforeCount = (await getGridPanelIds(setupWindow)).length;

    const setupPid = setupCtx.app.process().pid!;
    await closeApp(setupCtx.app);
    await waitForProcessExit(setupPid);

    // Session 2: a fresh V8 context re-evaluates `bootPromise`, re-fires
    // `app:boot`, and `use()` reads the result behind Suspense. The app must
    // reach interactive UI and rehydrate the saved terminal.
    ctx = await launchApp({ userDataDir });
    await expectMainUiReady(ctx.window);

    await expect(async () => {
      expect((await getGridPanelIds(ctx!.window)).length).toBeGreaterThanOrEqual(beforeCount);
    }).toPass({ timeout: T_LONG });
  });
});
