import { test, expect, type Page } from "@playwright/test";
import { BUILT_IN_APP_SCHEMES } from "../../../shared/theme/index.js";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { getGridPanelCount, openSettings, openTerminal } from "../../helpers/panels";
import {
  ensureQuickRunInputVisible,
  getThemeChromeMetrics,
  setAppTheme,
} from "../../helpers/theme";

const LIGHT_THEME_PROJECT = "light-theme-smoke";
const LIGHT_SCHEME_IDS = BUILT_IN_APP_SCHEMES.filter((scheme) => scheme.type === "light").map(
  (scheme) => scheme.id
);

async function expandProjectPulse(window: AppContext["window"]) {
  const trigger = window.getByRole("button", { name: /^project pulse/i });
  await expect(trigger).toBeVisible({ timeout: T_LONG });
  await trigger.click();
  await expect(window.locator(SEL.pulse.heatmap)).toBeVisible({ timeout: T_LONG });
}

// One launch hosts three projects in turn: the single-commit repo it boots
// into, the spread-commit Pulse repo, and the light-theme repo. Theme swaps
// reload the page and the Pulse settings toggle is global, so the theme group
// runs last and each group switches to its own project in its own hook.
// The pulse card's polite live region says "Refreshing pulse data" while a
// silent refresh runs and "Pulse data updated" when it lands. Recording every
// change proves a click started and finished a real refresh; a no-op handler
// never produces the transition.
async function recordPulseAnnouncements(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = globalThis.window as unknown as {
      __pulseAnnouncements?: string[];
      __pulseAnnouncementObserver?: MutationObserver;
    };
    w.__pulseAnnouncementObserver?.disconnect();
    const region = document.querySelector('.pulse-card [role="status"]');
    if (!region) throw new Error("pulse status region not found");
    const seen: string[] = [];
    w.__pulseAnnouncements = seen;
    const observer = new MutationObserver(() => seen.push(region.textContent ?? ""));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    w.__pulseAnnouncementObserver = observer;
  });
}

async function expectPulseRefreshCompleted(window: Page): Promise<void> {
  await expect
    .poll(
      () =>
        window.evaluate(
          () =>
            (globalThis.window as unknown as { __pulseAnnouncements?: string[] })
              .__pulseAnnouncements ?? []
        ),
      { timeout: T_LONG }
    )
    .toEqual(expect.arrayContaining(["Refreshing pulse data", "Pulse data updated"]));
}

test.describe("Panels: Project Pulse and light theme", () => {
  let ctx: AppContext;
  const cleanups: Array<() => void> = [];

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "pulse-minimal" });
    cleanups.push(cleanup);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Pulse Minimal");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  test.describe("Project Pulse — minimal repo", () => {
    test("card renders without error for a single-commit repo", async () => {
      const { window } = ctx;
      await expandProjectPulse(window);
      const heatmap = window.locator(SEL.pulse.heatmap);

      await expect(heatmap).toBeVisible({ timeout: T_LONG });
      // The pulse error state uses aria-label="Retry now" — ensure it's absent
      await expect(window.locator('[aria-label="Retry now"]')).not.toBeVisible({
        timeout: T_SHORT,
      });
    });
  });

  test.describe.serial("Project Pulse", () => {
    test.beforeAll(async () => {
      const { dir, cleanup } = createFixtureRepo({ name: "pulse-test", withSpreadCommits: true });
      cleanups.push(cleanup);
      ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, dir, "Pulse Test");
      await expandProjectPulse(ctx.window);
    });

    test("pulse card is visible after onboarding", async () => {
      const { window } = ctx;
      await expect(window.locator(SEL.pulse.heatmap)).toBeVisible({ timeout: T_LONG });
    });

    test("legend is visible below the heatmap with Less and More labels", async () => {
      const { window } = ctx;
      const legend = window.locator(SEL.pulse.legend);
      await expect(legend).toBeVisible({ timeout: T_MEDIUM });
      await expect(legend).toContainText("Less", { timeout: T_SHORT });
      await expect(legend).toContainText("More", { timeout: T_SHORT });
    });

    test("heatmap is described by a screen-reader-only intensity scale (issue #9819)", async () => {
      const { window } = ctx;
      const heatmap = window.locator(SEL.pulse.heatmap);
      const describedBy = await heatmap.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const description = window.locator(`#${describedBy}`);
      await expect(description).toHaveCount(1);
      await expect(description).toHaveText(/Heat intensity from no commits to many commits/);
    });

    test("card header shows project name and default range", async () => {
      const { window } = ctx;
      const title = window.getByText(/pulse-test.*Project Pulse/i);
      await expect(title).toBeVisible({ timeout: T_MEDIUM });
      const rangeGroup = window.locator(SEL.pulse.rangeTrigger);
      await expect(rangeGroup).toBeVisible({ timeout: T_SHORT });
      // The active range button has an accent border — verify "60d" is among the options
      await expect(rangeGroup.locator("button").first()).toContainText("60d", {
        timeout: T_SHORT,
      });
    });

    test("range selector changes time range", async () => {
      const { window } = ctx;
      const rangeGroup = window.locator(SEL.pulse.rangeTrigger);
      await expect(rangeGroup).toBeVisible({ timeout: T_MEDIUM });

      const btn120 = rangeGroup.locator("button", { hasText: "120d" });
      await btn120.click();

      await expect(window.locator(SEL.pulse.heatmap)).toHaveAttribute(
        "aria-label",
        "Activity over the last 120 days, one column per week",
        { timeout: T_MEDIUM }
      );
    });

    test("refresh button reloads data", async () => {
      const { window } = ctx;
      const refreshBtn = window.locator(SEL.pulse.refreshButton);
      await expect(refreshBtn).toBeEnabled({ timeout: T_SHORT });
      await recordPulseAnnouncements(window);
      await refreshBtn.click();
      await expectPulseRefreshCompleted(window);
      await expect(window.locator(SEL.pulse.heatmap)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("last-updated label is visible and triggers a refresh on click", async () => {
      const { window } = ctx;
      const lastUpdated = window.locator(SEL.pulse.lastUpdated);
      await expect(lastUpdated).toBeVisible({ timeout: T_MEDIUM });
      await expect(lastUpdated).toContainText(/Updated /, { timeout: T_SHORT });
      await recordPulseAnnouncements(window);
      await lastUpdated.click();
      await expectPulseRefreshCompleted(window);
      await expect(window.locator(SEL.pulse.heatmap)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("settings toggle hides pulse card", async () => {
      const { window } = ctx;

      await openSettings(window);
      const heading = window.locator(SEL.settings.heading);
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });

      const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
      await generalTab.click();

      const displaySubtab = window.locator(
        '#settings-panel-general button[role="tab"]:has-text("Display")'
      );
      await displaySubtab.click();

      const toggle = window.locator(SEL.settings.projectPulseToggle);
      await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
      await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_SHORT });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_SHORT });

      await window.keyboard.press("Escape");
      await expect(heading).not.toBeVisible({ timeout: T_SHORT });

      await expect(window.locator(SEL.pulse.heatmap)).not.toBeVisible({ timeout: T_MEDIUM });
    });
  });

  test.describe("Light theme smoke", () => {
    test.beforeAll(async () => {
      const { dir, cleanup } = createFixtureRepo({
        name: LIGHT_THEME_PROJECT,
        withFeatureBranch: true,
        withUncommittedChanges: true,
      });
      cleanups.push(cleanup);
      ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, dir, LIGHT_THEME_PROJECT);

      await expect(ctx.window.locator(SEL.toolbar.projectSwitcherTrigger)).toBeVisible({
        timeout: T_LONG,
      });
      await ensureQuickRunInputVisible(ctx.window);
      await expect(ctx.window.locator(SEL.worktree.mainCard)).toBeVisible({ timeout: T_LONG });
    });

    test("light themes keep key chrome readable", async () => {
      const { window } = ctx;

      expect(LIGHT_SCHEME_IDS.length, "there must be built-in light schemes").toBeGreaterThan(0);

      for (const schemeId of LIGHT_SCHEME_IDS) {
        await setAppTheme(window, schemeId, "light");

        await window.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
        await window
          .locator('[data-worktree-is-main="true"] [id$="-details"]')
          .waitFor({ state: "visible", timeout: T_LONG });
        // The theme reload does not bring the terminal back into this view, so
        // each scheme measures against a freshly opened grid panel.
        if ((await getGridPanelCount(window)) === 0) await openTerminal(window);
        await window
          .locator(SEL.panel.gridPanel)
          .first()
          .waitFor({ state: "visible", timeout: T_LONG });

        const showDetails = window
          .locator(SEL.worktree.mainCard)
          .getByRole("button", { name: "Show details" });
        if (await showDetails.isVisible()) {
          await showDetails.click();
        }

        const metrics = await getThemeChromeMetrics(window, { projectName: LIGHT_THEME_PROJECT });

        await expect(
          window.locator(SEL.toolbar.projectSwitcherTrigger),
          `${schemeId}: project switcher should still show the active project`
        ).toContainText(LIGHT_THEME_PROJECT);
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
        // getThemeChromeMetrics reports Infinity when no grid panel exists, which
        // would pass the contrast floor below without measuring anything.
        expect(
          Number.isFinite(metrics.panelVsGridContrast),
          `${schemeId}: panel-vs-grid contrast must be measured against a real grid panel`
        ).toBe(true);
        expect
          .soft(
            metrics.panelVsGridContrast,
            `${schemeId}: panel background should differ from grid background`
          )
          .toBeGreaterThanOrEqual(1.05);
      }
    });
  });
});
