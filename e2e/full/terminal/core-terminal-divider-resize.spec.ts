import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelIds } from "../../helpers/panels";
import { T_LONG, T_SHORT } from "../../helpers/timeouts";
import { spawnTerminalAndVerify } from "../../helpers/workflows";

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

test.describe.serial("Terminal divider resize coordination", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "divider-resize" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Divider Resize");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("holds both grids past the lock TTL and watchdog tick, then converges", async () => {
    test.setTimeout(6 * T_LONG);
    const { window } = ctx;

    await spawnTerminalAndVerify(window);
    await spawnTerminalAndVerify(window);

    const panelIds = await getGridPanelIds(window);
    expect(panelIds).toHaveLength(2);

    const divider = window.getByRole("separator", { name: "Resize panels" });
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
});
