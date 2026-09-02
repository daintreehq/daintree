/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
/**
 * Multi-project workload for the project-switch rotation benchmark.
 *
 * Five small repos, each with three worktrees, a shared fake `claude` that
 * keeps streaming while the user is elsewhere, and a per-project seeding pass
 * that leaves one focused shell pane (the nonce probe) plus three agent panes
 * behind — so every switch carries the PTY wake, agent-state and paint work
 * a real workspace does.
 */
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { createFixtureRepo, removePathSync } from "./fixtures";
import {
  FAKE_AGENT_IDLE,
  FAKE_AGENT_STREAM_ON,
  fakeAgentEnv,
  installFakeAgent,
  ptyWrite,
} from "./fakeAgent";
import { getGridPanelIds, openTerminal } from "./panels";
import { SEL } from "./selectors";
import { waitForTerminalReady, waitForTerminalText } from "./terminal";
import { T_LONG } from "./timeouts";

export const SWITCH_FIXTURE_NAMES = ["alpha", "bravo", "charlie", "delta", "echo"] as const;
const BRANCHES = ["feat/one", "feat/two", "feat/three"] as const;

export interface SwitchFixtureProject {
  name: string;
  dir: string;
  branches: string[];
}

export interface SwitchFixture {
  projects: SwitchFixtureProject[];
  fakeBinDir: string;
  zdotdir: string;
  launchEnv: Record<string, string>;
  metricsPath: string;
  cleanup: () => void;
}

export interface SwitchFixtureOptions {
  projects?: number;
  worktreesPerProject?: number;
  filesPerRepo?: number;
  streamLinesPerSec?: number;
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function writeSourceTree(dir: string, fileCount: number, salt: string): void {
  // ~12 directories × ~15 files: enough for the file browser, git status and
  // the sidebar watcher to have real work without dwarfing the switch itself.
  const dirs = Math.max(1, Math.min(12, Math.ceil(fileCount / 15)));
  let written = 0;
  for (let d = 0; d < dirs && written < fileCount; d++) {
    const sub = path.join(dir, "src", `module-${String(d).padStart(2, "0")}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < 15 && written < fileCount; f++, written++) {
      const name = `unit-${String(f).padStart(2, "0")}.ts`;
      writeFileSync(
        path.join(sub, name),
        `// ${salt} ${d}/${f}\nexport const value${d}_${f} = ${d * 100 + f};\nexport function fn${d}_${f}(x: number): number {\n  return x + ${f};\n}\n`
      );
    }
  }
}

/**
 * Build the repos, worktrees, fake CLI and launch env. Everything lives under
 * the OS temp dir and `cleanup` removes it, including the `<dir>-worktrees`
 * siblings that `createFixtureRepo` already knows how to tear down.
 */
export function createSwitchFixture(options: SwitchFixtureOptions = {}): SwitchFixture {
  const {
    projects: projectCount = 5,
    worktreesPerProject = 3,
    filesPerRepo = 180,
    streamLinesPerSec = 20,
  } = options;
  if (projectCount > SWITCH_FIXTURE_NAMES.length) {
    throw new Error(`at most ${SWITCH_FIXTURE_NAMES.length} switch fixture projects are named`);
  }
  if (worktreesPerProject > BRANCHES.length) {
    throw new Error(`at most ${BRANCHES.length} worktrees per project are named`);
  }

  const cleanups: Array<() => void> = [];
  const projects: SwitchFixtureProject[] = [];
  for (let i = 0; i < projectCount; i++) {
    const name = `switchperf-${SWITCH_FIXTURE_NAMES[i]}`;
    const repo = createFixtureRepo({ name, withMultipleFiles: true });
    cleanups.push(repo.cleanup);
    writeSourceTree(repo.dir, filesPerRepo, name);
    git("add -A", repo.dir);
    git('commit -m "seed source tree"', repo.dir);

    const branches: string[] = [];
    const worktreeRoot = path.join(path.dirname(repo.dir), `${path.basename(repo.dir)}-worktrees`);
    mkdirSync(worktreeRoot, { recursive: true });
    for (let w = 0; w < worktreesPerProject; w++) {
      const branch = BRANCHES[w]!;
      git(`branch ${branch}`, repo.dir);
      const worktreeDir = path.join(worktreeRoot, branch.replace("/", "-"));
      git(`worktree add ${JSON.stringify(worktreeDir)} ${branch}`, repo.dir);
      writeFileSync(path.join(worktreeDir, "NOTES.md"), `# ${branch}\n\n- ${name}\n`);
      git("add -A", worktreeDir);
      git(`commit -m "notes for ${branch}"`, worktreeDir);
      branches.push(branch);
    }
    projects.push({ name: path.basename(repo.dir), dir: repo.dir, branches });
  }

  const sharedDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-switchperf-cli-"));
  cleanups.push(() => removePathSync(sharedDir));
  const fakeBinDir = installFakeAgent(sharedDir, { streamLinesPerSec });
  // An empty ZDOTDIR keeps the user's zsh rc files from putting a real
  // `claude` ahead of the fake one on PATH (see worktree-agent-ready-perf).
  const zdotdir = path.join(sharedDir, ".e2e-zdotdir");
  mkdirSync(zdotdir, { recursive: true });
  const metricsPath = path.join(sharedDir, "perf-marks.ndjson");

  return {
    projects,
    fakeBinDir,
    zdotdir,
    metricsPath,
    launchEnv: {
      ...fakeAgentEnv(fakeBinDir),
      ZDOTDIR: zdotdir,
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: metricsPath,
    },
    cleanup: () => {
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {
          // Best effort; a locked worktree dir must not fail the run.
        }
      }
    },
  };
}

export interface SeededWorkload {
  probePanelId: string;
  agentPanelIds: string[];
  worktreeIds: string[];
}

interface WorktreeRow {
  id: string;
  path: string;
  branch?: string;
}

async function listWorktrees(page: Page): Promise<WorktreeRow[]> {
  const rows = await page
    .evaluate(() => (window as any).electron?.worktree?.getAll?.())
    .catch(() => null);
  return Array.isArray(rows) ? (rows as WorktreeRow[]) : [];
}

async function dispatch(page: Page, actionId: string, args: unknown): Promise<any> {
  return page.evaluate(
    async ([id, payload]) => {
      const fn = (window as any).__daintreeDispatchAction;
      if (typeof fn !== "function") return { ok: false, error: { message: "no dispatch bridge" } };
      return fn(id, payload, { source: "test" });
    },
    [actionId, args] as const
  );
}

async function selectWorktree(page: Page, worktreeId: string, branch: string): Promise<void> {
  const result = await dispatch(page, "worktree.select", { worktreeId });
  if (result && result.ok === false) {
    throw new Error(`worktree.select failed: ${result.error?.message ?? "unknown"}`);
  }
  // The sidebar card carries data-active once the store has flipped; the grid
  // remounts for the new worktree right after, so give it a beat.
  await expect(
    page.locator(`${SEL.worktree.card(branch)}[data-active="true"]`).first()
  ).toBeAttached({ timeout: T_LONG });
  await page.waitForTimeout(300);
}

async function newestGridPanel(page: Page, before: Set<string>): Promise<string> {
  await expect
    .poll(async () => (await getGridPanelIds(page)).filter((id) => !before.has(id)).length, {
      timeout: T_LONG,
      intervals: [100, 250],
    })
    .toBeGreaterThan(0);
  const fresh = (await getGridPanelIds(page)).filter((id) => !before.has(id));
  return fresh[fresh.length - 1]!;
}

async function launchAgent(page: Page, worktreeId: string): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  const result = await dispatch(page, "agent.launch", {
    agentId: "claude",
    worktreeId,
    location: "grid",
    focusPolicy: "preserve",
  });
  if (!result?.ok) {
    throw new Error(`agent.launch failed: ${result?.error?.message ?? JSON.stringify(result)}`);
  }
  const reported: string | null = result.result?.terminalId ?? null;
  // Prefer the DOM diff — it proves the panel mounted — and only trust the
  // reported id when the grid already held it (e.g. a re-used panel).
  const fresh = (await getGridPanelIds(page)).filter((id) => !before.has(id));
  const panelId = fresh.includes(reported ?? "")
    ? reported!
    : fresh.length > 0
      ? fresh[fresh.length - 1]!
      : reported
        ? reported
        : await newestGridPanel(page, before);

  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await waitForTerminalText(panel, "Enter to confirm", T_LONG);
  await ptyWrite(page, panelId, "\r");
  await waitForTerminalText(panel, "FAKE_CLAUDE_READY", T_LONG);
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), { timeout: 60_000, intervals: [250, 500] })
    .toBe("working");
  return panelId;
}

/**
 * Seed one project the way a working session leaves it: a focused shell
 * pane in worktree 1 (the nonce probe), two agents there — one streaming, one
 * quietly working — and one waiting agent in worktree 2. Ends back on
 * worktree 1 with the probe pane focused.
 */
export async function seedProjectWorkload(
  _app: ElectronApplication,
  page: Page,
  project: SwitchFixtureProject
): Promise<SeededWorkload> {
  const wanted = project.branches.slice(0, 2);
  let worktrees: WorktreeRow[] = [];
  await expect
    .poll(
      async () => {
        worktrees = await listWorktrees(page);
        return wanted.every((branch) =>
          worktrees.some(
            (row) => row.branch === branch || row.path.endsWith(branch.replace("/", "-"))
          )
        );
      },
      { timeout: 60_000, intervals: [250, 500] }
    )
    .toBe(true);
  const worktreeIds = wanted.map(
    (branch) =>
      worktrees.find((row) => row.branch === branch || row.path.endsWith(branch.replace("/", "-")))!
        .id
  );

  await selectWorktree(page, worktreeIds[0]!, wanted[0]!);

  const beforeProbe = new Set(await getGridPanelIds(page));
  await openTerminal(page);
  const probePanelId = await newestGridPanel(page, beforeProbe);
  await waitForTerminalReady(page, page.locator(`[data-panel-id="${probePanelId}"]`), T_LONG);

  const agentPanelIds: string[] = [];
  agentPanelIds.push(await launchAgent(page, worktreeIds[0]!));
  agentPanelIds.push(await launchAgent(page, worktreeIds[0]!));

  await selectWorktree(page, worktreeIds[1]!, wanted[1]!);
  agentPanelIds.push(await launchAgent(page, worktreeIds[1]!));
  // Cooked-mode stdin: the fake CLI only sees a line once it is terminated.
  await ptyWrite(page, agentPanelIds[2]!, `${FAKE_AGENT_IDLE}\r`);
  await expect
    .poll(
      () => page.locator(`[data-panel-id="${agentPanelIds[2]}"]`).getAttribute("data-agent-state"),
      { timeout: 60_000, intervals: [250, 500] }
    )
    .toBe("waiting");

  await selectWorktree(page, worktreeIds[0]!, wanted[0]!);
  await ptyWrite(page, agentPanelIds[0]!, `${FAKE_AGENT_STREAM_ON}\r`);

  const probe = page.locator(`[data-panel-id="${probePanelId}"]`);
  await expect(probe).toBeVisible({ timeout: T_LONG });
  await probe.locator(SEL.terminal.xtermRows).first().click({ force: true });
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            Boolean(
              document.activeElement?.closest(`[data-panel-id="${id}"]`) &&
              document.activeElement?.classList.contains("xterm-helper-textarea")
            ),
          probePanelId
        ),
      { timeout: T_LONG, intervals: [100, 250] }
    )
    .toBe(true);

  return { probePanelId, agentPanelIds, worktreeIds };
}
