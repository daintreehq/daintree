import {
  test,
  expect,
  type ConsoleMessage,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import {
  launchApp,
  closeApp,
  mockOpenDialog,
  refreshActiveWindow,
  type AppContext,
} from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { dismissTelemetryConsent } from "../helpers/project";
import { getTerminalText, runTerminalCommand } from "../helpers/terminal";
import { openTerminal, getFirstGridPanel } from "../helpers/panels";
import { SEL } from "../helpers/selectors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, "../../test-results/terminal-identity-transitions");
const MAX_DIAGNOSTIC_LINES = 1_500;
const AGENT_IDLE_STICKINESS_MS = 45_000;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const AGENT_STATE_VALUES = new Set([
  "idle",
  "working",
  "waiting",
  "directing",
  "completed",
  "exited",
]);

let ctx: AppContext;
let fixtureDir: string;
let diagnostics: IdentityDiagnostics | null = null;

interface IdentitySnapshot {
  label: string;
  capturedAt: string;
  data: unknown;
}

interface IdentityDiagnostics {
  attachPage(page: Page): void;
  captureSnapshot(label: string, page?: Page): Promise<void>;
  attachFailureArtifacts(testInfo: TestInfo): Promise<void>;
  dispose(): void;
}

function panelHeaderIcon(panel: Locator): Locator {
  return panel.locator("[data-pane-chrome] [data-terminal-icon-id]").first();
}

async function expectPanelHeaderIcon(panel: Locator, iconId: string): Promise<void> {
  await expect
    .poll(() => panelHeaderIcon(panel).getAttribute("data-terminal-icon-id"), {
      timeout: 5_000,
      intervals: [250],
    })
    .toBe(iconId);
}

async function expectPanelHasAgentState(panel: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await panel.getAttribute("data-agent-state");
        return state !== null && AGENT_STATE_VALUES.has(state);
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe(true);
}

async function expectPanelHasNoAgentState(panel: Locator): Promise<void> {
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), {
      timeout: 10_000,
      intervals: [250],
    })
    .toBeNull();
}

async function expectAgentChromeSurvivesIdle(
  page: Page,
  panel: Locator,
  terminalId: string,
  agentId: string
): Promise<void> {
  await page.waitForTimeout(AGENT_IDLE_STICKINESS_MS);
  await expect
    .poll(() => panel.getAttribute("data-chrome-agent-id"), {
      timeout: 5_000,
      intervals: [250],
    })
    .toBe(agentId);
  await expectPanelHeaderIcon(panel, agentId);
  await expectPanelHasAgentState(panel);
  await expectWorktreeTracksAgent(page, terminalId, agentId);
}

async function expandVisibleWorktreeTerminalAccordions(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      'button[aria-controls$="-terminals-panel"][aria-expanded="false"]'
    )) {
      button.click();
    }
  });
}

function worktreeTerminalRow(page: Page, terminalId: string): Locator {
  return page.locator(`[data-terminal-id="${terminalId}"][data-terminal-runtime-kind]`).first();
}

async function expectWorktreeRowVisible(page: Page, terminalId: string): Promise<Locator> {
  const row = worktreeTerminalRow(page, terminalId);
  await expect
    .poll(
      async () => {
        await expandVisibleWorktreeTerminalAccordions(page);
        return (await row.count()) > 0;
      },
      { timeout: 30_000, intervals: [500, 1_000] }
    )
    .toBe(true);
  await expect(row).toBeVisible({ timeout: 10_000 });
  return row;
}

async function expectWorktreeTracksAgent(
  page: Page,
  terminalId: string,
  agentId: string
): Promise<void> {
  const row = await expectWorktreeRowVisible(page, terminalId);
  await expect
    .poll(() => row.getAttribute("data-terminal-agent-id"), {
      timeout: 10_000,
      intervals: [250],
    })
    .toBe(agentId);
  await expect
    .poll(
      async () => {
        const state = await row.getAttribute("data-terminal-agent-state");
        return state !== null && AGENT_STATE_VALUES.has(state);
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] }
    )
    .toBe(true);
  await expect
    .poll(
      () => row.locator("[data-terminal-icon-id]").first().getAttribute("data-terminal-icon-id"),
      {
        timeout: 5_000,
        intervals: [250],
      }
    )
    .toBe(agentId);
}

async function expectWorktreeTracksPlainTerminal(page: Page, terminalId: string): Promise<void> {
  const row = await expectWorktreeRowVisible(page, terminalId);
  await expect
    .poll(() => row.getAttribute("data-terminal-agent-id"), {
      timeout: 10_000,
      intervals: [250],
    })
    .toBeNull();
  await expect
    .poll(() => row.getAttribute("data-terminal-agent-state"), {
      timeout: 10_000,
      intervals: [250],
    })
    .toBeNull();
}

function isRelevantDiagnosticLine(line: string): boolean {
  return (
    line.includes("[IdentityDebug]") ||
    line.includes("agent:detected") ||
    line.includes("agent:exited") ||
    /\bidentity\b/i.test(line) ||
    /\b(error|exception|crash|failed)\b/i.test(line)
  );
}

function createIdentityDiagnostics(appCtx: AppContext): IdentityDiagnostics {
  const lines: string[] = [];
  const snapshots: IdentitySnapshot[] = [];
  const disposers: Array<() => void> = [];
  const attachedPages = new WeakSet<Page>();
  let latestPage: Page | undefined = appCtx.window;

  const pushLine = (source: string, text: string, force = false) => {
    const cleanText = text.replace(ANSI_ESCAPE_PATTERN, "");
    for (const rawLine of cleanText.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (!force && !isRelevantDiagnosticLine(line)) continue;
      lines.push(`[${new Date().toISOString()}] [${source}] ${line}`);
      if (lines.length > MAX_DIAGNOSTIC_LINES) {
        lines.splice(0, lines.length - MAX_DIAGNOSTIC_LINES);
      }
    }
  };

  const attachPage = (page: Page) => {
    latestPage = page;
    if (attachedPages.has(page)) return;
    attachedPages.add(page);

    void page
      .evaluate(() => {
        (
          window as Window & { __DAINTREE_IDENTITY_RENDER_DEBUG__?: boolean }
        ).__DAINTREE_IDENTITY_RENDER_DEBUG__ = true;
      })
      .catch(() => {
        // Page may still be initializing; failure artifacts include later snapshots.
      });

    const onConsole = (message: ConsoleMessage) => {
      const type = message.type();
      pushLine(`renderer:${type}`, message.text(), type === "error" || type === "warning");
    };
    const onPageError = (error: Error) => {
      pushLine("renderer:pageerror", error.stack ?? error.message, true);
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    disposers.push(() => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    });
  };

  const appProcess = appCtx.app.process();
  const onStdout = (chunk: Buffer | string) => {
    pushLine("main:stdout", String(chunk));
  };
  const onStderr = (chunk: Buffer | string) => {
    pushLine("main:stderr", String(chunk));
  };
  appProcess.stdout?.on("data", onStdout);
  appProcess.stderr?.on("data", onStderr);
  disposers.push(() => {
    appProcess.stdout?.off("data", onStdout);
    appProcess.stderr?.off("data", onStderr);
  });

  const captureSnapshot = async (label: string, page = latestPage) => {
    if (!page || page.isClosed()) {
      snapshots.push({
        label,
        capturedAt: new Date().toISOString(),
        data: { unavailable: "page is closed or not attached" },
      });
      return;
    }

    try {
      const data = await page.evaluate(() => {
        type IdentityDebugWindow = Window & {
          __daintreeIdentityEvents?: () => unknown;
          __daintreeIdentityState?: () => unknown;
        };

        const debugWindow = window as IdentityDebugWindow;
        const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-panel-id]")).map(
          (panel) => {
            const header = panel.querySelector<HTMLElement>("[data-pane-chrome]");
            return {
              panelId: panel.getAttribute("data-panel-id"),
              detectedAgentId: panel.getAttribute("data-detected-agent-id"),
              detectedProcessId: panel.getAttribute("data-detected-process-id"),
              chromeAgentId: panel.getAttribute("data-chrome-agent-id"),
              agentState: panel.getAttribute("data-agent-state"),
              ambientAgentState: panel.getAttribute("data-ambient-agent-state"),
              runtimeKind: panel.getAttribute("data-runtime-kind"),
              runtimeIconId: panel.getAttribute("data-runtime-icon-id"),
              launchAgentId: panel.getAttribute("data-launch-agent-id"),
              everDetectedAgent: panel.getAttribute("data-ever-detected-agent"),
              ariaLabel: panel.getAttribute("aria-label"),
              headerIcons: Array.from(
                header?.querySelectorAll<HTMLElement>("[data-terminal-icon-id]") ?? []
              ).map((icon) => icon.getAttribute("data-terminal-icon-id")),
              allIcons: Array.from(
                panel.querySelectorAll<HTMLElement>("[data-terminal-icon-id]")
              ).map((icon) => icon.getAttribute("data-terminal-icon-id")),
              text: panel.textContent?.slice(0, 500) ?? "",
            };
          }
        );
        const worktreeTerminalRows = Array.from(
          document.querySelectorAll<HTMLElement>("[data-terminal-id][data-terminal-runtime-kind]")
        ).map((row) => ({
          terminalId: row.getAttribute("data-terminal-id"),
          runtimeKind: row.getAttribute("data-terminal-runtime-kind"),
          agentId: row.getAttribute("data-terminal-agent-id"),
          agentState: row.getAttribute("data-terminal-agent-state"),
          icons: Array.from(row.querySelectorAll<HTMLElement>("[data-terminal-icon-id]")).map(
            (icon) => icon.getAttribute("data-terminal-icon-id")
          ),
          text: row.textContent?.slice(0, 300) ?? "",
        }));

        return {
          url: location.href,
          title: document.title,
          identityEvents: debugWindow.__daintreeIdentityEvents?.() ?? null,
          identityState: debugWindow.__daintreeIdentityState?.() ?? null,
          panels,
          worktreeTerminalRows,
        };
      });

      snapshots.push({ label, capturedAt: new Date().toISOString(), data });
      pushLine("snapshot", `${label}: ${JSON.stringify(data)}`, true);
    } catch (error) {
      snapshots.push({
        label,
        capturedAt: new Date().toISOString(),
        data: {
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        },
      });
    }
  };

  attachPage(appCtx.window);

  return {
    attachPage,
    captureSnapshot,
    async attachFailureArtifacts(testInfo: TestInfo) {
      await captureSnapshot("failure-final");
      await testInfo.attach("identity-console.log", {
        body: lines.length > 0 ? lines.join("\n") : "(no relevant identity logs captured)",
        contentType: "text/plain",
      });
      await testInfo.attach("identity-debug-snapshots.json", {
        body: JSON.stringify(snapshots, null, 2),
        contentType: "application/json",
      });
      if (latestPage && !latestPage.isClosed()) {
        try {
          await testInfo.attach("identity-failure.png", {
            body: await latestPage.screenshot({ fullPage: false }),
            contentType: "image/png",
          });
        } catch {
          // Best-effort diagnostic; console + state attachments are primary.
        }
      }
    },
    dispose() {
      for (const dispose of disposers.splice(0)) {
        dispose();
      }
    },
  };
}

// Chrome is a function of the live process in the PTY. Nothing else. These
// assertions walk the full chrome surface — DOM attribute, title bar text,
// and the rendered icon — in both directions, to catch memoization or
// prop-threading leaks that let one read lag behind another.
test.describe("Terminal chrome ↔ live process identity (bidirectional)", () => {
  test.beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    fixtureDir = createFixtureRepo({ name: "identity-transitions" });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // Electron-only test: do not request the Playwright `page` fixture here, or
  // Playwright will try to launch a browser just to run cleanup.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      await diagnostics?.attachFailureArtifacts(testInfo);
    }
    diagnostics?.dispose();
    diagnostics = null;
  });

  test("chrome tracks live process: promote on `claude`, demote on `/quit`", async () => {
    test.setTimeout(300_000);

    await test.step("launch app + open project", async () => {
      ctx = await launchApp({ env: { DAINTREE_IDENTITY_DEBUG_PASS: "1" } });
      diagnostics = createIdentityDiagnostics(ctx);
      const { app, window } = ctx;
      await mockOpenDialog(app, fixtureDir);
      await window.getByRole("button", { name: "Open Folder" }).click();
    });

    ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
    await dismissTelemetryConsent(ctx.window);
    diagnostics?.attachPage(ctx.window);
    await diagnostics?.captureSnapshot("active project window refreshed", ctx.window);

    // ---------------------------------------------------------------------
    // FLOW 1: Claude cold-launch → /quit → demotes to plain shell
    // ---------------------------------------------------------------------

    let claudePanelId = "";
    await test.step("cold-launch Claude terminal", async () => {
      const { window } = ctx;
      await window.locator(SEL.agent.trayButton).click();
      await window.getByRole("menuitem", { name: "Claude" }).click();

      const agentPanel = window.locator(SEL.agent.panel);
      await expect(agentPanel).toBeVisible({ timeout: 30_000 });
      claudePanelId = (await agentPanel.getAttribute("data-panel-id")) ?? "";
      expect(claudePanelId).toBeTruthy();
      await diagnostics?.captureSnapshot("cold-launch Claude panel visible", window);
    });

    await test.step("chrome promotes once the detector sees Claude (promotion side A)", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${claudePanelId}"]`);

      // Authoritative signal — the live-process field.
      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), {
          timeout: 90_000,
          intervals: [500],
        })
        .toBe("claude");

      // Detection has now caught up; chrome must still be Claude.
      expect(await panel.getAttribute("data-chrome-agent-id")).toBe("claude");

      // Visible chrome: title contains "Claude".
      const title = await panel.getAttribute("aria-label");
      expect(title).toMatch(/Claude/i);
      await expectPanelHeaderIcon(panel, "claude");
      await expectPanelHasAgentState(panel);
      await expectWorktreeTracksAgent(window, claudePanelId, "claude");
      await diagnostics?.captureSnapshot("cold-launch Claude promoted", window);

      await window.screenshot({
        path: path.join(SCREENSHOT_DIR, "1a-claude-launched.png"),
        fullPage: false,
      });
    });

    await test.step("wait for Claude to reach welcome or any interactive prompt", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${claudePanelId}"]`);
      const cmEditor = panel.locator(SEL.terminal.cmEditor);

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await dismissTelemetryConsent(window);
        const text = (await getTerminalText(panel)).toLowerCase();

        if (text.includes("welcome") || text.includes("try ") || text.includes(">")) break;
        if (text.includes("trust")) {
          await cmEditor.click();
          await window.keyboard.press("Enter");
        } else if (text.includes("api key")) {
          await cmEditor.click();
          await window.keyboard.press("ArrowUp");
          await window.keyboard.press("Enter");
        }
        await window.waitForTimeout(1_000);
      }
    });

    await test.step("cold-launched Claude remains agent-branded after idle wait", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${claudePanelId}"]`);
      await expectAgentChromeSurvivesIdle(window, panel, claudePanelId, "claude");
      await diagnostics?.captureSnapshot("cold-launched Claude survived idle wait", window);
    });

    await test.step("type /quit in Claude", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${claudePanelId}"]`);
      const cmEditor = panel.locator(SEL.terminal.cmEditor);
      await cmEditor.click();
      await cmEditor.pressSequentially("/quit", { delay: 30 });
      await window.keyboard.press("Enter");
      await diagnostics?.captureSnapshot("typed /quit in cold-launched Claude", window);
    });

    await test.step("chrome DEMOTES to plain shell", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${claudePanelId}"]`);

      // Primary: detection has cleared.
      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), {
          timeout: 30_000,
          intervals: [500],
        })
        .toBeNull();

      // Chrome must release durable launch affinity after the explicit exit.
      await expect
        .poll(() => panel.getAttribute("data-chrome-agent-id"), {
          timeout: 5_000,
          intervals: [250],
        })
        .toBeNull();

      // Visible chrome: title is no longer a Claude title. The aria-label on
      // a plain panel root is typically "Panel: Terminal" or similar.
      await expect
        .poll(() => panel.getAttribute("aria-label"), {
          timeout: 10_000,
          intervals: [500],
        })
        .not.toMatch(/Claude agent/i);
      await expectPanelHeaderIcon(panel, "terminal");
      await expectPanelHasNoAgentState(panel);
      await expectWorktreeTracksPlainTerminal(window, claudePanelId);
      await diagnostics?.captureSnapshot("cold-launched Claude demoted", window);

      await window.screenshot({
        path: path.join(SCREENSHOT_DIR, "1b-claude-demoted.png"),
        fullPage: false,
      });
    });

    // ---------------------------------------------------------------------
    // FLOW 2: Plain shell → `claude` → promotes to agent chrome
    // ---------------------------------------------------------------------

    let plainPanelId = "";
    await test.step("open a fresh plain terminal", async () => {
      const { window } = ctx;
      await openTerminal(window);
      const plainPanel = getFirstGridPanel(window);
      plainPanelId = await window.evaluate((claudeId) => {
        const all = Array.from(document.querySelectorAll("[data-panel-id]"));
        const plain = all.find((el) => el.getAttribute("data-panel-id") !== claudeId);
        return plain?.getAttribute("data-panel-id") ?? "";
      }, claudePanelId);
      expect(plainPanelId).toBeTruthy();
      expect(plainPanelId).not.toBe(claudePanelId);
      const panel = window.locator(`[data-panel-id="${plainPanelId}"]`);
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Plain from birth.
      expect(await panel.getAttribute("data-chrome-agent-id")).toBeNull();
      expect(await panel.getAttribute("data-detected-agent-id")).toBeNull();
      await expectPanelHeaderIcon(panel, "terminal");
      await diagnostics?.captureSnapshot("plain terminal open", window);

      await window.screenshot({
        path: path.join(SCREENSHOT_DIR, "2a-plain-terminal-open.png"),
        fullPage: false,
      });
      void plainPanel;
    });

    await test.step("type `claude` in the plain terminal", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${plainPanelId}"]`);
      await runTerminalCommand(window, panel, "claude");
      await diagnostics?.captureSnapshot("typed claude in plain terminal", window);
    });

    await test.step("chrome PROMOTES to Claude", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${plainPanelId}"]`);

      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), {
          timeout: 90_000,
          intervals: [500],
        })
        .toBe("claude");

      // Chrome attribute must follow detection without lag.
      await expect
        .poll(() => panel.getAttribute("data-chrome-agent-id"), {
          timeout: 5_000,
          intervals: [250],
        })
        .toBe("claude");

      await expect
        .poll(() => panel.getAttribute("aria-label"), {
          timeout: 10_000,
          intervals: [500],
        })
        .toMatch(/Claude/i);
      await expectPanelHeaderIcon(panel, "claude");
      await expectPanelHasAgentState(panel);
      await expectWorktreeTracksAgent(window, plainPanelId, "claude");
      await diagnostics?.captureSnapshot("plain terminal promoted to Claude", window);

      await window.screenshot({
        path: path.join(SCREENSHOT_DIR, "2b-plain-promoted.png"),
        fullPage: false,
      });
    });

    await test.step("typed Claude remains agent-branded after idle wait", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${plainPanelId}"]`);
      await expectAgentChromeSurvivesIdle(window, panel, plainPanelId, "claude");
      await diagnostics?.captureSnapshot("typed Claude survived idle wait", window);
    });

    // ---------------------------------------------------------------------
    // FLOW 3: Promoted plain shell → /quit → demotes back
    // Covers the full enter-exit cycle on a single terminal — the scenario
    // that most directly proves a terminal can enter and exit agent affinity.
    // ---------------------------------------------------------------------

    await test.step("quit Claude from the promoted plain terminal", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${plainPanelId}"]`);
      const cmEditor = panel.locator(SEL.terminal.cmEditor);
      const deadline = Date.now() + 60_000;
      let reachedPrompt = false;
      while (Date.now() < deadline && !reachedPrompt) {
        await dismissTelemetryConsent(window);
        const text = (await getTerminalText(panel)).toLowerCase();
        if (text.includes("welcome") || text.includes("try ") || text.includes(">")) {
          reachedPrompt = true;
        } else if (text.includes("trust")) {
          await cmEditor.click();
          await window.keyboard.press("Enter");
        } else if (text.includes("api key")) {
          await cmEditor.click();
          await window.keyboard.press("ArrowUp");
          await window.keyboard.press("Enter");
        }
        await window.waitForTimeout(1_000);
      }
      await cmEditor.click();
      await cmEditor.pressSequentially("/quit", { delay: 30 });
      await window.keyboard.press("Enter");
      await diagnostics?.captureSnapshot("typed /quit in promoted plain terminal", window);
    });

    await test.step("chrome demotes after /quit on the same terminal (full cycle)", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${plainPanelId}"]`);

      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), {
          timeout: 30_000,
          intervals: [500],
        })
        .toBeNull();

      await expect
        .poll(() => panel.getAttribute("data-chrome-agent-id"), {
          timeout: 5_000,
          intervals: [250],
        })
        .toBeNull();
      await expectPanelHeaderIcon(panel, "terminal");
      await expectPanelHasNoAgentState(panel);
      await expectWorktreeTracksPlainTerminal(window, plainPanelId);
      await diagnostics?.captureSnapshot("promoted plain terminal demoted", window);

      await window.screenshot({
        path: path.join(SCREENSHOT_DIR, "3-full-cycle-demoted.png"),
        fullPage: false,
      });
    });
  });
});
