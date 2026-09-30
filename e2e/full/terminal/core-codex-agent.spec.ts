import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  launchApp,
  closeApp,
  waitForProcessExit,
  waitForActiveProject,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { waitForTerminalText } from "../../helpers/terminal";
import { dispatchAction } from "../../helpers/actions";
import {
  FAKE_AGENT_READY,
  fakeAgentEnv,
  installFakeAgent,
  readFakeAgentLaunchLog,
  readFakeAgentStdinChunks,
  sendFakeAgentCommand,
  type FakeAgentLaunchRecord,
} from "../../helpers/fakeAgent";
import { getGridPanelIds, getPanelById } from "../../helpers/panels";
import { switchWorktree } from "../../helpers/workflows";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { getDescendantPids } from "../../helpers/stress";
import { SEL } from "../../helpers/selectors";
import { E2E_TEMP_PREFIX, recordTempDir } from "../../helpers/tempDirs";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";

// The first non-Claude agent through the whole registry path: a fake `codex`
// launched from the toolbar launcher is identified as Codex, its state follows
// the working row and prompt it paints (no OSC progress, which is the Claude
// fake's signal), its quit goes through Codex's gated Ctrl-C, and a cold
// restart respawns it with Codex's resume args in the worktree it ran in.

const BRANCH = "feature/codex-e2e";
const PROJECT_NAME = "Codex Agent";

let userDataDir: string;
let binRoot: string;
let codexBin: string;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let ctx: AppContext | null = null;

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

async function newPanelId(page: Page, previous: Set<string>): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await getGridPanelIds(page)).find((candidate) => !previous.has(candidate));
        return id !== undefined;
      },
      { timeout: T_LONG, intervals: [250] }
    )
    .toBe(true);
  return id!;
}

/** Everything the UI draws that says "this pane is Codex". */
async function expectCodexIdentity(page: Page, panelId: string): Promise<void> {
  const panel = getPanelById(page, panelId);
  await expect
    .poll(() => panel.getAttribute("data-detected-agent-id"), {
      timeout: 60_000,
      intervals: [250, 500],
      message: "runtime identity should resolve the running CLI to codex",
    })
    .toBe("codex");
  await expect(panel).toHaveAttribute("data-chrome-agent-id", "codex", { timeout: T_LONG });
  await expect(panel).toHaveAttribute("data-runtime-icon-id", "codex", { timeout: T_LONG });
  await expect(panel.locator('[data-terminal-icon-id="codex"]').first()).toBeVisible({
    timeout: T_LONG,
  });
  // The terminal pane hands its accessible name to the panel root.
  await expect(panel).toHaveAttribute("aria-label", /^Codex agent:/, { timeout: T_LONG });
}

test.describe.serial("Codex agent: identity, state and resume", () => {
  test.beforeAll(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), `${E2E_TEMP_PREFIX}codex-agent-`));
    recordTempDir(userDataDir);
    binRoot = mkdtempSync(path.join(tmpdir(), `${E2E_TEMP_PREFIX}codex-agent-bin-`));
    recordTempDir(binRoot);
    codexBin = installFakeAgent(binRoot, { identity: "codex", controlChannel: true });
    const fixture = createFixtureRepo({ name: "codex-agent" });
    fixtureDir = fixture.dir;
    fixtureCleanup = fixture.cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    removePathSync(binRoot);
    fixtureCleanup?.();
  });

  test("launcher-started Codex is detected, cycles working → waiting, and resumes after a restart", async () => {
    test.slow();
    test.setTimeout(300_000);

    // ── Session 1 ──
    ctx = await launchApp({ userDataDir, env: fakeAgentEnv(codexBin) });
    let w = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, PROJECT_NAME);

    const wtPath = await w.evaluate(
      ({ rootPath, branch }) =>
        (
          window as unknown as {
            electron: { worktree: { getDefaultPath(r: string, b: string): Promise<string> } };
          }
        ).electron.worktree.getDefaultPath(rootPath, branch),
      { rootPath: fixtureDir, branch: BRANCH }
    );
    const created = await dispatchAction(
      w,
      "worktree.create",
      { rootPath: fixtureDir, options: { baseBranch: "main", newBranch: BRANCH, path: wtPath } },
      { source: "test" }
    );
    expect(created.ok, JSON.stringify(created.ok ? "" : created.error)).toBe(true);
    await expect(w.locator(SEL.worktree.card(BRANCH)).first()).toBeVisible({ timeout: T_LONG });
    await switchWorktree(w, BRANCH);

    // The gesture under test: the toolbar launcher's Codex row.
    const before = new Set(await getGridPanelIds(w));
    await dismissBlockingPalette(w);
    await w.locator(SEL.agent.trayButton).click();
    await w.locator(SEL.agent.launcherRow("Codex")).first().click();
    const panelId = await newPanelId(w, before);
    const panel = getPanelById(w, panelId);
    await expect(panel).toHaveAttribute("data-launch-agent-id", "codex", { timeout: T_LONG });

    await waitForTerminalText(panel, FAKE_AGENT_READY, T_LONG);
    await waitForTerminalText(panel, "OpenAI Codex", T_LONG);
    await expectCodexIdentity(w, panelId);

    const firstLaunches = readFakeAgentLaunchLog(codexBin);
    const firstLaunch = firstLaunches.find((l) => l.paneId === panelId);
    const firstDetail = `launches=${JSON.stringify(firstLaunches)}`;
    expect(firstLaunch, firstDetail).toBeDefined();
    expect(firstLaunch!.identity, firstDetail).toBe("codex");
    expect(realPath(firstLaunch!.cwd), firstDetail).toBe(realPath(wtPath));
    expect(firstLaunch!.argv, firstDetail).not.toContain("resume");

    // Working and waiting come only from what the fake paints: Codex's
    // `• Working (Ns • esc to interrupt)` row, then its prompt. Boot output
    // reads as working too, so the pane has to settle at its prompt first or
    // the working check could be satisfied by the banner alone.
    await expect(panel).toHaveAttribute("data-agent-state", "waiting", { timeout: T_LONG * 2 });
    await sendFakeAgentCommand(codexBin, "work");
    await waitForTerminalText(panel, "esc to interrupt", T_LONG);
    await expect(panel).toHaveAttribute("data-agent-state", "working", { timeout: T_LONG });
    await expect(panel.locator('[role="status"][aria-label="Agent state: working"]')).toBeVisible();
    await sendFakeAgentCommand(codexBin, "idle");
    await expect(panel).toHaveAttribute("data-agent-state", "waiting", { timeout: T_LONG * 2 });
    await expect(panel.locator('[role="status"][aria-label="Agent state: waiting"]')).toBeVisible();

    // timer: PanelPersistence debounceMs (500ms) flush before quit
    await w.waitForTimeout(T_SETTLE * 2);

    // The real quit path, which must finish its shutdown chain on its own.
    const stdinBeforeQuit = readFakeAgentStdinChunks(codexBin).length;
    const pid1 = ctx.app.process().pid!;
    const session1Descendants = getDescendantPids(pid1);
    const mainProcess = ctx.app.process();
    const exitCode = new Promise<number | null>((resolve) =>
      mainProcess.once("exit", (code) => resolve(code))
    );
    await ctx.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await waitForProcessExit(pid1, 60_000);
    expect(await exitCode, "quit should finish its shutdown chain cleanly").toBe(0);
    for (const child of session1Descendants) {
      try {
        process.kill(child, "SIGKILL");
      } catch {
        // Already gone with its parent.
      }
    }
    await closeApp(ctx.app).catch(() => undefined);
    ctx = null;

    // Codex quits on a gated Ctrl-C, not a slash command typed into its composer.
    const quitInput = readFakeAgentStdinChunks(codexBin)
      .slice(stdinBeforeQuit)
      .map((c) => c.data)
      .join("");
    // Two presses: the second only after the fake painted Codex's "again to
    // quit" gate. One press followed by a forced kill would also exit cleanly.
    expect(
      quitInput.split("\u0003").length - 1,
      `teardown should reach Codex as two gated Ctrl-C presses: ${JSON.stringify(quitInput)}`
    ).toBe(2);
    expect(quitInput).not.toContain("/quit");
    const session1LaunchCount = readFakeAgentLaunchLog(codexBin).length;
    // The fake reads its control file from the start, so the respawn would
    // otherwise replay this session's work/idle.
    writeFileSync(path.join(codexBin, "control.in"), "");

    // ── Session 2: cold restart on the same userData ──
    ctx = await launchApp({ userDataDir, env: fakeAgentEnv(codexBin) });
    w = await waitForActiveProject(ctx.app, ctx.window, path.basename(fixtureDir));

    const relaunches = (): FakeAgentLaunchRecord[] =>
      readFakeAgentLaunchLog(codexBin).slice(session1LaunchCount);
    await expect
      .poll(() => relaunches().some((l) => l.paneId === panelId), {
        timeout: T_LONG * 3,
        message: `pane ${panelId} should respawn its Codex CLI after the restart`,
      })
      .toBe(true);
    const relaunch = relaunches().find((l) => l.paneId === panelId)!;
    const detail = `relaunch=${JSON.stringify(relaunch)}`;
    expect(relaunch.identity, detail).toBe("codex");
    // The fake never prints Codex's `codex resume <id>` footer and has no
    // session index, so there is no id to name: the respawn takes Codex's
    // resume-latest form.
    const resumeAt = relaunch.argv.indexOf("resume");
    expect(resumeAt, detail).toBeGreaterThanOrEqual(0);
    expect(relaunch.argv.slice(resumeAt, resumeAt + 2), detail).toEqual(["resume", "--last"]);
    expect(realPath(relaunch.cwd), detail).toBe(realPath(wtPath));

    await switchWorktree(w, BRANCH);
    const restored = getPanelById(w, panelId);
    await expect(restored).toBeVisible({ timeout: T_LONG });
    await waitForTerminalText(restored, FAKE_AGENT_READY, T_LONG);
    await expectCodexIdentity(w, panelId);
  });
});
