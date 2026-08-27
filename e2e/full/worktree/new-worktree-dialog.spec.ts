import { test, expect, type Page } from "@playwright/test";
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

    await expect(window.locator(SEL.worktree.newDialog)).toContainText("Create worktree");
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

  test("the existing-branch panel searches from one character and drives from the keyboard", async () => {
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
  test("a click elsewhere in the form dismisses an open picker", async () => {
    const { window } = ctx;
    await openDialog(window);

    // AppDialog stops click propagation on its panel, which used to swallow the
    // click Radix defers its outside-dismissal to: every picker in every dialog
    // stayed open until you pressed Escape or clicked its own trigger again.
    const baseTrigger = window.locator(SEL.worktree.baseBranchTrigger);
    await baseTrigger.click();
    const branchList = window.locator(SEL.worktree.baseBranchListbox);
    await expect(branchList).toBeVisible({ timeout: T_MEDIUM });

    await window.locator("h3", { hasText: "Destination" }).first().click();
    await expect(branchList).toHaveCount(0, { timeout: T_MEDIUM });
    // The click lands inside the dialog, so the dialog itself must survive it.
    await expect(window.locator(SEL.worktree.newDialog)).toBeVisible();

    const recipeTrigger = window.locator(SEL.worktree.recipeTrigger);
    await recipeTrigger.click();
    const recipeList = window.locator(SEL.worktree.recipeListbox);
    await expect(recipeList).toBeVisible({ timeout: T_MEDIUM });

    await window.locator("h3", { hasText: "Destination" }).first().click();
    await expect(recipeList).toHaveCount(0, { timeout: T_MEDIUM });
    await expect(window.locator(SEL.worktree.newDialog)).toBeVisible();
  });

  test("the base-branch and recipe pickers open at their trigger's width", async () => {
    const { window } = ctx;
    await openDialog(window);

    // The recipe and issue panels were pinned at 400px while the branch pickers
    // tracked their trigger, so working down the form stepped the surface width.
    const widthOf = async (locator: ReturnType<Page["locator"]>) => {
      const box = await locator.boundingBox();
      return Math.round(box?.width ?? 0);
    };

    for (const [triggerSel, listSel] of [
      [SEL.worktree.baseBranchTrigger, SEL.worktree.baseBranchListbox],
      [SEL.worktree.recipeTrigger, SEL.worktree.recipeListbox],
    ] as const) {
      const trigger = window.locator(triggerSel);
      await trigger.click();
      const list = window.locator(listSel);
      await expect(list).toBeVisible({ timeout: T_MEDIUM });
      // The panel itself, not the listbox inside it (which gives up a few
      // pixels to the scrollbar) and not the popper wrapper around it (which
      // carries Radix's own `min-width: max-content`). Polled, not read once:
      // Radix parks the panel off-screen at content width until Floating UI's
      // first pass publishes the anchor width it sizes from, and `toBeVisible`
      // is already true by then.
      const panel = window.locator(
        `[data-radix-popper-content-wrapper]:has(${listSel}) > [role="dialog"]`
      );
      await expect
        .poll(async () => Math.abs((await widthOf(panel)) - (await widthOf(trigger))), {
          timeout: T_MEDIUM,
        })
        .toBeLessThanOrEqual(2);
      await window.keyboard.press("Escape");
      await expect(list).toHaveCount(0, { timeout: T_SHORT });
    }
  });
  test("the dialog body reserves its scrollbar so fields cannot resize under it", async () => {
    const { window } = ctx;
    await openDialog(window);

    // The app's scrollbar is 11px of real layout (`scrollbar-width: thin` in
    // index.css outranks the 6px ::-webkit-scrollbar rule), so a body that only
    // makes room for it once it overflows resizes every control in the form the
    // moment a hint row or a validation banner tips it over the fold.
    //
    // Asserted as the mechanism rather than by forcing an overflow: the window
    // has a 600px minimum, and at that height this form still fits, so a
    // shrink-until-it-scrolls test would pass without ever scrolling. Reserved
    // space is directly observable — the content box is already narrower than
    // the border box while nothing is scrolling, which is the whole point.
    const body = window.locator(`${SEL.worktree.newDialog} .overflow-y-auto`).first();
    const { reserved, scrolling } = await body.evaluate((el) => ({
      reserved: el.getBoundingClientRect().width - el.clientWidth,
      scrolling: el.scrollHeight > el.clientHeight + 1,
    }));

    expect(scrolling).toBe(false);
    // Both edges, so the padding stays symmetric — hence two gutters, not one.
    expect(reserved).toBeGreaterThan(0);

    // And the fields actually live inside that reserved box.
    const fieldWidth = Math.round(
      (await window.locator(SEL.worktree.baseBranchTrigger).boundingBox())?.width ?? 0
    );
    const contentWidth = await body.evaluate(
      (el) => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) * 2
    );
    expect(fieldWidth).toBeLessThanOrEqual(Math.round(contentWidth));
  });

  test("a long branch name crops in the footer instead of pushing the actions out", async () => {
    const { window } = ctx;
    await openDialog(window);

    // Built from a repeat rather than a literal so the name is unambiguously
    // wider than the footer at any font scale, and so the assertion below is
    // about geometry rather than about where the crop happens to land.
    const longBranch = `feature/${"payload-segment-".repeat(6)}end`;
    await window.locator(SEL.worktree.branchNameInput).fill(longBranch);

    const panel = window.locator(`${SEL.worktree.newDialog} > div`).first();
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();

    // The bug: the footer hint grew to its content width and shoved both
    // actions past the panel's right edge, where they were clipped away.
    for (const action of [
      window.locator(SEL.worktree.createButton),
      window.getByRole("button", { name: "Cancel", exact: true }),
    ]) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
    }

    // Cropping is only acceptable because nothing is lost: the footer still
    // carries the whole name for assistive tech and for the hover tooltip.
    const footer = window.locator(`${SEL.worktree.newDialog} .border-t`).last();
    await expect(footer).toContainText(longBranch);
  });
});
