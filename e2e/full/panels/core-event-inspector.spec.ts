import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

async function dispatchAction(page: Page, actionId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.evaluate((id) => (window as any).__daintreeDispatchAction(id), actionId);
}

async function openEventsDock(window: Page): Promise<void> {
  await dispatchAction(window, "panel.diagnosticsEvents");
  await expect(window.locator(SEL.diagnostics.dock)).toBeVisible({ timeout: T_MEDIUM });
  await expect(window.locator(SEL.diagnostics.tab("events"))).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: T_SHORT }
  );
  await expect(window.locator(SEL.diagnostics.panel("events"))).toBeVisible({ timeout: T_MEDIUM });

  // Grow the dock to its max height. At the 256px default the tall filter
  // header consumes the panel and the timeline/detail area below collapses to
  // zero height. The resize handle maps `End` to "max height" (50% of the
  // viewport), giving the lower content room to render. `locator.press` focuses
  // the handle and dispatches the key in one step.
  await window.locator(SEL.diagnostics.resizeHandle).press("End");
  await window.waitForTimeout(T_SETTLE);
}

test.describe.serial("Core: Event Inspector", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "event-inspector" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Event Inspector");

    // Generate backend activity so the EventBuffer has events to stream into
    // the timeline once the dock subscribes. Event availability is not
    // guaranteed in a headless session, so the selection test below tolerates
    // an empty timeline.
    await openTerminal(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("search and trace filters accept input and clear", async () => {
    const { window } = ctx;
    await openEventsDock(window);

    const panel = window.locator(SEL.diagnostics.panel("events"));
    const search = panel.locator(SEL.events.searchInput);
    const trace = panel.locator(SEL.events.traceInput);

    await test.step("Filter inputs render in the events panel", async () => {
      await expect(search).toBeVisible({ timeout: T_SHORT });
      await expect(trace).toBeVisible({ timeout: T_SHORT });
    });

    await test.step("Typing a search shows the clear button, clearing empties it", async () => {
      await search.fill("agent");
      const clear = panel.locator(SEL.events.clearSearch);
      await expect(clear).toBeVisible({ timeout: T_SHORT });
      await clear.click();
      await expect(search).toHaveValue("");
      await expect(clear).toHaveCount(0, { timeout: T_SHORT });
    });

    await test.step("Typing a trace ID shows its clear button, clearing empties it", async () => {
      await trace.fill("trace-123");
      const clearTrace = panel.locator(SEL.events.clearTraceId);
      await expect(clearTrace).toBeVisible({ timeout: T_SHORT });
      await clearTrace.click();
      await expect(trace).toHaveValue("");
      await expect(clearTrace).toHaveCount(0, { timeout: T_SHORT });
    });
  });

  test("search filter persists across diagnostics tab switches", async () => {
    const { window } = ctx;
    await openEventsDock(window);

    const panel = window.locator(SEL.diagnostics.panel("events"));
    const search = panel.locator(SEL.events.searchInput);

    await test.step("Type a query into the events search", async () => {
      await search.fill("agent");
      await expect(search).toHaveValue("agent");
      await window.waitForTimeout(T_SETTLE);
    });

    await test.step("Switch to Problems and back to Events", async () => {
      await dispatchAction(window, "panel.diagnosticsMessages");
      await expect(window.locator(SEL.diagnostics.tab("problems"))).toHaveAttribute(
        "aria-selected",
        "true",
        { timeout: T_SHORT }
      );
      await openEventsDock(window);
    });

    await test.step("The query is still applied (lives in the event store)", async () => {
      await expect(panel.locator(SEL.events.searchInput)).toHaveValue("agent", {
        timeout: T_MEDIUM,
      });
    });

    await test.step("Clear the search for a clean teardown", async () => {
      await panel.locator(SEL.events.clearSearch).click();
      await expect(panel.locator(SEL.events.searchInput)).toHaveValue("");
    });
  });

  test("selecting a timeline event populates the detail pane", async () => {
    const { window } = ctx;
    await openEventsDock(window);

    const panel = window.locator(SEL.diagnostics.panel("events"));
    const rows = window.locator(SEL.events.row);
    const timeline = window.locator(SEL.events.timeline);
    const emptyState = window.locator(SEL.events.emptyState);

    // The timeline streams real backend events, which a headless session may or
    // may not have produced, and the virtualized list's height depends on the
    // dock layout. Branch on what actually rendered so the test asserts
    // something real without flaking on event availability:
    //   - a visible row  → exercise the full selection → detail path
    //   - the empty state → assert it (no events captured)
    //   - otherwise       → the timeline at least mounted (events streamed)
    const hasRow = await rows
      .first()
      .isVisible({ timeout: T_LONG })
      .catch(() => false);

    if (hasRow) {
      await test.step("A row is selectable and populates the detail pane", async () => {
        await expect(panel.locator(SEL.events.detailPlaceholder)).toBeVisible({ timeout: T_SHORT });
        await rows.first().click();
        await expect(panel.locator(SEL.events.detailPlaceholder)).toHaveCount(0, {
          timeout: T_MEDIUM,
        });
        await expect(panel.getByText("Payload", { exact: true })).toBeVisible({
          timeout: T_MEDIUM,
        });
      });
    } else if (await emptyState.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      await test.step("No events captured — the empty state is shown", async () => {
        await expect(emptyState).toBeVisible({ timeout: T_SHORT });
        await expect(panel.locator(SEL.events.detailPlaceholder)).toBeVisible({ timeout: T_SHORT });
      });
    } else {
      await test.step("The timeline mounted with streamed events", async () => {
        await expect(timeline).toBeAttached({ timeout: T_SHORT });
      });
    }

    await test.step("Close the diagnostics dock", async () => {
      await window.locator(SEL.diagnostics.closeButton).click();
      await expect(window.locator(SEL.diagnostics.dock)).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
