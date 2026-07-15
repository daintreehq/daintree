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
import { waitForTerminalText } from "../../helpers/terminal";
import {
  writeResourceConfig,
  createWorktree,
  commandArg,
  nodeScriptCommand,
  sameFilesystemEntry,
} from "../../helpers/resource-lifecycle";

/**
 * E2E tests for worktree resource command substitution: connect commands,
 * DAINTREE_* environment variables, and {{branch}}/{{worktree_path}} templates.
 *
 * Uses shell script simulation instead of real Docker/SSH.
 */

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

const BRANCH = "e2e/resource-substitution";
const mod = process.platform === "darwin" ? "Meta" : "Control";

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

test.describe.serial("Full: Worktree Resource Substitution", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "worktree-resource-substitution",
    }));
    writeResourceConfig(fixtureDir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Worktree Resource Substitution"
    );

    const card = await createWorktree(ctx.window, BRANCH);
    await card.click({ position: { x: 10, y: 10 } });
    await expect
      .poll(() => card.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Worktree card should become selected",
      })
      .toContain("selected");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("connect action spawns terminal with substituted worktree_name variable", async () => {
    const { window } = ctx;

    const panelIdsBefore = new Set(await getGridPanelIds(window));

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

    const newPanel = await waitForNewGridPanel(window, panelIdsBefore);
    const xtermScreen = newPanel.locator(SEL.terminal.xtermRows);
    await expect(xtermScreen).toBeVisible({ timeout: T_MEDIUM });

    await waitForTerminalText(newPanel, `CONNECTED_TO_${BRANCH}`, T_LONG);
  });

  test("DAINTREE_* env vars are available in lifecycle commands", async () => {
    const { window } = ctx;

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

    const wtDaintreeDir = path.join(worktreePath, ".daintree");
    fs.mkdirSync(wtDaintreeDir, { recursive: true });
    const wtConfigPath = path.join(wtDaintreeDir, "config.json");
    const markerFile = path.join(wtDaintreeDir, "env-marker.txt");

    const mainDaintreeDir = path.join(fixtureDir, ".daintree");
    const originalConfig = fs.readFileSync(path.join(mainDaintreeDir, "config.json"), "utf-8");
    const config = JSON.parse(originalConfig);

    config.resource.status = nodeScriptCommand(path.join(mainDaintreeDir, "resource-action.cjs"), [
      commandArg("env-status"),
      commandArg(markerFile),
    ]);

    fs.writeFileSync(
      path.join(mainDaintreeDir, "resource-state.json"),
      JSON.stringify({ status: "ready" })
    );
    fs.writeFileSync(wtConfigPath, JSON.stringify(config, null, 2));

    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);
    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.actionPalette.searchInput).fill("Check Resource Status");
    const option = palette.locator('[role="option"]').filter({ hasText: /Check Resource Status/i });
    await expect(option.first()).toBeVisible({ timeout: T_SHORT });
    await option.first().click();

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
    expect(marker[0]?.length).toBeGreaterThan(0);
    expect(marker[1]?.length).toBeGreaterThan(0);
    expect(sameFilesystemEntry(marker[2]!, fixtureDir)).toBe(true);

    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
    if (fs.existsSync(wtConfigPath)) fs.unlinkSync(wtConfigPath);
  });

  test("{{branch}} and {{worktree_path}} are substituted in connect command", async () => {
    const { window } = ctx;

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

    const wtDaintreeDir = path.join(worktreePath, ".daintree");
    fs.mkdirSync(wtDaintreeDir, { recursive: true });
    const wtConfigPath = path.join(wtDaintreeDir, "config.json");

    const mainDaintreeDir = path.join(fixtureDir, ".daintree");
    const originalConfig = fs.readFileSync(path.join(mainDaintreeDir, "config.json"), "utf-8");
    const config = JSON.parse(originalConfig);

    config.resource.connect = nodeScriptCommand(path.join(mainDaintreeDir, "resource-action.cjs"), [
      commandArg("connect"),
      "BRANCH={{branch}}",
      "PATH={{worktree_path}}",
      "PROJECT={{project_root}}",
    ]);
    fs.writeFileSync(wtConfigPath, JSON.stringify(config, null, 2));

    await ensureWindowFocused(ctx.app);
    await window.evaluate(async () => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (actionId: string, args?: unknown) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (!dispatch) throw new Error("__daintreeDispatchAction is not installed");
      await dispatch("worktree.resource.provision");
    });

    // Provision is idempotent — a no-op when the resource is already ready — so the
    // helper script may not re-run. Wait for the renderer store used by the
    // Connect action to ingest the rewritten config before dispatching it.
    await expect
      .poll(
        async () =>
          window.evaluate(
            async ({ branch }) => {
              const states = window.__DAINTREE_E2E_WORKTREES__?.() ?? [];
              return states.find((state) => state.branch === branch)?.resourceConnectCommand ?? "";
            },
            { branch: BRANCH }
          ),
        { timeout: T_LONG, message: "Updated resource connect command should be visible" }
      )
      .toContain("BRANCH=");

    const panelIdsBefore = new Set(await getGridPanelIds(window));
    await window.evaluate(
      async ({ branch }) => {
        const worktree = window
          .__DAINTREE_E2E_WORKTREES__?.()
          .find((state) => state.branch === branch);
        if (!worktree?.resourceConnectCommand?.includes("BRANCH=")) {
          throw new Error("Renderer worktree snapshot does not contain the rewritten command");
        }
        const dispatch = window.__daintreeDispatchAction;
        if (!dispatch) throw new Error("__daintreeDispatchAction is not installed");
        await dispatch("worktree.resource.connect", { worktreeId: worktree.id });
      },
      { branch: BRANCH }
    );

    const newPanel = await waitForNewGridPanel(window, panelIdsBefore);
    const xtermScreen = newPanel.locator(SEL.terminal.xtermRows);
    await expect(xtermScreen).toBeVisible({ timeout: T_MEDIUM });

    await waitForTerminalText(newPanel, `BRANCH=${BRANCH}`, T_LONG);
    await waitForTerminalText(newPanel, process.platform === "win32" ? "PATH=" : "PATH=/", T_LONG);

    if (fs.existsSync(wtConfigPath)) fs.unlinkSync(wtConfigPath);
  });
});
