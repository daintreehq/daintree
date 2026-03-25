import { test, expect, type Locator } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  expectTerminalFocused,
  expectPaletteFocused,
  expectInputBarFocused,
} from "../helpers/focus";
import { getFirstGridPanel, openTerminal } from "../helpers/panels";
import { runTerminalCommand, waitForTerminalText, getTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
let fixtureDir: string;
let terminalPanel: Locator;

function streamingCommand(token: string, lineCount = 100): string {
  return `node -e "let i=0;const t=setInterval(()=>{console.log('${token}_'+(++i));if(i>=${lineCount}){clearInterval(t);console.log('DONE_${token}')}},50)"`;
}

async function countStreamLines(panel: Locator, token: string): Promise<number> {
  const text = await getTerminalText(panel);
  return (text.match(new RegExp(`${token}_\\d+`, "g")) || []).length;
}

test.describe.serial("Core: Concurrent terminal output during UI interactions", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "concurrent-ops" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Concurrent Ops");

    await openTerminal(ctx.window);
    terminalPanel = getFirstGridPanel(ctx.window);
    await expect(terminalPanel).toBeVisible({ timeout: T_LONG });
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("action palette focus remains stable during terminal streaming", async () => {
    const { window } = ctx;

    await runTerminalCommand(window, terminalPanel, streamingCommand("CONC_A"));
    await waitForTerminalText(terminalPanel, "CONC_A_1", T_MEDIUM);

    await window.keyboard.press(`${mod}+Shift+P`);
    const dialog = window.locator(SEL.actionPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expectPaletteFocused(window, "action");

    const searchInput = window.locator(SEL.actionPalette.searchInput);

    // Verify focus persists while terminal output is actively streaming
    await expect
      .poll(
        async () => {
          const focused = await searchInput.evaluate((el) => document.activeElement === el);
          const lines = await countStreamLines(terminalPanel, "CONC_A");
          return { focused, streaming: lines > 5 };
        },
        { intervals: [200], timeout: T_MEDIUM }
      )
      .toEqual({ focused: true, streaming: true });

    // Type a search query while output continues
    await searchInput.fill("toggle sidebar");
    await window.waitForTimeout(T_SETTLE);

    await expect(searchInput).toHaveValue("toggle sidebar");

    const options = window.locator(SEL.actionPalette.options);
    await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });

    // First Escape clears the search query, second closes the dialog
    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: T_SHORT });

    await waitForTerminalText(terminalPanel, "DONE_CONC_A", T_LONG);
  });

  test("focus returns to terminal after palette dismissal during streaming", async () => {
    const { window } = ctx;

    await terminalPanel.locator(SEL.terminal.xtermRows).click();
    await expectTerminalFocused(terminalPanel);

    await runTerminalCommand(window, terminalPanel, streamingCommand("CONC_B"));
    await waitForTerminalText(terminalPanel, "CONC_B_1", T_MEDIUM);

    await window.keyboard.press(`${mod}+Shift+P`);
    const dialog = window.locator(SEL.actionPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expectPaletteFocused(window, "action");

    // Confirm streaming is active while palette is open
    const linesBefore = await countStreamLines(terminalPanel, "CONC_B");

    await window.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: T_SHORT });

    await expectTerminalFocused(terminalPanel);

    // Verify streaming continued during the interaction
    const linesAfter = await countStreamLines(terminalPanel, "CONC_B");
    expect(linesAfter).toBeGreaterThan(linesBefore);

    await waitForTerminalText(terminalPanel, "DONE_CONC_B", T_LONG);
  });

  test.describe.serial("HybridInputBar typing during streaming", () => {
    let agentPanel: Locator;
    let cmEditor: Locator;
    let agentAvailable = false;

    test("setup agent panel", async () => {
      const { window } = ctx;

      const startBtn = window.locator(SEL.agent.startButton);
      if (!(await startBtn.isVisible().catch(() => false))) {
        test.skip();
        return;
      }

      await startBtn.click();
      agentPanel = window.locator(SEL.agent.panel);
      await expect(agentPanel).toBeVisible({ timeout: T_LONG });

      cmEditor = agentPanel.locator(SEL.terminal.cmEditor);
      await expect(cmEditor).toBeAttached({ timeout: T_LONG });
      agentAvailable = true;
    });

    test("typing in HybridInputBar is not disrupted by concurrent terminal output", async () => {
      if (!agentAvailable) {
        test.skip();
        return;
      }

      const { window } = ctx;

      // Switch to terminal tab and ensure it has focus before typing
      const tabList = window.locator(SEL.panel.tabList);
      const terminalTab = tabList
        .getByRole("tab")
        .filter({ hasNotText: /claude/i })
        .first();
      if (await terminalTab.isVisible().catch(() => false)) {
        await terminalTab.click();
        await window.waitForTimeout(T_SETTLE);
      }
      await terminalPanel.locator(SEL.terminal.xtermRows).click();
      await expectTerminalFocused(terminalPanel);

      // Use a longer stream (200 lines) to ensure it's still active during typing
      await runTerminalCommand(window, terminalPanel, streamingCommand("CONC_C", 200));
      await waitForTerminalText(terminalPanel, "CONC_C_3", T_MEDIUM);

      // Now switch to agent tab and type in the input bar
      const agentTab = tabList
        .getByRole("tab")
        .filter({ hasText: /claude/i })
        .first();
      if (await agentTab.isVisible().catch(() => false)) {
        await agentTab.click();
        await window.waitForTimeout(T_SETTLE);
      } else {
        await cmEditor.click();
      }

      await cmEditor.click();
      await expectInputBarFocused(agentPanel);

      const testText = "concurrent-typing-test";
      await cmEditor.pressSequentially(testText, { delay: 30 });

      await expect(cmEditor).toHaveText(new RegExp(testText), { timeout: T_MEDIUM });

      // Switch back to terminal tab to verify streaming was active
      if (await terminalTab.isVisible().catch(() => false)) {
        await terminalTab.click();
        await window.waitForTimeout(T_SETTLE);
      }
      const lines = await countStreamLines(terminalPanel, "CONC_C");
      expect(lines).toBeGreaterThan(5);

      // Clean up: switch to agent tab and clear editor
      if (await agentTab.isVisible().catch(() => false)) {
        await agentTab.click();
        await window.waitForTimeout(T_SETTLE);
      }
      await cmEditor.click();
      await window.keyboard.press(`${mod}+A`);
      await window.keyboard.press("Backspace");

      await waitForTerminalText(terminalPanel, "DONE_CONC_C", T_LONG);
    });
  });
});
