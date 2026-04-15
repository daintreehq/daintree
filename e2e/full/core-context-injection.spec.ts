/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { waitForTerminalText } from "../helpers/terminal";
import { T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

async function getActiveWorktreeId(window: import("@playwright/test").Page): Promise<string> {
  const res: any = await window.evaluate(() =>
    (window as any).__daintreeDispatchAction("actions.getContext")
  );
  return res?.result?.activeWorktreeId ?? "";
}

test.describe.serial("Core: Context Injection", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ withMultipleFiles: true });
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "context-test");

    // Wait for action dispatch hook to be available
    await expect
      .poll(
        async () => {
          return ctx.window.evaluate(() => {
            const dispatch = (window as any).__daintreeDispatchAction;
            return typeof dispatch === "function" ? "ready" : "no-hook";
          });
        },
        { timeout: T_MEDIUM, message: "Action dispatch hook not available" }
      )
      .toBe("ready");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("Copy Context button populates clipboard formats", async () => {
    const { app, window } = ctx;

    // Clear clipboard before testing to avoid false positives
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));

    const btn = window.getByRole("toolbar").locator('[aria-label="Copy Context"]');
    await expect(btn).toBeVisible({ timeout: T_MEDIUM });
    await btn.click();

    // Verify clipboard has content after copy
    await expect
      .poll(
        async () => {
          const formats = await app.evaluate(({ clipboard }) => clipboard.availableFormats());
          return formats.length;
        },
        { timeout: T_LONG, message: "Clipboard should have content after copy" }
      )
      .toBeGreaterThan(0);
  });

  test("generated content contains expected fixture files and excludes .git", async () => {
    const { window } = ctx;

    // Wait for active worktree ID to be available
    await expect
      .poll(async () => getActiveWorktreeId(window), {
        timeout: T_LONG,
        message: "Active worktree ID should be available",
      })
      .toBeTruthy();

    const wtId = await getActiveWorktreeId(window);

    // Generate content via the preload API
    const result: any = await window.evaluate(
      async (id: string) => (window as any).electron.copyTree.generate(id),
      wtId
    );

    expect(result?.error).toBeFalsy();
    expect(result?.content?.length).toBeGreaterThan(100);
    expect(result?.fileCount).toBe(4);

    // Verify expected fixture files are present
    const content = result.content as string;
    expect(content).toContain("index.ts");
    expect(content).toContain("utils.ts");
    expect(content).toContain("README.md");
    expect(content).toContain("package.json");

    // Verify .git directory is excluded
    expect(content).not.toContain(".git/");
    expect(content).not.toContain(".git\\");
  });

  test("injecting context writes content to terminal buffer", async () => {
    const { window } = ctx;

    const wtId = await getActiveWorktreeId(window);
    expect(wtId).toBeTruthy();

    // Open a terminal panel via toolbar and wait for it to appear
    const countBefore = await getGridPanelCount(window);
    await window.locator('[aria-label="Open Terminal"]').click();
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBeGreaterThan(countBefore);

    const panel = getFirstGridPanel(window);
    const panelId = await panel.evaluate((el) => {
      const p = el.closest("[data-panel-id]");
      return p?.getAttribute("data-panel-id") ?? "";
    });
    expect(panelId).toBeTruthy();

    // Inject context into terminal via preload API
    const injectResult: any = await window.evaluate(
      async (args: { terminalId: string; worktreeId: string }) => {
        return await (window as any).electron.copyTree.injectToTerminal(
          args.terminalId,
          args.worktreeId
        );
      },
      { terminalId: panelId, worktreeId: wtId }
    );

    expect(injectResult?.error).toBeFalsy();

    // Verify injected content appears in terminal buffer
    await waitForTerminalText(panel, "index.ts", T_LONG);
  });
});
