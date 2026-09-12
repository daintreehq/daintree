import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { T_LONG } from "../../helpers/timeouts";

/**
 * A scheduled timer, from the moment it is listed to the moment it fires.
 *
 * This suite exists because both halves of the timer feature failed in ways no static
 * fixture could catch, and both failed SILENTLY — the user's report was "it didn't
 * start", when in fact it had.
 *
 *  1. The countdown was computed from a `Date.now()` read during render. Nothing
 *     re-rendered the deck, so "in 10s" sat unchanged while the timer beneath it came
 *     due. A fixture asserting the string "in 10s" passed against the frozen clock.
 *  2. The fire was announced from a diff against the FIRST reading of the list — and
 *     because the list was only read when a fire marked it stale, a session's first
 *     timer made its own arrival the baseline it was then measured against. It
 *     announced nothing.
 *
 * Both are properties of TIME PASSING, so both are asserted by watching one real timer
 * really come due: `FAKE_ENGINE_TIMERS=countdown` seeds a single timer seconds out and
 * fires it, unprompted, off the engine's own clock.
 *
 * Deliberately NOT in `e2e/core/`: that tier runs unauthenticated, and while this suite
 * needs no account either (the fake engine speaks the wire without one), the release
 * smoke tier is not where a twenty-second wall-clock wait belongs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = path.resolve(HERE, "../../helpers/fake-assistant-engine.mjs");

/**
 * How far out the fake schedules its one timer.
 *
 * The spec OWNS this and hands it to the engine, rather than copying a constant the
 * fake also holds — two declarations of one number drift, and the drift shows up as a
 * timing flake rather than as a compile error. Under a minute because that is the band
 * `formatDueIn` renders in seconds, which is the only band where a frozen clock is
 * visible within a test's patience; comfortably above the few seconds each countdown
 * assertion needs, so a slow launch cannot eat the window.
 */
const TIMER_DUE_MS = 25_000;

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

async function openAssistant(window: AppContext["window"]) {
  const toggle = window
    .getByRole("toolbar", { name: "Main toolbar" })
    .getByRole("button", { name: "Daintree Assistant", exact: true });
  await expect(toggle).toBeVisible({ timeout: T_LONG });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: T_LONG });

  const panel = window.locator("#daintree-assistant-panel");
  await expect(panel).toBeVisible({ timeout: T_LONG });
  // The status line is the readiness signal: the engine is up and the session is live.
  await expect(panel.getByText("Connected", { exact: true })).toBeVisible({ timeout: T_LONG });
  return panel;
}

/**
 * Opens the operations deck, which is where the SCHEDULED section lives.
 *
 * Through the header's overflow menu rather than the ^O binding: the shortcut is
 * handled on the panel root, so driving it needs focus to be somewhere the test would
 * have to assert separately, and a failure there reads as "the deck is broken" when it
 * means "the keypress went somewhere else".
 */
async function openDeck(window: AppContext["window"]) {
  await window.getByTestId("assistant-header-more").click();
  await window.getByRole("menuitem", { name: "View operations" }).click();
  const panel = window.locator("#daintree-assistant-panel");
  await expect(panel.getByText("Operations", { exact: true })).toBeVisible({ timeout: T_LONG });
  return panel;
}

/**
 * The seconds shown on the countdown, or null when it is not rendering one.
 *
 * Reads the NUMBER rather than the string on purpose: the assertion is that the value
 * moves, and pinning the exact text would make this a test of `formatDueIn`, which is
 * unit-tested where it lives and would drift from it here.
 */
async function secondsRemaining(scope: ReturnType<AppContext["window"]["locator"]>) {
  const text = (await scope.textContent()) ?? "";
  const match = /in (\d+)s/.exec(text);
  return match ? Number(match[1]) : null;
}

test.describe.serial("Assistant: scheduled timers", () => {
  test.beforeEach(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "assistant-timers" });
    fixtureCleanup = cleanup;
    ctx = await launchApp({
      env: {
        DAINTREE_ASSISTANT_BIN: FAKE_ENGINE,
        FAKE_ENGINE_SPEED: "0",
        FAKE_ENGINE_TIMERS: "countdown",
        FAKE_ENGINE_TIMER_DUE_MS: String(TIMER_DUE_MS),
      },
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Assistant Timers Test");
  });

  test.afterEach(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("shows a live countdown above the composer, with the deck closed", async () => {
    const { window } = ctx;
    // The deck is never opened. This is the surface the user asked for: scheduling a
    // timer used to leave the panel looking identical to nothing having happened,
    // because the only place a pending timer appeared was behind a header menu.
    await openAssistant(window);

    const strip = window.getByTestId("assistant-timer-status");
    await expect(strip).toBeVisible({ timeout: T_LONG });
    // WHEN and WHAT — the two questions the strip exists to answer.
    await expect(strip).toContainText("Spawn new default agent terminal");
    await expect(strip).toContainText("Runs agentTask.spawnForEdits");

    const first = await secondsRemaining(strip);
    expect(first, "the strip should render a seconds countdown").not.toBeNull();
    await window.waitForTimeout(4_000);
    const second = await secondsRemaining(strip);
    expect(second!, "the strip's countdown must fall on its own").toBeLessThan(first!);

    // It goes when the timer does — a strip still promising a timer that has already
    // fired is worse than no strip.
    await expect(strip).toBeHidden({ timeout: TIMER_DUE_MS + T_LONG });
  });

  test("counts down in the deck, then moves from SCHEDULED to FIRED", async () => {
    const { window } = ctx;
    await openAssistant(window);
    const panel = await openDeck(window);

    // Scoped to the SECTIONS, not to the bare label: a fired timer keeps its title,
    // and is supposed to — it moves from the list of what has not happened yet to the
    // list of what just did. Asserting on the text alone would pass while the row sat
    // in the wrong one, which is the state a user reads as "it never fired".
    const scheduled = panel.locator('section:has(h3:text-is("SCHEDULED"))');
    const fired = panel.locator('section:has(h3:text-is("FIRED"))');

    await expect(scheduled).toBeVisible({ timeout: T_LONG });
    await expect(scheduled).toContainText("Spawn new default agent terminal");
    await expect(fired).toBeHidden();

    // The countdown moves with no input but time. Scoped to the scheduled section so a
    // duration elsewhere on the deck cannot satisfy it.
    const first = await secondsRemaining(scheduled);
    expect(first, "the deck should render a seconds countdown").not.toBeNull();
    await window.waitForTimeout(3_000);
    const second = await secondsRemaining(scheduled);
    expect(second, "the countdown should still be rendering").not.toBeNull();
    expect(second!, "the countdown must fall as the clock advances").toBeLessThan(first!);

    // Nothing is clicked. The engine's own clock reaches the due time, the fire is
    // pushed, and the deck re-reads on its own.
    await expect(fired).toBeVisible({ timeout: TIMER_DUE_MS + T_LONG });
    await expect(fired).toContainText("Spawn new default agent terminal");
    // A one-shot timer that stayed SCHEDULED after firing would render as still
    // pending — the same "nothing happened" reading, from the other direction.
    await expect(scheduled).toBeHidden({ timeout: T_LONG });
  });
});
