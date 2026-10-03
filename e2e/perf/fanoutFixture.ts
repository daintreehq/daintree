/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { tmpdir } from "os";
import { launchApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { T_LONG } from "../helpers/timeouts";

// Fixture and session setup shared by store-fanout-perf and
// background-energy-perf: a repo with (scale-1) sibling worktrees, one fake
// claude per worktree, the main worktree's agent visible in the grid, and the
// render-probe accessors both harnesses sample.

export const READY_TOKEN = "FAKE_CLAUDE_READY";
export const WORK_TOKEN = "__DAINTREE_FAKE_WORK__";
export const IDLE_TOKEN = "__DAINTREE_FAKE_IDLE__";
export const TITLE_TOKEN = "__DAINTREE_FAKE_TITLE__";

export interface EventSample {
  /** commits observed in the event window */
  commits: number;
  /** component fibers rendered across those commits */
  renders: number;
  /** total self render ms across those commits */
  selfMs: number;
  /** per-component rollup for the window */
  byComponent: Record<string, { n: number; ms: number }>;
  /** wall ms from trigger to last attributed commit (diagnostic) */
  windowMs: number;
}

export interface ProbeCommit {
  t: number;
  renders: number;
  selfMs: number;
  byComponent: any;
}

// Attribute captured commits to [t0, t1] windows on the page clock.
export function collectWindow(commits: ProbeCommit[], t0: number, t1: number): EventSample {
  const inWindow = commits.filter((c) => c.t >= t0 && c.t <= t1);
  const byComponent: Record<string, { n: number; ms: number }> = {};
  for (const c of inWindow) {
    for (const [name, v] of Object.entries(
      c.byComponent as Record<string, { n: number; ms: number }>
    )) {
      const entry = (byComponent[name] ??= { n: 0, ms: 0 });
      entry.n += v.n;
      entry.ms += v.ms;
    }
  }
  const last = inWindow.length > 0 ? inWindow[inWindow.length - 1].t : t0;
  return {
    commits: inWindow.length,
    renders: inWindow.reduce((a, c) => a + c.renders, 0),
    selfMs: inWindow.reduce((a, c) => a + c.selfMs, 0),
    byComponent,
    windowMs: last - t0,
  };
}

export function topComponents(
  events: EventSample[],
  limit = 12
): Array<{ name: string; n: number; ms: number }> {
  const merged = new Map<string, { n: number; ms: number }>();
  for (const e of events) {
    for (const [name, v] of Object.entries(e.byComponent)) {
      const entry = merged.get(name) ?? { n: 0, ms: 0 };
      entry.n += v.n;
      entry.ms += v.ms;
      merged.set(name, entry);
    }
  }
  return [...merged.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

export interface Fixture {
  dir: string;
  worktreeDirs: string[];
  fakeBinDir: string;
  cleanup: () => void;
}

// Fresh repo + (scale-1) sibling git worktrees + a fake `claude` CLI that
// boots instantly (no trust prompt) and flips working/idle on stdin tokens.
// The OSC 9;4 heartbeat drives the working state viewport-independently
// (#8753); WORK mode also streams a short line every `streamMs` (150 by default), which exercises
// terminal output but not panelStatusBuffer (see the activity workload).
export function prepareFixture(scale: number, streamMs = 150): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), `daintree-e2e-store-fanout-${scale}-`));
  try {
    return buildFixture(scale, dir, streamMs);
  } catch (error) {
    // A failed git/chmod step would otherwise leak the temp repo and the
    // sibling worktree root.
    rmSync(path.join(path.dirname(dir), path.basename(dir) + "-worktrees"), {
      recursive: true,
      force: true,
    });
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function buildFixture(scale: number, dir: string, streamMs: number): Fixture {
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), `# store-fanout-${scale}\n`);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `store-fanout-${scale}`, version: "1.0.0", private: true }, null, 2) +
      "\n"
  );

  const fakeBinDir = path.join(dir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  const implName = process.platform === "win32" ? "claude.js" : "claude";
  writeFileSync(
    path.join(fakeBinDir, implName),
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      `const WORK = ${JSON.stringify(WORK_TOKEN)};`,
      `const IDLE = ${JSON.stringify(IDLE_TOKEN)};`,
      "const OSC_WORKING = '\\u001b]9;4;1;0\\u0007';",
      "const OSC_IDLE = '\\u001b]9;4;0;0\\u0007';",
      `process.stdout.write('╭─ fake claude ─╮\\n│ fanout bench │\\n╰──────────────╯\\n' + ${JSON.stringify(READY_TOKEN)} + '\\n');`,
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "let oscTimer = null;",
      "let streamTimer = null;",
      "let tick = 0;",
      "const startWork = () => {",
      "  if (oscTimer) return;",
      "  process.stdout.write(OSC_WORKING);",
      "  oscTimer = setInterval(() => process.stdout.write(OSC_WORKING), 1000);",
      "  streamTimer = setInterval(() => {",
      "    tick++;",
      "    process.stdout.write('working... step ' + tick + '\\n');",
      `  }, ${streamMs});`,
      "};",
      "const stopWork = () => {",
      "  if (oscTimer) { clearInterval(oscTimer); oscTimer = null; }",
      "  if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }",
      "  process.stdout.write(OSC_IDLE);",
      "};",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const shutdown = () => { stopWork(); clearInterval(keepAlive); process.exit(0); };",
      `const TITLE = ${JSON.stringify(TITLE_TOKEN)};`,
      "process.stdin.on('data', (chunk) => {",
      "  const input = String(chunk);",
      "  const ti = input.lastIndexOf(TITLE);",
      "  if (ti >= 0) {",
      "    const text = input.slice(ti + TITLE.length).split(/[\\r\\n]/)[0];",
      "    process.stdout.write('\\u001b]0;' + text + '\\u0007');",
      "  }",
      "  const wi = input.lastIndexOf(WORK);",
      "  const ii = input.lastIndexOf(IDLE);",
      "  if (wi >= 0 && wi > ii) startWork();",
      "  else if (ii >= 0) stopWork();",
      "});",
      "process.stdin.on('end', shutdown);",
      "process.stdin.on('close', shutdown);",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(path.join(fakeBinDir, implName), 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  git("add -A", dir);
  git('commit -m "store-fanout fixture"', dir);

  const worktreeRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const worktreeDirs: string[] = [];
  for (let i = 1; i < scale; i++) {
    const branch = `wt-${String(i).padStart(2, "0")}`;
    const wtDir = path.join(worktreeRoot, branch);
    git(`worktree add -b ${branch} ${JSON.stringify(wtDir)} main`, dir);
    worktreeDirs.push(wtDir);
  }

  const cleanup = () => {
    try {
      rmSync(worktreeRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  return { dir, worktreeDirs, fakeBinDir, cleanup };
}

// enableWebgl keeps the GPU process out-of-process (and matches production
// rendering). The local-macOS default of --disable-gpu --in-process-gpu makes a
// compositor fault under sustained terminal streaming fatal to the whole app —
// observed as a mid-flip "graceful shutdown" cascade that killed the measured view.
export function launchFanoutApp(fixture: Fixture): Promise<AppContext> {
  return launchApp({
    enableWebgl: true,
    env: {
      PATH: `${fixture.fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      DAINTREE_CLI_PATH_PREPEND: fixture.fakeBinDir,
      DAINTREE_IDENTITY_DEBUG_PASS: "1",
    },
  });
}

export interface FanoutWorktree {
  id: string;
  path: string;
  isMain: boolean;
}

export interface FanoutSession {
  page: Page;
  probeInstalled: boolean;
  worktrees: FanoutWorktree[];
  mainWt: FanoutWorktree;
  /** Terminal id of each worktree's agent, in `worktrees` order. */
  launched: string[];
  gridPanel: Locator;
  flipPanelId: string;
  probeStart: () => Promise<unknown>;
  probeStop: () => Promise<any>;
  assertNoReload: (where: string) => Promise<void>;
}

export interface FanoutSessionOptions {
  projectName: string;
  requireProbe: boolean;
  /** Runs after the settle and before the first agent launch. */
  beforeAgentLaunch?: (page: Page) => Promise<void>;
}

export async function startFanoutSession(
  ctx: AppContext,
  scale: number,
  fixture: Fixture,
  options: FanoutSessionOptions
): Promise<FanoutSession> {
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, options.projectName);
  const page = ctx.window;

  // The probe only exists in bench builds — fail loudly unless the caller is
  // deliberately measuring a production bundle.
  const probeState = await page.evaluate(() => {
    const probe = (window as any).__DAINTREE_RENDER_PROBE__;
    return { installed: !!probe?.installed };
  });
  if (options.requireProbe)
    expect(
      probeState.installed,
      "render probe missing — build with `npm run build:e2e:bench` first"
    ).toBe(true);

  // All worktrees discovered by the workspace scan.
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const all = await (window as any).electron.worktree.getAll();
          return Array.isArray(all) ? all.length : 0;
        }),
      { timeout: 120_000, intervals: [500, 1000] }
    )
    .toBeGreaterThanOrEqual(scale);

  const worktrees: FanoutWorktree[] = await page.evaluate(async () => {
    const all = await (window as any).electron.worktree.getAll();
    return all.map((w: any) => ({
      id: w.id,
      path: w.path,
      isMain: !!(w.isMain ?? w.isMainWorktree),
    }));
  });
  expect(worktrees.length).toBeGreaterThanOrEqual(scale);
  const mainWt = worktrees.find((w) => w.isMain) ?? worktrees[0];

  // Let post-onboarding work (availability probes, pool warmup) settle
  // before the first launch — `agent.launch` returns null while the
  // fake claude hasn't been probed as installed yet.
  await page.waitForTimeout(3_000);

  if (options.beforeAgentLaunch) await options.beforeAgentLaunch(page);

  // One fake agent per worktree. Launches beyond the spawn token bucket
  // (6) queue at 1/s — dispatch sequentially and let the queue drain.
  // Retried because the very first dispatch can race the availability
  // probe on slow starts.
  const launched: string[] = [];
  for (const wt of worktrees.slice(0, scale)) {
    let terminalId: string | null = null;
    for (let attempt = 0; attempt < 20 && !terminalId; attempt++) {
      terminalId = await page.evaluate(async (worktreeId) => {
        const dispatch = (window as any).__daintreeDispatchAction;
        // dispatch returns the ActionDispatchResult envelope, not the
        // action's raw result.
        const envelope = await dispatch(
          "agent.launch",
          { agentId: "claude", worktreeId, focusPolicy: "preserve" },
          { source: "test" }
        );
        return envelope?.ok ? (envelope.result?.terminalId ?? null) : null;
      }, wt.id);
      if (!terminalId) await page.waitForTimeout(1_500);
    }
    expect(terminalId, `agent launch in ${wt.id}`).toBeTruthy();
    launched.push(terminalId!);
  }

  // Deterministic focus across scales: the main worktree is active, so
  // the visible grid panel (and flip target) is always main's agent.
  await page.evaluate((id) => (window as any).electron.worktree.setActive(id), mainWt.id);
  await page.waitForTimeout(1_000);

  // The active worktree's agent is the one we flip; find its grid panel.
  const gridPanel = page.locator('[data-panel-location="grid"]').first();
  await expect(gridPanel).toBeVisible({ timeout: T_LONG });
  const flipPanelId = await gridPanel.getAttribute("data-panel-id");
  expect(flipPanelId).toBeTruthy();

  // Wait for the visible agent to be detected and READY, then let the
  // background spawn queue + availability probes fully settle.
  await expect
    .poll(() => gridPanel.getAttribute("data-detected-agent-id"), {
      timeout: 120_000,
      intervals: [500, 1000],
    })
    .toBe("claude");
  const queueSettleMs = Math.max(5_000, (scale - 6) * 1_100 + 4_000);
  await page.waitForTimeout(queueSettleMs);

  // Reload sentinel: a renderer crash/reload mid-scale reinstalls a fresh
  // probe and silently truncates captured commits — fail loudly instead.
  await page.evaluate(() => {
    (window as any).__FANOUT_SESSION_MARKER__ = true;
  });
  const assertNoReload = async (where: string) => {
    const alive = await page.evaluate(() => !!(window as any).__FANOUT_SESSION_MARKER__);
    expect(alive, `renderer view survived without reload (${where})`).toBe(true);
  };

  const probeStart = () => page.evaluate(() => (window as any).__DAINTREE_RENDER_PROBE__?.start());
  const probeStop = () =>
    page.evaluate(() => (window as any).__DAINTREE_RENDER_PROBE__?.stop() ?? []);

  return {
    page,
    probeInstalled: probeState.installed,
    worktrees,
    mainWt,
    launched,
    gridPanel,
    flipPanelId: flipPanelId!,
    probeStart,
    probeStop,
    assertNoReload,
  };
}
