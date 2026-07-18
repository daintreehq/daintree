/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { mkdtempSync } from "fs";
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
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

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
// In-repo recipe ids are rewritten to opaque UUIDs at load time, so the
// runtime id is resolved by name via `recipe.list`.
const RECIPE_NAME = "Startup Restore Agent";

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

  fakeBinDir = path.join(fixtureDir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });

  const implName = process.platform === "win32" ? "claude.js" : "claude";
  const fakeClaude = path.join(fakeBinDir, implName);
  // Instant-boot fake agent: prints a banner, the READY token, and the
  // basename of its cwd (short enough to never wrap in xterm), then idles so
  // the PTY stays alive until app quit. The cwd line is what proves a
  // restored panel respawned its agent in the right worktree directory.
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      // One single write so READY and the cwd line cannot land in separate
      // chunks — keeps first-output a single observable event.
      `process.stdout.write('╭─ fake claude ─╮\\n' + ${JSON.stringify(READY_TOKEN)} + '\\nAGENT_CWD=' + require('path').basename(process.cwd()) + '\\n');`,
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const shutdown = () => { clearInterval(keepAlive); process.exit(0); };",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(fakeClaude, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  const recipesDir = path.join(fixtureDir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  writeFileSync(
    path.join(recipesDir, "startup-restore-agent.json"),
    JSON.stringify(
      {
        id: "inrepo-startup-restore-agent",
        name: RECIPE_NAME,
        terminals: [{ type: "claude", title: "Restore Agent" }],
        createdAt: 1700000000000,
        showInEmptyState: false,
      },
      null,
      2
    ) + "\n"
  );

  execSync("git add -A && git commit -m startup-agent-restore-fixture", {
    cwd: fixtureDir,
    stdio: "ignore",
  });

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

async function dispatchAction(page: AppContext["window"], id: string, args?: unknown) {
  return page.evaluate(
    async ({ id, args }) => {
      const dispatch = (window as any).__daintreeDispatchAction as
        | ((id: string, args?: unknown, opts?: unknown) => Promise<any>)
        | undefined;
      if (!dispatch) throw new Error("__daintreeDispatchAction missing");
      return dispatch(id, args, { source: "test" });
    },
    { id, args }
  );
}

interface TerminalSummary {
  id: string;
  worktreeId: string | null;
  agentId: string | null;
}

async function listTerminals(page: AppContext["window"]): Promise<TerminalSummary[]> {
  const r = await dispatchAction(page, "terminal.list");
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
  const r = await dispatchAction(page, "worktree.list");
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
  await dispatchAction(page, "worktree.select", { worktreeId });
  await expect
    .poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG })
    .toBe(expectedGridCount);
}

// Every visible grid panel must show the fake agent's READY token and the
// expected cwd basename — proof the agent process actually (re)launched in
// the worktree the panel claims to belong to.
async function expectVisibleAgents(
  page: AppContext["window"],
  count: number,
  cwdBasename: string
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const panel = page.locator(SEL.panel.gridPanel).nth(i);
    await waitForTerminalText(panel, READY_TOKEN, T_LONG * 2);
    await waitForTerminalText(panel, `AGENT_CWD=${cwdBasename}`, T_LONG);
  }
}

test.describe.serial("Startup: agent terminals across multiple worktrees", () => {
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
    fixtureCleanup?.();
  });

  test("agent terminals restore into their saved worktrees after a cold restart", async () => {
    test.slow();
    test.setTimeout(420_000);

    // ── Session 1: main + two worktrees, four fake agents spread across them ──
    ctx = await launchApp({ userDataDir, env: launchEnv() });
    let w = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Startup Agent Restore");

    // Recipes only load when recipe UI mounts — open and close the New
    // Worktree dialog once so `.daintree/recipes/*.json` is in the store.
    await dispatchAction(w, "worktree.createDialog.open");
    await expect(w.locator(SEL.worktree.newDialog)).toBeVisible({ timeout: T_LONG });
    await w.keyboard.press("Escape");
    await expect(w.locator(SEL.worktree.newDialog)).not.toBeVisible({ timeout: T_LONG });

    // Resolve the runtime recipe id by name (in-repo ids are rewritten to
    // opaque UUIDs at load time).
    const recipeId = await w.evaluate(async (name) => {
      const dispatch = (window as any).__daintreeDispatchAction;
      let last: unknown = null;
      for (let i = 0; i < 40; i++) {
        const r = await dispatch?.("recipe.list", {}, { source: "test" });
        last = r;
        const found = r?.ok ? (r.result?.recipes ?? []).find((x: any) => x.name === name) : null;
        if (found) return found.id as string;
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error(
        `recipe '${name}' never appeared in recipe.list; last=${JSON.stringify(last)}`
      );
    }, RECIPE_NAME);

    // Create the two extra worktrees.
    for (const branch of [BRANCH_A, BRANCH_B]) {
      const wtPath = await w.evaluate(
        ({ rootPath, branch }) =>
          (window as any).electron.worktree.getDefaultPath(rootPath, branch) as Promise<string>,
        { rootPath: fixtureDir, branch }
      );
      const created = await dispatchAction(w, "worktree.create", {
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
      await dispatchAction(w, "worktree.select", { worktreeId: wt.id });
      for (let i = 1; i <= agents; i++) {
        const before = await w.locator(SEL.panel.gridPanel).count();
        const ran = await dispatchAction(w, "recipe.run", { recipeId, worktreeId: wt.id });
        expect(ran?.ok, `recipe.run in ${wt.path}: ${ran?.error?.message ?? ""}`).toBe(true);
        await expect
          .poll(() => w.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG })
          .toBe(before + 1);
      }
      await expectVisibleAgents(w, agents, path.basename(wt.path));
    }

    // Snapshot the per-worktree panel distribution — this is what must
    // survive the restart. Sanity-check its shape first so the assertion
    // can't degrade into comparing two empty maps.
    const savedTerminals = await listTerminals(w);
    const savedCounts = countByWorktree(savedTerminals);
    expect(savedCounts.get(mainWt.id) ?? 0).toBeGreaterThanOrEqual(2);
    expect(savedCounts.get(wtA.id) ?? 0).toBeGreaterThanOrEqual(1);
    expect(savedCounts.get(wtB.id) ?? 0).toBeGreaterThanOrEqual(1);

    // Leave a non-main worktree active: the #11234 collapse re-homed every
    // panel onto the *active* worktree, so restarting with wt-alpha active
    // makes any regression change the distribution instead of no-opping.
    await selectWorktreeAndAwaitPanels(w, wtA.id, savedCounts.get(wtA.id) ?? 1);
    // Let the debounced panel/selection persistence flush before quitting.
    await w.waitForTimeout(T_SETTLE * 2);

    const pid1 = ctx.app.process().pid!;
    await closeApp(ctx.app);
    await waitForProcessExit(pid1);
    ctx = null;

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
    for (const { wt, agents } of plan.slice().reverse()) {
      await selectWorktreeAndAwaitPanels(w, wt.id, savedCounts.get(wt.id) ?? agents);
      await expectVisibleAgents(w, savedCounts.get(wt.id) ?? agents, path.basename(wt.path));
    }

    // Orphan cleanup (gated by #11235 on a trustworthy worktree list) must
    // not have killed anything after the workspace finished loading.
    await w.waitForTimeout(T_SETTLE * 2);
    expect((await listTerminals(w)).length).toBe(savedTerminals.length);
  });
});
