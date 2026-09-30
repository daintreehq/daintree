import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { ensureWindowFocused } from "../../helpers/focus";
import { getGridPanelIds, getPanelById } from "../../helpers/panels";
import { getTerminalText, waitForTerminalText } from "../../helpers/terminal";
import {
  approveWorktreeCommands,
  writeResourceConfig,
  createWorktree,
  deleteWorktree,
  waitForWorktreeCardRemoval,
  commandArg,
  nodeScriptCommand,
  sameFilesystemEntry,
} from "../../helpers/resource-lifecycle";

/**
 * Worktree resource lifecycle end to end, against one worktree in one launch:
 * status/pause/resume/provision through the action palette, connect-command
 * and environment substitution, then teardown on delete.
 *
 * Uses a node helper script instead of real Docker/SSH (see
 * `writeResourceHelper`): provision/resume write `{status:"ready"}` to a state
 * file in the main checkout's `.daintree/`, pause writes "paused", teardown
 * removes the file, status prints it, connect echoes its arguments.
 *
 * Order matters: the state file is shared by every worktree, the substitution
 * tests rewrite the worktree's own config (each rewrite needs a fresh command
 * approval), and the delete tests remove the worktree, so they run last.
 */

let ctx: AppContext;
let mainBranch: string;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

const BRANCH = "e2e/resource-lifecycle";
const mod = process.platform === "darwin" ? "Meta" : "Control";

function resourceStateFile(): string {
  return path.join(fixtureDir, ".daintree", "resource-state.json");
}

function readResourceStatus(): string | null {
  try {
    return JSON.parse(fs.readFileSync(resourceStateFile(), "utf-8")).status ?? null;
  } catch {
    return null;
  }
}

function worktreePathFor(branch: string): string {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: fixtureDir,
    encoding: "utf-8",
  });
  for (const block of output.split("\n\n")) {
    if (block.includes(`refs/heads/${branch}`)) {
      const match = block.match(/^worktree (.+)$/m);
      if (match) return match[1];
    }
  }
  return "";
}

async function runPaletteAction(window: Page, app: AppContext["app"], title: string) {
  await ensureWindowFocused(app);
  await window.keyboard.press(`${mod}+Shift+P`);

  const palette = window.locator(SEL.actionPalette.dialog);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await palette.locator(SEL.actionPalette.searchInput).fill(title);

  const option = palette.locator('[role="option"]').filter({ hasText: new RegExp(title, "i") });
  // Resource actions are only offered once the worktree's resource config has
  // loaded, which can trail the card appearing.
  await expect(option.first()).toBeVisible({ timeout: T_LONG });
  await option.first().click();
}

async function expectResourceBadge(window: Page, status: string, message: string) {
  const card = window.locator(SEL.worktree.card(BRANCH));
  await expect
    .poll(async () => card.getAttribute("data-resource-status"), { timeout: T_LONG, message })
    .toBe(status);
}

async function checkStatus(window: Page, app: AppContext["app"]) {
  await runPaletteAction(window, app, "Check Resource Status");
}

async function waitForNewGridPanel(page: Page, existingIds: Set<string>): Promise<Locator> {
  let panelId = "";
  await expect
    .poll(
      async () => {
        panelId = (await getGridPanelIds(page)).find((id) => !existingIds.has(id)) ?? "";
        return panelId;
      },
      { timeout: T_LONG }
    )
    .not.toBe("");
  return getPanelById(page, panelId);
}

test.describe.serial("Full: Worktree Resources", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "worktree-resources",
    }));
    writeResourceConfig(fixtureDir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Worktree Resources");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("main worktree card is visible", async () => {
    const { window } = ctx;

    const cards = window.locator("[data-worktree-branch]");
    await expect(cards.first()).toBeVisible({ timeout: T_LONG });

    mainBranch = (await cards.first().getAttribute("data-worktree-branch")) ?? "";
    expect(mainBranch.length).toBeGreaterThan(0);
  });

  test("worktree creation with resource config", async () => {
    const { window } = ctx;

    const newBtn = window.locator('button[aria-label="Create new worktree"]');
    await newBtn.click();

    const dialog = window.locator(SEL.worktree.newDialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const branchInput = window.locator(SEL.worktree.branchNameInput);
    await expect(branchInput).toBeVisible({ timeout: T_MEDIUM });
    await branchInput.fill(BRANCH);

    const pathInput = window.locator('[data-testid="worktree-path-input"]');
    await expect
      .poll(async () => (await pathInput.inputValue()).trim().length, {
        timeout: T_LONG,
        message: "Worktree path should auto-populate",
      })
      .toBeGreaterThan(0);

    await window.locator(SEL.worktree.createButton).click();

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: T_LONG });
    await approveWorktreeCommands(window, BRANCH);

    await newCard.click({ position: { x: 10, y: 10 } });
    await expect(window.locator(SEL.worktree.row(BRANCH))).toHaveAttribute("aria-current", "true", {
      timeout: T_LONG,
    });
  });

  test("manual status check shows resource badge", async () => {
    const { window } = ctx;

    fs.writeFileSync(resourceStateFile(), JSON.stringify({ status: "ready" }));
    await checkStatus(window, ctx.app);

    await expectResourceBadge(window, "ready", "Resource status badge should reflect primed ready");
  });

  test("pause resource action updates status", async () => {
    const { window } = ctx;

    await runPaletteAction(window, ctx.app, "Pause Resource");
    await expect
      .poll(readResourceStatus, {
        timeout: T_LONG,
        message: "Pause should run the pause command",
      })
      .toBe("paused");

    await checkStatus(window, ctx.app);
    await expectResourceBadge(window, "paused", "Resource badge should show paused");
  });

  test("resume resource after pause restores ready status", async () => {
    const { window } = ctx;

    await runPaletteAction(window, ctx.app, "Resume Resource");
    await expect
      .poll(readResourceStatus, {
        timeout: T_LONG,
        message: "Resume should run the resume command",
      })
      .toBe("ready");

    await checkStatus(window, ctx.app);
    await expectResourceBadge(window, "ready", "Resource badge should show ready after resume");
  });

  test("unhealthy status JSON is reflected in badge", async () => {
    const { window } = ctx;

    fs.writeFileSync(resourceStateFile(), JSON.stringify({ status: "unhealthy" }));
    await checkStatus(window, ctx.app);

    await expectResourceBadge(window, "unhealthy", "Resource badge should show unhealthy");
  });

  test("non-JSON status output is treated as unknown", async () => {
    const { window } = ctx;

    fs.writeFileSync(resourceStateFile(), "not valid json");
    await checkStatus(window, ctx.app);

    await expectResourceBadge(
      window,
      "unknown",
      "Resource badge should show unknown for non-JSON output"
    );
  });

  // Provision short-circuits when the last status is ready and routes to
  // resume when paused, so it runs from `unknown` here. The worktree's config
  // appends a marker command to provision only, so the marker proves the
  // provision command list ran, in this worktree, rather than resume or a no-op.
  test("resource provision via action palette runs the provision command", async () => {
    const { window } = ctx;

    const worktreePath = worktreePathFor(BRANCH);
    expect(worktreePath.length).toBeGreaterThan(0);
    const wtConfigPath = path.join(worktreePath, ".daintree", "config.json");
    const markerFile = path.join(worktreePath, ".daintree", "provision-marker.txt");
    const mainDaintreeDir = path.join(fixtureDir, ".daintree");
    const originalConfig = fs.readFileSync(path.join(mainDaintreeDir, "config.json"), "utf-8");
    const config = JSON.parse(originalConfig);
    config.resource.provision = [
      ...config.resource.provision,
      nodeScriptCommand(path.join(mainDaintreeDir, "resource-action.cjs"), [
        commandArg("env-status"),
        commandArg(markerFile),
      ]),
    ];
    fs.writeFileSync(wtConfigPath, JSON.stringify(config, null, 2));
    await approveWorktreeCommands(window, BRANCH);

    expect(fs.readFileSync(resourceStateFile(), "utf-8")).toBe("not valid json");
    await expectResourceBadge(window, "unknown", "Provision must start from an unknown status");

    await runPaletteAction(window, ctx.app, "Provision Resource");
    await expect
      .poll(readResourceStatus, {
        timeout: T_LONG,
        message: "Provision should write resource state file with status ready",
      })
      .toBe("ready");
    await expect
      .poll(() => fs.existsSync(markerFile), {
        timeout: T_LONG,
        message: "Provision should run every provision command for this worktree",
      })
      .toBe(true);
    expect(fs.readFileSync(markerFile, "utf-8").split("\n")[0]).toBe(BRANCH);

    await checkStatus(window, ctx.app);
    await expectResourceBadge(window, "ready", "Resource badge should show ready after provision");

    fs.unlinkSync(markerFile);
    fs.writeFileSync(wtConfigPath, originalConfig);
    await approveWorktreeCommands(window, BRANCH);
  });

  test("connect action spawns terminal with substituted worktree_name variable", async () => {
    const { window } = ctx;

    const panelIdsBefore = new Set(await getGridPanelIds(window));
    await runPaletteAction(window, ctx.app, "Connect to Resource");

    const newPanel = await waitForNewGridPanel(window, panelIdsBefore);
    await expect(newPanel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_MEDIUM });

    await waitForTerminalText(newPanel, `CONNECTED_TO_${BRANCH}`, T_LONG);
  });

  test("DAINTREE_* env vars are available in lifecycle commands", async () => {
    const { window } = ctx;

    const worktreePath = worktreePathFor(BRANCH);
    expect(worktreePath.length).toBeGreaterThan(0);

    const wtConfigPath = path.join(worktreePath, ".daintree", "config.json");
    const markerFile = path.join(worktreePath, ".daintree", "env-marker.txt");

    const mainDaintreeDir = path.join(fixtureDir, ".daintree");
    const originalConfig = fs.readFileSync(path.join(mainDaintreeDir, "config.json"), "utf-8");
    const config = JSON.parse(originalConfig);

    config.resource.status = nodeScriptCommand(path.join(mainDaintreeDir, "resource-action.cjs"), [
      commandArg("env-status"),
      commandArg(markerFile),
    ]);

    fs.writeFileSync(resourceStateFile(), JSON.stringify({ status: "ready" }));
    fs.writeFileSync(wtConfigPath, JSON.stringify(config, null, 2));
    await approveWorktreeCommands(window, BRANCH);

    await checkStatus(window, ctx.app);

    await expect
      .poll(() => fs.existsSync(markerFile), {
        timeout: T_LONG,
        message: "Marker file should be written by status command",
      })
      .toBe(true);

    const [name, wtPath, projectRoot] = fs.readFileSync(markerFile, "utf-8").trim().split("\n");
    expect(name).toBe(BRANCH);
    expect(sameFilesystemEntry(wtPath!, worktreePath)).toBe(true);
    expect(sameFilesystemEntry(projectRoot!, fixtureDir)).toBe(true);

    fs.unlinkSync(markerFile);
    fs.writeFileSync(wtConfigPath, originalConfig);
  });

  test("{{branch}}, {{worktree_path}} and {{project_root}} are substituted in connect", async () => {
    const { window } = ctx;

    const worktreePath = worktreePathFor(BRANCH);
    expect(worktreePath.length).toBeGreaterThan(0);

    const wtConfigPath = path.join(worktreePath, ".daintree", "config.json");
    const mainDaintreeDir = path.join(fixtureDir, ".daintree");
    const originalConfig = fs.readFileSync(path.join(mainDaintreeDir, "config.json"), "utf-8");
    const config = JSON.parse(originalConfig);

    config.resource.connect = nodeScriptCommand(path.join(mainDaintreeDir, "resource-action.cjs"), [
      commandArg("connect"),
      // One space-free argument: xterm trims trailing spaces from each row,
      // so a space landing on a wrap boundary could not be recovered.
      "@@BRANCH={{branch}}@@PATH={{worktree_path}}@@PROJECT={{project_root}}@@END_OF_CONNECT",
    ]);
    fs.writeFileSync(wtConfigPath, JSON.stringify(config, null, 2));
    await approveWorktreeCommands(window, BRANCH);

    // Setup only: provision is a no-op on a ready resource, but it re-reads
    // the config and re-emits the worktree, which is how the renderer store
    // behind Connect learns the rewritten command.
    await ensureWindowFocused(ctx.app);
    await window.evaluate(async () => {
      const dispatch = globalThis.window.__daintreeDispatchAction;
      if (!dispatch) throw new Error("__daintreeDispatchAction is not installed");
      await dispatch("worktree.resource.provision");
    });
    await expect
      .poll(
        async () =>
          window.evaluate(
            async ({ branch }) => {
              const states = globalThis.window.__DAINTREE_E2E_WORKTREES__?.() ?? [];
              return states.find((state) => state.branch === branch)?.resourceConnectCommand ?? "";
            },
            { branch: BRANCH }
          ),
        { timeout: T_LONG, message: "Updated resource connect command should be visible" }
      )
      .toContain("END_OF_CONNECT");

    const panelIdsBefore = new Set(await getGridPanelIds(window));
    await runPaletteAction(window, ctx.app, "Connect to Resource");

    const newPanel = await waitForNewGridPanel(window, panelIdsBefore);
    await expect(newPanel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_MEDIUM });

    // Long paths wrap across rows; the buffer joins rows with newlines.
    const connectLine = /@@BRANCH=(.+?)@@PATH=(.+?)@@PROJECT=(.+?)@@END_OF_CONNECT/;
    let match: RegExpMatchArray | null = null;
    await expect
      .poll(
        async () => {
          match = (await getTerminalText(newPanel)).replace(/\r?\n/g, "").match(connectLine);
          return match !== null;
        },
        { timeout: T_LONG, message: "Connect terminal should print the substituted arguments" }
      )
      .toBe(true);

    const [, branch, printedPath, printedRoot] = match!;
    expect(branch).toBe(BRANCH);
    expect(sameFilesystemEntry(printedPath!, worktreePath)).toBe(true);
    expect(sameFilesystemEntry(printedRoot!, fixtureDir)).toBe(true);

    fs.writeFileSync(wtConfigPath, originalConfig);
    // Setup for the delete below: the restored commands need approving again
    // or teardown will not run.
    await approveWorktreeCommands(window, BRANCH);
  });

  test("deleting worktree triggers resource teardown", async () => {
    const { window } = ctx;

    // Preconditions: the state file exists (so its removal is teardown's
    // doing) and the worktree is clean (so delete needs no force path).
    expect(readResourceStatus()).toBe("ready");
    const worktreePath = worktreePathFor(BRANCH);
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf-8" })
    ).toBe("");

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await ensureWindowFocused(ctx.app);
    await newCard.locator(SEL.worktree.actionsMenu).click();

    const deleteItem = window.getByRole("menuitem", { name: /delete/i });
    await expect(deleteItem).toBeVisible({ timeout: T_SHORT });
    await deleteItem.hover();
    await deleteItem.click();

    const confirmBtn = window.locator(SEL.worktree.deleteConfirm);
    await expect(confirmBtn).toBeVisible({ timeout: T_MEDIUM });
    await expect(confirmBtn).toBeEnabled({ timeout: T_MEDIUM });
    await confirmBtn.click();

    await waitForWorktreeCardRemoval(window, BRANCH);

    await expect
      .poll(() => fs.existsSync(resourceStateFile()), {
        timeout: T_LONG,
        message: "Teardown should remove the resource state file",
      })
      .toBe(false);

    await expect(window.locator(SEL.worktree.row(mainBranch))).toHaveAttribute(
      "aria-current",
      "true",
      { timeout: T_LONG }
    );
  });

  test("teardown failure does not block worktree deletion", async () => {
    const { window } = ctx;

    const configPath = path.join(fixtureDir, ".daintree", "config.json");
    const originalConfig = fs.readFileSync(configPath, "utf-8");

    const attemptMarker = path.join(fixtureDir, ".daintree", "teardown-attempt.txt");
    const failConfig = JSON.parse(originalConfig);
    // Record the attempt first so the assertion below can't pass because
    // teardown was skipped rather than failed.
    failConfig.resource.teardown = [
      nodeScriptCommand(path.join(fixtureDir, ".daintree", "resource-action.cjs"), [
        commandArg("env-status"),
        commandArg(attemptMarker),
      ]),
      "exit 1",
    ];
    fs.writeFileSync(configPath, JSON.stringify(failConfig, null, 2));
    execFileSync("git", ["add", "-A"], { cwd: fixtureDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "temp: failing teardown"], {
      cwd: fixtureDir,
      stdio: "ignore",
    });

    const failBranch = "e2e/resource-teardown-fail";
    const card = await createWorktree(window, failBranch);
    await card.click({ position: { x: 10, y: 10 } });
    await expect(window.locator(SEL.worktree.row(failBranch))).toHaveAttribute(
      "aria-current",
      "true",
      { timeout: T_LONG }
    );

    await runPaletteAction(window, ctx.app, "Provision Resource");

    await expect
      .poll(readResourceStatus, {
        timeout: T_LONG,
        message: "Provision should run before delete in teardown-failure flow",
      })
      .toBe("ready");

    await deleteWorktree(window, ctx.app, failBranch);

    await expect
      .poll(() => fs.existsSync(attemptMarker), {
        timeout: T_LONG,
        message: "Teardown should have been attempted",
      })
      .toBe(true);
    expect(fs.readFileSync(attemptMarker, "utf-8").split("\n")[0]).toBe(failBranch);
    expect(fs.existsSync(resourceStateFile())).toBe(true);

    fs.writeFileSync(configPath, originalConfig);
    execFileSync("git", ["add", "-A"], { cwd: fixtureDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "restore: original teardown"], {
      cwd: fixtureDir,
      stdio: "ignore",
    });
  });
});
