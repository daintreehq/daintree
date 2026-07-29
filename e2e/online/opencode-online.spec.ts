import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { dismissTelemetryConsent, openAndOnboardProject } from "../helpers/project";
import { getTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import {
  classifyOpenCodeOutput,
  formatOpenCodeCrashError,
  formatOpenCodeTimeoutError,
  initialStabilizationState,
  observeOpenCodeOutput,
  type OpenCodeOutputKind,
} from "../helpers/opencodeReady";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

async function focusHybridEditor(page: Page, agentPanel: Locator): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 8; attempt++) {
    const cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
    try {
      await expect(cmEditor).toBeVisible({ timeout: 5_000 });
      await cmEditor.evaluate((node) => {
        const element = node as HTMLElement;
        element.scrollIntoView({ block: "center", inline: "center" });
        element.focus();
      });
      await expect
        .poll(
          () => cmEditor.evaluate((node) => document.activeElement === node).catch(() => false),
          {
            timeout: 2_000,
            intervals: [100, 250],
          }
        )
        .toBe(true);
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(500);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to focus hybrid editor");
}

async function openFixtureProject(): Promise<void> {
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir);
}

async function launchOpenCodeAgent(): Promise<Locator> {
  const { window } = ctx;

  // Agents are unpinned by default, so the toolbar shows the Agent Tray
  // rather than a direct "Start OpenCode Agent" button. Open the tray and
  // click the OpenCode entry under "Launch".
  await window.locator(SEL.agent.trayButton).click();
  await window.getByRole("menuitem", { name: "OpenCode" }).click();

  const agentPanel = window.locator(SEL.opencodeAgent.panel);
  await expect(agentPanel).toBeVisible({ timeout: 30_000 });
  return agentPanel;
}

// Poll cadence while an actionable prompt is settling. Four samples at this
// interval is the ~1.5s of quiet the stabilization gate wants before we type.
const STABILIZATION_POLL_MS = 500;
const IDLE_POLL_MS = 1_000;

async function waitForOpenCodeReady(agentPanel: Locator): Promise<"ready" | "needs-restart"> {
  const { window } = ctx;

  // Windows GitHub runners take significantly longer to bring up the
  // OpenCode CLI (Node spawn + provider probe + render) — extend the
  // ready-state polling budget so we don't trip the deadline on cold-start.
  // macOS/Linux release runners need more than the local budget too: they run
  // every E2E bucket at once, and a flat 120s expired mid-cold-start on the
  // v0.29.0 macOS release run. The online gate runs with FAIL_ON_FLAKY_TESTS,
  // so a retry-recovered timeout still fails the release.
  const deadline =
    Date.now() + (process.platform === "win32" ? 360_000 : process.env.CI ? 180_000 : 120_000);

  let stabilization = initialStabilizationState();
  let lastText = "";
  let lastKind: OpenCodeOutputKind = "pending";

  while (Date.now() < deadline) {
    await dismissTelemetryConsent(window);

    lastText = await getTerminalText(agentPanel);
    const classification = classifyOpenCodeOutput(lastText);
    lastKind = classification.kind;

    // Fail in one poll interval rather than burning the whole deadline on a
    // CLI that is already dead — the generic timeout that used to surface here
    // read as a Daintree ready-state bug and cost a release investigation.
    if (classification.kind === "crashed") {
      throw new Error(formatOpenCodeCrashError(classification.signature, lastText));
    }
    if (classification.kind === "needs-restart") return "needs-restart";
    if (classification.kind === "ready") return "ready";

    const observed = observeOpenCodeOutput(stabilization, {
      kind: classification.kind,
      text: lastText,
      now: Date.now(),
    });
    stabilization = observed.state;

    if (observed.decision !== "act") {
      await window.waitForTimeout(
        observed.decision === "wait" ? STABILIZATION_POLL_MS : IDLE_POLL_MS
      );
      continue;
    }

    await focusHybridEditor(window, agentPanel);

    // Focus retries can take seconds, during which the TUI may have moved on
    // (or died). Re-read before committing a keystroke: sending the previous
    // screen's answer is what feeds the CLI's keymap parser input it cannot
    // decode.
    lastText = await getTerminalText(agentPanel);
    const settled = classifyOpenCodeOutput(lastText);
    lastKind = settled.kind;

    if (settled.kind === "crashed") {
      throw new Error(formatOpenCodeCrashError(settled.signature, lastText));
    }
    if (settled.kind !== classification.kind) {
      stabilization = initialStabilizationState();
      continue;
    }

    if (settled.kind === "awaiting-api-key") {
      await window.keyboard.press("ArrowUp");
    }
    await window.keyboard.press("Enter");
    await window.waitForTimeout(2_000);

    // Make a prompt that survives our input settle again before we retry it.
    stabilization = initialStabilizationState();
  }

  throw new Error(formatOpenCodeTimeoutError(lastKind, lastText));
}

async function launchOpenCodeReady(): Promise<Locator> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const agentPanel = await launchOpenCodeAgent();
    const state = await waitForOpenCodeReady(agentPanel);
    if (state === "ready") return agentPanel;

    // OpenCode can self-update on first launch and require the embedding app
    // to restart before the new CLI process will accept input.
    await closeApp(ctx.app);
    ctx = await launchApp();
    await openFixtureProject();
  }

  throw new Error("OpenCode required restart more than once");
}

test.describe("OpenCode Online Flow", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "opencode-online" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("full OpenCode agent interaction", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "online: requires OpenCode installed and OPENCODE_E2E_ENABLED=1",
    });

    test.skip(
      !process.env.OPENCODE_E2E_ENABLED,
      "online: requires OpenCode installed and OPENCODE_E2E_ENABLED=1"
    );

    await test.step("launch app", async () => {
      ctx = await launchApp();
    });

    await test.step("open folder", async () => {
      await openFixtureProject();
    });

    await test.step("launch OpenCode agent", async () => {
      await launchOpenCodeReady();
    });

    await test.step("send hello world command", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.opencodeAgent.panel);
      await focusHybridEditor(window, agentPanel);
      await window.waitForTimeout(500);
      await window.keyboard.type("Please say hello world", { delay: 30 });
      await window.waitForTimeout(200);
      await window.keyboard.press("Enter");
    });

    await test.step("verify response contains hello", async () => {
      const { window } = ctx;

      const agentPanel = window.locator(SEL.opencodeAgent.panel);

      await expect
        .poll(
          async () => {
            const text = await getTerminalText(agentPanel);
            return text.toLowerCase().split("hello").length - 1;
          },
          { timeout: 60_000, intervals: [1_000] }
        )
        .toBeGreaterThanOrEqual(1);
    });
  });
});
