import { test, expect, type Page } from "@playwright/test";
import path from "path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getPanelById } from "../../helpers/panels";
import { waitForTerminalPty } from "../../helpers/terminal";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";

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
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Confirm");
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

async function openSavedFleetRow(page: Page, fleetName: string) {
  const savedRow = page.locator(SEL.fleet.savedRow).filter({ hasText: fleetName });
  if (await savedRow.isVisible({ timeout: 500 }).catch(() => false)) {
    return savedRow;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.locator(SEL.fleet.selectionMenuTrigger).click({ timeout: T_MEDIUM });
    if (await savedRow.isVisible({ timeout: 1000 }).catch(() => false)) {
      return savedRow;
    }
  }
  await expect(savedRow).toBeVisible({ timeout: T_MEDIUM });
  return savedRow;
}

async function requestSavedFleetDelete(page: Page, fleetName: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await openSavedFleetRow(page, fleetName);
    const clicked = await page.evaluate((name) => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="fleet-saved-row-delete"]')
      );
      const button = buttons.find(
        (candidate) => candidate.getAttribute("aria-label") === `Delete fleet "${name}"`
      );
      button?.click();
      return Boolean(button);
    }, fleetName);
    if (clicked) return;
  }
  throw new Error(`Could not request delete for saved fleet "${fleetName}"`);
}

// These confirmation keys belong to window-level listeners. Dispatch from
// body so Electron's asynchronous xterm refocus cannot retarget the synthetic
// key into the terminal-only guard between blur and keyboard.press().
async function dispatchGlobalKey(page: Page, key: "Enter" | "Escape"): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await page.evaluate((value) => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        code: value,
        bubbles: true,
        cancelable: true,
      })
    );
  }, key);
}

test.describe.serial("Fleet broadcast: confirm and lifecycle paths", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "fleet-confirm" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Confirm");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("fleet.kill surfaces a pending confirm that Escape cancels without killing", async () => {
    test.setTimeout(90_000);
    const { window } = ctx;
    await clearFleet(window);

    const ids = (await createFreshGridPanels(2)).slice(0, 2);
    await armPanels(window, ids);
    await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });

    await test.step("Dispatching fleet.kill arms the confirm strip", async () => {
      const kill = await dispatchAction(window, "fleet.kill", undefined, { source: "user" });
      expect(kill.ok, kill.error?.message).toBe(true);
      await expect(window.locator(`${SEL.fleet.ribbon}[data-pending-action="kill"]`)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    await test.step("Escape cancels the confirm — terminals survive, fleet stays armed", async () => {
      await dispatchGlobalKey(window, "Escape");
      await expect(window.locator(`${SEL.fleet.ribbon}[data-pending-action]`)).toBeHidden({
        timeout: T_MEDIUM,
      });
      await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
      for (const id of ids) {
        await expect(getPanelById(window, id)).toBeVisible({ timeout: T_MEDIUM });
      }
    });
  });

  test("fleet.kill confirmed with Enter removes every armed terminal", async () => {
    test.setTimeout(90_000);
    const { window } = ctx;
    await clearFleet(window);

    const ids = (await createFreshGridPanels(2)).slice(0, 2);
    await armPanels(window, ids);
    await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });

    const kill = await dispatchAction(window, "fleet.kill", undefined, { source: "user" });
    expect(kill.ok, kill.error?.message).toBe(true);
    await expect(window.locator(`${SEL.fleet.ribbon}[data-pending-action="kill"]`)).toBeVisible({
      timeout: T_MEDIUM,
    });

    await dispatchGlobalKey(window, "Enter");

    await test.step("Both armed panels are removed and the ribbon clears", async () => {
      for (const id of ids) {
        await expect(getPanelById(window, id)).toHaveCount(0, { timeout: T_LONG });
      }
      await expect(window.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });
    });
  });

  test("fleet.armAll arms every eligible terminal in the worktree", async () => {
    test.setTimeout(90_000);
    const { window } = ctx;
    await clearFleet(window);

    const ids = await createFreshGridPanels(3);
    expect(ids.length).toBeGreaterThanOrEqual(3);

    const armAll = await dispatchAction(
      window,
      "fleet.armAll",
      { scope: "current" },
      { source: "user" }
    );
    expect(armAll.ok, armAll.error?.message).toBe(true);

    await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
    // Assert by identity rather than a tolerant count: every fresh eligible
    // panel must end up armed. A count regex would still pass if armAll
    // skipped one of these and armed an unrelated leftover instead.
    for (const id of ids) {
      await expect(getPanelById(window, id)).toHaveAttribute("data-selected", "true", {
        timeout: T_MEDIUM,
      });
    }
  });

  test("saved fleet snapshot save → recall → delete lifecycle", async () => {
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

    const fleetName = `E2E Snapshot ${Date.now()}`;

    await test.step("Save the current selection as a named snapshot", async () => {
      await dismissBlockingPalette(window);
      await window.locator(SEL.fleet.selectionMenuTrigger).click();
      await expect(window.locator(SEL.fleet.saveForm)).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.fleet.saveFormName).fill(fleetName);
      await window.locator(SEL.fleet.saveFormSubmit).click();
      // The form lives inside the dropdown and keeps it open; dismiss it.
      await window.keyboard.press("Escape");
    });

    await test.step("Reopening the menu shows the saved row", async () => {
      await window.locator(SEL.fleet.selectionMenuTrigger).click();
      await expect(window.locator(SEL.fleet.savedRow).filter({ hasText: fleetName })).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.keyboard.press("Escape");
    });

    await test.step("Leave one pane out, then recall the snapshot to re-arm all three", async () => {
      const disarmAll = await dispatchAction(window, "terminal.disarmAll", undefined, {
        source: "user",
      });
      expect(disarmAll.ok, disarmAll.error?.message).toBe(true);
      await expect(window.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });

      await armPanels(window, ids.slice(1));
      await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
        "aria-label",
        /^2 in fleet/,
        { timeout: T_MEDIUM }
      );

      const savedRow = await openSavedFleetRow(window, fleetName);
      await savedRow.click({ force: true });
      await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
        "aria-label",
        /^3 in fleet/,
        { timeout: T_MEDIUM }
      );
      // Recall must restore the snapshot's exact panes, not just any three
      // eligible terminals — the disarmed pane (ids[0]) is re-armed by id.
      await expect(getPanelById(window, ids[0]!)).toHaveAttribute("data-selected", "true", {
        timeout: T_MEDIUM,
      });
    });

    await test.step("Delete the saved fleet via the confirm dialog", async () => {
      await armPanels(window, ids);
      await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
        "aria-label",
        /^3 in fleet/,
        { timeout: T_MEDIUM }
      );

      const confirmButton = window.locator('[data-confirm-role="confirm"]').filter({
        hasText: "Delete fleet",
      });
      await requestSavedFleetDelete(window, fleetName);
      await expect(confirmButton).toBeVisible({ timeout: T_MEDIUM });
      await confirmButton.click();

      await expect(window.locator(SEL.fleet.savedRow).filter({ hasText: fleetName })).toHaveCount(
        0,
        { timeout: T_MEDIUM }
      );
      await window.keyboard.press("Escape");
    });
  });
});
