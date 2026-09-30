import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getGridPanelCount,
  getDockPanelCount,
  getGridPanelIds,
  getDockPanelIds,
  getFirstGridPanel,
  getFocusedPanelId,
  getPanelById,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { getTerminalText, waitForTerminalText } from "../../helpers/terminal";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { spawnTerminalAndVerify } from "../../helpers/workflows";
import { dismissBlockingPalette } from "../../helpers/overlays";

type TerminalGeometry = {
  cols: number;
  rows: number;
  proposedCols: number;
  proposedRows: number;
  ptyCols: number | null;
  ptyRows: number | null;
};

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown,
  options?: { source?: string; confirmed?: boolean }
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(([id, a, o]) => (window as any).__daintreeDispatchAction(id, a, o), [
    actionId,
    args,
    options,
  ] as const);
}

async function focusPanel(page: Page, panelId: string): Promise<void> {
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const xtermArea = panel.locator(SEL.terminal.xtermRows).first();
  await dismissBlockingPalette(page);
  await xtermArea.click();
  await expect
    .poll(() => getFocusedPanelId(page), { timeout: T_MEDIUM, intervals: [50, 100, 250] })
    .toBe(panelId);
}

async function getPersistedGridStrategy(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const app = (
      window as unknown as {
        electron?: {
          app?: {
            getState?: () => Promise<{ panelGridConfig?: { strategy?: string } }>;
          };
        };
      }
    ).electron?.app;
    const state = await app?.getState?.();
    return state?.panelGridConfig?.strategy ?? null;
  });
}

async function getGridColumnCount(page: Page): Promise<number> {
  const gridEl = page.locator('[data-grid-container="true"]');
  const cols = await gridEl.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  return cols.trim().split(/\s+/).length;
}

/**
 * Bring the group back to an empty grid through the panel close button, so each
 * group starts from the panels it spawns itself. Docked panels are moved back to
 * the grid first (setup only) because the grid close button is the path under use.
 */
async function resetToEmptyGrid(page: Page): Promise<void> {
  await dismissBlockingPalette(page);
  for (const id of await getDockPanelIds(page)) {
    await dispatchAction(page, "terminal.moveToGrid", { terminalId: id });
  }
  await expect.poll(() => getDockPanelCount(page), { timeout: T_MEDIUM }).toBe(0);

  let gridCount = await getGridPanelCount(page);
  while (gridCount > 0) {
    await getFirstGridPanel(page).locator(SEL.panel.close).first().click({ force: true });
    await expect.poll(() => getGridPanelCount(page), { timeout: T_MEDIUM }).toBe(gridCount - 1);
    gridCount--;
  }
  await expect.poll(() => getGridPanelCount(page), { timeout: T_MEDIUM }).toBe(0);
}

async function getTerminalGeometry(page: Page, panelId: string): Promise<TerminalGeometry | null> {
  return page.evaluate(async (id) => {
    const target = window as unknown as {
      __daintreeProposeTerminalDimensions?: (terminalId: string) => {
        cols: number;
        rows: number;
        proposedCols: number;
        proposedRows: number;
      } | null;
      electron?: {
        terminal?: {
          getInfo?: (terminalId: string) => Promise<{ ptyCols?: number; ptyRows?: number } | null>;
        };
      };
    };
    const renderer = target.__daintreeProposeTerminalDimensions?.(id) ?? null;
    const pty = (await target.electron?.terminal?.getInfo?.(id)) ?? null;
    if (!renderer || !pty) return null;
    return {
      ...renderer,
      ptyCols: pty.ptyCols ?? null,
      ptyRows: pty.ptyRows ?? null,
    };
  }, panelId);
}

function isConverged(geometry: TerminalGeometry | null): boolean {
  return (
    geometry !== null &&
    geometry.cols > 1 &&
    geometry.rows > 1 &&
    geometry.cols === geometry.proposedCols &&
    geometry.rows === geometry.proposedRows &&
    geometry.cols === geometry.ptyCols &&
    geometry.rows === geometry.ptyRows
  );
}

async function waitForConvergence(page: Page, panelIds: string[]): Promise<TerminalGeometry[]> {
  await expect
    .poll(
      async () => {
        const geometries = await Promise.all(
          panelIds.map((panelId) => getTerminalGeometry(page, panelId))
        );
        return geometries.every(isConverged);
      },
      { timeout: T_LONG, intervals: [100, 250, 500] }
    )
    .toBe(true);

  const geometries = await Promise.all(
    panelIds.map((panelId) => getTerminalGeometry(page, panelId))
  );
  expect(geometries.every(isConverged)).toBe(true);
  return geometries as TerminalGeometry[];
}

async function setActive(page: Page, panelId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const w = window as unknown as {
      electron?: {
        terminal?: {
          setActivityTier?: (id: string, tier: "active" | "background") => void;
          wake?: (id: string) => Promise<unknown>;
        };
      };
    };
    const terminal = w.electron?.terminal;
    if (typeof terminal?.wake === "function") {
      await terminal.wake(id);
      return;
    }
    terminal?.setActivityTier?.(id, "active");
  }, panelId);
}

async function ptyWrite(page: Page, panelId: string, data: string): Promise<void> {
  await setActive(page, panelId);
  const result = await page.evaluate(
    ([id, d]) => {
      const w = window as unknown as {
        electron?: { terminal?: { write?: (id: string, d: string) => void } };
      };
      if (!w.electron?.terminal?.write) {
        return { ok: false, reason: "terminal.write API missing" };
      }
      w.electron.terminal.write(id, d);
      return { ok: true };
    },
    [panelId, data]
  );
  if (!result.ok) throw new Error(`ptyWrite failed: ${result.reason}`);
}

// Written straight to the PTY: keyboard typing races the flood's output and can
// interleave characters between panels.
async function ptySubmit(page: Page, panelId: string, text: string): Promise<void> {
  await setActive(page, panelId);
  const result = await page.evaluate(
    async ([id, t]) => {
      const w = window as unknown as {
        electron?: { terminal?: { submit?: (id: string, t: string) => Promise<unknown> } };
      };
      if (!w.electron?.terminal?.submit) {
        return { ok: false, reason: "terminal.submit API missing" };
      }
      try {
        // PTY submit writes body, then appends `\r` for each trailing newline.
        // Without a trailing `\n` the command text is written but never committed.
        const payload = t.endsWith("\n") ? t : `${t}\n`;
        await w.electron.terminal.submit(id, payload);
        return { ok: true };
      } catch (err) {
        // eslint-disable-next-line no-restricted-syntax -- runs inside page.evaluate, cannot import shared helpers.
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    [panelId, text]
  );
  if (!result.ok) throw new Error(`ptySubmit failed: ${result.reason}`);
}

test.describe("Core: Terminal Layout Operations", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "layout-operations" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Layout Ops Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Split Divider Resize ───────────────────────────────────

  test("divider holds both grids past the lock TTL and watchdog tick, then converges", async () => {
    test.setTimeout(6 * T_LONG);
    const { window } = ctx;

    await resetToEmptyGrid(window);
    await spawnTerminalAndVerify(window);
    await spawnTerminalAndVerify(window);

    const panelIds = await getGridPanelIds(window);
    expect(panelIds).toHaveLength(2);

    const divider = window.getByRole("separator", { name: "Resize left pane" });
    await expect(divider).toBeVisible({ timeout: T_LONG });

    const baseline = await waitForConvergence(window, panelIds);
    const gridBox = await window.locator('[data-grid-container="true"]').boundingBox();
    const dividerBox = await divider.boundingBox();
    expect(gridBox).not.toBeNull();
    expect(dividerBox).not.toBeNull();

    const startX = dividerBox!.x + dividerBox!.width / 2;
    const y = dividerBox!.y + dividerBox!.height / 2;
    const targetX = gridBox!.x + gridBox!.width * 0.66;
    const baselineGrids = baseline.map(({ cols, rows, ptyCols, ptyRows }) => ({
      cols,
      rows,
      ptyCols,
      ptyRows,
    }));

    await window.mouse.move(startX, y);
    await window.mouse.down();
    let released = false;
    try {
      await window.mouse.move(targetX, y, { steps: 8 });

      // The controller's dead-man lock expires after 5s and the watchdog ticks
      // every 3s. The held-state assertion below proves the gesture re-arm owns
      // the grid throughout, regardless of the watchdog's interval phase. Do not
      // separately require the transient proposal state to paint within 3s.
      // timer: RESIZE_LOCK_TTL_MS (5s) + WATCHDOG_INTERVAL_MS (3s)
      await window.waitForTimeout(8_250);

      const held = await Promise.all(
        panelIds.map((panelId) => getTerminalGeometry(window, panelId))
      );
      expect(
        held.map((geometry) =>
          geometry
            ? {
                cols: geometry.cols,
                rows: geometry.rows,
                ptyCols: geometry.ptyCols,
                ptyRows: geometry.ptyRows,
              }
            : null
        )
      ).toEqual(baselineGrids);
      expect(held.every((geometry) => geometry && geometry.proposedCols !== geometry.cols)).toBe(
        true
      );
      const heldProposals = held.map((geometry) => ({
        cols: geometry!.proposedCols,
        rows: geometry!.proposedRows,
      }));

      await window.mouse.up();
      released = true;

      const final = await waitForConvergence(window, panelIds);
      expect(final.map(({ cols, rows }) => ({ cols, rows }))).toEqual(heldProposals);
    } finally {
      if (!released) await window.mouse.up().catch(() => undefined);
    }
  });

  // ── Terminal Isolation ─────────────────────────────────────

  test("flooding one terminal leaves another responsive, and the flooded one recovers", async () => {
    if (process.platform === "win32") {
      test.info().annotations.push({
        type: "platform-skip",
        description: "Terminal isolation tests use Unix shell loops",
      });
      test.skip(true, "Terminal isolation tests use Unix shell loops");
    }
    test.setTimeout(120_000);
    const { window } = ctx;

    await resetToEmptyGrid(window);
    for (let i = 0; i < 3; i++) {
      await spawnTerminalAndVerify(window);
    }
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);

    const ids = await getGridPanelIds(window);
    expect(ids.length).toBe(3);
    const floodPanelId = ids[0]!;
    const probePanelId = ids[1]!;
    const floodPanel = getPanelById(window, floodPanelId);
    const probePanel = getPanelById(window, probePanelId);

    await test.step("Flood one terminal while another answers a command", async () => {
      // Wait for shell readiness in both terminals
      await waitForTerminalText(floodPanel, "layout-operations", T_LONG);
      await waitForTerminalText(probePanel, "layout-operations", T_LONG);

      // Both active so neither is throttled by the background activity tier.
      await setActive(window, floodPanelId);
      await setActive(window, probePanelId);

      // An unthrottled builtin-echo loop: the flood saturates the flood pane's
      // PTY stream, which is what the probe has to stay isolated from.
      // The marker expands only when the loop body runs, so the echoed command
      // line cannot stand in for a flood that never started.
      await ptySubmit(window, floodPanelId, "while true; do echo FLOOD_$((7*6))_LINE; done");
      await waitForTerminalText(floodPanel, "FLOOD_42_LINE", T_LONG);

      // The arithmetic expands only when the shell runs the command, so the
      // echoed command line alone cannot satisfy the wait.
      await ptySubmit(window, probePanelId, "echo RESPONSE_$((40+2))");
      await waitForTerminalText(probePanel, "RESPONSE_42", T_LONG);
      expect(await getTerminalText(probePanel)).not.toContain("FLOOD_42_LINE");

      // Verify toolbar remains interactive (app is not frozen)
      await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible();
    });

    await test.step("Flooded terminal recovers after the flood is interrupted", async () => {
      // Ctrl+C straight to the PTY; the shell only runs the next line once the
      // loop has exited, so the recovered marker also proves the flood stopped.
      await ptyWrite(window, floodPanelId, "\x03");
      await ptyWrite(window, floodPanelId, "echo FLOOD_$((1+1))_RECOVERED\r");
      await waitForTerminalText(floodPanel, "FLOOD_2_RECOVERED", 60_000);
    });
  });

  // ── Grid Panel Reordering + Layout Undo/Redo (one journey over 3 panels) ──

  test.describe.serial("Grid Panel Reordering and Undo/Redo", () => {
    test.beforeAll(async () => {
      const { window } = ctx;
      await resetToEmptyGrid(window);
      await spawnTerminalAndVerify(window);
      await spawnTerminalAndVerify(window);
      await spawnTerminalAndVerify(window);
    });

    test("move focused panel right changes order", async () => {
      const { window } = ctx;

      const idsBefore = await getGridPanelIds(window);
      expect(idsBefore).toHaveLength(3);

      await focusPanel(window, idsBefore[0]);
      await dispatchAction(window, "terminal.moveRight");

      await expect
        .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
        .toEqual([idsBefore[1], idsBefore[0], idsBefore[2]]);
    });

    // Actions run in dispatch order, so a real move dispatched after the no-op
    // is a barrier: once its result renders, the no-op has had its turn. Moving
    // the middle panel down and back only lands on these exact orders when the
    // edge move left the grid alone.
    async function expectEdgeMoveIsNoOp(
      page: Page,
      edgeIndex: 0 | 2,
      action: "terminal.moveLeft" | "terminal.moveRight"
    ): Promise<void> {
      const idsBefore = await getGridPanelIds(page);
      await focusPanel(page, idsBefore[edgeIndex]);
      await dispatchAction(page, action);

      await focusPanel(page, idsBefore[1]);
      const barrier = edgeIndex === 0 ? "terminal.moveRight" : "terminal.moveLeft";
      const barrierOrder =
        edgeIndex === 0
          ? [idsBefore[0], idsBefore[2], idsBefore[1]]
          : [idsBefore[1], idsBefore[0], idsBefore[2]];
      await dispatchAction(page, barrier);
      await expect.poll(() => getGridPanelIds(page), { timeout: T_MEDIUM }).toEqual(barrierOrder);

      await dispatchAction(page, edgeIndex === 0 ? "terminal.moveLeft" : "terminal.moveRight");
      await expect.poll(() => getGridPanelIds(page), { timeout: T_MEDIUM }).toEqual(idsBefore);

      const idsAfter = await getGridPanelIds(page);
      expect(idsAfter).toEqual(idsBefore);
    }

    test("move first panel left is a no-op", async () => {
      await expectEdgeMoveIsNoOp(ctx.window, 0, "terminal.moveLeft");
    });

    test("move last panel right is a no-op", async () => {
      await expectEdgeMoveIsNoOp(ctx.window, 2, "terminal.moveRight");
    });

    test("undo restores previous panel order", async () => {
      const { window } = ctx;
      let idsBefore: string[] = [];

      await test.step("Move first panel right and verify reorder", async () => {
        idsBefore = await getGridPanelIds(window);
        await focusPanel(window, idsBefore[0]);
        await dispatchAction(window, "terminal.moveRight");

        await expect
          .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
          .toEqual([idsBefore[1], idsBefore[0], idsBefore[2]]);
      });

      await test.step("Dispatch layout.undo and verify original order is restored", async () => {
        await dispatchAction(window, "layout.undo");
        await expect.poll(() => getGridPanelIds(window), { timeout: T_MEDIUM }).toEqual(idsBefore);
      });
    });

    test("redo re-applies the layout change", async () => {
      const { window } = ctx;
      let idsBefore: string[] = [];

      await test.step("Dispatch layout.redo and verify reorder reapplies", async () => {
        idsBefore = await getGridPanelIds(window);
        await dispatchAction(window, "layout.redo");

        await expect
          .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
          .toEqual([idsBefore[1], idsBefore[0], idsBefore[2]]);
      });

      await test.step("Undo back to original order for subsequent tests", async () => {
        await dispatchAction(window, "layout.undo");
        await expect.poll(() => getGridPanelIds(window), { timeout: T_MEDIUM }).toEqual(idsBefore);
      });
    });
  });

  // ── Grid Layout Strategy ───────────────────────────────────

  test.describe.serial("Grid Layout Strategy", () => {
    let automaticColumns = 0;

    test.beforeAll(async () => {
      const { window } = ctx;
      await resetToEmptyGrid(window);
      await spawnTerminalAndVerify(window);
      await spawnTerminalAndVerify(window);
      await spawnTerminalAndVerify(window);
      await expect
        .poll(() => getPersistedGridStrategy(window), { timeout: T_MEDIUM })
        .toBe("automatic");
      automaticColumns = await getGridColumnCount(window);
    });

    test("switch to fixed-columns with value 3 updates grid", async () => {
      const { window } = ctx;

      await dispatchAction(window, "terminal.gridLayout.setStrategy", {
        strategy: "fixed-columns",
      });
      await dispatchAction(window, "terminal.gridLayout.setValue", { value: 3 });

      // Verify grid shows 3 columns via computed style
      await expect.poll(() => getGridColumnCount(window), { timeout: T_MEDIUM }).toBe(3);
    });

    test("switch to fixed-rows updates column count", async () => {
      const { window } = ctx;

      await dispatchAction(window, "terminal.gridLayout.setStrategy", {
        strategy: "fixed-rows",
      });
      await dispatchAction(window, "terminal.gridLayout.setValue", { value: 3 });

      // With 3 panels and 3 rows, columns = ceil(3/3) = 1
      await expect.poll(() => getGridColumnCount(window), { timeout: T_MEDIUM }).toBe(1);
    });

    test("restore automatic layout strategy", async () => {
      const { window } = ctx;
      await dispatchAction(window, "terminal.gridLayout.setStrategy", {
        strategy: "automatic",
      });

      // Automatic may also choose one column on a narrow runner viewport.
      // Check the persisted strategy as well as the grid's original geometry.
      await expect
        .poll(() => getPersistedGridStrategy(window), { timeout: T_MEDIUM })
        .toBe("automatic");

      await expect
        .poll(() => getGridColumnCount(window), { timeout: T_MEDIUM })
        .toBe(automaticColumns);
    });
  });

  // ── Dock Panel Activation ──────────────────────────────────

  test.describe.serial("Dock Panel Activation", () => {
    let dockIds: string[];

    test.beforeAll(async () => {
      const { window } = ctx;
      await resetToEmptyGrid(window);
      await spawnTerminalAndVerify(window);
      await spawnTerminalAndVerify(window);
      await spawnTerminalAndVerify(window);
    });

    test("move to dock and back while the grid remains active", async () => {
      const { window } = ctx;
      let dockedId = "";

      await test.step("Move first grid panel to dock and verify counts", async () => {
        const gridIds = await getGridPanelIds(window);
        expect(gridIds.length).toBeGreaterThanOrEqual(3);
        dockedId = gridIds[0]!;

        await dispatchAction(window, "terminal.moveToDock", { terminalId: dockedId });

        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
        await expect(window.locator(`[data-dock-portal-target="${dockedId}"]`)).toBeVisible({
          timeout: T_MEDIUM,
        });
      });

      await test.step("Move docked panel back to grid and verify restoration", async () => {
        await dispatchAction(window, "terminal.moveToGrid", { terminalId: dockedId });

        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(3);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
        await expect
          .poll(() => getDockPanelIds(window), { timeout: T_MEDIUM })
          .not.toContain(dockedId);
      });
    });

    test("creating a new dock terminal while another panel is docked keeps both rendered", async () => {
      const { window } = ctx;
      let dockedId = "";
      let newDockId = "";

      await test.step("Dock first grid panel as the existing docked terminal", async () => {
        const gridIds = await getGridPanelIds(window);
        expect(gridIds.length).toBeGreaterThanOrEqual(3);
        dockedId = gridIds[0]!;

        await dispatchAction(window, "terminal.moveToDock", { terminalId: dockedId });
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
      });

      await test.step("Launch a new dock terminal and verify both ids appear", async () => {
        const launchResult = (await dispatchAction(window, "agent.launch", {
          agentId: "terminal",
          location: "dock",
          cwd: fixtureDir,
        })) as { ok?: boolean; result?: { terminalId?: string | null } };
        expect(launchResult.ok).toBe(true);
        newDockId = launchResult.result?.terminalId ?? "";
        expect(newDockId).not.toBe("");

        await expect
          .poll(() => getDockPanelIds(window), { timeout: T_MEDIUM })
          .toEqual(expect.arrayContaining([dockedId, newDockId]));
      });

      await test.step("Kill the new dock terminal and restore the original docked panel to grid", async () => {
        await dispatchAction(
          window,
          "terminal.kill",
          { terminalId: newDockId },
          { source: "user", confirmed: true }
        );
        await dispatchAction(window, "terminal.moveToGrid", { terminalId: dockedId });

        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(3);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
      });
    });

    test("move all panels to dock", async () => {
      const { window } = ctx;

      await test.step("Move every grid panel to dock", async () => {
        const gridIds = await getGridPanelIds(window);
        for (const [index, id] of gridIds.entries()) {
          await dispatchAction(window, "terminal.moveToDock", { terminalId: id });
          await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(index + 1);
        }
      });

      await test.step("Verify grid is empty and dock holds all 3 panels", async () => {
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(3);

        dockIds = await getDockPanelIds(window);
        expect(dockIds).toHaveLength(3);
      });
    });

    test("click dock item opens popover with terminal content", async () => {
      const { window } = ctx;
      const anyPortal = window.locator("[data-dock-portal-target]");

      await window.locator(SEL.toolbar.toggleSidebar).click();
      await window.locator(SEL.toolbar.toggleSidebar).click();
      await expect(anyPortal).not.toBeVisible({ timeout: T_SHORT });

      const dock = window.locator(SEL.dock.container);
      const firstButton = dock.locator(`[aria-label*="Click to preview"]`).first();
      await firstButton.click();

      const portalTarget = window.locator(`[data-dock-portal-target="${dockIds[0]}"]`);
      await expect(portalTarget).toBeVisible({ timeout: T_MEDIUM });
      // The popover is only a slot; the terminal itself has to be moved into it.
      await expect(portalTarget.locator(".xterm-screen")).toBeVisible({ timeout: T_MEDIUM });
    });

    test("click different dock item switches active panel", async () => {
      const { window } = ctx;

      const dock = window.locator(SEL.dock.container);
      const buttons = dock.locator(`[aria-label*="Click to preview"]`);
      const count = await buttons.count();
      expect(count).toBeGreaterThanOrEqual(2);

      await buttons.nth(1).click();

      const newPortal = window.locator(`[data-dock-portal-target="${dockIds[1]}"]`);
      await expect(newPortal).toBeVisible({ timeout: T_MEDIUM });
      await expect(newPortal.locator(".xterm-screen")).toBeVisible({ timeout: T_MEDIUM });

      const oldPortal = window.locator(`[data-dock-portal-target="${dockIds[0]}"]`);
      await expect(oldPortal).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
