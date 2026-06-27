import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getFocusedPanelId, getPanelById } from "../../helpers/panels";
import {
  waitForTerminalPty,
  waitForTerminalText,
  waitForTerminalTextById,
  getTerminalText,
  getTerminalTextById,
} from "../../helpers/terminal";
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

async function editorContains(locator: Locator, text: string): Promise<boolean> {
  if (!(await locator.isVisible().catch(() => false))) return false;
  return locator
    .evaluate((element, expected) => (element.textContent ?? "").includes(expected), text)
    .catch(() => false);
}

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
    await expect(getPanelById(page, id)).toHaveAttribute("data-selected", "true", {
      timeout: T_MEDIUM,
    });
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
  await expect
    .poll(() => editorContains(editor, command), {
      timeout: T_MEDIUM,
      intervals: [100, 250],
    })
    .toBe(true);

  await editor.press("Enter");
  const consumed = await expect
    .poll(() => editorContains(editor, command), {
      timeout: T_MEDIUM,
      intervals: [100, 250],
    })
    .toBe(false)
    .then(
      () => true,
      () => false
    );

  if (!consumed) {
    await editor.click();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => editorContains(editor, command), {
        timeout: T_MEDIUM,
        intervals: [100, 250],
      })
      .toBe(false);
  }
}

async function focusHybridInput(page: Page, panel: Locator, terminalId: string): Promise<Locator> {
  await dismissBlockingPalette(page);
  await panel.click({ force: true, noWaitAfter: true });
  await expect
    .poll(() => getFocusedPanelId(page), { timeout: T_MEDIUM, intervals: [100, 250] })
    .toBe(terminalId);
  const editor = panel.locator(SEL.terminal.cmEditor).first();
  await expect(editor).toBeVisible({ timeout: T_MEDIUM });
  await editor.evaluate((node) => {
    if (node instanceof HTMLElement) node.focus();
  });
  await expect
    .poll(() => editor.evaluate((node) => document.activeElement === node).catch(() => false), {
      timeout: T_MEDIUM,
      intervals: [100, 250],
    })
    .toBe(true);
  return editor;
}

test.describe.serial("Fleet broadcast: failure and progress paths", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "fleet-failure" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Failure");
    // The failure/progress store paths only run through the structured-submit
    // route, which requires the hybrid input editor.
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
      // The faulted broadcast must not have reached either pane — otherwise a
      // later "marker present" assertion would pass on the original send, not
      // the retry, making the retry path falsely look exercised.
      for (const id of ids) {
        await expect
          .poll(() => getTerminalText(getPanelById(window, id)), { timeout: T_MEDIUM })
          .not.toContain(marker);
      }
    });

    await test.step("Clearing the fault and retrying delivers the payload", async () => {
      await clearAllFaults(ctx.app);
      const retryFailed = window.getByRole("button", { name: "Retry failed" });
      await expect(retryFailed).toBeVisible({ timeout: T_MEDIUM });
      await window.getByRole("button", { name: "Retry failed" }).click({
        force: true,
        timeout: T_MEDIUM,
      });
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

  test("cancelling a slow batched broadcast skips the later batch", async () => {
    test.setTimeout(200_000);
    const { window } = ctx;
    await clearFleet(window);

    const ids = (await createFreshGridPanels(6)).slice(0, 6);
    await armPanels(window, ids);
    await expect
      .poll(
        async () => {
          const label =
            (await window.locator(SEL.fleet.armedCountChip).getAttribute("aria-label")) ?? "";
          const match = label.match(/^(\d+) in fleet/);
          return match ? Number(match[1]) : 0;
        },
        { timeout: T_MEDIUM }
      )
      .toBeGreaterThanOrEqual(6);

    // Cooperative cancellation only has anything to interrupt on the batched
    // fan-out path, which `executeFleetBroadcast` enters when there are more
    // than FLEET_LARGE_PASTE_BATCH_SIZE (5) targets AND a payload at or above
    // FLEET_LARGE_PASTE_BYTE_THRESHOLD (100 KB). A small payload fires every
    // submit in a single Promise.allSettled, so Cancel would be a no-op the
    // test couldn't distinguish from a broken feature. Keep the POSIX sentinel
    // first and the byte-threshold filler in a shell comment so raw paste
    // fallback on slower macOS runners still executes the marker instead of
    // flooding the terminal with echoed filler. PowerShell line-wraps oversized
    // prompt echoes before it reaches final command output, so Windows asserts
    // the unique variable name echoed at the start of the oversized assignment.
    const sentinel = `fleet-cancel-${Date.now()}`;
    const windowsSentinelVariable = `$fc${Date.now().toString(36)}`;
    const firstBatchReceiptText = process.platform === "win32" ? windowsSentinelVariable : sentinel;
    const largePayload =
      process.platform === "win32"
        ? `${windowsSentinelVariable} = '${"A".repeat(103_000)}'`
        : `printf '${sentinel}\\n'; : # ${"A".repeat(103_000)}`;

    await test.step("Send the oversized broadcast directly through the editor", async () => {
      // A long per-submit delay removes the cancel-click race: batch one stays
      // in flight for ~12s, far longer than it takes to click Cancel, so the
      // abort always lands before batch two would dispatch.
      await injectDelay(ctx.app, TERMINAL_SUBMIT_CHANNEL, 12_000);
      const editor = await focusHybridInput(window, getPanelById(window, ids[0]!), ids[0]!);
      await editor.fill(largePayload);
      await window.keyboard.press("Enter");
      // Editor fleet broadcasts intentionally do not show a paste/destructive
      // confirm; arming is the consent boundary. The large payload still
      // forces the batched progress path below.
      await expect(window.locator(SEL.fleet.pasteConfirmSend)).toBeHidden({ timeout: T_MEDIUM });
    });

    await test.step("Progress and cancel affordances surface, then cancel mid-flight", async () => {
      await expect(window.locator(SEL.fleet.broadcastProgress)).toBeVisible({ timeout: T_LONG });
      await expect(window.locator(SEL.fleet.broadcastCancel)).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.fleet.broadcastCancel).click();
    });

    await test.step("First-batch target receives the payload; the sixth (later batch) is skipped", async () => {
      // ids[0] is in the first batch — already dispatched before Cancel — so it
      // completes once its delayed submit resolves. The 12s-per-submit injected
      // delay applies to every batched submit, so the marker can land well past
      // 12s; keep generous headroom (60s local / scaled on CI) so a slow batch
      // drain never races the assertion.
      await waitForTerminalTextById(window, ids[0]!, firstBatchReceiptText, T_LONG * 6);
      // ids[5] is the lone second-batch target; the abort skips it entirely.
      // Progress hidden is the structural signal that all in-flight work has
      // drained, so the absence check can no longer race a late delivery.
      await expect(window.locator(SEL.fleet.broadcastProgress)).toBeHidden({ timeout: T_LONG });
      await expect
        .poll(() => getTerminalTextById(window, ids[5]!), { timeout: T_MEDIUM })
        .not.toContain(firstBatchReceiptText);
    });
  });
});
