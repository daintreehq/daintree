import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

/** Seed an in-repo recipe so the RecipePickerPopover (gated on globalRecipes.length > 0) renders. */
function seedRecipe(dir: string): void {
  const recipesDir = path.join(dir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  writeFileSync(
    path.join(recipesDir, "e2e-recipe.json"),
    JSON.stringify(
      {
        id: "inrepo-e2e",
        name: "E2E Recipe",
        terminals: [{ type: "terminal", title: "Shell", env: {} }],
        createdAt: 1700000000000,
        showInEmptyState: false,
      },
      null,
      2
    )
  );
}

/**
 * Local branches no worktree holds, so existing-branch mode has something to
 * offer: the fixture's `main` belongs to the root worktree and
 * `feature/test-branch` to the linked one, which leaves that list empty.
 * Distinct first letters so a one-character query narrows to exactly one.
 */
const SPARE_BRANCHES = ["e2e-spare-alpha", "e2e-spare-zulu"];

function seedSpareBranches(dir: string): void {
  for (const branch of SPARE_BRANCHES) {
    execSync(`git branch ${branch}`, { cwd: dir, stdio: "ignore" });
  }
}

/**
 * #11724: both panels were pinned to `w-[400px]` under a full-width trigger.
 * Only a real layout pass can catch that, so this measures boxes rather than
 * asserting on a class string. The listbox is the panel's only child under
 * `p-0`, so its border box is the panel's width — and it is a selector we own
 * rather than a Radix internal.
 */
async function expectPanelMatchesTrigger(trigger: Locator, listbox: Locator): Promise<void> {
  const triggerBox = await trigger.boundingBox();
  const panelBox = await listbox.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  // Sub-pixel rounding only; a hardcoded width would be off by far more.
  expect(Math.abs(panelBox!.width - triggerBox!.width)).toBeLessThanOrEqual(2);
}

async function openDialog(window: Page): Promise<void> {
  await window.locator(SEL.worktree.newWorktreeButton).click();
  const dialog = window.locator(SEL.worktree.newDialog);
  await expect(dialog).toBeVisible({ timeout: T_LONG });
  // Branch list loads via IPC behind a skeleton — gate on it disappearing
  // so the form fields are interactable before assertions run.
  await expect(window.locator('[aria-label="Loading branches"]')).toBeHidden({ timeout: T_LONG });
}

/** Close the dialog, dismissing the dirty-form discard guard if it appears. */
async function ensureDialogClosed(window: Page): Promise<void> {
  const dialog = window.locator(SEL.worktree.newDialog);
  if (!(await dialog.isVisible().catch(() => false))) return;

  await window
    .getByRole("button", { name: "Cancel" })
    .click({ timeout: T_SHORT })
    .catch(() => {});
  const discard = window.getByRole("button", { name: "Discard" });
  // The dirty-form confirmation can take a beat to render on a loaded CI runner;
  // match the Cancel click's budget so the Discard click isn't silently skipped.
  if (await discard.isVisible({ timeout: T_SHORT }).catch(() => false)) {
    await discard.click().catch(() => {});
  }
  await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
}

test.describe.serial("Full: New Worktree Dialog", () => {
  test.beforeAll(async () => {
    const { dir: fixture, cleanup } = createFixtureRepo({
      name: "new-worktree-dialog",
      withFeatureBranch: true,
    });
    fixtureCleanup = cleanup;
    seedRecipe(fixture);
    seedSpareBranches(fixture);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, "New Worktree Dialog");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.afterEach(async () => {
    await ensureDialogClosed(ctx.window);
  });

  test("opens the create-worktree dialog with a branch name input", async () => {
    const { window } = ctx;
    await openDialog(window);

    await expect(window.locator(SEL.worktree.newDialog)).toContainText("Create New Worktree");
    await expect(window.locator(SEL.worktree.branchNameInput)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.worktree.createButton)).toBeVisible();
  });

  test("branch mode defaults to New Branch and toggles to Existing Branch", async () => {
    const { window } = ctx;
    await openDialog(window);

    const group = window.locator(SEL.worktree.branchModeGroup);
    await expect(group).toBeVisible({ timeout: T_MEDIUM });

    const newRadio = group.getByRole("radio", { name: "New Branch" });
    const existingRadio = group.getByRole("radio", { name: "Existing Branch" });

    await expect(newRadio).toBeChecked();
    await expect(existingRadio).not.toBeChecked();
    await expect(window.locator(SEL.worktree.branchNameInput)).toBeVisible();

    await existingRadio.click();
    await expect(existingRadio).toBeChecked();
    await expect(newRadio).not.toBeChecked();
    // Existing mode swaps the new-branch text input for the existing-branch picker.
    await expect(window.locator(SEL.worktree.branchNameInput)).toBeHidden({ timeout: T_MEDIUM });

    await newRadio.click();
    await expect(newRadio).toBeChecked();
    await expect(window.locator(SEL.worktree.branchNameInput)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("shows a validation error for an empty branch name and clears it on input", async () => {
    const { window } = ctx;
    await openDialog(window);

    const input = window.locator(SEL.worktree.branchNameInput);
    await input.fill("");

    const createButton = window.locator(SEL.worktree.createButton);
    await expect(createButton).toBeEnabled({ timeout: T_LONG });
    await createButton.click();

    const alert = window.locator(SEL.worktree.validationError);
    await expect(alert).toBeVisible({ timeout: T_MEDIUM });
    await expect(alert).toContainText("branch name");

    // Typing a valid branch name clears the error (onChange resets validation).
    await input.fill("e2e-valid-branch");
    await expect(alert).toBeHidden({ timeout: T_MEDIUM });
  });

  test("omits the environment selector when no resource environments are configured", async () => {
    const { window } = ctx;
    await openDialog(window);

    // EnvironmentRadioGroup returns null without configured environments — a
    // plain fixture repo has none, so the group must not render.
    await expect(window.locator(SEL.worktree.environmentGroup)).toHaveCount(0);
  });

  test("recipe picker lists the clone-layout option and reflects selection", async () => {
    const { window } = ctx;
    await openDialog(window);

    const trigger = window.locator(SEL.worktree.recipeTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await trigger.click();

    // The popover portals to <body>, so query the listbox from the page root.
    const listbox = window.locator(SEL.worktree.recipeListbox);
    await expect(listbox).toBeVisible({ timeout: T_MEDIUM });

    const cloneOption = listbox.getByRole("option", { name: /Clone current layout/i });
    await expect(cloneOption).toBeVisible({ timeout: T_MEDIUM });
    await cloneOption.click();

    // #6289: gate on the portaled listbox unmounting first so a lingering
    // FocusScope doesn't swallow keys in the next serial test (and so the
    // trigger-text assertion below isn't racing the popover teardown).
    await expect(listbox).toHaveCount(0, { timeout: T_SHORT });
    await expect(trigger).toContainText(/Clone current layout/i, { timeout: T_MEDIUM });
  });

  test("selecting an in-use base branch keeps the dialog open and the form intact", async () => {
    const { window } = ctx;
    await openDialog(window);

    // Dirty the form first: #11714 discarded typed input by closing the dialog,
    // so a surviving value is the observable proof the diversion is gone.
    const branchInput = window.locator(SEL.worktree.branchNameInput);
    await branchInput.fill("e2e-keeps-form-state");

    const trigger = window.locator(SEL.worktree.baseBranchTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await trigger.click();

    // The popover portals to <body>, so query the listbox from the page root.
    const listbox = window.locator(SEL.worktree.baseBranchListbox);
    await expect(listbox).toBeVisible({ timeout: T_MEDIUM });

    // withFeatureBranch checks feature/test-branch out into a linked worktree,
    // so its row is the one carrying the "in use" badge.
    const inUseOption = listbox.getByRole("option", { name: /feature\/test-branch/ });
    await expect(inUseOption).toContainText("in use", { timeout: T_MEDIUM });
    await inUseOption.click();

    // #6289: gate on the portaled listbox unmounting before asserting on the trigger.
    await expect(listbox).toHaveCount(0, { timeout: T_SHORT });
    await expect(window.locator(SEL.worktree.newDialog)).toBeVisible();
    await expect(trigger).toContainText("feature/test-branch", { timeout: T_MEDIUM });
    await expect(branchInput).toHaveValue("e2e-keeps-form-state");
  });

  // #11724: both panels were pinned to 400px under a full-width trigger. Only a
  // real layout pass can prove the fix, so this measures boxes rather than
  // asserting on a class string.
  test("the base-branch panel is exactly as wide as its trigger", async () => {
    const { window } = ctx;
    await openDialog(window);

    const trigger = window.locator(SEL.worktree.baseBranchTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await trigger.click();

    const listbox = window.locator(SEL.worktree.baseBranchListbox);
    await expect(listbox).toBeVisible({ timeout: T_MEDIUM });

    // The listbox is the panel's only child under `p-0`, so its border box IS the
    // panel width — and it's a selector we own, not a Radix internal.
    await expectPanelMatchesTrigger(trigger, listbox);

    await window.keyboard.press("Escape");
    await expect(listbox).toHaveCount(0, { timeout: T_SHORT });
    // The dialog owns Escape too, so the panel must have swallowed its own.
    await expect(window.locator(SEL.worktree.newDialog)).toBeVisible();
  });

  test("the existing-branch panel is keyboard-operable and matches its trigger", async () => {
    const { window } = ctx;
    await openDialog(window);

    await window
      .locator(SEL.worktree.branchModeGroup)
      .getByRole("radio", { name: "Existing Branch" })
      .click();

    const trigger = window.locator(SEL.worktree.existingBranchTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await trigger.click();

    const listbox = window.locator(SEL.worktree.existingBranchListbox);
    await expect(listbox).toBeVisible({ timeout: T_MEDIUM });

    await expectPanelMatchesTrigger(trigger, listbox);

    // `main` belongs to the root worktree and feature/test-branch to the linked
    // one, so the seeded spares are the only selectable candidates here.
    const search = window.getByLabel("Search existing branches");
    await expect(listbox.getByRole("option")).toHaveCount(SPARE_BRANCHES.length, {
      timeout: T_MEDIUM,
    });

    // A single character used to blank the list entirely.
    await search.fill("z");
    await expect(listbox.getByRole("option")).toHaveCount(1, { timeout: T_MEDIUM });
    await expect(listbox.getByRole("option").first()).toHaveText(/e2e-spare-zulu/);

    // Multi-token, which the single-Bitap-pattern search could never match.
    await search.fill("spare alpha");
    await expect(listbox.getByRole("option")).toHaveCount(1, { timeout: T_MEDIUM });

    // This field had no arrow-key or Enter handling at all — mouse only.
    await search.fill("");
    await expect(listbox.getByRole("option")).toHaveCount(SPARE_BRANCHES.length, {
      timeout: T_MEDIUM,
    });
    const cursor = listbox.locator('[role="option"][aria-selected="true"]');
    await expect(cursor).toHaveCount(1);
    const beforeArrow = await cursor.getAttribute("id");

    await search.press("ArrowDown");

    // The cursor must actually MOVE — recording whichever row is current after the
    // key and then checking Enter picked it would pass with ArrowDown unhandled.
    await expect(cursor).toHaveCount(1);
    const afterArrow = await cursor.getAttribute("id");
    expect(afterArrow).toBeTruthy();
    expect(afterArrow).not.toBe(beforeArrow);
    expect(await search.getAttribute("aria-activedescendant")).toBe(afterArrow);

    // The row's first span is the bare branch name; its whole textContent also
    // carries the recency badge ("just now" for these fresh branches), which the
    // trigger deliberately does not render.
    const chosen = ((await cursor.locator("span").first().textContent()) ?? "").trim();
    expect(SPARE_BRANCHES).toContain(chosen);
    await search.press("Enter");

    await expect(listbox).toHaveCount(0, { timeout: T_SHORT });
    await expect(window.locator(SEL.worktree.newDialog)).toBeVisible();
    await expect(trigger).toContainText(chosen, { timeout: T_MEDIUM });
  });
});
