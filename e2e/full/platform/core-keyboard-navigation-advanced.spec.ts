import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount, getGridPanelIds } from "../../helpers/panels";
import { ensureWindowFocused, expectTerminalFocused } from "../../helpers/focus";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";
// terminal.focusNext / terminal.focusPrevious are bound to literal Ctrl on every
// platform (shared/config/defaultKeybindings.ts), not the Cmd/Ctrl modifier.
const FOCUS_NEXT = "Control+Tab";
const FOCUS_PREVIOUS = "Control+Shift+Tab";
const FEATURE_BRANCH = "feature/test-branch";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
let mainBranch: string;

const NO_OP_DWELL_MS = 750;

/** Every distinct branch whose row was aria-current on any frame across `dwellMs`. */
async function currentRowBranchesDuring(page: Page, dwellMs: number): Promise<string[]> {
  return page.evaluate(
    (dwellMs) =>
      new Promise<string[]>((resolve) => {
        const seen = new Set<string>();
        const start = performance.now();
        const sample = () => {
          for (const row of document.querySelectorAll('[data-worktree-row][aria-current="true"]')) {
            seen.add(
              row.querySelector("[data-worktree-branch]")?.getAttribute("data-worktree-branch") ??
                "?"
            );
          }
          if (performance.now() - start >= dwellMs) return resolve([...seen]);
          requestAnimationFrame(sample);
        };
        sample();
      }),
    dwellMs
  );
}

function worktreeRow(card: Locator): Locator {
  return card.locator("xpath=ancestor::*[@data-worktree-row][1]");
}

function gridPanel(page: Page, id: string): Locator {
  return page.locator(`${SEL.panel.gridPanel}[data-panel-id="${id}"]`);
}

/** The grid panel that holds DOM focus — what the keyboard will actually type into. */
async function domFocusedPanelId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null
  );
}

async function focusTerminal(page: Page, id: string): Promise<void> {
  const panel = gridPanel(page, id);
  await panel.locator(SEL.terminal.xtermRows).click();
  await expectTerminalFocused(panel);
}

async function pressAndExpectFocus(page: Page, key: string, expectedId: string): Promise<void> {
  await page.keyboard.press(key);
  await expectTerminalFocused(gridPanel(page, expectedId), T_LONG);
}

test.describe.serial("Core: Keyboard Navigation", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "kbd-nav", withFeatureBranch: true });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Kbd Nav");

    const cards = ctx.window.locator("[data-worktree-branch]");
    await expect(cards).toHaveCount(2, { timeout: T_LONG });
    mainBranch =
      (await ctx.window.locator(SEL.worktree.mainCard).getAttribute("data-worktree-branch")) ?? "";
    expect(mainBranch.length).toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.describe.serial("Terminal focus cycling", () => {
    let panelIds: string[] = [];

    test.beforeAll(async () => {
      const { window } = ctx;
      const initial = await getGridPanelCount(window);
      for (let i = initial; i < 3; i++) {
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(i + 1);
      }
      panelIds = await getGridPanelIds(window);
      expect(panelIds).toHaveLength(3);
      for (const id of panelIds) {
        await expect(gridPanel(window, id).locator(SEL.terminal.xtermRows)).toBeVisible({
          timeout: T_LONG,
        });
      }
    });

    test("Ctrl+Tab cycles forward through terminals and wraps", async () => {
      const { window } = ctx;
      await ensureWindowFocused(ctx.app);
      const [first, second, third] = panelIds;

      await focusTerminal(window, first);
      await pressAndExpectFocus(window, FOCUS_NEXT, second);
      await pressAndExpectFocus(window, FOCUS_NEXT, third);
      await pressAndExpectFocus(window, FOCUS_NEXT, first);
    });

    test("Ctrl+Shift+Tab cycles backward through terminals and wraps", async () => {
      const { window } = ctx;
      await ensureWindowFocused(ctx.app);
      const [first, second, third] = panelIds;

      await focusTerminal(window, first);
      await pressAndExpectFocus(window, FOCUS_PREVIOUS, third);
      await pressAndExpectFocus(window, FOCUS_PREVIOUS, second);
      await pressAndExpectFocus(window, FOCUS_PREVIOUS, first);
    });

    test("cycling with a single panel keeps focus where it is", async () => {
      const { window } = ctx;
      await ensureWindowFocused(ctx.app);

      for (const id of panelIds.slice(1)) {
        const before = await getGridPanelCount(window);
        await gridPanel(window, id).locator(SEL.panel.close).first().click({ force: true });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
      }
      const [onlyId] = panelIds;
      await focusTerminal(window, onlyId);

      // Sample the focused panel every frame for a dwell after each press, so a
      // transient hop away and back fails the test instead of settling unseen.
      for (const key of [FOCUS_NEXT, FOCUS_PREVIOUS]) {
        const samples = window.evaluate(
          () =>
            new Promise<Array<string | null>>((resolve) => {
              const seen: Array<string | null> = [];
              const end = performance.now() + 600;
              const tick = () => {
                seen.push(
                  document.activeElement
                    ?.closest("[data-panel-id]")
                    ?.getAttribute("data-panel-id") ?? null
                );
                if (performance.now() < end) requestAnimationFrame(tick);
                else resolve(seen);
              };
              requestAnimationFrame(tick);
            })
        );
        await window.keyboard.press(key);
        expect(new Set(await samples)).toEqual(new Set([onlyId]));
        await expectTerminalFocused(gridPanel(window, onlyId));
        expect(await domFocusedPanelId(window)).toBe(onlyId);
      }
    });
  });

  test.describe.serial("Worktree cycling", () => {
    test("Cmd+Alt+] cycles to next worktree", async () => {
      const { window } = ctx;
      await ensureWindowFocused(ctx.app);

      const mainCard = window.locator(SEL.worktree.card(mainBranch));
      await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });

      await window.keyboard.press(`${mod}+Alt+]`);
      const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));
      await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });

      await window.keyboard.press(`${mod}+Alt+]`);
      await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });
    });

    test("Cmd+Alt+[ cycles to previous worktree", async () => {
      const { window } = ctx;
      await ensureWindowFocused(ctx.app);

      const mainCard = window.locator(SEL.worktree.card(mainBranch));
      await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });

      await window.keyboard.press(`${mod}+Alt+[`);
      const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));
      await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });

      await window.keyboard.press(`${mod}+Alt+[`);
      await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });
    });

    test("Cmd+Alt+N jumps to worktree by index", async () => {
      const { window } = ctx;
      await ensureWindowFocused(ctx.app);

      const mainCard = window.locator(SEL.worktree.card(mainBranch));
      const featureCard = window.locator(SEL.worktree.card(FEATURE_BRANCH));

      await window.keyboard.press(`${mod}+Alt+2`);
      await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });
      await expect(worktreeRow(mainCard)).not.toHaveAttribute("aria-current", "true", {
        timeout: T_SHORT,
      });

      // Out of range: a no-op. The feature row must stay current on every
      // frame through a dwell, then a following "next" must land on main.
      await window.keyboard.press(`${mod}+Alt+9`);
      expect(await currentRowBranchesDuring(window, NO_OP_DWELL_MS)).toEqual([FEATURE_BRANCH]);
      await window.keyboard.press(`${mod}+Alt+]`);
      await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });

      await window.keyboard.press(`${mod}+Alt+2`);
      await expect(worktreeRow(featureCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });
      await window.keyboard.press(`${mod}+Alt+1`);
      await expect(worktreeRow(mainCard)).toHaveAttribute("aria-current", "true", {
        timeout: T_MEDIUM,
      });
      await expect(worktreeRow(featureCard)).not.toHaveAttribute("aria-current", "true");
    });
  });
});
