import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { spawnTerminalAndVerify } from "../../helpers/workflows";
import {
  getTerminalDimensions,
  getTerminalText,
  waitForTerminalText,
} from "../../helpers/terminal";
import { expectTerminalFocused } from "../../helpers/focus";
import { T_LONG, T_MEDIUM, T_SHORT } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
let panel: Locator;

/** Capture a settled state and attach it to the report for visual review. */
async function capture(page: Page, testInfo: TestInfo, target: Locator, name: string) {
  await expect(target).toBeVisible();
  const path = testInfo.outputPath(`${name}.png`);
  await target.screenshot({ path, animations: "disabled", caret: "hide" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function openScratchpadFromMenu(page: Page, pane: Locator): Promise<void> {
  await pane.getByRole("button", { name: "More panel actions" }).click();
  await page.getByRole("menuitem", { name: "Show scratchpad" }).click();
  // The menu's exit animation keeps a focus scope alive that swallows the next
  // keystrokes; wait for the portal to unmount before typing anywhere.
  await expect(page.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
}

test.describe.serial("Terminal scratchpad (#12835)", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "terminal-scratchpad" });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Terminal Scratchpad");
    panel = await spawnTerminalAndVerify(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("opens from the overflow menu beside the terminal without taking focus", async () => {
    const testInfo = test.info();
    const { window } = ctx;
    const scratchpad = panel.getByTestId("terminal-scratchpad");
    await expect(scratchpad).toHaveCount(0);

    const before = await getTerminalDimensions(panel);
    expect(before).not.toBeNull();

    await openScratchpadFromMenu(window, panel);

    await expect(scratchpad).toBeVisible({ timeout: T_MEDIUM });
    const editor = panel.getByTestId("terminal-scratchpad-editor");
    await expect(editor).toHaveValue("");
    await expect(editor).not.toBeFocused();

    // The terminal gives up the column's width rather than sitting under it.
    await expect
      .poll(async () => (await getTerminalDimensions(panel))?.cols ?? 0, { timeout: T_LONG })
      .toBeLessThan(before!.cols);

    await capture(window, testInfo, panel, "01-scratchpad-open-empty");
  });

  test("takes typing only when clicked into, and gives the terminal its keys back", async () => {
    const testInfo = test.info();
    const { window } = ctx;
    const editor = panel.getByTestId("terminal-scratchpad-editor");
    const notes = "## Next\n- [ ] check CI\n- run `npm test`";

    await editor.click();
    await expect(editor).toBeFocused();
    await window.keyboard.type(notes);
    await expect(editor).toHaveValue(notes);
    expect(await getTerminalText(panel)).not.toContain("check CI");

    await panel.locator(".xterm-screen").click();
    await expectTerminalFocused(panel);
    await window.keyboard.type("echo scratchpad-keys-ok");
    await window.keyboard.press("Enter");
    await waitForTerminalText(panel, "scratchpad-keys-ok", T_LONG);
    await expect(editor).toHaveValue(notes);

    await capture(window, testInfo, panel, "02-scratchpad-with-notes");
  });

  test("resizes from its left edge", async () => {
    const testInfo = test.info();
    const { window } = ctx;
    const scratchpad = panel.getByTestId("terminal-scratchpad");
    const grip = panel.getByTestId("terminal-scratchpad-resize");
    const start = await scratchpad.boundingBox();
    const gripBox = await grip.boundingBox();
    expect(start).not.toBeNull();
    expect(gripBox).not.toBeNull();

    const x = gripBox!.x + gripBox!.width / 2;
    const y = gripBox!.y + gripBox!.height / 2;
    await window.mouse.move(x, y);
    await window.mouse.down();
    await window.mouse.move(x - 80, y, { steps: 8 });
    await window.mouse.up();

    await expect
      .poll(async () => (await scratchpad.boundingBox())?.width ?? 0, { timeout: T_SHORT })
      .toBeGreaterThan(start!.width + 40);

    await capture(window, testInfo, panel, "03-scratchpad-resized");
  });

  test("collapses to a header control and expands back as it was", async () => {
    const testInfo = test.info();
    const { window } = ctx;
    const scratchpad = panel.getByTestId("terminal-scratchpad");
    const width = (await scratchpad.boundingBox())!.width;
    const editor = panel.getByTestId("terminal-scratchpad-editor");
    const notes = await editor.inputValue();

    await panel.getByRole("button", { name: "Collapse scratchpad" }).click();
    await expect(scratchpad).toHaveCount(0);
    const expand = panel.getByTestId("panel-expand-scratchpad");
    await expect(expand).toBeVisible();

    await capture(window, testInfo, panel, "04-scratchpad-collapsed");

    await expand.click();
    await expect(scratchpad).toBeVisible();
    await expect(editor).toHaveValue(notes);
    await expect(editor).not.toBeFocused();
    expect(Math.abs((await scratchpad.boundingBox())!.width - width)).toBeLessThan(2);
    await expect(expand).toHaveCount(0);
  });

  test("leaves nothing behind when closed empty, and the menu brings it back", async () => {
    const testInfo = test.info();
    const { window } = ctx;
    const editor = panel.getByTestId("terminal-scratchpad-editor");

    await editor.fill("");
    await panel.getByRole("button", { name: "Close scratchpad" }).click();

    await expect(panel.getByTestId("terminal-scratchpad")).toHaveCount(0);
    await expect(panel.getByTestId("panel-expand-scratchpad")).toHaveCount(0);

    await capture(window, testInfo, panel, "05-scratchpad-closed");

    await openScratchpadFromMenu(window, panel);
    await expect(panel.getByTestId("terminal-scratchpad")).toBeVisible();
    await expect(editor).toHaveValue("");
  });
});
