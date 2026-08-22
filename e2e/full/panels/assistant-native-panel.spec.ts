import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";

/**
 * The native assistant panel, driven end to end against a real engine process.
 *
 * `DAINTREE_ASSISTANT_BIN` points at the scriptable fake engine, so every turn is an
 * exact byte sequence rather than whatever a model happened to say. That is the whole
 * reason the fake exists: this suite asserts things the panel must do — a tool batch
 * reads as a plan, `waiting` reads as blocked-on-you, a typed confirmation cannot be
 * clicked past, `turn:end` content replaces the streamed buffer — and none of those
 * can be asserted against non-deterministic prose, a live backend, or real spend.
 *
 * The fake is separately proven faithful to the real Go engine's wire shapes by
 * `e2e/helpers/__tests__/fakeAssistantEngine.test.ts`, so a green run here is a
 * statement about the product rather than about a fiction.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = path.resolve(HERE, "../../helpers/fake-assistant-engine.mjs");

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

/**
 * Opens the assistant panel.
 *
 * Open state comes from the TOOLBAR TOGGLE'S `aria-pressed`, not from whether the
 * composer looks visible. The panel slides off-canvas instead of unmounting, so
 * Playwright reports its contents as visible while it is closed — a check on the
 * composer silently skips the toggle, leaves `isOpen` false, and the engine never
 * starts because the panel it belongs to is not actually open.
 */
async function openAssistant(window: AppContext["window"]) {
  const toggle = window
    .getByRole("toolbar", { name: "Main toolbar" })
    .getByRole("button", { name: "Daintree Assistant", exact: true });
  await expect(toggle).toBeVisible({ timeout: T_LONG });

  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: T_LONG });

  const panel = window.locator("#daintree-assistant-panel");
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await waitForSession(window);
  return panel;
}

/** Waits for a live engine session. The status line is the readiness signal. */
async function waitForSession(window: AppContext["window"]) {
  await expect(
    window.locator("#daintree-assistant-panel").getByText("Connected", { exact: true })
  ).toBeVisible({ timeout: T_LONG });
}

/** The composer — present only when the NATIVE panel rendered, never for an xterm. */
function composer(window: AppContext["window"]) {
  return window.locator("#daintree-assistant-panel textarea");
}

/**
 * The panel's own send button, scoped to the panel: the dock's "Send output to Grid"
 * also matches an unscoped accessible name of "Send".
 */
function sendButton(window: AppContext["window"]) {
  return window
    .locator("#daintree-assistant-panel")
    .getByRole("button", { name: "Send", exact: true });
}

async function ask(window: AppContext["window"], text: string) {
  const input = composer(window);
  await expect(input).toBeVisible({ timeout: T_LONG });
  // Wait for the ENGINE, not just the panel. The composer renders as soon as the panel
  // does, but the session is still starting — and a prompt sent before it is ready is
  // refused (the draft is kept) rather than queued, so asking early would assert
  // against a turn that never happened.
  //
  // The status line is the readiness signal. The send button is not: it is also
  // disabled on an empty draft, so waiting for it to enable before typing can never
  // succeed.
  await waitForSession(window);

  await input.fill(text);
  // Now it must be live — the draft is non-empty and the session is ready.
  await expect(sendButton(window)).toBeEnabled();
  await sendButton(window).click();
  // The composer clears only on ACCEPTANCE, so an empty box is the proof the prompt
  // was taken rather than refused.
  await expect(input).toHaveValue("", { timeout: T_MEDIUM });
}

test.describe.serial("Assistant: native panel", () => {
  test.beforeEach(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "assistant-native" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;

    ctx = await launchApp({
      env: {
        // The engine under test. Resolution prefers this over the bundled binary, so
        // no build of the real engine is needed for these assertions.
        DAINTREE_ASSISTANT_BIN: FAKE_ENGINE,
        // Zero delay: these assert behaviour, not animation timing.
        FAKE_ENGINE_SPEED: "0",
        FAKE_ENGINE_SCENARIO: "streaming",
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Assistant Native Test"
    );
  });

  test.afterEach(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("renders natively rather than as a terminal", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);

    // The composer is a real textarea. An xterm pane has none — so this single
    // assertion is what separates "the native panel rendered" from "we are looking at
    // the old PTY cockpit in a terminal", which is exactly the regression that would
    // otherwise be invisible in a screenshot.
    await expect(composer(window)).toBeVisible({ timeout: T_LONG });
    await expect(panel.locator(".xterm")).toHaveCount(0);
  });

  test("streams an answer and settles its tool batch", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario streaming");

    // The batch is announced as a plan before dispatch, so the group header appears
    // with both calls counted rather than one row at a time.
    await expect(window.getByText(/2 actions/)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.getByText(/Three worktrees are ready/)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("replaces streamed tokens with the authoritative final content", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario authoritativeContent");

    await expect(window.getByText(/authoritative answer replaced/)).toBeVisible({
      timeout: T_MEDIUM,
    });
    // The self-healing property: a consumer that merely concatenates tokens would
    // still be showing the truncated stream.
    await expect(window.getByText(/PARTIAL-STREAM-SHOULD-BE-REPLACED/)).toHaveCount(0);
  });

  test("a typed confirmation cannot be approved by clicking", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario approval");

    const card = window.getByRole("group", { name: "Approval required" });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });

    // needsTypedConfirm is the ENGINE's verdict. The destructive button stays disabled
    // until the phrase is typed — a UI that enabled it early would have forked a
    // security rule into a second codebase.
    const approve = card.getByRole("button", { name: /Push commits/ });
    await expect(approve).toBeDisabled();

    await card.getByPlaceholder("confirm").fill("confirm");
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect(window.getByText(/Pushed\./)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("surfaces a lost frame instead of showing a partial answer as whole", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario droppedFrame");

    await expect(window.getByText(/lost in transit/)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("keeps an accepted background task out of the finished state", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario asyncWork");

    // The call settled but the work continues. Rendering it as done — or showing the
    // dispatch duration, which reads as "finished in 1.2s" — would claim work
    // completed that is still running.
    await expect(window.getByText(/Running in background/)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.getByText(/still running/)).toBeVisible();
  });

  /**
   * Screenshots of the REAL app, in both default themes, for design review.
   *
   * Taken from the live panel rather than a fixture harness: a fixture is a belief
   * about what the panel receives, and reviewing one reviews the belief.
   */
  for (const theme of ["daintree", "bondi"] as const) {
    test(`looks right in the ${theme} theme`, async () => {
      const { window } = ctx;
      await window.evaluate((id) => {
        window.localStorage.setItem("daintree-theme", JSON.stringify({ state: { themeId: id } }));
      }, theme);

      await openAssistant(window);
      await ask(window, "/scenario approval");
      await expect(window.getByRole("group", { name: "Approval required" })).toBeVisible({
        timeout: T_MEDIUM,
      });

      await window
        .locator("#daintree-assistant-panel")
        .screenshot({ path: `e2e/screenshots/assistant-${theme}.png` });
    });
  }
});
