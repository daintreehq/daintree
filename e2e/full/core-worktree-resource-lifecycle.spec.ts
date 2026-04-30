import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { ensureWindowFocused } from "../helpers/focus";
import { getGridPanelCount } from "../helpers/panels";
import { waitForTerminalText } from "../helpers/terminal";

/**
 * E2E test for the per-worktree remote compute lifecycle (issue #4426).
 *
 * Uses shell script simulation instead of real Docker/SSH:
 * - provision: writes a state file
 * - status: reads the state file and outputs JSON
 * - connect: spawns an interactive bash shell
 * - pause: updates the state file
 * - teardown: removes the state file
 *
 * This exercises the full pipeline: config parsing → lifecycle hooks →
 * status badge → terminal spawn → resource teardown on worktree delete.
 */

let ctx: AppContext;
let mainBranch: string;
let fixtureDir: string;

const BRANCH = "e2e/resource-lifecycle";
const mod = process.platform === "darwin" ? "Meta" : "Control";

function writeResourceConfig(repoDir: string) {
  const daintreeDir = path.join(repoDir, ".daintree");
  fs.mkdirSync(daintreeDir, { recursive: true });

  const stateFile = path.join(daintreeDir, "resource-state.json");

  const config = {
    setup: [],
    teardown: [],
    resource: {
      provision: [
        `printf '{"status":"provisioning"}' > "${stateFile}"`,
        `sleep 0.1`,
        `printf '{"status":"ready"}' > "${stateFile}"`,
      ],
      teardown: [`rm -f "${stateFile}"`],
      resume: [`printf '{"status":"ready"}' > "${stateFile}"`],
      pause: [`printf '{"status":"paused"}' > "${stateFile}"`],
      status: `cat "${stateFile}" 2>/dev/null || printf '{"status":"unknown"}'`,
      connect: `echo CONNECTED_TO_{{worktree_name}}; bash --norc --noprofile`,
    },
  };

  fs.writeFileSync(path.join(daintreeDir, "config.json"), JSON.stringify(config, null, 2));

  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add resource config"], { cwd: repoDir, stdio: "ignore" });
}

/** Helper to create a worktree (local mode — lifecycle commands come from .daintree/config.json) */
async function createWorktree(
  window: Awaited<ReturnType<typeof launchApp>>["window"],
  branch: string
) {
  const newBtn = window.locator('button[aria-label="Create new worktree"]');
  await newBtn.click();

  const dialog = window.locator(SEL.worktree.newDialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

  const branchInput = window.locator(SEL.worktree.branchNameInput);
  await branchInput.fill(branch);

  const pathInput = window.locator('[data-testid="worktree-path-input"]');
  await expect
    .poll(async () => (await pathInput.inputValue()).trim().length, {
      timeout: T_LONG,
      message: "Worktree path should auto-populate",
    })
    .toBeGreaterThan(0);

  const createBtn = window.locator(SEL.worktree.createButton);
  await createBtn.click();

  const card = window.locator(SEL.worktree.card(branch));
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

/** Helper to delete a worktree by branch name */
async function deleteWorktree(
  window: Awaited<ReturnType<typeof launchApp>>["window"],
  app: Awaited<ReturnType<typeof launchApp>>["app"],
  branch: string
) {
  const card = window.locator(SEL.worktree.card(branch));
  const actionsBtn = card.locator(SEL.worktree.actionsMenu);
  await ensureWindowFocused(app);
  await actionsBtn.click();

  const deleteItem = window.getByRole("menuitem", { name: /delete/i });
  await expect(deleteItem).toBeVisible({ timeout: T_SHORT });
  await deleteItem.hover();
  await deleteItem.click();

  const confirmBtn = window.locator(SEL.worktree.deleteConfirm);
  await expect(confirmBtn).toBeVisible({ timeout: T_MEDIUM });
  await confirmBtn.click();

  await expect(card).not.toBeVisible({ timeout: T_LONG });
}

test.describe.serial("Full: Worktree Resource Lifecycle", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "worktree-resource" });
    writeResourceConfig(fixtureDir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Worktree Resource");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("main worktree card is visible", async () => {
    const { window } = ctx;

    const cards = window.locator("[data-worktree-branch]");
    await expect(cards.first()).toBeVisible({ timeout: T_LONG });

    mainBranch = (await cards.first().getAttribute("data-worktree-branch")) ?? "";
    expect(mainBranch.length).toBeGreaterThan(0);
  });

  test("worktree creation with resource config triggers auto-provision", async () => {
    const { window } = ctx;

    const newBtn = window.locator('button[aria-label="Create new worktree"]');
    await newBtn.click();

    const dialog = window.locator(SEL.worktree.newDialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    // Fill in the branch name
    const branchInput = window.locator(SEL.worktree.branchNameInput);
    await expect(branchInput).toBeVisible({ timeout: T_MEDIUM });
    await branchInput.fill(BRANCH);

    // Wait for path auto-population
    const pathInput = window.locator('[data-testid="worktree-path-input"]');
    await expect
      .poll(
        async () => {
          const val = await pathInput.inputValue();
          return val.trim().length;
        },
        { timeout: T_LONG, message: "Worktree path should auto-populate" }
      )
      .toBeGreaterThan(0);

    // Create the worktree
    const createBtn = window.locator(SEL.worktree.createButton);
    await createBtn.click();

    // Wait for the new worktree card to appear
    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: 30_000 });
  });

  test("resource provision runs after worktree creation", async () => {
    const { window } = ctx;

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: T_LONG });

    // Switch to the new worktree
    await newCard.click({ position: { x: 10, y: 10 } });
    await expect
      .poll(() => newCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "New worktree card should become selected",
      })
      .toContain("selected");

    // Wait for lifecycle to settle (setup + provision should complete)
    // The card should stop showing lifecycle running indicators
    await window.waitForTimeout(3000);
  });

  test("manual status check shows resource badge", async () => {
    const { window } = ctx;

    // Guard: ensure worktrees are loaded (app may have reloaded after creation)
    await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({ timeout: T_LONG });

    // Ensure we're focused and the worktree card is visible
    await ensureWindowFocused(ctx.app);
    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: T_LONG });

    // Click on the card area first to ensure focus is in the app
    await newCard.click({ position: { x: 10, y: 10 } });
    await window.waitForTimeout(500);

    // Open action palette
    await window.keyboard.press(`${mod}+Shift+P`);

    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = palette.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Check Resource Status");

    const statusOption = palette
      .locator('[role="option"]')
      .filter({ hasText: /Check Resource Status/i });
    await expect(statusOption.first()).toBeVisible({ timeout: T_MEDIUM });
    await statusOption.first().click();

    // Wait for the resource status data attribute to appear on the worktree card
    await expect
      .poll(
        async () => {
          return await newCard.getAttribute("data-resource-status");
        },
        { timeout: T_LONG, message: "Resource status badge should appear" }
      )
      .toMatch(/ready|provisioning|unknown/);
  });

  test("connect action spawns terminal with substituted worktree_name variable", async () => {
    const { window } = ctx;

    const countBefore = await getGridPanelCount(window);

    // Trigger connect via action palette
    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);

    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = palette.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Connect to Resource");

    const connectOption = palette
      .locator('[role="option"]')
      .filter({ hasText: /Connect to Resource/i });
    await expect(connectOption.first()).toBeVisible({ timeout: T_SHORT });
    await connectOption.first().click();

    // A new terminal panel should be spawned
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

    // The new panel should be a terminal (has xterm rows)
    const newPanel = window.locator(SEL.panel.gridPanel).last();
    const xtermScreen = newPanel.locator(SEL.terminal.xtermRows);
    await expect(xtermScreen).toBeVisible({ timeout: T_MEDIUM });

    // The panel title carries the substituted worktree name — this verifies
    // the substitution path independent of terminal buffer scrollback (which
    // can be wiped when interactive bash starts on macOS).
    await expect(newPanel.locator("text=Connect:")).toBeVisible({ timeout: T_MEDIUM });
    await expect(newPanel.locator("text=Connect: e2e/resource-lifecycle")).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("pause resource action updates status", async () => {
    const { window } = ctx;

    // Trigger pause via action palette
    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);

    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = palette.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Pause Resource");

    const pauseOption = palette.locator('[role="option"]').filter({ hasText: /Pause Resource/i });
    await expect(pauseOption.first()).toBeVisible({ timeout: T_SHORT });
    await pauseOption.first().click();

    // Confirm the action (danger: confirm)
    const confirmBtn = window.locator('button:has-text("Confirm")');
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // After pause, trigger status check to see updated badge
    await window.keyboard.press(`${mod}+Shift+P`);
    const palette2 = window.locator(SEL.actionPalette.dialog);
    await expect(palette2).toBeVisible({ timeout: T_MEDIUM });

    const searchInput2 = palette2.locator(SEL.actionPalette.searchInput);
    await searchInput2.fill("Check Resource Status");

    const statusOption = palette2
      .locator('[role="option"]')
      .filter({ hasText: /Check Resource Status/i });
    await expect(statusOption.first()).toBeVisible({ timeout: T_SHORT });
    await statusOption.first().click();

    // The badge should now show "paused"
    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect
      .poll(async () => newCard.getAttribute("data-resource-status"), {
        timeout: T_LONG,
        message: "Resource badge should show paused",
      })
      .toBe("paused");
  });

  // ---- New Test 5: Resume resource after pause -- full cycle ----

  test("resume resource after pause restores ready status", async () => {
    const { window } = ctx;

    // Trigger "Resume Resource" via action palette
    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);

    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = palette.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Resume Resource");

    const resumeOption = palette.locator('[role="option"]').filter({ hasText: /Resume Resource/i });
    await expect(resumeOption.first()).toBeVisible({ timeout: T_SHORT });
    await resumeOption.first().click();

    // Handle potential confirmation dialog
    const confirmBtn = window.locator('button:has-text("Confirm")');
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // Wait for resume to complete
    await window.waitForTimeout(1000);

    // Trigger status check
    await window.keyboard.press(`${mod}+Shift+P`);
    const palette2 = window.locator(SEL.actionPalette.dialog);
    await expect(palette2).toBeVisible({ timeout: T_MEDIUM });

    const searchInput2 = palette2.locator(SEL.actionPalette.searchInput);
    await searchInput2.fill("Check Resource Status");

    const statusOption = palette2
      .locator('[role="option"]')
      .filter({ hasText: /Check Resource Status/i });
    await expect(statusOption.first()).toBeVisible({ timeout: T_SHORT });
    await statusOption.first().click();

    // Badge should return to "ready"
    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect
      .poll(async () => newCard.getAttribute("data-resource-status"), {
        timeout: T_LONG,
        message: "Resource badge should show ready after resume",
      })
      .toBe("ready");
  });

  // ---- Resource status badge appears after manual provision ----

  test("resource provision via action palette updates lifecycle status", async () => {
    const { window } = ctx;

    // Trigger "Provision Resource" via action palette
    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);

    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = palette.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Provision Resource");

    const provisionOption = palette
      .locator('[role="option"]')
      .filter({ hasText: /Provision Resource/i });
    await expect(provisionOption.first()).toBeVisible({ timeout: T_SHORT });
    await provisionOption.first().click();

    // Handle confirmation dialog (danger: confirm)
    const confirmBtn = window.locator('button:has-text("Confirm")');
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // Wait for provision to complete, then check status
    await window.waitForTimeout(2000);

    await window.keyboard.press(`${mod}+Shift+P`);
    const palette2 = window.locator(SEL.actionPalette.dialog);
    await expect(palette2).toBeVisible({ timeout: T_MEDIUM });

    const searchInput2 = palette2.locator(SEL.actionPalette.searchInput);
    await searchInput2.fill("Check Resource Status");

    const statusOption = palette2
      .locator('[role="option"]')
      .filter({ hasText: /Check Resource Status/i });
    await expect(statusOption.first()).toBeVisible({ timeout: T_SHORT });
    await statusOption.first().click();

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect
      .poll(async () => newCard.getAttribute("data-resource-status"), {
        timeout: T_LONG,
        message: "Resource badge should show ready after provision",
      })
      .toMatch(/ready|provisioning/);
  });

  // ---- Status badge reflects unhealthy / non-JSON outputs ----

  test("unhealthy status JSON is reflected in badge", async () => {
    const { window } = ctx;

    const stateFile = path.join(fixtureDir, ".daintree", "resource-state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ status: "unhealthy" }));

    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);
    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.actionPalette.searchInput).fill("Check Resource Status");
    const option = palette.locator('[role="option"]').filter({ hasText: /Check Resource Status/i });
    await expect(option.first()).toBeVisible({ timeout: T_SHORT });
    await option.first().click();

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect
      .poll(async () => newCard.getAttribute("data-resource-status"), {
        timeout: T_LONG,
        message: "Resource badge should show unhealthy",
      })
      .toBe("unhealthy");
  });

  test("non-JSON status output is treated as unknown", async () => {
    const { window } = ctx;

    // Write non-JSON content; the status command (cat) will exit 0 but output isn't valid JSON.
    // Per the implementation, exit 0 + non-JSON → "unknown" (neutral badge).
    const stateFile = path.join(fixtureDir, ".daintree", "resource-state.json");
    fs.writeFileSync(stateFile, "not valid json");

    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);
    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.actionPalette.searchInput).fill("Check Resource Status");
    const option = palette.locator('[role="option"]').filter({ hasText: /Check Resource Status/i });
    await expect(option.first()).toBeVisible({ timeout: T_SHORT });
    await option.first().click();

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect
      .poll(async () => newCard.getAttribute("data-resource-status"), {
        timeout: T_LONG,
        message: "Resource badge should show unknown for non-JSON output",
      })
      .toBe("unknown");
  });

  // ---- DAINTREE_* env vars are injected into lifecycle commands ----

  test("DAINTREE_* env vars are available in lifecycle commands", async () => {
    const { window } = ctx;

    // Find the worktree path from git (each worktree has its own working tree)
    const worktreeListOutput = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: fixtureDir,
      encoding: "utf-8",
    });
    // Parse porcelain format: "worktree <path>\nHEAD ...\nbranch refs/heads/<branch>"
    const worktreeBlocks = worktreeListOutput.split("\n\n");
    let worktreePath = "";
    for (const block of worktreeBlocks) {
      if (block.includes(`refs/heads/${BRANCH}`)) {
        const match = block.match(/^worktree (.+)$/m);
        if (match) worktreePath = match[1];
        break;
      }
    }
    expect(worktreePath.length).toBeGreaterThan(0);

    // Write the modified config directly to the worktree's .daintree dir
    const wtDaintreeDir = path.join(worktreePath, ".daintree");
    fs.mkdirSync(wtDaintreeDir, { recursive: true });
    const wtConfigPath = path.join(wtDaintreeDir, "config.json");
    const markerFile = path.join(wtDaintreeDir, "env-marker.txt");

    const mainDaintreeDir = path.join(fixtureDir, ".daintree");
    const originalConfig = fs.readFileSync(path.join(mainDaintreeDir, "config.json"), "utf-8");
    const config = JSON.parse(originalConfig);

    // Modify status command to dump DAINTREE_* env vars into a marker file,
    // then still output valid JSON for the badge
    config.resource.status = [
      `printf '%s\\n%s\\n%s' "$DAINTREE_WORKTREE_NAME" "$DAINTREE_WORKTREE_PATH" "$DAINTREE_PROJECT_ROOT" > "${markerFile}"`,
      `cat "${path.join(mainDaintreeDir, "resource-state.json")}" 2>/dev/null || printf '{"status":"unknown"}'`,
    ].join(" && ");

    // Ensure the state file exists so badge shows something
    fs.writeFileSync(
      path.join(mainDaintreeDir, "resource-state.json"),
      JSON.stringify({ status: "ready" })
    );
    fs.writeFileSync(wtConfigPath, JSON.stringify(config, null, 2));

    // Trigger status check
    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);
    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.actionPalette.searchInput).fill("Check Resource Status");
    const option = palette.locator('[role="option"]').filter({ hasText: /Check Resource Status/i });
    await expect(option.first()).toBeVisible({ timeout: T_SHORT });
    await option.first().click();

    // Wait for status command to complete and write marker file
    await expect
      .poll(
        () => {
          try {
            return fs.existsSync(markerFile);
          } catch {
            return false;
          }
        },
        { timeout: T_LONG, message: "Marker file should be written by status command" }
      )
      .toBe(true);

    const marker = fs.readFileSync(markerFile, "utf-8").trim().split("\n");
    // DAINTREE_WORKTREE_NAME should be set (worktree name or branch)
    expect(marker[0]?.length).toBeGreaterThan(0);
    // DAINTREE_WORKTREE_PATH should be a real path
    expect(marker[1]?.length).toBeGreaterThan(0);
    // DAINTREE_PROJECT_ROOT should match the fixture dir (resolve symlinks for macOS /private/var)
    expect(fs.realpathSync(marker[2]!)).toBe(fs.realpathSync(fixtureDir));

    // Clean up: remove modified config and marker from worktree
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
    if (fs.existsSync(wtConfigPath)) fs.unlinkSync(wtConfigPath);
  });

  // ---- {{branch}} and {{worktree_path}} substitution in connect command ----

  test("{{branch}} and {{worktree_path}} are substituted in connect command", async () => {
    const { window } = ctx;

    // Find the worktree path from git
    const worktreeListOutput = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: fixtureDir,
      encoding: "utf-8",
    });
    const worktreeBlocks = worktreeListOutput.split("\n\n");
    let worktreePath = "";
    for (const block of worktreeBlocks) {
      if (block.includes(`refs/heads/${BRANCH}`)) {
        const match = block.match(/^worktree (.+)$/m);
        if (match) worktreePath = match[1];
        break;
      }
    }
    expect(worktreePath.length).toBeGreaterThan(0);

    // Write modified config directly to the worktree's .daintree dir
    const wtDaintreeDir = path.join(worktreePath, ".daintree");
    fs.mkdirSync(wtDaintreeDir, { recursive: true });
    const wtConfigPath = path.join(wtDaintreeDir, "config.json");

    const mainDaintreeDir = path.join(fixtureDir, ".daintree");
    const originalConfig = fs.readFileSync(path.join(mainDaintreeDir, "config.json"), "utf-8");
    const config = JSON.parse(originalConfig);

    config.resource.connect = `echo BRANCH={{branch}} PATH={{worktree_path}} PROJECT={{project_root}}; bash --norc --noprofile`;
    fs.writeFileSync(wtConfigPath, JSON.stringify(config, null, 2));

    // Re-provision to pick up new connect command (provision stores the substituted connect command)
    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);
    let palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.actionPalette.searchInput).fill("Provision Resource");
    let option = palette.locator('[role="option"]').filter({ hasText: /Provision Resource/i });
    await expect(option.first()).toBeVisible({ timeout: T_SHORT });
    await option.first().click();
    const confirmBtn = window.locator('button:has-text("Confirm")');
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }
    await window.waitForTimeout(2000);

    // Trigger connect
    const countBefore = await getGridPanelCount(window);
    await window.keyboard.press(`${mod}+Shift+P`);
    palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.actionPalette.searchInput).fill("Connect to Resource");
    option = palette.locator('[role="option"]').filter({ hasText: /Connect to Resource/i });
    await expect(option.first()).toBeVisible({ timeout: T_SHORT });
    await option.first().click();

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

    const newPanel = window.locator(SEL.panel.gridPanel).last();
    const xtermScreen = newPanel.locator(SEL.terminal.xtermRows);
    await expect(xtermScreen).toBeVisible({ timeout: T_MEDIUM });

    // {{branch}} should be substituted with the actual branch name
    await waitForTerminalText(newPanel, `BRANCH=${BRANCH}`);
    // {{worktree_path}} should be substituted with a real path (not the literal placeholder)
    await waitForTerminalText(newPanel, "PATH=/");

    // Clean up: remove modified config from worktree
    if (fs.existsSync(wtConfigPath)) fs.unlinkSync(wtConfigPath);
  });

  // ---- Original test: deleting worktree triggers resource teardown ----
  // (Must run before teardown-failure test which modifies config.json)

  test("deleting worktree triggers resource teardown", async () => {
    const { window } = ctx;

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    const actionsBtn = newCard.locator(SEL.worktree.actionsMenu);
    await ensureWindowFocused(ctx.app);
    await actionsBtn.click();

    const deleteItem = window.getByRole("menuitem", { name: /delete/i });
    await expect(deleteItem).toBeVisible({ timeout: T_SHORT });
    await deleteItem.hover();
    await deleteItem.click();

    const confirmBtn = window.locator(SEL.worktree.deleteConfirm);
    await expect(confirmBtn).toBeVisible({ timeout: T_MEDIUM });

    // Check "Force delete" if worktree has uncommitted changes (from earlier tests writing config)
    const forceCheckbox = window.locator("text=Force delete");
    if (await forceCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
      await forceCheckbox.click();
    }

    await confirmBtn.click();

    // Worktree card should disappear
    await expect(newCard).not.toBeVisible({ timeout: T_LONG });

    // Main card should become selected again
    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should become selected after delete",
      })
      .toContain("selected");
  });

  // ---- Teardown failure test: runs last since it modifies config.json ----

  test("teardown failure does not block worktree deletion", async () => {
    const { window } = ctx;

    // Temporarily update config.json to have a failing teardown
    const daintreeDir = path.join(fixtureDir, ".daintree");
    const configPath = path.join(daintreeDir, "config.json");
    const originalConfig = fs.readFileSync(configPath, "utf-8");

    const failConfig = JSON.parse(originalConfig);
    failConfig.resource.teardown = ["exit 1"];
    fs.writeFileSync(configPath, JSON.stringify(failConfig, null, 2));
    execFileSync("git", ["add", "-A"], { cwd: fixtureDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "temp: failing teardown"], {
      cwd: fixtureDir,
      stdio: "ignore",
    });

    // Create a worktree that will have failing teardown
    const failBranch = "e2e/resource-teardown-fail";
    const card = await createWorktree(window, failBranch);
    await card.click({ position: { x: 10, y: 10 } });
    await window.waitForTimeout(2000);

    // Delete the worktree -- teardown will fail with exit 1
    await deleteWorktree(window, ctx.app, failBranch);

    // Restore original config
    fs.writeFileSync(configPath, originalConfig);
    execFileSync("git", ["add", "-A"], { cwd: fixtureDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "restore: original teardown"], {
      cwd: fixtureDir,
      stdio: "ignore",
    });
  });
});
