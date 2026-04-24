import { test, expect } from "@playwright/test";
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

let ctx: AppContext;
let fixtureDir: string;

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

  test("chrome tracks live process: promote on `claude`, demote on `/quit`", async () => {
    test.setTimeout(300_000);

    await test.step("launch app + open project", async () => {
      ctx = await launchApp();
      const { app, window } = ctx;
      await mockOpenDialog(app, fixtureDir);
      await window.getByRole("button", { name: "Open Folder" }).click();

      const heading = window.locator("h2", { hasText: "Set up your project" });
      await expect(heading).toBeVisible({ timeout: 15_000 });
      await window.getByRole("textbox", { name: "Project Name" }).fill("Identity Transitions");
      await window.getByRole("button", { name: "Finish", exact: true }).click();
      await expect(heading).not.toBeVisible({ timeout: 10_000 });
      await dismissTelemetryConsent(window);
    });

    ctx.window = await refreshActiveWindow(ctx.app, ctx.window);

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

      // Derived chrome attribute — must match detection exactly (chrome = live).
      expect(await panel.getAttribute("data-chrome-agent-id")).toBe("claude");

      // Visible chrome: title contains "Claude".
      const title = await panel.getAttribute("aria-label");
      expect(title).toMatch(/Claude/i);

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

    await test.step("type /quit in Claude", async () => {
      const { window } = ctx;
      const panel = window.locator(`[data-panel-id="${claudePanelId}"]`);
      const cmEditor = panel.locator(SEL.terminal.cmEditor);
      await cmEditor.click();
      await cmEditor.pressSequentially("/quit", { delay: 30 });
      await window.keyboard.press("Enter");
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

      // Chrome must mirror detection. Zero lag.
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

      await window.screenshot({
        path: path.join(SCREENSHOT_DIR, "2b-plain-promoted.png"),
        fullPage: false,
      });
    });

    // ---------------------------------------------------------------------
    // FLOW 3: Promoted plain shell → /quit → demotes back
    // Covers the full enter-exit cycle on a single terminal — the scenario
    // that most directly proves chrome is driven ONLY by live process state.
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

      await window.screenshot({
        path: path.join(SCREENSHOT_DIR, "3-full-cycle-demoted.png"),
        fullPage: false,
      });
    });
  });
});
