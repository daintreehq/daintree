import { test, expect } from "@playwright/test";
import { BUILT_IN_APP_SCHEMES } from "../../../shared/theme/index.js";
import { createFixtureRepo } from "../../helpers/fixtures";
import { T_LONG } from "../../helpers/timeouts";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { getThemeChromeMetrics, setAppTheme } from "../../helpers/theme";

const PROJECT_NAME = "light-theme-smoke";
const LIGHT_SCHEME_IDS = BUILT_IN_APP_SCHEMES.filter((scheme) => scheme.type === "light").map(
  (scheme) => scheme.id
);

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Light Theme Smoke", () => {
  test.beforeAll(async () => {
    const { dir: fixture, cleanup } = createFixtureRepo({
      name: "light-theme-smoke",
      withFeatureBranch: true,
      withUncommittedChanges: true,
    });
    fixtureCleanup = cleanup;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, PROJECT_NAME);

    await expect(ctx.window.locator(SEL.toolbar.projectSwitcherTrigger)).toBeVisible();
    await expect(ctx.window.getByLabel("Command input")).toBeVisible();
    await expect(ctx.window.locator(SEL.worktree.mainCard)).toBeVisible();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // eslint-disable-next-line no-empty-pattern
  test("light themes keep key chrome readable", async ({}) => {
    const { window } = ctx;

    for (const schemeId of LIGHT_SCHEME_IDS) {
      await setAppTheme(window, schemeId, "light");

      await window.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
      await window
        .locator('[data-worktree-is-main="true"] [id$="-details"]')
        .waitFor({ state: "visible", timeout: T_LONG });

      const showDetails = window
        .locator(SEL.worktree.mainCard)
        .getByRole("button", { name: "Show details" });
      if (await showDetails.isVisible()) {
        await showDetails.click();
      }

      const metrics = await getThemeChromeMetrics(window, { projectName: PROJECT_NAME });

      await expect(
        window.locator(SEL.toolbar.projectSwitcherTrigger),
        `${schemeId}: project switcher should still show the active project`
      ).toContainText(PROJECT_NAME);
      expect
        .soft(
          metrics.projectTitleContrast,
          `${schemeId}: project title text should meet WCAG AA contrast`
        )
        .toBeGreaterThanOrEqual(4.5);
      expect
        .soft(
          metrics.quickRunFieldBorderContrast,
          `${schemeId}: quick-run input border should stay visibly separated`
        )
        .toBeGreaterThanOrEqual(1.02);
      expect
        .soft(
          metrics.worktreeSectionLabelContrast,
          `${schemeId}: worktree section labels should remain readable`
        )
        .toBeGreaterThanOrEqual(4.5);
      expect
        .soft(
          metrics.sidebarVsCanvasContrast,
          `${schemeId}: sidebar should be visually separated from canvas`
        )
        .toBeGreaterThanOrEqual(1.02);
      expect
        .soft(
          metrics.panelVsGridContrast,
          `${schemeId}: panel background should differ from grid background`
        )
        .toBeGreaterThanOrEqual(1.05);
    }
  });
});
