/**
 * Terminal destructive-action confirm visual-review harness.
 *
 * `TerminalDestructiveActionConfirmDialog` is the app-level host for every terminal and
 * worktree-session destructive confirm raised outside a component that owns its own
 * dialog (keybindings, the action palette, bulk surfaces, deleted-worktree rows). It is
 * one component rendering ten different copy variants, and one of them carries a D2
 * preview list, so it is reviewed per variant on rendered pixels.
 *
 * Every state is reached through the real seam: the action is dispatched unconfirmed, the
 * action body stages the snapshot in the pending store, and the host renders it. The
 * running-agent variants use the fake `claude` CLI driven to `working`, since those
 * confirms only exist while an agent is mid-work. The deleted-worktree variants delete
 * real worktrees on disk out from under their terminals.
 *
 * Every step cancels its dialog, so nothing is ever killed and the steps are independent.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_TERMINAL_CONFIRM is set, so the
 * marketing screenshots workflow never executes it. One boot per theme, never in
 * parallel:
 *
 *   for t in daintree namib hokkaido; do
 *     DAINTREE_SHOT_TERMINAL_CONFIRM=1 DAINTREE_SHOT_THEME=$t DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots terminal-destructive-confirm-review
 *   done
 *
 * Env knobs:
 *   DAINTREE_SHOT_TERMINAL_CONFIRM  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME             optional theme id (default: daintree)
 *   DESIGN_CAPTURE_DIR              output directory (default: artifacts/terminal-confirm-shots)
 *   DAINTREE_SHOT_ONLY              comma-separated step filter (step names below)
 *
 * Output: <dir>/<NN-slug>-<theme>.png
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import {
  installFakeAgent,
  fakeAgentEnv,
  sendFakeAgentCommand,
  FAKE_AGENT_READY,
} from "../helpers/fakeAgent";
import { getTerminalText, writeTerminalInput } from "../helpers/terminal";
import { getGridPanelIds } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_TERMINAL_CONFIRM;
const THEME = process.env.DAINTREE_SHOT_THEME || "daintree";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "terminal-confirm-shots");
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const WINDOW = { width: 1680, height: 1050 };
const DIALOG = '[role="dialog"], [role="alertdialog"]';

const BRANCH_A = "feature/oauth-device-flow";
const BRANCH_B = "fix/retry-backoff-jitter";

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function worktreeDir(wtRoot: string, branch: string): string {
  return path.join(wtRoot, branch.replace(/[/]/g, "-"));
}

function createFixtureRepo(): { dir: string; wtRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-termconfirm-repo-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  for (const branch of [BRANCH_A, BRANCH_B]) {
    git(`branch ${branch}`, dir);
    git(`worktree add ${JSON.stringify(worktreeDir(wtRoot, branch))} ${branch}`, dir);
  }

  return {
    dir,
    wtRoot,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function dispatch(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    async ([id, a]) => {
      const fn = window.__daintreeDispatchAction;
      if (typeof fn !== "function") throw new Error("Action dispatch hook not available");
      try {
        return await fn(id, a, { source: "keybinding" });
      } catch (error) {
        // Staging a confirmation refuses the dispatch by design; the dialog is the point.
        return { staged: String(error) };
      }
    },
    [actionId, args] as const
  );
}

/**
 * Wait for the confirm to be up with the title this step expects, then capture the
 * dialog card and, optionally, the whole window. Throws rather than writing a shot of the
 * wrong dialog, or of no dialog at all.
 */
async function snapDialog(
  page: Page,
  slug: string,
  title: RegExp,
  options: { window?: boolean } = {}
): Promise<void> {
  const dialog = page.locator(DIALOG).last();
  await dialog.waitFor({ state: "visible", timeout: 8000 });
  await expect
    .poll(
      () =>
        dialog.evaluate((el) => {
          const id = el.getAttribute("aria-labelledby");
          return (id && document.getElementById(id)?.textContent?.trim()) ?? "";
        }),
      { timeout: 5000 }
    )
    .toMatch(title);
  await settle(page, 500);
  // The role sits on the full-window backdrop, so crop to the card inside it, with a
  // margin so the card's edge and shadow against the scrim stay in frame.
  const box = await dialog.locator(":scope > div").first().boundingBox();
  if (!box) throw new Error("dialog card has no bounding box");
  const pad = 24;
  const viewport = page.viewportSize() ?? WINDOW;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}-${THEME}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + pad * 2),
      height: Math.min(viewport.height - y, box.height + pad * 2),
    },
  });
  if (options.window) {
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `${slug}-window-${THEME}.png`),
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
  }
}

async function cancelDialog(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (
      !(await page
        .locator(DIALOG)
        .first()
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

const failures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 400);
    console.warn(`[terminal-confirm-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await cancelDialog(page).catch(() => {});
  }
}

async function newPanelId(page: Page, before: Set<string>): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const id = (await getGridPanelIds(page).catch(() => [] as string[])).find(
      (candidate) => !before.has(candidate)
    );
    if (id) return id;
    await page.waitForTimeout(250);
  }
  throw new Error("new panel never appeared in the grid");
}

async function openTerminal(page: Page, title: string): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await dispatch(page, "terminal.new");
  const id = await newPanelId(page, before);
  await dispatch(page, "terminal.rename", { terminalId: id, name: title });
  return id;
}

/** Launch the fake `claude`, clear its trust prompt, and wait for it to read as working. */
async function launchWorkingAgent(page: Page, binDir: string, title: string): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await dispatch(page, "agent.launch", { agentId: "claude" });
  const id = await newPanelId(page, before);
  const panel = page.locator(`[data-panel-id="${id}"]`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const text = (await getTerminalText(panel).catch(() => "")).toLowerCase();
    if (text.includes(FAKE_AGENT_READY.toLowerCase())) break;
    if (text.includes("enter to confirm") || text.includes("trust this folder")) {
      await writeTerminalInput(page, panel, "\r").catch(() => {});
    }
    await page.waitForTimeout(300);
  }
  await sendFakeAgentCommand(binDir, "work").catch(() => {});
  await expectWorking(page, id);
  await dispatch(page, "terminal.rename", { terminalId: id, name: title });
  return id;
}

async function expectWorking(page: Page, id: string): Promise<void> {
  await expect
    .poll(() => page.locator(`[data-panel-id="${id}"]`).getAttribute("data-agent-state"), {
      timeout: T_LONG * 2,
      intervals: [250, 500, 1000],
    })
    .toBe("working");
}

interface WorktreeRow {
  id: string;
  branch?: string;
  path: string;
  isMainWorktree?: boolean;
}

async function listWorktrees(page: Page): Promise<WorktreeRow[]> {
  const rows = await page
    .evaluate(() =>
      (
        window as unknown as { electron?: { worktree?: { getAll?: () => unknown } } }
      ).electron?.worktree?.getAll?.()
    )
    .catch(() => null);
  return Array.isArray(rows) ? (rows as WorktreeRow[]) : [];
}

async function worktreeIdFor(page: Page, branch: string | null): Promise<string> {
  let match: WorktreeRow | undefined;
  await expect
    .poll(
      async () => {
        const rows = await listWorktrees(page);
        match = rows.find((row) =>
          branch === null
            ? row.isMainWorktree === true
            : row.branch === branch || row.path.endsWith(branch.replace(/[/]/g, "-"))
        );
        return match !== undefined;
      },
      { timeout: 60_000, intervals: [250, 500] }
    )
    .toBe(true);
  return match!.id;
}

/**
 * Make `branch` the active worktree. A card click alone is not enough: `terminal.new`
 * reads the active worktree synchronously, and an unconfirmed switch put every
 * seeded terminal in main.
 */
async function selectWorktree(page: Page, branch: string | null): Promise<void> {
  const worktreeId = await worktreeIdFor(page, branch);
  await dispatch(page, "worktree.select", { worktreeId });
  const card = branch
    ? `${SEL.worktree.card(branch)}[data-active="true"]`
    : `${SEL.worktree.mainCard}[data-active="true"]`;
  await expect(page.locator(card).first()).toBeAttached({ timeout: T_LONG });
  await settle(page, 400);
}

test("terminal destructive confirm review — every copy variant", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TERMINAL_CONFIRM is required for the capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_TERMINAL_CONFIRM to run the capture");
  test.setTimeout(600_000);

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const binDir = installFakeAgent(repo.dir, { controlChannel: true, streamLinesPerSec: 3 });
  // Prefix avoids "daintree-e2e": launchApp's pre-launch hygiene pkills that pattern.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-termconfirmshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WINDOW,
      env: fakeAgentEnv(binDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await setAppTheme(page, THEME);
    await page.setViewportSize(WINDOW);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    // Terminals in the two feature worktrees first, so they exist before those worktrees
    // are deleted from under them at the end.
    await selectWorktree(page, BRANCH_A);
    await openTerminal(page, "dev server");
    await openTerminal(page, "test watch");
    await selectWorktree(page, BRANCH_B);
    await openTerminal(page, "db migrations");

    await selectWorktree(page, null);
    const agentA = await launchWorkingAgent(page, binDir, "Claude · auth refactor");
    const agentB = await launchWorkingAgent(page, binDir, "Claude · flaky tests");
    await openTerminal(page, "shell");
    await dismissBlockingPalette(page);
    await settle(page, 800);

    const running = async () => {
      await expectWorking(page, agentA);
      await expectWorking(page, agentB);
    };

    await step(page, "kill", async () => {
      await running();
      await dispatch(page, "terminal.kill", { terminalId: agentA });
      await snapDialog(page, "01-kill", /^Kill terminal with running agent\?$/, { window: true });
    });

    await step(page, "restart", async () => {
      await running();
      await dispatch(page, "terminal.restart", { terminalId: agentA });
      await snapDialog(page, "02-restart", /^Restart terminal with running agent\?$/);
    });

    await step(page, "kill-all", async () => {
      await running();
      await dispatch(page, "terminal.killAll");
      await snapDialog(page, "03-kill-all", /^Kill \d+ terminals\?$/);
    });

    await step(page, "restart-all", async () => {
      await running();
      await dispatch(page, "terminal.restartAll");
      await snapDialog(page, "04-restart-all", /^Restart \d+ terminals\?$/);
    });

    await step(page, "worktree-restart-all", async () => {
      await running();
      await dispatch(page, "worktree.sessions.restartAll");
      await snapDialog(
        page,
        "05-worktree-restart-all",
        /^Restart \d+ sessions in this worktree\?$/
      );
    });

    await step(page, "worktree-trash-all", async () => {
      await dispatch(page, "worktree.sessions.trashAll");
      await snapDialog(page, "06-worktree-trash-all", /^Trash \d+ sessions in this worktree\?$/);
    });

    await step(page, "worktree-end-all", async () => {
      await dispatch(page, "worktree.sessions.endAll");
      await snapDialog(page, "07-worktree-end-all", /^End \d+ sessions in this worktree\?$/);
    });

    await step(page, "clear-history", async () => {
      await dispatch(page, "worktree.sessions.clearHistory");
      await snapDialog(page, "08-clear-history", /^Clear session history for this worktree\?$/);
    });

    // Keyboard focus, delivered by the keyboard so Chromium paints :focus-visible. The
    // dialog opens on Cancel; one Tab moves to the destructive button.
    await step(page, "focus", async () => {
      await running();
      await dispatch(page, "terminal.kill", { terminalId: agentA });
      await page.locator(DIALOG).last().waitFor({ state: "visible", timeout: 8000 });
      await settle(page, 300);
      await page.keyboard.press("Tab");
      await snapDialog(page, "09-focus-destructive", /^Kill terminal with running agent\?$/);
    });

    // Deleted worktrees. One first, for the single-row dismiss, then the second, which
    // folds both rows into the grouped summary and its D2 preview. The default cleanup
    // countdown is 60s, so these run back to back.
    await step(page, "deleted-single", async () => {
      git(
        `worktree remove --force ${JSON.stringify(worktreeDir(repo.wtRoot, BRANCH_B))}`,
        repo.dir
      );
      // An external removal reaches the renderer through the topology watcher; a refresh
      // makes it prompt instead of racing the 60s cleanup countdown.
      await dispatch(page, "worktree.refresh");
      const card = page.locator(`[aria-label^="Deleted worktree:"]`).first();
      await card.waitFor({ state: "visible", timeout: 30_000 });
      await card.locator('button[aria-label^="Close "]').first().click();
      await snapDialog(page, "10-deleted-single", /^Close \d+ terminals?\?$/);
    });

    await step(page, "deleted-group", async () => {
      git(
        `worktree remove --force ${JSON.stringify(worktreeDir(repo.wtRoot, BRANCH_A))}`,
        repo.dir
      );
      await dispatch(page, "worktree.refresh");
      const group = page.locator('[data-testid="deleted-worktree-group"]');
      await group.waitFor({ state: "visible", timeout: 30_000 });
      await group.locator('button[aria-label^="Close "]').first().click();
      await snapDialog(
        page,
        "11-deleted-group",
        /^Close \d+ terminals from \d+ deleted worktrees\?$/,
        {
          window: true,
        }
      );
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    try {
      repo.cleanup();
    } catch {
      /* best effort */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  const written = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`-${THEME}.png`));
  console.log(`[terminal-confirm-shots] ${THEME}: ${written.length} files in ${OUTPUT_DIR}`);
  if (failures.length > 0) {
    throw new Error(
      `[terminal-confirm-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`
    );
  }
});
