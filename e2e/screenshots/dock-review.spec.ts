/**
 * Dock design-review capture.
 *
 * Frames the dock and everything that can sit in it: the launch button, agent
 * chips in each state, a plain terminal, a browser, a file viewer, a tab group,
 * the project-wide status tray (Needs attention, Background, Trash), every
 * popover those open, the right-click menu, keyboard focus, overflow with its
 * scroll chevrons, the three densities, the empty dock, and a theme sweep. It
 * boots the real app on the "Atlas Ledger" showcase project with fake agent
 * CLIs driving the app's own state detection.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_DOCK=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots dock-review --workers=1
 *
 * Knobs: DAINTREE_SHOT_THEMES (comma list for the sweep; "none" skips it).
 *
 * Strip crops are rendered at 2x through CDP so a 12px glyph is legible.
 * Every state is verified painted before its PNG is written, and the run fails
 * listing every state it could not produce.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme/index.js";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { getGridPanelIds } from "../helpers/panels";
import {
  WINDOW,
  createFixture,
  settle,
  polish,
  act,
  worktreeIdFor,
  ensureWindowSize,
  parkPointer,
} from "./atlasLedgerShowcase";

const ENABLED = process.env.DAINTREE_SHOT_DOCK === "1";
const OUT = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEME_FILTER = (process.env.DAINTREE_SHOT_THEMES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SWEEP_THEMES =
  THEME_FILTER[0] === "none"
    ? []
    : BUILT_IN_APP_SCHEMES.map((s) => s.id).filter(
        (id) => THEME_FILTER.length === 0 || THEME_FILTER.includes(id)
      );
const FOCUS_BRANCH = "feature/settlement-export";
const ADD_TAB = '[aria-label="Duplicate panel as new tab"]';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function capture(page: Page, file: string, clip?: Rect, scale = 1): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = (await cdp.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale } } : {}),
    })) as { data: string };
    writeFileSync(file, Buffer.from(data, "base64"));
  } finally {
    await cdp.detach().catch(() => {});
  }
  if (!existsSync(file) || statSync(file).size < 3_000) {
    throw new Error(`capture ${path.basename(file)} missing or implausibly small`);
  }
}

async function boxOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box || box.width < 2 || box.height < 2) throw new Error("element has no painted box");
  return box;
}

function around(boxes: Rect[], pad = 24): Rect {
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.min(WINDOW.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const y1 = Math.min(WINDOW.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

async function escapeAll(page: Page, times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(120);
  }
}

async function newGridPanelId(page: Page, before: Set<string>): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(
      async () => {
        found = (await getGridPanelIds(page)).find((id) => !before.has(id));
        return found ?? null;
      },
      { timeout: T_LONG, message: "new grid panel never appeared" }
    )
    .not.toBeNull();
  return found!;
}

test("dock — every item kind, its popovers, densities, overflow, theme sweep", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DOCK=1 is required for the dock capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_DOCK=1 to capture the dock review");
  test.setTimeout(30 * 60_000);
  if (!OUT || !path.isAbsolute(OUT)) {
    throw new Error("DESIGN_CAPTURE_DIR must be an absolute path outside the repo");
  }
  if (path.resolve(OUT).startsWith(path.resolve(process.cwd()) + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo: ${OUT}`);
  }
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith(".png")) rmSync(path.join(OUT, f));

  const failures = new Map<string, string>();
  const written: string[] = [];
  const fixture = createFixture();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "atlas-dock-userdata-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      homeDir: fixture.home,
      screenshotScale: "2",
      windowSize: WINDOW,
      env: {
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fixture.bin,
        DAINTREE_IDENTITY_DEBUG_PASS: "1",
      },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, fixture.repo, "Atlas Ledger");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id)
        await window.electron.project.update(cur.id, { emoji: "📒", name: "Atlas Ledger" });
    });
    await ensureWindowSize(page, ctx.app);
    await setAppTheme(page, "daintree");
    await polish(page);
    await dismissBlockingPalette(page).catch(() => {});
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });

    const dock = page.locator(SEL.dock.container).first();
    const rail = page.locator(SEL.dock.rail).first();

    const launch = async (
      agentId: string,
      worktreeId: string,
      location: "grid" | "dock"
    ): Promise<string> => {
      const launched = await act<{ terminalId: string }>(page, "agent.launch", {
        agentId,
        worktreeId,
        location,
        force: true,
        focusPolicy: "preserve",
      });
      if (!launched?.terminalId) throw new Error(`agent.launch ${agentId} returned no terminal`);
      return launched.terminalId;
    };
    const newShell = async (): Promise<string> => {
      const before = new Set(await getGridPanelIds(page));
      await act(page, "terminal.new", {});
      return newGridPanelId(page, before);
    };

    // Other worktrees carry agents in the grid, so the project-wide tray counts.
    await launch("antigravity", await worktreeIdFor(page, "refactor/matcher"), "grid");
    await launch("claude", await worktreeIdFor(page, "chore/deps"), "grid");

    const focusId = await worktreeIdFor(page, FOCUS_BRANCH);
    await act(page, "worktree.select", { worktreeId: focusId });
    await settle(page, 800);
    const ids: Record<string, string> = {};
    ids.claude = await launch("claude", focusId, "dock");
    ids.codex = await launch("codex", focusId, "dock");
    ids.agy = await launch("antigravity", focusId, "dock");
    ids.opencode = await launch("opencode", focusId, "dock");
    ids.shell = await newShell();
    await act(page, "terminal.moveToDock", { terminalId: ids.shell });
    ids.browser = await launch("browser", focusId, "dock");
    // A grid pane stays open: the dock sits under a working grid, and an empty
    // grid raises the new-panel palette over everything.
    ids.gridShell = await newShell();
    await expect
      .poll(() => page.locator(`${SEL.dock.rail} ${SEL.dock.chip}`).count(), {
        timeout: T_LONG * 2,
      })
      .toBeGreaterThanOrEqual(6);
    // Let the fake CLIs draw their sessions and the state detector settle.
    await page.waitForTimeout(9000);
    await escapeAll(page);

    const shoot = async (slug: string, clip?: Rect, scale = 1) => {
      const file = path.join(OUT, `${slug}.png`);
      await capture(page, file, clip, scale);
      written.push(path.basename(file));
    };
    const step = async (name: string, run: () => Promise<void>) => {
      try {
        await polish(page);
        await dismissBlockingPalette(page).catch(() => {});
        await run();
        console.log(`[dock] ${name} ok`);
      } catch (error) {
        failures.set(name, String(error).slice(0, 400));
        console.warn(`[dock] ${name} FAILED: ${String(error).slice(0, 400)}`);
      } finally {
        await escapeAll(page);
        await settle(page, 300);
      }
    };
    /** The whole dock strip, 2x. */
    const strip = async (slug: string) => {
      const box = await boxOf(dock);
      await shoot(slug, { x: box.x, y: box.y - 6, width: box.width, height: box.height + 6 });
    };
    /** The bottom of the window: the strip plus whatever floats above it. */
    const bottom = async (slug: string, height = 560) => {
      await shoot(slug, { x: 0, y: WINDOW.height - height, width: WINDOW.width, height });
    };
    const closeDockPopovers = async () => {
      // A preview's focus sits in its terminal, which keeps Escape for itself;
      // a user closes it by clicking its chip again.
      const openChips = page.locator(
        `${SEL.dock.container} [data-dock-item][aria-expanded="true"]`
      );
      for (let i = 0; i < 4 && (await openChips.count()) > 0; i++) {
        await openChips.first().click();
        await settle(page, 300);
      }
      await escapeAll(page);
      await dismissBlockingPalette(page).catch(() => {});
      await settle(page, 400);
      const open = await page.locator('[role="dialog"]:visible, [role="menu"]:visible').count();
      if (open > 0) throw new Error(`${open} overlay(s) still open over the dock`);
    };
    /** A point on the dock that belongs to no chip or pill: the tray's caption. */
    const dockBackground = () => page.locator(".dock-status-tray-scope:visible").first();
    const chip = (panelId: string) =>
      page.locator(`${SEL.dock.rail} [data-dock-item-id="${panelId}"] ${SEL.dock.chip}`).first();
    const dumpLayout = async (slug: string) => {
      const layout = await page.evaluate(() => {
        const box = (el: Element) => {
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        };
        return {
          chips: Array.from(document.querySelectorAll("#dock-container [data-dock-item]")).map(
            (el) => ({ label: el.getAttribute("aria-label"), rect: box(el) })
          ),
          tray: Array.from(document.querySelectorAll(".dock-status-tray button")).map((el) => ({
            label: el.getAttribute("aria-label"),
            rect: box(el),
          })),
          active: document.activeElement?.getAttribute("aria-label") ?? null,
        };
      });
      writeFileSync(path.join(OUT, `${slug}.layout.json`), JSON.stringify(layout, null, 2));
    };

    // ---- The populated dock at rest ---------------------------------------
    await step("01-rest", async () => {
      await closeDockPopovers();
      await parkPointer(page);
      await settle(page, 1200);
      await strip("01-rest-strip");
      await bottom("01-rest-window", 1000);
      await dumpLayout("01-rest");
    });

    // ---- The tray populated: Background, Trash -----------------------------
    await step("02-tray", async () => {
      const bg = await newShell();
      await act(page, "terminal.background", { terminalId: bg });
      const trashed = await newShell();
      await act(page, "terminal.trash", { terminalId: trashed });
      await page.locator('[data-testid="trash-container"]').first().waitFor({
        state: "visible",
        timeout: T_LONG,
      });
      await closeDockPopovers();
      await parkPointer(page);
      await settle(page, 1200);
      await strip("02-tray-strip");
      await dumpLayout("02-tray");
    });

    // ---- Pointer and keyboard states on a chip -------------------------------
    await step("03-hover", async () => {
      await chip(ids.codex!).hover();
      await settle(page, 900);
      await bottom("03-chip-hover", 200);
    });

    await step("04-focus", async () => {
      await parkPointer(page);
      await chip(ids.claude!).focus();
      await page.keyboard.press("ArrowRight");
      await settle(page, 700);
      await strip("04-chip-focus-strip");
      await dumpLayout("04-focus");
    });

    // ---- Popovers ---------------------------------------------------------
    const popover = async (slug: string, open: () => Promise<Locator>) => {
      await closeDockPopovers();
      const surface = await open();
      await surface.waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 900);
      await shoot(slug, around([await boxOf(surface), await boxOf(dock)], 16));
    };

    await step("05-agent-popover", async () => {
      await popover("05-agent-popover", async () => {
        await chip(ids.agy!).click();
        return page.locator('[aria-label^="Preview:"]').last();
      });
    });

    await step("06-browser-popover", async () => {
      await popover("06-browser-popover", async () => {
        await chip(ids.browser!).click();
        return page.locator('[aria-label^="Preview:"]').last();
      });
    });

    await step("07-launch-menu", async () => {
      await popover("07-launch-menu", async () => {
        await dock.locator("button").first().click();
        return page.locator('[role="dialog"]').last();
      });
    });

    await step("08-context-menu", async () => {
      await popover("08-context-menu", async () => {
        await dockBackground().click({ button: "right" });
        return page.locator('[role="menu"]').last();
      });
    });

    await step("09-attention-popover", async () => {
      await popover("09-attention-popover", async () => {
        await page.locator('.dock-status-tray button[aria-label^="Attention"]').first().click();
        return page.locator('[aria-label="Agents needing attention"]').last();
      });
    });

    await step("10-background-popover", async () => {
      await popover("10-background-popover", async () => {
        await page.locator('.dock-status-tray button[aria-label^="Background"]').first().click();
        return page.locator('[aria-label="Backgrounded panels"]').last();
      });
    });

    await step("11-trash-popover", async () => {
      // Trash entries expire after a few seconds, so trash one right here.
      await act(page, "terminal.trash", { terminalId: await newShell() });
      await popover("11-trash-popover", async () => {
        await page.locator('[data-testid="trash-container"]').first().click();
        return page.locator('[aria-label="Recently closed panels"]').last();
      });
    });

    await step("12-chip-context-menu", async () => {
      await popover("12-chip-context-menu", async () => {
        await chip(ids.codex!).click({ button: "right" });
        return page.locator('[role="menu"]').last();
      });
    });

    // ---- A tab group, a file viewer, then overflow ---------------------------
    await step("13-tab-group", async () => {
      await closeDockPopovers();
      const group = await newShell();
      const pane = page.locator(`[data-panel-id="${group}"]`).first();
      await pane.locator("[data-pane-chrome]").first().hover();
      await pane.locator(ADD_TAB).first().click({ force: true });
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              Array.from(
                document.querySelectorAll('[data-panel-id][data-panel-location="grid"]')
              ).some((el) => el.querySelectorAll('[role="tab"]').length > 1)
            ),
          { timeout: T_LONG }
        )
        .toBe(true);
      await settle(page, 600);
      await act(page, "terminal.moveToDock", { terminalId: group });
      const groupChip = page
        .locator(
          `${SEL.dock.rail} ${SEL.dock.chip}[aria-label*="tab"], ${SEL.dock.rail} [data-dock-item-id="${group}"] ${SEL.dock.chip}`
        )
        .first();
      await groupChip.waitFor({ state: "visible", timeout: T_LONG });
      ids.group = group;
      await closeDockPopovers();
      await parkPointer(page);
      await settle(page, 900);
      await strip("13-tab-group-strip");
      await popover("14-tab-group-popover", async () => {
        await groupChip.click();
        return page.locator('[aria-label^="Preview:"]').last();
      });
    });

    await step("15-overflow", async () => {
      await closeDockPopovers();
      const beforeFile = new Set(await getGridPanelIds(page));
      await act(page, "file.openPanel", { path: "README.md" });
      const file = await newGridPanelId(page, beforeFile);
      await act(page, "terminal.moveToDock", { terminalId: file });
      await launch("browser", focusId, "dock");
      await launch("claude", focusId, "dock");
      await launch("codex", focusId, "dock");
      await settle(page, 4000);
      await closeDockPopovers();
      await parkPointer(page);
      await settle(page, 1200);
      await strip("15-overflow-strip");
      await dumpLayout("15-overflow");
      // Scrolled to the far end, so the left chevron shows.
      await rail.evaluate((el) => (el.scrollLeft = el.scrollWidth));
      await settle(page, 700);
      await strip("16-overflow-scrolled-strip");
    });

    // ---- Densities --------------------------------------------------------
    await step("17-densities", async () => {
      await rail.evaluate((el) => (el.scrollLeft = 0));
      for (const density of ["compact", "comfortable"] as const) {
        // Set the way a user sets it: the dock's own right-click menu.
        await dockBackground().click({ button: "right" });
        await page.getByRole("menuitem", { name: "Dock density" }).hover();
        await page
          .getByRole("menuitemradio", { name: density === "compact" ? "Compact" : "Comfortable" })
          .press("Enter");
        await expect(dock).toHaveAttribute("data-dock-density", density, { timeout: T_LONG });
        await parkPointer(page);
        await settle(page, 900);
        await strip(`17-density-${density}-strip`);
      }
      await dockBackground().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Dock density" }).hover();
      await page.getByRole("menuitemradio", { name: "Normal" }).press("Enter");
      await expect(dock).toHaveAttribute("data-dock-density", "normal", { timeout: T_LONG });
    });

    // ---- The empty dock ----------------------------------------------------
    await step("18-empty", async () => {
      await act(page, "worktree.select", {
        worktreeId: await worktreeIdFor(page, "fix/fx-rounding"),
      });
      await parkPointer(page);
      await settle(page, 1500);
      await strip("18-empty-strip");
      await act(page, "worktree.select", { worktreeId: focusId });
      await settle(page, 800);
    });

    // ---- Contrast modes: an open chip, then the same chip focused ----------
    await step("19-contrast-modes", async () => {
      await closeDockPopovers();
      await rail.evaluate((el) => (el.scrollLeft = 0));
      await chip(ids.codex!).click();
      await page.locator('[aria-label^="Preview:"]').last().waitFor({ state: "visible" });
      const cdp = await page.context().newCDPSession(page);
      try {
        for (const [slug, feature] of [
          ["19-contrast-more", { name: "prefers-contrast", value: "more" }],
          ["19-forced-colors", { name: "forced-colors", value: "active" }],
        ] as const) {
          await cdp.send("Emulation.setEmulatedMedia", { features: [feature] });
          // The previous mode's focused frame left focus on the chip.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await parkPointer(page);
          await settle(page, 800);
          await strip(`${slug}-open-strip`);
          // Keyboard focus onto the open chip: focus must still read over open.
          await chip(ids.codex!).focus();
          await page.keyboard.press("ArrowRight");
          await page.keyboard.press("ArrowLeft");
          await settle(page, 500);
          await strip(`${slug}-open-focused-strip`);
        }
      } finally {
        await cdp.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
        await cdp.detach().catch(() => {});
      }
    });

    // ---- Theme sweep of the populated strip --------------------------------
    for (const themeId of SWEEP_THEMES) {
      const slug = `30-theme-${themeId}`;
      try {
        await setAppTheme(page, themeId);
        await polish(page);
        await dismissBlockingPalette(page).catch(() => {});
        await act(page, "worktree.select", { worktreeId: focusId });
        await rail.evaluate((el) => (el.scrollLeft = 0));
        await parkPointer(page);
        await settle(page, 1200);
        await strip(slug);
      } catch (error) {
        failures.set(slug, String(error).slice(0, 300));
      }
    }
    await setAppTheme(page, "daintree").catch(() => {});

    writeFileSync(
      path.join(OUT, "manifest.json"),
      JSON.stringify({ written, failures: Object.fromEntries(failures) }, null, 2)
    );
    console.log(`[dock] wrote ${written.length} captures, ${failures.size} failures`);
    expect(
      [...failures.entries()].map(([k, v]) => `${k}: ${v}`),
      "every dock state captured"
    ).toEqual([]);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    fixture.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
