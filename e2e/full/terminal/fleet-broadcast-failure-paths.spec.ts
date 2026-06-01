import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getFocusedPanelId, getPanelById } from "../../helpers/panels";
import { waitForTerminalPty, waitForTerminalText } from "../../helpers/terminal";
import { injectFault, injectDelay, clearAllFaults } from "../../helpers/ipcFaults";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";

// Submit is the structured fleet-broadcast write path. Faulting this channel
// makes `terminalClient.submit` reject for every target so the renderer's
// transient/permanent classification (`classifyFleetRejectionReason`) runs.
const TERMINAL_SUBMIT_CHANNEL = "terminal:submit";

interface ActionResult<T = unknown> {
  ok?: boolean;
  result?: T;
  error?: { message?: string };
}

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

async function dispatchAction<T = unknown>(
  page: Page,
  actionId: string,
  args?: unknown,
  options?: { source?: string; confirmed?: boolean }
): Promise<ActionResult<T>> {
  return page.evaluate(
    ([id, actionArgs, dispatchOptions]) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            actionId: string,
            args?: unknown,
            options?: { source?: string; confirmed?: boolean }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (!dispatch) return { ok: false, error: { message: "dispatch bridge missing" } };
      return dispatch(id, actionArgs, dispatchOptions);
    },
    [actionId, args, options] as const
  ) as Promise<ActionResult<T>>;
}

async function ensureProjectOpen(): Promise<void> {
  const projectName = path.basename(fixtureDir);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    ctx.window = await getActiveAppWindow(ctx.app);
    if (
      await ctx.window
        .locator("[data-worktree-branch]")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      return;
    }
    if (
      await ctx.window
        .getByRole("button", { name: "Open folder" })
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Failure");
      continue;
    }
    const recentProject = ctx.window.locator("button", { hasText: projectName }).first();
    if (await recentProject.isVisible({ timeout: 500 }).catch(() => false)) {
      await recentProject.click();
      await ctx.window.waitForTimeout(1000);
      continue;
    }
    await ctx.window.waitForTimeout(250);
  }
  await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
    timeout: T_LONG,
  });
}

async function createFreshGridPanels(count: number): Promise<string[]> {
  await ensureProjectOpen();
  const createdIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await dispatchAction<{ terminalId?: string }>(
      ctx.window,
      "terminal.new",
      undefined,
      {
        source: "test",
      }
    );
    expect(result.ok, result.error?.message).toBe(true);
    const id = result.result?.terminalId ?? "";
    expect(id).not.toBe("");
    const panel = getPanelById(ctx.window, id);
    await expect(panel).toBeVisible({ timeout: T_LONG });
    await waitForTerminalPty(ctx.window, panel, T_LONG);
    createdIds.push(id);
  }
  return createdIds;
}

async function armPanels(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    const result = await dispatchAction(
      page,
      "terminal.arm",
      { terminalId: id },
      { source: "user" }
    );
    expect(result.ok, result.error?.message).toBe(true);
  }
}

async function clearFleet(page: Page): Promise<void> {
  await dispatchAction(page, "terminal.disarmAll", undefined, { source: "test" });
  await expect(page.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });
}

async function broadcastViaEditor(
  page: Page,
  panel: Locator,
  terminalId: string,
  command: string
): Promise<void> {
  await dismissBlockingPalette(page);
  await panel.click();
  await expect
    .poll(() => getFocusedPanelId(page), { timeout: T_MEDIUM, intervals: [100, 250] })
    .toBe(terminalId);
  const editor = panel.locator(SEL.terminal.cmEditor).first();
  await expect(editor).toBeVisible({ timeout: T_MEDIUM });
  await editor.click();
  await editor.pressSequentially(command);
  await page.keyboard.press("Enter");
}

test.describe.serial("Fleet broadcast: failure and progress paths", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "fleet-failure" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Failure");
    // The broadcast confirm + failure store paths only run through the
    // structured-submit route, which requires the hybrid input editor.
    const enableHybrid = await dispatchAction(
      ctx.window,
      "terminalConfig.setHybridInputEnabled",
      { enabled: true },
      { source: "user" }
    );
    expect(enableHybrid.ok, enableHybrid.error?.message).toBe(true);
  });

  test.afterEach(async () => {
    if (ctx?.app) await clearAllFaults(ctx.app);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("a killed armed terminal is pruned from the broadcast targets (eligibility drift)", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;
    await clearFleet(window);

    const ids = (await createFreshGridPanels(3)).slice(0, 3);
    await armPanels(window, ids);
    await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
      "aria-label",
      /^3 in fleet/,
      {
        timeout: T_MEDIUM,
      }
    );

    await test.step("Killing one armed terminal drops the armed count to two", async () => {
      const kill = await dispatchAction(
        window,
        "terminal.kill",
        { terminalId: ids[2]!, confirmed: true },
        { source: "user" }
      );
      expect(kill.ok, kill.error?.message).toBe(true);
      await expect(getPanelById(window, ids[2]!)).toHaveCount(0, { timeout: T_LONG });
      await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
        "aria-label",
        /^2 in fleet/,
        { timeout: T_MEDIUM }
      );
    });

    const marker = `fleet-drift-${Date.now()}`;
    await test.step("Broadcasting reaches the two survivors only", async () => {
      await broadcastViaEditor(window, getPanelById(window, ids[0]!), ids[0]!, `echo ${marker}`);
      await waitForTerminalText(getPanelById(window, ids[0]!), marker, T_LONG);
      await waitForTerminalText(getPanelById(window, ids[1]!), marker, T_LONG);
    });
  });

  test("a transient submit failure surfaces the retry banner and retry re-sends", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;
    await clearFleet(window);

    const ids = (await createFreshGridPanels(2)).slice(0, 2);
    await armPanels(window, ids);
    await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });

    const marker = `fleet-transient-${Date.now()}`;

    await test.step("Inject a transient submit fault and broadcast", async () => {
      await injectFault(ctx.app, TERMINAL_SUBMIT_CHANNEL, "simulated transient broadcast failure");
      await broadcastViaEditor(window, getPanelById(window, ids[0]!), ids[0]!, `echo ${marker}`);
    });

    await test.step("The failure banner appears with a retry action", async () => {
      await expect(window.locator(SEL.fleet.failureBanner)).toBeVisible({ timeout: T_LONG });
      await expect(window.getByRole("button", { name: "Retry failed" })).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    await test.step("Clearing the fault and retrying delivers the payload", async () => {
      await clearAllFaults(ctx.app);
      await window.getByRole("button", { name: "Retry failed" }).click();
      await waitForTerminalText(getPanelById(window, ids[0]!), marker, T_LONG);
      await waitForTerminalText(getPanelById(window, ids[1]!), marker, T_LONG);
      await expect(window.locator(SEL.fleet.failureBanner)).toBeHidden({ timeout: T_LONG });
    });
  });

  test("a permanent submit failure (EPIPE) auto-disarms the dead targets", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;
    await clearFleet(window);

    const ids = (await createFreshGridPanels(2)).slice(0, 2);
    await armPanels(window, ids);
    for (const id of ids) {
      await expect(getPanelById(window, id)).toHaveAttribute("data-selected", "true", {
        timeout: T_MEDIUM,
      });
    }

    await test.step("Inject an EPIPE fault and broadcast", async () => {
      await injectFault(ctx.app, TERMINAL_SUBMIT_CHANNEL, "EPIPE: broken pipe on write", "EPIPE");
      await broadcastViaEditor(
        window,
        getPanelById(window, ids[0]!),
        ids[0]!,
        `echo fleet-perm-${Date.now()}`
      );
    });

    await test.step("Both dead panes auto-disarm and the ribbon collapses", async () => {
      for (const id of ids) {
        await expect(getPanelById(window, id)).not.toHaveAttribute("data-selected", "true", {
          timeout: T_LONG,
        });
      }
      await expect(window.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });
    });
  });

  test("broadcast progress and cancel surface for a slow multi-target fan-out", async () => {
    test.setTimeout(150_000);
    const { window } = ctx;
    await clearFleet(window);

    const ids = (await createFreshGridPanels(6)).slice(0, 6);
    await armPanels(window, ids);
    await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
      "aria-label",
      /^[6-9]\d* in fleet/,
      { timeout: T_MEDIUM }
    );

    await test.step("Delay submits so the in-flight progress UI is observable", async () => {
      await injectDelay(ctx.app, TERMINAL_SUBMIT_CHANNEL, 2000);
      await broadcastViaEditor(
        window,
        getPanelById(window, ids[0]!),
        ids[0]!,
        `echo fleet-progress-${Date.now()}`
      );
    });

    await test.step("Progress counter and cancel affordance both appear", async () => {
      await expect(window.locator(SEL.fleet.broadcastProgress)).toBeVisible({ timeout: T_LONG });
      await expect(window.locator(SEL.fleet.broadcastCancel)).toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("Cancelling clears the progress UI", async () => {
      await window.locator(SEL.fleet.broadcastCancel).click();
      await expect(window.locator(SEL.fleet.broadcastProgress)).toBeHidden({ timeout: T_LONG });
    });
  });
});
