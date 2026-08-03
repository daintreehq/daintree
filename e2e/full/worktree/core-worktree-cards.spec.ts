import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
const FEATURE = "feature/test-branch";
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Worktree Cards", () => {
  test.beforeAll(async () => {
    const { dir: fixture, cleanup } = createFixtureRepo({
      name: "worktree-cards",
      withFeatureBranch: true,
      withUncommittedChanges: true,
    });
    fixtureCleanup = cleanup;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, "Worktree Cards");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // -- Multi-Worktree Coverage --

  test.describe.serial("Multi-Worktree Coverage", () => {
    test("fixture shows main and feature worktree cards", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.mainCard);
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      await expect(mainCard).toBeVisible({ timeout: T_LONG });
      await expect(featureCard).toBeVisible({ timeout: T_LONG });
    });

    test("main card is selected by default", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.mainCard);

      await expect(window.locator(SEL.worktree.mainRow)).toHaveAttribute("aria-current", "true", {
        timeout: T_LONG,
      });
      await expect(window.locator(SEL.worktree.row(FEATURE))).not.toHaveAttribute(
        "aria-current",
        "true"
      );
    });

    test("main worktree shows uncommitted changes, feature does not", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.mainCard);
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

      const mainCard = window.locator(SEL.worktree.mainCard);
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      // Click the top of the card to avoid hitting interactive child elements
      await featureCard.click({ position: { x: 10, y: 10 } });

      await expect(window.locator(SEL.worktree.row(FEATURE))).toHaveAttribute(
        "aria-current",
        "true",
        { timeout: T_LONG }
      );
      await expect(window.locator(SEL.worktree.mainRow)).not.toHaveAttribute(
        "aria-current",
        "true",
        { timeout: T_MEDIUM }
      );
    });

    test("clicking main card restores selection", async () => {
      const { window } = ctx;

      const mainCard = window.locator(SEL.worktree.mainCard);
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      await mainCard.click({ position: { x: 10, y: 10 } });

      await expect(window.locator(SEL.worktree.mainRow)).toHaveAttribute("aria-current", "true", {
        timeout: T_LONG,
      });
      await expect(window.locator(SEL.worktree.row(FEATURE))).not.toHaveAttribute(
        "aria-current",
        "true",
        { timeout: T_LONG }
      );
    });
  });

  // -- Actions Menu --

  test.describe.serial("Actions Menu", () => {
    test("actions menu opens and shows expected items", async () => {
      const { window } = ctx;
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      await test.step("Select feature card and open its actions menu", async () => {
        // Switch to feature card first — it has the richest menu (Pin, Delete)
        await featureCard.click({ position: { x: 10, y: 10 } });
        await expect(window.locator(SEL.worktree.row(FEATURE))).toHaveAttribute(
          "aria-current",
          "true",
          { timeout: T_LONG }
        );

        const actionsBtn = featureCard.locator(SEL.worktree.actionsMenu);
        await actionsBtn.click();
      });

      await test.step("Verify expected menu items are visible", async () => {
        await expect(window.getByRole("menuitem", { name: "Launch" })).toBeVisible({
          timeout: T_SHORT,
        });
        await expect(window.getByRole("menuitem", { name: "Sessions" })).toBeVisible();
        await expect(window.getByRole("menuitem", { name: "Open in Editor" })).toBeVisible();
        await expect(window.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();

        // Feature-only items (not shown on main worktree card)
        await expect(window.getByRole("menuitem", { name: "Pin to Top" })).toBeVisible();
        await expect(window.getByRole("menuitem", { name: /Delete Worktree/i })).toBeVisible();
      });

      await test.step("Close the menu via Escape", async () => {
        await window.keyboard.press("Escape");
        await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
      });
    });

    // The card's two menu surfaces are one item list rendered through two sets
    // of primitives, so they must present the same top-level menu. They drifted
    // once (Browse Files was wired into the dropdown only), which no test caught
    // because both specs assert item labels one surface at a time. This compares
    // the surfaces to each other instead of to hardcoded expectations.
    test("right-click menu and actions dropdown present the same items", async () => {
      const { window } = ctx;
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      const readOpenMenuSignature = async () => {
        const menu = window.locator('[role="menu"]');
        await expect(menu).toHaveCount(1, { timeout: T_SHORT });
        await expect(menu).toBeVisible({ timeout: T_SHORT });
        return menu.evaluate((root) =>
          Array.from(root.children)
            // Menu content also holds conditional scroll-shadow overlays whose
            // presence depends on overflow geometry, and the two surfaces anchor
            // differently — keep only the semantic children.
            .filter((el) => {
              const role = el.getAttribute("role");
              return role === "separator" || (role?.startsWith("menuitem") ?? false);
            })
            .map((el) => {
              const role = el.getAttribute("role")!;
              if (role === "separator") return "separator";
              const label = (el.textContent ?? "").trim().replace(/\s+/g, " ");
              const state = el.getAttribute("aria-disabled") === "true" ? " [disabled]" : "";
              const submenu = el.getAttribute("aria-haspopup") ? " [submenu]" : "";
              return `${role}|${label}${submenu}${state}`;
            })
        );
      };

      const closeMenu = async () => {
        await window.keyboard.press("Escape");
        await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
      };

      let dropdownSignature: string[] = [];
      await test.step("Capture the ⋯ dropdown signature", async () => {
        await featureCard.locator(SEL.worktree.actionsMenu).click();
        dropdownSignature = await readOpenMenuSignature();
        await closeMenu();
      });

      let contextSignature: string[] = [];
      await test.step("Capture the right-click menu signature", async () => {
        await featureCard.click({ button: "right", position: { x: 40, y: 12 } });
        contextSignature = await readOpenMenuSignature();
        await closeMenu();
      });

      // Guards a vacuous pass: two empty or near-empty reads would compare equal.
      expect(dropdownSignature.length).toBeGreaterThan(8);
      expect(
        dropdownSignature.filter((entry) => entry.includes("[submenu]")).length
      ).toBeGreaterThan(0);
      expect(contextSignature).toEqual(dropdownSignature);

      // Every separator must divide two groups — no leading, trailing, or
      // stacked rules, which is what the conditional group separators buy.
      expect(dropdownSignature[0]).not.toBe("separator");
      expect(dropdownSignature[dropdownSignature.length - 1]).not.toBe("separator");
      expect(
        dropdownSignature.filter(
          (entry, i) => entry === "separator" && dropdownSignature[i + 1] === "separator"
        )
      ).toEqual([]);
    });

    test("Launch submenu opens on hover and Open Terminal creates a panel", async () => {
      const { window } = ctx;
      let panelsBefore = 0;
      const featureCard = window.locator(SEL.worktree.card(FEATURE));

      await test.step("Capture panel count and open actions menu", async () => {
        panelsBefore = await getGridPanelCount(window);

        const actionsBtn = featureCard.locator(SEL.worktree.actionsMenu);
        await actionsBtn.click();
      });

      await test.step("Hover Launch submenu and click Open Terminal", async () => {
        const launchTrigger = window.getByRole("menuitem", { name: "Launch" });
        await expect(launchTrigger).toBeVisible({ timeout: T_SHORT });
        await launchTrigger.hover();

        const openTerminal = window.getByRole("menuitem", { name: "Open Terminal" });
        await expect(openTerminal).toBeVisible({ timeout: T_SHORT });
        await openTerminal.click();
      });

      await test.step("Verify panel count increased by one", async () => {
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBe(panelsBefore + 1);
      });
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
      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      const mainCard = window.locator(SEL.worktree.mainCard);

      await test.step("Select feature worktree and confirm panels are present", async () => {
        // Feature card should have at least 1 panel from the Open Terminal test
        await featureCard.click({ position: { x: 10, y: 10 } });
        await expect(window.locator(SEL.worktree.row(FEATURE))).toHaveAttribute(
          "aria-current",
          "true",
          { timeout: T_LONG }
        );

        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(1);
      });

      await test.step("Switch to main worktree and verify panels are hidden", async () => {
        await mainCard.click({ position: { x: 10, y: 10 } });
        await expect(window.locator(SEL.worktree.mainRow)).toHaveAttribute("aria-current", "true", {
          timeout: T_LONG,
        });

        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
      });

      await test.step("Switch back to feature and verify panels reappear", async () => {
        await featureCard.click({ position: { x: 10, y: 10 } });
        await expect(window.locator(SEL.worktree.row(FEATURE))).toHaveAttribute(
          "aria-current",
          "true",
          { timeout: T_LONG }
        );

        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(1);
      });
    });
  });
});
