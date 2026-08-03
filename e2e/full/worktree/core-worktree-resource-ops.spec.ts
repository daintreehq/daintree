import path from "path";
import fs from "fs";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { ensureWindowFocused } from "../../helpers/focus";
import { writeResourceConfig, createWorktree } from "../../helpers/resource-lifecycle";

/**
 * E2E tests for worktree resource operations: status checks, pause, resume, provision.
 *
 * Uses shell script simulation instead of real Docker/SSH.
 * Each test checks the resource status badge after triggering lifecycle actions
 * via the action palette.
 */

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

const BRANCH = "e2e/resource-ops";
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.describe.serial("Full: Worktree Resource Ops", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "worktree-resource-ops",
    }));
    writeResourceConfig(fixtureDir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Worktree Resource Ops"
    );

    const card = await createWorktree(ctx.window, BRANCH);
    await card.click({ position: { x: 10, y: 10 } });
    await expect(ctx.window.locator(SEL.worktree.row(BRANCH))).toHaveAttribute(
      "aria-current",
      "true",
      { timeout: T_LONG }
    );

    await ensureWindowFocused(ctx.app);
    await ctx.window.keyboard.press(`${mod}+Shift+P`);
    const readyPalette = ctx.window.locator(SEL.actionPalette.dialog);
    await expect(readyPalette).toBeVisible({ timeout: T_MEDIUM });
    await readyPalette.locator(SEL.actionPalette.searchInput).fill("Check Resource Status");
    const readyOption = readyPalette
      .locator('[role="option"]')
      .filter({ hasText: /Check Resource Status/i });
    await expect(readyOption.first()).toBeVisible({ timeout: T_LONG });
    // First Escape clears the non-empty query, second closes (useEscapeStack).
    await ctx.window.keyboard.press("Escape");
    await ctx.window.keyboard.press("Escape");
    await expect(readyPalette).toBeHidden({ timeout: T_MEDIUM });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("manual status check shows resource badge", async () => {
    const { window } = ctx;

    await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({ timeout: T_LONG });

    await ensureWindowFocused(ctx.app);
    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: T_LONG });

    await newCard.click({ position: { x: 10, y: 10 } });

    const stateFile = path.join(fixtureDir, ".daintree", "resource-state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ status: "ready" }));

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

    await expect
      .poll(
        async () => {
          return await newCard.getAttribute("data-resource-status");
        },
        { timeout: T_LONG, message: "Resource status badge should reflect primed ready state" }
      )
      .toBe("ready");
  });

  test("pause resource action updates status", async () => {
    const { window } = ctx;

    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);

    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = palette.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Pause Resource");

    const pauseOption = palette.locator('[role="option"]').filter({ hasText: /Pause Resource/i });
    await expect(pauseOption.first()).toBeVisible({ timeout: T_SHORT });
    await pauseOption.first().click();

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
        message: "Resource badge should show paused",
      })
      .toBe("paused");
  });

  test("resume resource after pause restores ready status", async () => {
    const { window } = ctx;

    await ensureWindowFocused(ctx.app);
    await window.keyboard.press(`${mod}+Shift+P`);

    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = palette.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Resume Resource");

    const resumeOption = palette.locator('[role="option"]').filter({ hasText: /Resume Resource/i });
    await expect(resumeOption.first()).toBeVisible({ timeout: T_SHORT });
    await resumeOption.first().click();

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
        message: "Resource badge should show ready after resume",
      })
      .toBe("ready");
  });

  test("resource provision via action palette updates lifecycle status", async () => {
    const { window } = ctx;

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
      .toBe("ready");
  });

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
});
