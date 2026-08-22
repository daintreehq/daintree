/**
 * Documentation screenshots — Fleet.
 *
 * Fleet is a mode, not a panel, so almost every state here is "N agents armed
 * and then something done to them". The agents are the fake CLI, so the states
 * are the ones the app really computes, offline and without an API key.
 *
 * Three launches rather than one. The deck needs a window wide enough for
 * three columns (roughly 1612px of grid, which a 1280 window cannot give), and
 * the saved-fleets rows print a live count of every eligible pane in the app —
 * so that shot needs exactly two, where the others need four or five.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { rmSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays } from "../helpers/docsCapture";
import {
  bootDocsApp,
  DOCS_WINDOW_WIDE,
  DOCS_WINDOW_DECK,
  DIALOG_PAD,
} from "../helpers/docsBoot";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { launchDocsAgent, parkAgent } from "../helpers/docsAgents";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("fleet");

/**
 * Fleet selectors the shared `SEL` map does not carry yet. Every one is a real
 * `data-testid` from the Fleet components; they are grouped here rather than
 * added to `selectors.ts` so the docs suite does not fork a shared file.
 */
const FLEET = {
  ribbon: '[data-testid="fleet-arming-ribbon"]',
  countChip: '[data-testid="fleet-armed-count-chip"]',
  armedList: '[data-testid="fleet-armed-list"]',
  selectionMenuTrigger: '[data-testid="fleet-selection-menu-trigger"]',
  pickerDialog: '[role="dialog"][aria-label="Select terminals to arm"]',
  pickerRoot: '[data-testid="fleet-picker-cold-start-root"]',
  draftingPill: '[data-testid="fleet-drafting-pill"]',
  resolutionPopover: '[data-testid="fleet-resolution-popover"]',
  deck: '[data-fleet-scope="true"]',
  saveFormName: '[data-testid="fleet-save-form-name"]',
};

const git = (cmd: string, cwd: string) => execSync(`git ${cmd}`, { cwd, stdio: "ignore" });

/** Dispatch an action through the E2E bridge. */
async function dispatch(page: Page, id: string, payload?: unknown): Promise<unknown> {
  return page.evaluate(
    async (args) => {
      const fn = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            payload: unknown,
            opts: { source: string }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (!fn) throw new Error("action dispatch bridge unavailable");
      return fn(args.id, args.payload, { source: "user" });
    },
    { id, payload }
  );
}

async function arm(page: Page, terminalId: string): Promise<void> {
  await dispatch(page, "terminal.arm", { terminalId });
  await page.waitForTimeout(250);
}

/**
 * Two extra worktrees whose branch names carry an issue number.
 *
 * `{{issue_number}}` resolves offline, from the branch or folder name — there
 * is no GitHub call — but atlas-ledger's own branches carry no number, so the
 * broadcast preview would render an "unresolved" chip for every target.
 */
function addIssueWorktrees(repo: DemoRepo): string[] {
  const root = path.join(path.dirname(repo.dir), `${repo.slug}-worktrees`);
  const branches = ["feature/issue-412-settlement", "feature/issue-418-fx-rates"];
  for (const branch of branches) {
    const dir = path.join(root, branch.replace(/\//g, "-"));
    git(`worktree add -b ${branch} ${JSON.stringify(dir)} main`, repo.dir);
  }
  return branches;
}

test.describe.serial("Documentation Screenshots — Fleet", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  // ---------------------------------------------------------------------------
  // Scene F1 — picker, ribbon, chip popover, bulk confirm, broadcast preview
  // ---------------------------------------------------------------------------
  test("scene-f1-arming", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    const [issueA, issueB] = addIssueWorktrees(repo);
    const binDir = installFakeAgent(path.dirname(repo.dir));

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        env: fakeAgentEnv(binDir),
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      // Five agents over two issue-numbered worktrees. Group headers in the
      // picker only render when more than one worktree is represented, and the
      // broadcast preview is only interesting when the resolved values differ.
      const a1 = await launchDocsAgent(page, { branch: issueA, name: "Settlement review" });
      const a2 = await launchDocsAgent(page, { branch: issueA, name: "Settlement tests" });
      const a3 = await launchDocsAgent(page, { branch: issueA, name: "Settlement docs" });
      // Park before moving on. The grid only renders the *active* worktree's
      // panels, so once a launch switches worktrees the earlier panes leave
      // the DOM entirely and anything that reads their state attribute waits
      // on a locator that will never resolve.
      await parkAgent(page, a3);

      const b1 = await launchDocsAgent(page, { branch: issueB, name: "FX rates" });
      const b2 = await launchDocsAgent(page, { branch: issueB, name: "FX backfill" });

      await cap.shot("fleet/fleet-picker-palette", async () => {
        await dispatch(page, "terminal.disarmAll");
        await resetOverlays(page);
        // The Zap lives in a hover-only slot in the sidebar header.
        const header = page.locator(`${SEL.sidebar.aside} >> text=Worktrees`).first();
        await header.hover();
        await page.waitForTimeout(400);
        await page.locator('button[aria-label="Select terminals to arm"]').click();
        const dlg = page.locator(FLEET.pickerDialog);
        await expect(dlg).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(page, dlg.locator("> div").first(), "fleet/fleet-picker-palette", 24);
        await page.keyboard.press("Escape");
        await expect(dlg).toBeHidden({ timeout: T_MEDIUM });
      });

      await cap.shot("fleet/fleet-arming-ribbon", async () => {
        // Three armed across two worktrees, so the chip carries worktree dots
        // and reads "3 in fleet · 2 worktrees".
        for (const id of [a1, a2, b1]) await arm(page, id);
        const ribbon = page.locator(FLEET.ribbon);
        await expect(ribbon).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(page, ribbon, "fleet/fleet-arming-ribbon", 12);
      });

      await cap.shot("fleet/fleet-count-chip-popover", async () => {
        const chip = page.locator(FLEET.countChip).first();
        await chip.click();
        const pop = page.locator(FLEET.armedList);
        await expect(pop).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        // Band from the ribbon down past the popover: the popover is only
        // 260px wide, and cropped alone it loses the chip it hangs off.
        const ribbonBox = await page.locator(FLEET.ribbon).boundingBox();
        const popBox = await pop.boundingBox();
        if (!ribbonBox || !popBox) throw new Error("fleet chip popover has no layout");
        const x = Math.max(0, Math.min(ribbonBox.x, popBox.x) - 24);
        await cap.snapBand(page, "fleet/fleet-count-chip-popover", {
          x,
          y: ribbonBox.y - 12,
          width: Math.max(popBox.x + popBox.width - x, 420) + 24,
          height: popBox.y + popBox.height + 16 - (ribbonBox.y - 12),
        });
        await page.keyboard.press("Escape");
      });

      await cap.shot("fleet/saved-fleets/fleet-saved-fleets", async () => {
        // Seed two snapshots and two live rules. A snapshot whose terminal ids
        // match nothing counts zero, which is what marks it stale and puts it
        // below the separator.
        await dispatch(page, "fleet.saveNamedFleet", {
          kind: "predicate",
          name: "Everything live",
          scope: "all",
          stateFilter: "all",
        });
        await dispatch(page, "fleet.saveNamedFleet", {
          kind: "predicate",
          name: "All agents",
          scope: "all",
          stateFilter: "all",
        });
        await dispatch(page, "fleet.saveNamedFleet", {
          kind: "snapshot",
          name: "Settlement pair",
        });
        await dispatch(page, "fleet.saveNamedFleet", {
          kind: "snapshot",
          name: "Nightly sweep",
          terminalIds: ["gone-a", "gone-b"],
        });
        // Each save fires a toast; wait them out rather than photograph one.
        await page.waitForTimeout(6_000);

        await page.locator(FLEET.selectionMenuTrigger).click();
        const menu = page.locator('[role="menu"]').last();
        await expect(menu).toBeVisible({ timeout: T_LONG });
        await menu.locator(FLEET.saveFormName).fill("Reviewers").catch(() => {});
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(page, menu, "fleet/saved-fleets/fleet-saved-fleets", 16);
        await page.keyboard.press("Escape");
      });

      await cap.shot("fleet/fleet-quick-action-confirmation", async () => {
        await resetOverlays(page);
        await arm(page, b2);
        await dispatch(page, "fleet.restart");
        const strip = page.locator(`${FLEET.ribbon}[data-pending-action="restart"]`);
        await expect(strip).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(page, strip, "fleet/fleet-quick-action-confirmation", 12);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(T_SHORT);
      });

      await cap.shot("fleet/broadcasting/fleet-drafting-pill-popover", async () => {
        await resetOverlays(page);
        await dispatch(page, "terminal.disarmAll");
        for (const id of [a1, a2, b1]) await arm(page, id);
        // The pill mounts on the focused armed pane once the fleet has two or
        // more members; typing a recipe variable opens the preview by itself.
        // The primary has to be a pane that is actually on screen, so it must
        // belong to the active worktree — which the last launch made issueB.
        const primary = page.locator(`[data-panel-id="${b1}"]`);
        await primary.locator(SEL.terminal.cmEditor).click();
        await page.keyboard.type("Pick up {{issue_number}} and post a plan", { delay: 12 });
        const pop = page.locator(FLEET.resolutionPopover);
        await expect(pop).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        const pillBox = await page.locator(FLEET.draftingPill).first().boundingBox();
        const popBox = await pop.boundingBox();
        if (!popBox) throw new Error("broadcast preview has no layout");
        const top = Math.min(popBox.y, pillBox?.y ?? popBox.y) - 16;
        const bottom = Math.max(popBox.y + popBox.height, (pillBox?.y ?? 0) + (pillBox?.height ?? 0)) + 16;
        await cap.snapBand(page, "fleet/broadcasting/fleet-drafting-pill-popover", {
          x: Math.max(0, popBox.x - 24),
          y: Math.max(0, top),
          width: popBox.width + 48,
          height: bottom - Math.max(0, top),
        });
        // Never Enter: that broadcasts to every armed pane.
        await page.keyboard.press("Escape");
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene F2 — the deck, which needs a wider window than anything else
  // ---------------------------------------------------------------------------
  test("scene-f2-deck", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    const [issueA, issueB] = addIssueWorktrees(repo);
    const binDir = installFakeAgent(path.dirname(repo.dir));

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        env: fakeAgentEnv(binDir),
        // Three columns need ~1612px of grid. At 1280 the automatic layout
        // gives two, whatever else is true.
        windowSize: DOCS_WINDOW_DECK,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      const a1 = await launchDocsAgent(page, { branch: issueA, name: "Settlement review" });
      const a2 = await launchDocsAgent(page, { branch: issueA, name: "Settlement tests" });
      const b1 = await launchDocsAgent(page, { branch: issueB, name: "FX rates" });

      await cap.shot("fleet/fleet-deck", async () => {
        for (const id of [a1, a2, b1]) await arm(page, id);
        await expect(page.locator(FLEET.ribbon)).toBeVisible({ timeout: T_LONG });
        // Scope is entered from the ribbon's "Focus selection", nowhere else —
        // typing into a primary pane broadcasts but does not switch the grid.
        await dispatch(page, "fleet.scope.enter");
        await expect(page.locator(FLEET.deck)).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapWindow(page, "fleet/fleet-deck");
        await dispatch(page, "fleet.scope.exit");
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});
