import { test, expect, type Locator } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../../helpers/terminal";
import {
  getFirstGridPanel,
  getGridPanelCount,
  openTerminal as clickOpenTerminal,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { getPtyPid, isPidAlive } from "../../helpers/stress";

// E2E-only trash TTL overrides (renderer and pty-host timers alike; honoured
// only under DAINTREE_E2E_MODE in an unpackaged build). The restore / Empty
// trash launch holds entries far longer than any of its tests, so only Empty
// trash can be what kills a PTY there; the expiry launch makes the TTL short
// enough to observe without sleeping through the real 20 s.
const TRASH_TTL_HOLD_MS = 120_000;
const TRASH_TTL_EXPIRY_MS = 5_000;

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

async function launchWithTrashTtl(ttlMs: number, name: string): Promise<void> {
  const fixture = createFixtureRepo({ name });
  fixtureCleanup = fixture.cleanup;
  ctx = await launchApp({ env: { DAINTREE_E2E_TRASH_TTL_MS: String(ttlMs) } });
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Trash Restore Test");

  const worktreeCards = ctx.window.locator("[data-worktree-branch]");
  await expect(worktreeCards.first()).toBeVisible({ timeout: T_LONG });
}

async function closeLaunch(): Promise<void> {
  if (ctx?.app) await closeApp(ctx.app);
  fixtureCleanup?.();
  fixtureCleanup = undefined;
}

/** The trash pill names the TTL the renderer is actually running with. */
async function expectAdvertisedTtl(window: AppContext["window"], ttlMs: number): Promise<void> {
  await expect(window.locator(SEL.trash.container)).toHaveAttribute(
    "aria-label",
    new RegExp(`removed for good ${ttlMs / 1000} seconds after closing`)
  );
}

function uniqueMarker(): string {
  return `TM_${Date.now().toString(36).slice(-6)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function openTerminal(window: AppContext["window"]): Promise<void> {
  const before = await getGridPanelCount(window);
  await clickOpenTerminal(window);
  await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
}

async function ptyPidOf(window: AppContext["window"], panel: Locator): Promise<number> {
  const pid = await getPtyPid(window, panel);
  expect(isPidAlive(pid), `PTY ${pid} should be alive before it is trashed`).toBe(true);
  return pid;
}

async function closeFirstPanel(window: AppContext["window"]): Promise<void> {
  const before = await getGridPanelCount(window);
  const panel = getFirstGridPanel(window);
  await dismissBlockingPalette(window);
  await panel.locator(SEL.panel.close).first().click();
  await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
}

/**
 * Close every grid panel, then empty the trash through the popover's
 * "Empty trash" button and its confirm. The confirm must still list every
 * closed panel (so the TTL has not already taken them), and afterwards each
 * PTY process must really be gone.
 */
async function closeAllAndEmptyTrash(
  window: AppContext["window"],
  ptyPids: number[]
): Promise<void> {
  let count = await getGridPanelCount(window);
  while (count > 0) {
    await closeFirstPanel(window);
    count = await getGridPanelCount(window);
  }

  const trashBtn = window.locator(SEL.trash.container);
  await expect(trashBtn).toBeVisible({ timeout: T_MEDIUM });
  // The popover keeps its open state across a restore, so a plain click on
  // the reappearing pill would toggle it shut.
  if ((await trashBtn.getAttribute("aria-expanded")) !== "true") {
    await trashBtn.click();
  }

  const popover = window.locator('[role="dialog"][aria-label="Recently closed terminals"]');
  await expect(popover).toBeVisible({ timeout: T_SHORT });
  await popover.locator('[data-testid="empty-trash-button"]').click();

  const confirm = window
    .locator('[role="dialog"], [role="alertdialog"]')
    .filter({ hasText: "Empty trash?" });
  await expect(confirm).toBeVisible({ timeout: T_SHORT });
  const noun = ptyPids.length === 1 ? "1 panel" : `${ptyPids.length} panels`;
  await expect(confirm).toContainText(`${noun} will be permanently removed`);
  for (const pid of ptyPids) {
    expect(isPidAlive(pid), `PTY ${pid} should still be alive until Empty trash`).toBe(true);
  }
  await confirm.locator(SEL.confirmDialog.confirm).click();

  await expect(confirm).not.toBeVisible({ timeout: T_SHORT });
  await expect(trashBtn).not.toBeVisible({ timeout: T_MEDIUM });
  for (const pid of ptyPids) {
    await waitForProcessExit(pid, T_LONG);
  }
}

test.describe.serial("Core: Terminal Trash & Restore", () => {
  test.beforeAll(async () => {
    await launchWithTrashTtl(TRASH_TTL_HOLD_MS, "trash-restore");
  });

  test.afterAll(closeLaunch);

  // ── Trash and Restore via Keyboard Shortcut ─────────────

  test.describe.serial("Trash and Restore via Keyboard Shortcut", () => {
    const marker = uniqueMarker();

    test("close terminal moves it to trash, Cmd+Shift+T restores with content", async () => {
      const { window } = ctx;

      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await runTerminalCommand(window, panel, `echo "${marker}"`);
      await waitForTerminalText(panel, marker, T_LONG);
      const pid = await ptyPidOf(window, panel);

      await closeFirstPanel(window);

      const trashBtn = window.locator(SEL.trash.container);
      await expect(trashBtn).toBeVisible({ timeout: T_MEDIUM });
      await expectAdvertisedTtl(window, TRASH_TTL_HOLD_MS);

      await window.keyboard.press(`${mod}+Shift+T`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      const restored = getFirstGridPanel(window);
      await waitForTerminalText(restored, marker, T_LONG);

      // Trash container should disappear after restore (entry consumed)
      await expect(trashBtn).not.toBeVisible({ timeout: T_MEDIUM });

      await test.step("close the restored terminal and empty the trash", async () => {
        await closeAllAndEmptyTrash(window, [pid]);
      });
    });
  });

  // ── Restore via Trash Popover UI ────────────────────────

  test.describe.serial("Restore via Trash Popover UI", () => {
    const marker = uniqueMarker();

    test("close terminal and restore via popover restore button", async () => {
      const { window } = ctx;

      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await runTerminalCommand(window, panel, `echo "${marker}"`);
      await waitForTerminalText(panel, marker, T_LONG);
      const pid = await ptyPidOf(window, panel);

      await closeFirstPanel(window);

      const trashBtn = window.locator(SEL.trash.container);
      await expect(trashBtn).toBeVisible({ timeout: T_MEDIUM });
      await trashBtn.click();

      const popover = window.locator('[role="dialog"][aria-label="Recently closed terminals"]');
      await expect(popover).toBeVisible({ timeout: T_SHORT });

      const restoreBtn = popover.getByRole("button", { name: /Restore/ });
      await restoreBtn.first().click();

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      const restored = getFirstGridPanel(window);
      await waitForTerminalText(restored, marker, T_LONG);

      await test.step("close the restored terminal and empty the trash", async () => {
        await closeAllAndEmptyTrash(window, [pid]);
      });
    });
  });

  // ── Reopen Last Restores Most Recent ────────────────────

  test.describe.serial("Reopen Last Restores Most Recent", () => {
    const markerA = uniqueMarker();
    const markerB = uniqueMarker();

    test("closing A then B, reopen-last restores B", async () => {
      const { window } = ctx;

      // Open terminal A
      await openTerminal(window);
      const panelA = getFirstGridPanel(window);
      await runTerminalCommand(window, panelA, `echo "${markerA}"`);
      await waitForTerminalText(panelA, markerA, T_LONG);
      const pidA = await ptyPidOf(window, panelA);

      // Open terminal B
      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);

      const panels = window.locator(SEL.panel.gridPanel);
      const panelB = panels.last();
      await runTerminalCommand(window, panelB, `echo "${markerB}"`);
      await waitForTerminalText(panelB, markerB, T_LONG);
      const pidB = await ptyPidOf(window, panelB);

      // Close A (first panel), then B
      await panels.first().locator(SEL.panel.close).first().click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      await closeFirstPanel(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);

      // Reopen last — should restore B
      await window.keyboard.press(`${mod}+Shift+T`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      const restored = getFirstGridPanel(window);
      await waitForTerminalText(restored, markerB, T_LONG);

      await test.step("close B again and empty the trash holding A and B", async () => {
        await closeAllAndEmptyTrash(window, [pidA, pidB]);
      });
    });
  });
});

// ── TTL Expiry Permanently Removes Terminal ─────────────

test.describe.serial("Core: Terminal Trash TTL Expiry", () => {
  test.beforeAll(async () => {
    await launchWithTrashTtl(TRASH_TTL_EXPIRY_MS, "trash-ttl");
  });

  test.afterAll(closeLaunch);

  test.describe.serial("TTL Expiry Permanently Removes Terminal", () => {
    test("trashed terminal is permanently removed after TTL", async () => {
      test.setTimeout(120_000);
      const { window } = ctx;
      const marker = uniqueMarker();

      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await runTerminalCommand(window, panel, `echo "${marker}"`);
      await waitForTerminalText(panel, marker, T_LONG);
      const pid = await ptyPidOf(window, panel);

      const closedAt = Date.now();
      await closeFirstPanel(window);

      const trashBtn = window.locator(SEL.trash.container);
      await expect(trashBtn).toBeVisible({ timeout: T_MEDIUM });
      await expectAdvertisedTtl(window, TRASH_TTL_EXPIRY_MS);
      // Trash holds the PTY: it is still running while the entry waits.
      expect(isPidAlive(pid), `PTY ${pid} should survive being trashed`).toBe(true);

      // Nothing but the TTL removes it: the trash entry and the PTY both go.
      await expect(trashBtn).not.toBeVisible({ timeout: TRASH_TTL_EXPIRY_MS + T_LONG });
      await waitForProcessExit(pid, T_LONG);
      // Not early: the entry lived out its TTL rather than being dropped.
      expect(Date.now() - closedAt).toBeGreaterThanOrEqual(TRASH_TTL_EXPIRY_MS - 1_000);
      expect(await getGridPanelCount(window)).toBe(0);

      // Reopen-last should be a no-op
      await window.keyboard.press(`${mod}+Shift+T`);
      await window.waitForTimeout(T_SETTLE);
      expect(await getGridPanelCount(window)).toBe(0);
    });
  });
});
