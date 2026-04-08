import { test, expect } from "@playwright/test";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme/index.js";
import { createFixtureRepo } from "../helpers/fixtures";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { getThemeChromeMetrics, setAppTheme } from "../helpers/theme";

const PROJECT_NAME = "Light Theme Smoke";
const LIGHT_SCHEME_IDS = BUILT_IN_APP_SCHEMES.filter((scheme) => scheme.type === "light").map(
  (scheme) => scheme.id
);

let ctx: AppContext;

test.describe.serial("Core: Light Theme Smoke", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({
      name: "light-theme-smoke",
      withFeatureBranch: true,
      withUncommittedChanges: true,
    });

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, PROJECT_NAME);

    await expect(ctx.window.locator(SEL.toolbar.projectSwitcherTrigger)).toBeVisible();
    await expect(ctx.window.getByLabel("Command input")).toBeVisible();
    await expect(ctx.window.locator(SEL.worktree.mainCard)).toBeVisible();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // eslint-disable-next-line no-empty-pattern
  test("light themes keep key chrome readable and capture screenshots", async ({}, testInfo) => {
    const { window } = ctx;

    for (const schemeId of LIGHT_SCHEME_IDS) {
      await setAppTheme(window, schemeId);

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
          metrics.worktreeSectionContrast,
          `${schemeId}: worktree sections should remain visually separated`
        )
        .toBeGreaterThanOrEqual(1.03);
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

      const screenshotPath = testInfo.outputPath(`light-theme-${schemeId}.png`);
      await window.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach(`light-theme-${schemeId}`, {
        path: screenshotPath,
        contentType: "image/png",
      });
    }

    expect(testInfo.errors).toHaveLength(0);
  });
});
