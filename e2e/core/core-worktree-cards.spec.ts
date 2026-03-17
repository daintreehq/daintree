import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
const MAIN = "main";
const FEATURE = "feature/test-branch";

test.describe.serial("Core: Worktree Cards", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({
      name: "worktree-cards",
      withFeatureBranch: true,
      withUncommittedChanges: true,
    });

    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixture, "Worktree Cards");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // -- Multi-Worktree Coverage --

  test.describe.serial("Multi-Worktree Coverage", () => {
    test("fixture shows main and feature worktree cards", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.card(MAIN));
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      await expect(mainCard).toBeVisible({ timeout: T_LONG });
      await expect(featureCard).toBeVisible({ timeout: T_LONG });
    });

    test("main card is selected by default", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.card(MAIN));
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      await expect
        .poll(() => mainCard.getAttribute("aria-label"), {
          timeout: T_LONG,
          message: "Main card should be selected by default",
        })
        .toContain("selected");

      const featureLabel = await featureCard.getAttribute("aria-label");
      expect(featureLabel).not.toContain("selected");
    });

    test("main worktree shows uncommitted changes, feature does not", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.card(MAIN));
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      await expect
        .poll(() => mainCard.getAttribute("aria-label"), {
          timeout: T_LONG,
          message: "Main card should indicate uncommitted changes",
        })
        .toContain("has uncommitted changes");

      const featureLabel = await featureCard.getAttribute("aria-label");
      expect(featureLabel).not.toContain("has uncommitted changes");
    });

    test("clicking feature card switches selection", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.card(MAIN));
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      // Click the top of the card to avoid hitting interactive child elements
      await featureCard.click({ position: { x: 10, y: 10 } });

      await expect
        .poll(() => featureCard.getAttribute("aria-label"), {
          timeout: T_LONG,
          message: "Feature card should become selected after click",
        })
        .toContain("selected");

      await expect
        .poll(() => mainCard.getAttribute("aria-label"), {
          timeout: T_MEDIUM,
          message: "Main card should lose selection after clicking feature",
        })
        .not.toContain("selected");
    });

    test("clicking main card restores selection", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.card(MAIN));
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      await mainCard.click({ position: { x: 10, y: 10 } });

      await expect
        .poll(() => mainCard.getAttribute("aria-label"), {
          timeout: T_LONG,
          message: "Main card should become selected after click",
        })
        .toContain("selected");

      await expect
        .poll(() => featureCard.getAttribute("aria-label"), {
          timeout: T_LONG,
          message: "Feature card should lose selection after clicking main",
        })
        .not.toContain("selected");
    });
  });

  // -- Actions Menu --

  test.describe.serial("Actions Menu", () => {
    test("actions menu opens and shows expected items", async () => {
      const { window } = ctx;

      // Switch to feature card first — it has the richest menu (Pin, Delete)
      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      await featureCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => featureCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");

      const actionsBtn = featureCard.locator(SEL.worktree.actionsMenu);
      await actionsBtn.click();

      // Verify top-level items/submenus are visible
      await expect(window.getByRole("menuitem", { name: "Launch" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.getByRole("menuitem", { name: "Sessions" })).toBeVisible();
      await expect(window.getByRole("menuitem", { name: "Open in Editor" })).toBeVisible();
      await expect(window.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();

      // Feature-only items (not shown on main worktree card)
      await expect(window.getByRole("menuitem", { name: "Pin to Top" })).toBeVisible();
      await expect(window.getByRole("menuitem", { name: /Delete Worktree/i })).toBeVisible();

      // Close the menu
      await window.keyboard.press("Escape");
      await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
    });

    test("Launch submenu opens on hover and Open Terminal creates a panel", async () => {
      const { window } = ctx;

      const panelsBefore = await getGridPanelCount(window);

      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      const actionsBtn = featureCard.locator(SEL.worktree.actionsMenu);
      await actionsBtn.click();

      const launchTrigger = window.getByRole("menuitem", { name: "Launch" });
      await expect(launchTrigger).toBeVisible({ timeout: T_SHORT });
      await launchTrigger.hover();

      const openTerminal = window.getByRole("menuitem", { name: "Open Terminal" });
      await expect(openTerminal).toBeVisible({ timeout: T_SHORT });
      await openTerminal.click();

      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBe(panelsBefore + 1);
    });

    test("Escape dismisses the menu without side effects", async () => {
      const { window } = ctx;

      // Wait for any panel creation from prior test to settle
      await window.waitForTimeout(T_SETTLE);
      const panelsBefore = await getGridPanelCount(window);

      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      const actionsBtn = featureCard.locator(SEL.worktree.actionsMenu);
      await actionsBtn.click();

      await expect(window.getByRole("menuitem", { name: "Launch" })).toBeVisible({
        timeout: T_SHORT,
      });

      await window.keyboard.press("Escape");

      await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });

      const panelsAfter = await getGridPanelCount(window);
      expect(panelsAfter).toBe(panelsBefore);
    });
  });

  // -- Panel Isolation --

  test.describe.serial("Panel Isolation", () => {
    test("switching worktrees isolates grid panels", async () => {
      const { window } = ctx;

      // Feature card should have at least 1 panel from the Open Terminal test
      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      await featureCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => featureCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");

      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(1);

      // Switch to main — should have 0 panels
      const mainCard = window.locator(SEL.worktree.card(MAIN));
      await mainCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => mainCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");

      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);

      // Switch back to feature — panels should reappear
      await featureCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => featureCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");

      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(1);
    });
  });
});
