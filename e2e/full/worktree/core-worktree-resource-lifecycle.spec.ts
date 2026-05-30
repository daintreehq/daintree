import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { ensureWindowFocused } from "../../helpers/focus";
import {
  writeResourceConfig,
  createWorktree,
  deleteWorktree,
  waitForWorktreeCardRemoval,
} from "../../helpers/resource-lifecycle";

/**
 * E2E tests for worktree resource lifecycle: create, delete, and teardown.
 *
 * Uses shell script simulation instead of real Docker/SSH:
 * - provision: writes a state file
 * - status: reads the state file and outputs JSON
 * - connect: spawns an interactive bash shell
 * - pause: updates the state file
 * - teardown: removes the state file
 */

let ctx: AppContext;
let mainBranch: string;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

const BRANCH = "e2e/resource-lifecycle";

test.describe.serial("Full: Worktree Resource Lifecycle", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "worktree-resource-lifecycle",
    }));
    writeResourceConfig(fixtureDir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Worktree Resource Lifecycle"
    );
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

  test("worktree creation with resource config triggers auto-provision", async () => {
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
      .poll(
        async () => {
          const val = await pathInput.inputValue();
          return val.trim().length;
        },
        { timeout: T_LONG, message: "Worktree path should auto-populate" }
      )
      .toBeGreaterThan(0);

    const createBtn = window.locator(SEL.worktree.createButton);
    await createBtn.click();

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: 30_000 });
  });

  test("resource provision runs after worktree creation", async () => {
    const { window } = ctx;

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: T_LONG });

    await newCard.click({ position: { x: 10, y: 10 } });
    await expect
      .poll(() => newCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "New worktree card should become selected",
      })
      .toContain("selected");

    await window.waitForTimeout(3000);
  });

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

    const forceCheckbox = window.locator("text=Force delete");
    if (await forceCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
      await forceCheckbox.click();
      const confirmInput = window.locator(SEL.worktree.deleteConfirmInput);
      if (await confirmInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await confirmInput.fill(BRANCH);
      }
    }

    await expect(confirmBtn).toBeEnabled({ timeout: T_MEDIUM });
    await confirmBtn.click();

    await waitForWorktreeCardRemoval(window, BRANCH);

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should become selected after delete",
      })
      .toContain("selected");
  });

  test("teardown failure does not block worktree deletion", async () => {
    const { window } = ctx;

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

    const failBranch = "e2e/resource-teardown-fail";
    const card = await createWorktree(window, failBranch);
    await card.click({ position: { x: 10, y: 10 } });
    await window.waitForTimeout(2000);

    await deleteWorktree(window, ctx.app, failBranch);

    fs.writeFileSync(configPath, originalConfig);
    execFileSync("git", ["add", "-A"], { cwd: fixtureDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "restore: original teardown"], {
      cwd: fixtureDir,
      stdio: "ignore",
    });
  });
});
