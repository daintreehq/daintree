import path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { spawnTerminalAndVerify } from "../helpers/workflows";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { ensureWindowFocused } from "../helpers/focus";

let ctx: AppContext;
let mainBranch: string;
let worktreeDirName: string;

const BRANCH = "e2e/lifecycle-test";

test.describe.serial("Core: Worktree Lifecycle", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({ name: "worktree-lifecycle" });

    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixture, "Worktree Lifecycle");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("main worktree card is visible and selected", async () => {
    const { window } = ctx;

    const cards = window.locator("[data-worktree-branch]");
    await expect(cards.first()).toBeVisible({ timeout: T_LONG });

    mainBranch = (await cards.first().getAttribute("data-worktree-branch")) ?? "";
    expect(mainBranch.length).toBeGreaterThan(0);

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(mainCard).toHaveAttribute("aria-label", /selected/, { timeout: T_MEDIUM });
  });

  test("create new worktree via UI", async () => {
    const { window } = ctx;

    const newBtn = window.locator('button[aria-label="Create new worktree"]');
    await newBtn.click();

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

    // Capture the worktree directory name for later pwd verification
    const worktreePath = await pathInput.inputValue();
    worktreeDirName = path.basename(worktreePath.trim());

    const createBtn = window.locator(SEL.worktree.createButton);
    await createBtn.click();

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: 30_000 });
  });

  test("switch to new worktree and verify terminal pwd", async () => {
    const { window } = ctx;

    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await newCard.click({ position: { x: 10, y: 10 } });

    await expect
      .poll(() => newCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "New worktree card should become selected",
      })
      .toContain("selected");

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_MEDIUM,
        message: "Main card should lose selection",
      })
      .not.toContain("selected");

    const panel = await spawnTerminalAndVerify(window);
    await runTerminalCommand(window, panel, "pwd");
    await waitForTerminalText(panel, worktreeDirName);
  });

  test("delete active worktree auto-switches to main", async () => {
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
    await confirmBtn.click();

    await expect(newCard).not.toBeVisible({ timeout: T_LONG });

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect
      .poll(() => mainCard.getAttribute("aria-label"), {
        timeout: T_LONG,
        message: "Main card should become selected after deleting active worktree",
      })
      .toContain("selected");
  });

  test("worktree card removed from sidebar after deletion", async () => {
    const { window } = ctx;

    const deletedCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(deletedCard).toHaveCount(0);

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(mainCard).toBeVisible({ timeout: T_MEDIUM });
  });
});
