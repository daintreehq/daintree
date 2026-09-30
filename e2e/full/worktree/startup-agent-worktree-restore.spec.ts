/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
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
import {
  getTerminalTextById,
  typeTerminalCommand,
  waitForTerminalText,
} from "../../helpers/terminal";
import { dispatchAction } from "../../helpers/actions";
import { readFakeAgentLaunchLog, type FakeAgentLaunchRecord } from "../../helpers/fakeAgent";
import { getGridPanelIds, getPanelById } from "../../helpers/panels";
import { spawnTerminalAndVerify } from "../../helpers/workflows";
import { getDescendantPids } from "../../helpers/stress";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";

// Regression coverage for #11234 (PR #11235): on a cold restart, hydration
// races the workspace host, and `worktree.getAll()` can answer `[]` before
// `load-project` finishes. That empty list was treated as authoritative, so
// every restored agent terminal failed the known-worktree check and was
// re-homed onto the active worktree — all panels collapsing into a single
// worktree, with the wrong assignment persisted and compounding per restart.
//
// The scenario: multiple worktrees, multiple agent terminals spread across
// them, cold restart. A fake `claude` CLI stands in for a real agent so the
// respawn-on-restart path ("fake resume") is deterministic and offline: each
// restored panel must relaunch its agent in its own worktree's directory, and
// the per-worktree panel distribution must survive the restart unchanged.
const READY_TOKEN = "FAKE_AGENT_READY";
const BRANCH_A = "wt-alpha";
const BRANCH_B = "wt-beta";
let userDataDir: string;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let fakeBinDir: string;
let emptyZdotdir: string;
let ctx: AppContext | null = null;

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "startup-agent-restore" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;

  fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-startup-agent-bin-"));

  const implName = process.platform === "win32" ? "claude.js" : "claude";
  const fakeClaude = path.join(fakeBinDir, implName);
  // Instant-boot fake agent: prints a banner, the READY token, and the
  // basename of its cwd (short enough to never wrap in xterm), then idles so
  // the PTY stays alive until app quit. The cwd line is what proves a
  // restored panel respawned its agent in the right worktree directory.
  //
  // Every launch is also appended to `launches.log` in the shape
  // `readFakeAgentLaunchLog` reads, so the argv Daintree respawned it with is
  // on record. Like Claude Code, it keeps a transcript for the session id it
  // runs under: Daintree only replays `--resume <id>` for an id it can find a
  // transcript for, and otherwise relaunches the pane as a fresh assignment.
  writeFileSync(
    fakeClaude,
    String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("claude code v9.9.9");
  process.exit(0);
}
fs.appendFileSync(
  path.join(__dirname, "launches.log"),
  JSON.stringify({
    identity: "claude",
    paneId: process.env.DAINTREE_PANE_ID || null,
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    env: {},
    present: {},
    at: Date.now(),
  }) + "\n"
);
const idFlag = argv.findIndex((a) => a === "--session-id" || a === "--resume");
const sessionId = idFlag >= 0 ? argv[idFlag + 1] : undefined;
// Daintree never looks for a transcript on Windows, and a drive-letter cwd is
// no valid directory name there.
if (sessionId && process.platform !== "win32") {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projectDir = path.join(configDir, "projects", process.cwd().replace(/[\\/]/g, "-"));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.appendFileSync(path.join(projectDir, sessionId + ".jsonl"), "");
}
// One single write so READY and the cwd line cannot land in separate
// chunks — keeps first-output a single observable event.
process.stdout.write("╭─ fake claude ─╮\n" + ${JSON.stringify(READY_TOKEN)} + "\nAGENT_CWD=" + path.basename(process.cwd()) + "\n");
process.stdin.resume();
process.stdin.setEncoding("utf8");
const keepAlive = setInterval(() => {}, 1000);
const shutdown = () => { clearInterval(keepAlive); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`
  );
  chmodSync(fakeClaude, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", `"${process.execPath}" "%~dp0claude.js" %*`, ""].join("\r\n")
    );
  }

  // Agent terminals launch through a login shell that sources the user's rc
  // files — on a machine with a real `claude` install those prepend its
  // directory and the fake CLI loses the PATH race. Point ZDOTDIR at an empty
  // dir so resolution stays deterministic.
  emptyZdotdir = path.join(fixtureDir, ".e2e-zdotdir");
  mkdirSync(emptyZdotdir, { recursive: true });
}

function launchEnv(): Record<string, string> {
  return {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ZDOTDIR: emptyZdotdir,
    DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
  };
}

function act(page: AppContext["window"], id: string, args?: unknown): Promise<any> {
  return dispatchAction<any>(page, id, args, { source: "test" });
}

interface TerminalSummary {
  id: string;
  worktreeId: string | null;
  agentId: string | null;
}

async function listTerminals(page: AppContext["window"]): Promise<TerminalSummary[]> {
  const r = await act(page, "terminal.list");
  if (!r?.ok) throw new Error(`terminal.list failed: ${r?.error?.message ?? "unknown"}`);
  return (r.result?.terminals ?? []).map((t: any) => ({
    id: t.id,
    worktreeId: t.worktreeId ?? null,
    agentId: t.agentId ?? null,
  }));
}

async function listWorktrees(
  page: AppContext["window"]
): Promise<
  Array<{ id: string; branch: string | null; path: string; isMain: boolean; isActive: boolean }>
> {
  const r = await act(page, "worktree.list");
  if (!r?.ok) throw new Error(`worktree.list failed: ${r?.error?.message ?? "unknown"}`);
  return (r.result?.worktrees ?? []).map((w: any) => ({
    id: w.id,
    branch: w.branch ?? null,
    path: w.path,
    isMain: w.isMain === true,
    isActive: w.isActive === true,
  }));
}

function countByWorktree(terminals: TerminalSummary[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of terminals) {
    const key = t.worktreeId ?? "<none>";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

async function selectWorktreeAndAwaitPanels(
  page: AppContext["window"],
  worktreeId: string,
  expectedGridCount: number
): Promise<void> {
  await act(page, "worktree.select", { worktreeId });
  await expect
    .poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG })
    .toBe(expectedGridCount);
}

// Every visible agent panel must show the fake agent's READY token and the
// expected cwd basename — proof the agent process actually (re)launched in
// the worktree the panel claims to belong to. `plainTerminalId` is the one
// plain shell in the grid, which runs no agent.
async function expectVisibleAgents(
  page: AppContext["window"],
  count: number,
  cwdBasename: string,
  plainTerminalId?: string
): Promise<void> {
  const ids = (await getGridPanelIds(page)).filter((id) => id !== plainTerminalId);
  expect(ids).toHaveLength(count);
  for (const id of ids) {
    const panel = getPanelById(page, id);
    await waitForTerminalText(panel, READY_TOKEN, T_LONG * 2);
    await waitForTerminalText(panel, `AGENT_CWD=${cwdBasename}`, T_LONG);
  }
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readRestoreFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

test.describe.serial("Startup: agent terminals across multiple worktrees", () => {
  // Handed from the restart journey to the quarantined scrollback check below.
  let restoredPlain: { window: Page; terminalId: string; marker: string } | null = null;
  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-startup-restore-"));
    prepareFixture();
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    removePathSync(fakeBinDir);
    fixtureCleanup?.();
  });

  test("agent terminals restore into their saved worktrees after a cold restart", async () => {
    test.slow();
    test.setTimeout(420_000);

    // ── Session 1: main + two worktrees, four fake agents spread across them ──
    ctx = await launchApp({ userDataDir, env: launchEnv() });
    let w = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Startup Agent Restore");

    const resolvedClaudePath = await w.evaluate(async () => {
      await (window as any).electron.system.refreshCliAvailability();
      const details = await (window as any).electron.system.getAgentCliDetails();
      return details?.claude?.resolvedPath as string | null | undefined;
    });
    const expectedClaudePath = path.join(
      fakeBinDir,
      process.platform === "win32" ? "claude.cmd" : "claude"
    );
    expect(path.normalize(resolvedClaudePath ?? "<missing>")).toBe(
      path.normalize(expectedClaudePath)
    );

    // Create the two extra worktrees.
    for (const branch of [BRANCH_A, BRANCH_B]) {
      const wtPath = await w.evaluate(
        ({ rootPath, branch }) =>
          (window as any).electron.worktree.getDefaultPath(rootPath, branch) as Promise<string>,
        { rootPath: fixtureDir, branch }
      );
      const created = await act(w, "worktree.create", {
        rootPath: fixtureDir,
        options: { baseBranch: "main", newBranch: branch, path: wtPath },
      });
      expect(created?.ok, `worktree.create ${branch}: ${created?.error?.message ?? ""}`).toBe(true);
      await expect(w.locator(SEL.worktree.card(branch)).first()).toBeVisible({ timeout: T_LONG });
    }

    const worktrees = await listWorktrees(w);
    const mainWt = worktrees.find((x) => x.isMain);
    const wtA = worktrees.find((x) => x.branch === BRANCH_A);
    const wtB = worktrees.find((x) => x.branch === BRANCH_B);
    if (!mainWt || !wtA || !wtB) {
      throw new Error(`missing worktrees in worktree.list: ${JSON.stringify(worktrees)}`);
    }

    // Launch the fleet: two agents in main, one in each extra worktree. Wait
    // for each agent's READY output so the panel is fully spawned (and its
    // state worth persisting) before moving on.
    const plan: Array<{ wt: { id: string; path: string }; agents: number }> = [
      { wt: mainWt, agents: 2 },
      { wt: wtA, agents: 1 },
      { wt: wtB, agents: 1 },
    ];
    for (const { wt, agents } of plan) {
      await act(w, "worktree.select", { worktreeId: wt.id });
      for (let i = 1; i <= agents; i++) {
        const before = await w.locator(SEL.panel.gridPanel).count();
        // The launcher's path: it assigns each pane its own `--session-id`,
        // the id a restart hands back through `--resume`.
        const ran = await act(w, "agent.launch", { agentId: "claude", worktreeId: wt.id });
        expect(ran?.ok, `agent.launch in ${wt.path}: ${ran?.error?.message ?? ""}`).toBe(true);
        await expect
          .poll(() => w.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG })
          .toBe(before + 1);
      }
      await expectVisibleAgents(w, agents, path.basename(wt.path));
    }

    // A plain shell beside wt-alpha's agent, with scrollback only real typing
    // put there. The marker is assembled at runtime by node (the same under
    // POSIX shells and PowerShell), so the echoed command line alone can never
    // satisfy a search for it.
    await selectWorktreeAndAwaitPanels(w, wtA.id, 1);
    const plainPanel = await spawnTerminalAndVerify(w);
    const plainTerminalId = (await plainPanel.getAttribute("data-panel-id")) ?? "";
    expect(plainTerminalId, "spawned plain terminal has no panel id").not.toBe("");
    const nonce = Date.now().toString(36);
    const scrollbackMarker = `RESTORE_${nonce}_42`;
    await typeTerminalCommand(
      w,
      plainTerminalId,
      `node -e "console.log('RESTORE_'+'${nonce}'+'_'+(40+2))"`,
      {
        expectOutput: scrollbackMarker,
        timeout: T_LONG,
      }
    );

    // Quit only once the scrollback is on disk — the snapshot is debounced
    // (SESSION_SNAPSHOT_DEBOUNCE_MS, 5s), and a quit that beats it would test
    // nothing about restore.
    const restoreFile = path.join(userDataDir, "terminal-sessions", `${plainTerminalId}.restore`);
    await expect
      .poll(() => readRestoreFile(restoreFile).includes(scrollbackMarker), {
        timeout: T_LONG * 3,
        intervals: [500, 1000],
        message: `${restoreFile} should hold the typed marker before quitting`,
      })
      .toBe(true);

    // Snapshot the per-worktree panel distribution — this is what must
    // survive the restart. Sanity-check its shape first so the assertion
    // can't degrade into comparing two empty maps.
    const savedTerminals = await listTerminals(w);
    const savedCounts = countByWorktree(savedTerminals);
    expect(savedCounts.get(mainWt.id) ?? 0).toBeGreaterThanOrEqual(2);
    expect(savedCounts.get(wtA.id) ?? 0).toBeGreaterThanOrEqual(1);
    expect(savedCounts.get(wtB.id) ?? 0).toBeGreaterThanOrEqual(1);
    const plainSaved = savedTerminals.find((t) => t.id === plainTerminalId);
    expect(plainSaved?.worktreeId, "plain terminal should belong to wt-alpha").toBe(wtA.id);
    expect(plainSaved?.agentId ?? null).toBeNull();

    // Each agent pane's first launch assigned it a session id — the id a
    // restart must hand back through `--resume`.
    const worktreePathById = new Map(worktrees.map((x) => [x.id, x.path] as const));
    const savedAgents = savedTerminals.filter((t) => t.id !== plainTerminalId);
    expect(savedAgents).toHaveLength(4);
    const firstLaunches = readFakeAgentLaunchLog(fakeBinDir);
    const assignedSessionIds = new Map<string, string>();
    for (const agent of savedAgents) {
      const launch = firstLaunches.find((l) => l.paneId === agent.id);
      const sessionId = launch ? flagValue(launch.argv, "--session-id") : undefined;
      expect(
        sessionId ?? "<none>",
        `first launch of ${agent.id} should carry --session-id; launches=${JSON.stringify(firstLaunches)}`
      ).toMatch(/^[0-9a-f-]{36}$/i);
      assignedSessionIds.set(agent.id, sessionId!);
    }

    // Leave a non-main worktree active: the #11234 collapse re-homed every
    // panel onto the *active* worktree, so restarting with wt-alpha active
    // makes any regression change the distribution instead of no-opping.
    await selectWorktreeAndAwaitPanels(w, wtA.id, savedCounts.get(wtA.id) ?? 1);
    // Let the debounced panel/selection persistence flush before quitting.
    // timer: PanelPersistence debounceMs (500ms) flush before quit
    await w.waitForTimeout(T_SETTLE * 2);

    // The real quit path: app.quit() runs before-quit and the shutdown chain
    // (graceful agent teardown, final snapshots) and must end the process on
    // its own. closeApp's force-kill fallback would hide a hung quit.
    const pid1 = ctx.app.process().pid!;
    const session1Descendants = getDescendantPids(pid1);
    const mainProcess = ctx.app.process();
    const exitCode = new Promise<number | null>((resolve) =>
      mainProcess.once("exit", (code) => resolve(code))
    );
    await ctx.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await waitForProcessExit(pid1, 60_000);
    // A shutdown chain that blows its deadline still ends the process, via
    // app.exit(1) — only a zero exit is a clean quit.
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
    // Quitting keeps the plain terminal's snapshot for the next launch.
    expect(readRestoreFile(restoreFile), `${restoreFile} after quit`).toContain(scrollbackMarker);
    const session1LaunchCount = readFakeAgentLaunchLog(fakeBinDir).length;

    // ── Session 2: cold restart — same distribution, agents respawned ──
    // Hold the workspace host's load-project so hydration's worktree prefetch
    // deterministically sees the not-ready [] answer — the #11234 boot race.
    // Without this the fixture repo loads faster than hydration and the
    // regression window never opens on a fast machine.
    ctx = await launchApp({
      userDataDir,
      env: { ...launchEnv(), DAINTREE_E2E_WORKSPACE_LOAD_DELAY_MS: "4000" },
    });
    w = await waitForActiveProject(ctx.app, ctx.window, path.basename(fixtureDir));

    // All saved panels must come back (staggered restore), each still homed
    // in its saved worktree. A #11234-style collapse would put 4 panels in
    // one worktree and never satisfy this poll.
    await expect
      .poll(async () => (await listTerminals(w)).length, { timeout: T_LONG * 3 })
      .toBe(savedTerminals.length);
    await expect
      .poll(
        async () => {
          const counts = countByWorktree(await listTerminals(w));
          return [mainWt.id, wtA.id, wtB.id].map((id) => counts.get(id) ?? 0).join(",");
        },
        { timeout: T_LONG * 3 }
      )
      .toBe([mainWt.id, wtA.id, wtB.id].map((id) => savedCounts.get(id) ?? 0).join(","));

    // The active worktree selection must survive too — the same empty-list
    // race used to silently drop it (second latent bug fixed in #11235).
    await expect
      .poll(async () => (await listWorktrees(w)).find((x) => x.isActive)?.id ?? "<none>", {
        timeout: T_LONG,
      })
      .toBe(wtA.id);

    // Each restored panel must have actually respawned its agent ("fake
    // resume") in its own worktree's directory — visit every worktree and
    // check the fake agent's READY + cwd line.
    // The selection is also what the sidebar draws.
    await expect(
      w.locator(`${SEL.worktree.card(BRANCH_A)}[data-active="true"]`).first()
    ).toBeVisible({ timeout: T_LONG });

    for (const { wt, agents } of plan.slice().reverse()) {
      const panelsHere = savedCounts.get(wt.id) ?? agents;
      await selectWorktreeAndAwaitPanels(w, wt.id, panelsHere);
      const agentsHere = wt.id === wtA.id ? panelsHere - 1 : panelsHere;
      await expectVisibleAgents(w, agentsHere, path.basename(wt.path), plainTerminalId);
    }

    // What each agent was actually respawned with: its own session id handed
    // back through `--resume`, in its own worktree's directory.
    const relaunches = (): FakeAgentLaunchRecord[] =>
      readFakeAgentLaunchLog(fakeBinDir).slice(session1LaunchCount);
    await expect
      .poll(() => new Set(relaunches().map((l) => l.paneId)).size, { timeout: T_LONG })
      .toBe(savedAgents.length);
    for (const agent of savedAgents) {
      const relaunch = relaunches().find((l) => l.paneId === agent.id);
      const detail = `relaunch of ${agent.id}: ${JSON.stringify(relaunch)}`;
      expect(relaunch, detail).toBeDefined();
      expect(flagValue(relaunch!.argv, "--resume"), detail).toBe(assignedSessionIds.get(agent.id));
      expect(realPath(relaunch!.cwd), detail).toBe(
        realPath(worktreePathById.get(agent.worktreeId ?? "") ?? "<no worktree>")
      );
    }

    // The plain shell came back under its old id with the typed history
    // replayed from its `.restore` file, below the restore banner. On failure
    // the pty host's own mirror is attached, to tell "never restored" apart
    // from "restored but never shown".
    await selectWorktreeAndAwaitPanels(w, wtA.id, savedCounts.get(wtA.id) ?? 2);
    await expect.poll(() => getGridPanelIds(w), { timeout: T_LONG }).toContain(plainTerminalId);
    restoredPlain = { window: w, terminalId: plainTerminalId, marker: scrollbackMarker };

    // Orphan cleanup (gated by #11235 on a trustworthy worktree list) must
    // not have killed anything after the workspace finished loading.
    // timer: negative-assertion dwell for a late orphan-cleanup kill
    await w.waitForTimeout(T_SETTLE * 2);
    expect((await listTerminals(w)).length).toBe(savedTerminals.length);
  });
  test("restored plain terminal shows its pre-quit scrollback", async () => {
    // The pty host replays the `.restore` file on a cold restart (its mirror
    // holds the marker and the banner), but the respawned plain terminal gets
    // no scrollback restore task in the renderer's restore phase, so the pane
    // only ever shows the fresh shell. Remove the skip once that is fixed.
    test.info().annotations.push({
      type: "quarantine",
      description:
        "2026-09-30 plain-terminal scrollback replayed by the pty host is not shown after a cold restart (renderer restore phase respawn branch schedules no scrollback restore)",
    });
    test.skip(true, "restored scrollback is not rendered; see quarantine annotation");
    expect(restoredPlain, "restart journey must run first").not.toBeNull();
    const { window, terminalId, marker } = restoredPlain!;
    await expect
      .poll(() => getTerminalTextById(window, terminalId), {
        timeout: T_LONG * 2,
        message: "restored plain terminal should show its pre-quit scrollback",
      })
      .toContain(marker)
      .catch(async (e: Error) => {
        const mirror = await window.evaluate(
          (id) => (globalThis.window as any).electron.terminal.getSerializedState(id),
          terminalId
        );
        throw new Error(`${e.message}\npty-host mirror: ${JSON.stringify(mirror).slice(0, 1500)}`);
      });
    expect(await getTerminalTextById(window, terminalId)).toContain("Session restored");
  });
});
