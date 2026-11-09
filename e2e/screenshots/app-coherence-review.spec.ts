/**
 * Whole-app coherence review capture.
 *
 * The other review harnesses each frame one surface. This one frames the
 * window as a whole, so a reviewer can judge whether the title bar, the
 * sidebar, the pane headers, the grid, the dock and every floating surface
 * read as one system: the same control heights, radii, dividers, type and
 * icon sizes from one region to the next. It boots the real app on the
 * "Atlas Ledger" showcase project, runs fake agent CLIs that drive the app's
 * own state detection, and reaches every state the way a user would (an
 * action dispatch, a click, a right-click).
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_COHERENCE=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots app-coherence-review --workers=1
 *
 * Knobs: DAINTREE_SHOT_ONLY (comma list of step names), DAINTREE_SHOT_THEMES
 * (comma list for the theme sweep; "none" skips it).
 *
 * After the theme sweep it widens to the rest of the app, so the shell's
 * vocabulary can be checked against every other surface: Pilot, Review Hub,
 * the Assistant, toasts, the theme browser, the agent, panel and quick-create
 * palettes, the delete-worktree and terminal-info dialogs, a sheet of Settings
 * pages, and a file-browser pane in the grid (last, since it changes the grid).
 *
 * Every state is verified painted before its PNG is written, and the run
 * fails listing every state it could not produce, so a missing file is never
 * silent. Overlay states also write a crop around the overlay and its trigger
 * (`<step>--crop.png`), since a full window shrinks a menu row to a few pixels.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme/index.js";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { injectToast, resetNotifications } from "../helpers/notifications";
import {
  WINDOW,
  createFixture,
  settle,
  polish,
  act,
  worktreeIdFor,
  ensureWindowSize,
  parkPointer,
} from "../helpers/atlasLedgerShowcase";

const ENABLED = process.env.DAINTREE_SHOT_COHERENCE === "1";
const OUT = process.env.DESIGN_CAPTURE_DIR ?? "";
const SCALE = 2;
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
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

/** Agents in the focus worktree, in launch order (grid order). */
const FOCUS_AGENTS = [
  { agentId: "claude", key: "claude" },
  { agentId: "codex", key: "codex" },
  { agentId: "antigravity", key: "agy" },
] as const;
/** One agent in each of two other worktrees, so their sidebar cards carry state. */
const SIDE_AGENTS = [
  { agentId: "opencode", branch: "test/reconcile-fixtures" },
  { agentId: "claude", branch: "chore/deps" },
] as const;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function capture(page: Page, file: string, clip?: Rect): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = (await cdp.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    })) as { data: string };
    writeFileSync(file, Buffer.from(data, "base64"));
  } finally {
    await cdp.detach().catch(() => {});
  }
  if (!existsSync(file) || statSync(file).size < 4_000) {
    throw new Error(`capture ${path.basename(file)} missing or implausibly small`);
  }
}

async function boxOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box || box.width < 2 || box.height < 2) throw new Error("element has no painted box");
  return box;
}

/**
 * A modal's role="dialog" node can be a full-window wrapper; crop to the
 * largest descendant that is visibly smaller than the window instead.
 */
async function framedBox(locator: Locator): Promise<Rect> {
  const box = await boxOf(locator);
  if (box.width * box.height < WINDOW.width * WINDOW.height * 0.8) return box;
  const inner = await locator.evaluate((root, limit) => {
    // Measured by the part on screen: a long page's scroll content can be
    // taller than the window, and its full box would outrank the dialog.
    let best: { x: number; y: number; width: number; height: number } | null = null;
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left);
      const y = Math.max(0, r.top);
      const width = Math.min(window.innerWidth, r.right) - x;
      const height = Math.min(window.innerHeight, r.bottom) - y;
      const area = width * height;
      if (width < 300 || height < 100 || area >= limit) continue;
      if (!best || area > best.width * best.height) best = { x, y, width, height };
    }
    return best;
  }, WINDOW.width * WINDOW.height * 0.8);
  if (!inner) throw new Error("no framed surface inside the overlay");
  return inner;
}

function around(boxes: Rect[], pad = 48): Rect {
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

test("app coherence — whole window, floating surfaces, theme sweep", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COHERENCE=1 is required for the coherence capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_COHERENCE=1 to capture the coherence review");
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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "atlas-coherence-userdata-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      homeDir: fixture.home,
      screenshotScale: String(SCALE),
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

    const launch = async (agentId: string, worktreeId: string): Promise<string> => {
      const launched = await act<{ terminalId: string }>(page, "agent.launch", {
        agentId,
        worktreeId,
        location: "grid",
        force: true,
        focusPolicy: "preserve",
      });
      if (!launched?.terminalId) throw new Error(`agent.launch ${agentId} returned no terminal`);
      return launched.terminalId;
    };

    for (const side of SIDE_AGENTS) await launch(side.agentId, await worktreeIdFor(page, side.branch));
    const focusId = await worktreeIdFor(page, FOCUS_BRANCH);
    await act(page, "worktree.select", { worktreeId: focusId });
    const ids: Record<string, string> = {};
    for (const a of FOCUS_AGENTS) ids[a.key] = await launch(a.agentId, focusId);
    const shell = await act<{ terminalId?: string; id?: string }>(page, "terminal.new").catch(
      () => undefined
    );
    ids.shell = shell?.terminalId ?? shell?.id ?? "";
    await expect
      .poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG * 2 })
      .toBeGreaterThanOrEqual(4);
    // Let the fake CLIs draw their sessions and the state detector settle.
    await page.waitForTimeout(9000);

    const want = (step: string) => ONLY.length === 0 || ONLY.includes(step);
    const shoot = async (slug: string, clip?: Rect) => {
      const file = path.join(OUT, `${slug}.png`);
      await capture(page, file, clip);
      written.push(path.basename(file));
    };
    const step = async (name: string, run: () => Promise<void>) => {
      if (!want(name)) return;
      try {
        await polish(page);
        await run();
        console.log(`[coherence] ${name} ok`);
      } catch (error) {
        failures.set(name, String(error).slice(0, 400));
        console.warn(`[coherence] ${name} FAILED: ${String(error).slice(0, 400)}`);
      } finally {
        await escapeAll(page);
        await settle(page, 300);
      }
    };
    const restShot = async (slug: string) => {
      await parkPointer(page);
      await settle(page, 1200);
      await shoot(slug);
    };

    // ---- The resting window --------------------------------------------
    await step("01-shell", async () => {
      await act(page, "worktree.select", { worktreeId: focusId });
      await restShot("01-shell");
      // Geometry sidecar: where each sidebar card's age lands and which boxes
      // hold it, so an off-column age can be traced without guessing.
      const layout = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-worktree-row]")).map((row) => {
          const ages = Array.from(row.querySelectorAll("span, time, div")).filter((el) =>
            /^\d+[smhd]$/.test((el.textContent ?? "").trim())
          );
          const age = ages[ages.length - 1];
          const chain: string[] = [];
          for (let el = age; el && el !== row; el = el.parentElement)
            chain.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 160)}`);
          const r = age?.getBoundingClientRect();
          return {
            branch: row.querySelector("[data-worktree-branch]")?.getAttribute("data-worktree-branch"),
            age: r ? { x: r.x, right: r.right, y: r.y } : null,
            chain,
          };
        })
      );
      writeFileSync(path.join(OUT, "01-shell.layout.json"), JSON.stringify(layout, null, 2));
      const toolbar = await boxOf(page.locator("header, [data-toolbar-root], [role='toolbar']").first());
      const sidebar = await boxOf(page.locator(SEL.sidebar.aside).first());
      // Title bar meeting the sidebar: the top-left corner of the window.
      await shoot("02-corner-titlebar-sidebar", {
        x: 0,
        y: 0,
        width: Math.min(WINDOW.width, sidebar.width + 420),
        height: Math.min(WINDOW.height, toolbar.height + 300),
      });
      // The top band of the grid: pane headers side by side, under the title bar.
      const grid = await boxOf(page.locator("#panel-grid").first());
      await shoot("03-pane-header-band", {
        x: grid.x,
        y: 0,
        width: grid.width,
        height: Math.min(WINDOW.height, grid.y + 120),
      });
      // The full sidebar column.
      await shoot("04-sidebar-column", { x: 0, y: 0, width: sidebar.width + 24, height: WINDOW.height });
      // Bottom edge: dock, quick-run and how the grid ends.
      await shoot("05-bottom-edge", {
        x: 0,
        y: WINDOW.height - 220,
        width: WINDOW.width,
        height: 220,
      });
    });

    // ---- Dropdowns, menus, popovers -------------------------------------
    const overlay = async (
      slug: string,
      open: () => Promise<Locator>,
      trigger?: Locator
    ): Promise<void> => {
      const surface = await open();
      await surface.waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 700);
      const boxes = [await framedBox(surface)];
      if (trigger) boxes.push(await boxOf(trigger));
      await shoot(slug);
      await shoot(`${slug}--crop`, around(boxes));
    };

    await step("10-project-switcher", async () => {
      const trigger = page.locator(SEL.toolbar.projectSwitcherTrigger).first();
      await overlay(
        "10-project-switcher",
        async () => {
          await trigger.click();
          return page.locator(SEL.projectSwitcher.palette).first();
        },
        trigger
      );
    });

    await step("11-pane-overflow-menu", async () => {
      const pane = page.locator(`[data-panel-id="${ids.claude}"]`).first();
      const trigger = pane.locator(SEL.panel.overflowMenu).first();
      await overlay(
        "11-pane-overflow-menu",
        async () => {
          await trigger.click();
          return page.locator('[role="menu"]').last();
        },
        trigger
      );
    });

    await step("12-worktree-actions-menu", async () => {
      const card = page.locator(SEL.worktree.row(FOCUS_BRANCH)).first();
      await card.hover();
      const trigger = card.locator(SEL.worktree.actionsMenu).first();
      await overlay(
        "12-worktree-actions-menu",
        async () => {
          await trigger.click();
          return page.locator('[role="menu"]').last();
        },
        trigger
      );
    });

    await step("13-worktree-context-menu", async () => {
      const card = page.locator(SEL.worktree.row("refactor/matcher")).first();
      await overlay(
        "13-worktree-context-menu",
        async () => {
          await card.click({ button: "right" });
          return page.locator('[role="menu"]').last();
        },
        card
      );
    });

    await step("14-terminal-context-menu", async () => {
      const body = page.locator(`[data-panel-id="${ids.codex}"] ${SEL.terminal.xtermRows}`).first();
      await overlay("14-terminal-context-menu", async () => {
        await body.click({ button: "right", position: { x: 260, y: 120 } });
        return page.locator('[role="menu"]').last();
      });
    });

    await step("15-notification-center", async () => {
      const bell = page.locator(SEL.notifications.bellButton).first();
      await overlay(
        "15-notification-center",
        async () => {
          await bell.click();
          return page.locator('[role="dialog"], [data-radix-popper-content-wrapper]').last();
        },
        bell
      );
    });

    await step("16-worktree-filter-popover", async () => {
      const trigger = page.locator(SEL.worktree.filterButton).first();
      await overlay(
        "16-worktree-filter-popover",
        async () => {
          await trigger.click();
          return page.locator(SEL.worktree.filterPopover).first();
        },
        trigger
      );
    });

    // ---- Palettes and dialogs --------------------------------------------
    await step("20-action-palette", async () => {
      await overlay("20-action-palette", async () => {
        await act(page, "action.palette.open");
        return page.locator('[role="dialog"]').last();
      });
    });

    await step("21-quick-switcher", async () => {
      await overlay("21-quick-switcher", async () => {
        await act(page, "nav.quickSwitcher");
        return page.locator('[role="dialog"]').last();
      });
    });

    await step("22-new-worktree-dialog", async () => {
      await overlay("22-new-worktree-dialog", async () => {
        await act(page, "worktree.createDialog.open");
        return page.locator(SEL.worktree.newDialog).first();
      });
    });

    await step("23-settings", async () => {
      await overlay("23-settings", async () => {
        await act(page, "app.settings");
        return page.locator('[role="dialog"].settings-shell, [role="dialog"]:has(.settings-sidebar)').first();
      });
    });

    await step("24-worktree-overview", async () => {
      await act(page, "worktree.overview.open");
      const modal = page.locator(SEL.worktree.overviewModal).first();
      await modal.waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 1200);
      await shoot("24-worktree-overview");
    });

    // ---- Layout variants -------------------------------------------------
    await step("30-dock", async () => {
      if (!ids.shell) throw new Error("no plain terminal to dock");
      await act(page, "terminal.moveToDock", { terminalId: ids.shell });
      await page.locator(SEL.dock.chip).first().waitFor({ state: "visible", timeout: T_LONG });
      // Docking a focused terminal opens its popover; shoot that, then the dock at rest.
      await settle(page, 800);
      await shoot("33-dock-popover");
      await escapeAll(page);
      await page.mouse.click(WINDOW.width - 300, 400).catch(() => {});
      await restShot("30-dock");
      await shoot("31-dock-edge", {
        x: 0,
        y: WINDOW.height - 160,
        width: WINDOW.width,
        height: 160,
      });
    });

    await step("32-empty-worktree", async () => {
      // fix/fx-rounding runs no agents, so its grid is the empty state.
      await act(page, "worktree.select", { worktreeId: await worktreeIdFor(page, "fix/fx-rounding") });
      await restShot("32-empty-worktree");
      await act(page, "worktree.select", { worktreeId: focusId });
      await settle(page, 600);
    });

    // ---- Theme sweep of the resting window --------------------------------
    if (want("40-themes")) {
      for (const themeId of SWEEP_THEMES) {
        const slug = `40-theme-${themeId}`;
        try {
          await setAppTheme(page, themeId);
          await polish(page);
          await dismissBlockingPalette(page).catch(() => {});
          await act(page, "worktree.select", { worktreeId: focusId });
          await restShot(slug);
        } catch (error) {
          failures.set(slug, String(error).slice(0, 300));
        }
      }
      await setAppTheme(page, "daintree").catch(() => {});
    }

    // ---- The rest of the app ----------------------------------------------
    const dialogShot = async (slug: string, open: () => Promise<Locator>) => {
      const surface = await open();
      await surface.waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 900);
      await shoot(slug);
      await shoot(`${slug}--crop`, around([await framedBox(surface)], 24));
    };

    await step("50-pilot", async () => {
      await act(page, "pilot.toggle");
      const dialog = page.locator('[role="dialog"][aria-label="All agents"]');
      await dialog.waitFor({ state: "visible", timeout: T_LONG });
      await expect
        .poll(() => dialog.getByTestId("pilot-row").count(), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(3);
      await settle(page, 900);
      await shoot("50-pilot");
    });

    await step("51-review-hub", async () => {
      await dialogShot("51-review-hub", async () => {
        await act(page, "worktree.openReviewHub", { worktreeId: focusId });
        return page.locator(SEL.reviewHub.container).first();
      });
    });

    await step("52-delete-worktree-dialog", async () => {
      await dialogShot("52-delete-worktree-dialog", async () => {
        await page.locator(SEL.worktree.row("refactor/matcher")).first().click({ button: "right" });
        await page.getByRole("menuitem", { name: /Delete worktree/ }).first().click();
        return page.locator(SEL.worktree.deleteDialog).first();
      });
    });

    await step("53-assistant", async () => {
      await act(page, "help.togglePanel");
      await page
        .locator('aside[aria-label="Daintree Assistant"]')
        .waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 900);
      await shoot("53-assistant");
      await act(page, "help.togglePanel").catch(() => {});
    });

    await step("54-toasts", async () => {
      // The polish sheet hides the toast region for every other shot.
      await page.evaluate((id) => document.getElementById(id)?.remove(), "readme-showcase-polish");
      await resetNotifications(page);
      const toasts = [
        { type: "success", title: "Claude finished", message: "Settlement CSV export is ready for review in feature/settlement-export." },
        { type: "warning", title: "Antigravity is waiting", message: "Split matcher passes needs permission to run git mv." },
        { type: "info", title: "Update available", message: "Daintree is downloading the next release in the background." },
      ] as const;
      for (const t of toasts) await injectToast(page, { ...t, duration: 0 });
      const region = page.locator(SEL.notifications.toastRegion).first();
      await region.getByText("Settlement CSV export is ready").waitFor({ timeout: T_LONG });
      await settle(page, 900);
      await shoot("54-toasts");
      await shoot("54-toasts--crop", around([await boxOf(region)], 32));
      await resetNotifications(page);
    });

    await step("55-theme-browser", async () => {
      await act(page, "app.theme.browser.open");
      await page.locator(SEL.settings.themeBrowserDialog).waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 900);
      await shoot("55-theme-browser");
    });

    await step("56-agent-palette", async () => {
      await dialogShot("56-agent-palette", async () => {
        await act(page, "agent.palette");
        return page.locator('[role="dialog"]').last();
      });
    });

    await step("57-panel-palette", async () => {
      await dialogShot("57-panel-palette", async () => {
        await act(page, "panel.palette");
        return page.locator('[role="dialog"]').last();
      });
    });

    await step("58-quick-create", async () => {
      await dialogShot("58-quick-create", async () => {
        await act(page, "worktree.quickCreate");
        return page.locator(SEL.worktree.quickCreatePalette).first();
      });
    });

    await step("59-terminal-info", async () => {
      await dialogShot("59-terminal-info", async () => {
        await act(page, "terminal.info.open", { terminalId: ids.claude });
        return page.locator('[role="dialog"]').last();
      });
    });

    const SETTINGS_PAGES = [
      "terminalAppearance",
      "keyboard",
      "agents",
      "notifications",
      "worktree",
      "plugins",
      "mcp",
      "project:general",
      "project:recipes",
    ] as const;
    if (want("60-settings")) {
      for (const tab of SETTINGS_PAGES) {
        const slug = `60-settings-${tab.replace(":", "-")}`;
        try {
          await polish(page);
          await act(page, "app.settings.openTab", { tab });
          const dialog = page.locator('[role="dialog"]:has(.settings-sidebar)').first();
          await dialog.waitFor({ state: "visible", timeout: T_LONG });
          await settle(page, 1200);
          await shoot(slug, around([await framedBox(dialog)], 16));
        } catch (error) {
          failures.set(slug, String(error).slice(0, 300));
        } finally {
          await escapeAll(page);
          await settle(page, 300);
        }
      }
    }

    // Last: it adds a pane to the grid.
    await step("61-file-browser-pane", async () => {
      await act(page, "worktree.select", { worktreeId: focusId });
      const before = await page.locator(SEL.panel.gridPanel).count();
      await act(page, "worktree.openFileBrowserPanel", { worktreeId: focusId });
      await expect
        .poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG })
        .toBeGreaterThan(before);
      await restShot("61-file-browser-pane");
    });
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    fixture.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify({ written, failures: Object.fromEntries(failures) }, null, 2)
  );
  expect([...failures.entries()], "states that could not be captured").toEqual([]);
});
