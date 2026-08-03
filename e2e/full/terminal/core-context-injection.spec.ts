/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  clickToolbarButton,
  getGridPanelCount,
  getGridPanelIds,
  getPanelById,
  openTerminal,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { waitForTerminalTextIgnoringLineBreaks } from "../../helpers/terminal";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

async function getActiveWorktreeId(window: import("@playwright/test").Page): Promise<string> {
  const res: any = await window.evaluate(() =>
    (window as any).__daintreeDispatchAction("actions.getContext")
  );
  return res?.result?.activeWorktreeId ?? "";
}

test.describe.serial("Core: Context Injection", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ withMultipleFiles: true });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
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
    fixtureCleanup?.();
  });

  test("Copy Context button populates clipboard formats", async () => {
    const { app, window } = ctx;

    // Clear clipboard before testing to avoid false positives
    await app.evaluate(({ clipboard }) => clipboard.writeText(""));

    await clickToolbarButton(window, SEL.toolbar.copyContext, T_MEDIUM);

    // The Copy Context button writes a *file reference* to the clipboard (the
    // generated context lives in a temp file), not the raw text — so readText()
    // is empty on darwin/linux. Assert that a clipboard format was actually
    // installed by the copy. See electron/ipc/handlers/copyTree.ts.
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

    // Generate via the preload API, opting in to the inline head — the default
    // now writes the bundle to a file and returns only its path (#11528).
    const result: any = await window.evaluate(
      async (id: string) => (window as any).electron.copyTree.generate(id, undefined, true),
      wtId
    );

    expect(result?.error).toBeFalsy();
    expect(result?.filePath).toBeTruthy();
    expect(result?.outputBytes).toBeGreaterThan(100);
    expect(result?.content?.length).toBeGreaterThan(100);
    expect(result?.fileCount).toBeGreaterThanOrEqual(4);

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
    const idsBefore = new Set(await getGridPanelIds(window));
    const countBefore = idsBefore.size;
    await openTerminal(window);
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBeGreaterThan(countBefore);

    const idsAfter = await getGridPanelIds(window);
    const panelId = idsAfter.find((id) => !idsBefore.has(id)) ?? "";
    expect(panelId).toBeTruthy();

    const panel = getPanelById(window, panelId);
    await expect
      .poll(
        async () => {
          const terminals = await window.evaluate(() =>
            (window as any).electron.terminal.getAllTerminals()
          );
          return terminals.some((terminal: { id: string }) => terminal.id === panelId);
        },
        { timeout: T_LONG, message: "Terminal should be registered before context injection" }
      )
      .toBe(true);

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
    await waitForTerminalTextIgnoringLineBreaks(panel, "index.ts", T_LONG);
  });
});
