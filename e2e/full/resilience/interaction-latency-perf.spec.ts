/* eslint-disable @typescript-eslint/no-explicit-any -- window bridges are untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { connectGitHub, makeFixtureIssue, stubRepoStats } from "../../helpers/githubHelpers";
import { seedNotificationHistory } from "../../helpers/notifications";
import {
  armProbe,
  installProbe,
  probeResult,
  type DoneCondition,
} from "../../helpers/interactionProbe";

// Everyday-interaction latency benchmark. Each scenario drives one thing a
// user does many times a day — open a dropdown, switch a worktree, type into a
// search box, launch an agent — through real input (CDP mouse/keyboard, a
// 100ms hover dwell before every click so hover-intent prefetches behave as
// they do for a person), and times input event → the first frame in which the
// result is on screen. Entry animations are not waited out: a popover that has
// mounted its content and is fading in counts as answered.
//
// Opt-in only, never a CI gate:
//   npm run build:e2e
//   RUN_PERF_INTERACTIONS=1 npx playwright test --project=full-resilience \
//     e2e/full/resilience/interaction-latency-perf.spec.ts
// Env: PERF_INTERACTIONS_REPS (default 8), PERF_INTERACTIONS_ONLY (comma ids),
// PERF_INTERACTIONS_OUT (JSON path), PERF_INTERACTIONS_LABEL.

const REPS = Math.max(3, Math.floor(Number(process.env.PERF_INTERACTIONS_REPS) || 8));
const ONLY = (process.env.PERF_INTERACTIONS_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = process.env.PERF_INTERACTIONS_OUT ?? "";
// Diagnosis only: capture a CPU profile of reps 0 and 1 of these scenarios.
const PROFILE = (process.env.PERF_INTERACTIONS_PROFILE ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PROFILE_DIR = process.env.PERF_INTERACTIONS_PROFILE_DIR ?? "";
// Diagnosis only: record a devtools timeline trace of rep 1 of these scenarios.
const TRACE = (process.env.PERF_INTERACTIONS_TRACE ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LABEL = process.env.PERF_INTERACTIONS_LABEL ?? "run";
// Simulated forge round trip for the stubbed list endpoints — a real GitHub
// list call is 300-800ms, and a zero-latency stub would hide every cache and
// prefetch path the dropdowns have.
const FORGE_LATENCY_MS = Number(process.env.PERF_INTERACTIONS_FORGE_LATENCY_MS ?? 300);
const DWELL_MS = 100;
const SETTLE_MS = 300;
const READY_TOKEN = "ILAT_AGENT_READY";
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const BRANCHES = [
  "feat/alpha",
  "feat/bravo",
  "feat/charlie",
  "feat/delta",
  "feat/echo",
  "feat/foxtrot",
  "feat/golf",
  "feat/hotel",
];

interface Fixture {
  mainDir: string;
  otherDir: string;
  binDir: string;
  zdotdir: string;
  cleanup: () => void;
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function writeSourceTree(dir: string, dirs: number, perDir: number): void {
  for (let d = 0; d < dirs; d++) {
    const sub = path.join(dir, "src", `module-${String(d).padStart(2, "0")}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < perDir; f++) {
      writeFileSync(
        path.join(sub, `unit-${String(f).padStart(2, "0")}.ts`),
        `export const value${d}_${f} = ${d * 100 + f};\nexport function fn${d}_${f}(x: number): number {\n  return x + ${f};\n}\n`
      );
    }
  }
}

function buildFixture(): Fixture {
  const cleanups: Array<() => void> = [];
  const main = createFixtureRepo({
    name: "ilat-main",
    withGitHubRemote: true,
    withMultipleFiles: true,
  });
  cleanups.push(main.cleanup);
  writeSourceTree(main.dir, 16, 20);
  writeFileSync(path.join(main.dir, "bench-a.ts"), "export const BENCH_FILE_ALPHA = 1;\n");
  writeFileSync(path.join(main.dir, "bench-b.ts"), "export const BENCH_FILE_BRAVO = 2;\n");
  git("add -A", main.dir);
  git('commit -m "seed source tree"', main.dir);
  const wtRoot = path.join(path.dirname(main.dir), `${path.basename(main.dir)}-worktrees`);
  mkdirSync(wtRoot, { recursive: true });
  for (const branch of BRANCHES) {
    git(`branch ${branch}`, main.dir);
    git(
      `worktree add ${JSON.stringify(path.join(wtRoot, branch.replace("/", "-")))} ${branch}`,
      main.dir
    );
  }
  // Uncommitted work in the main tree so the card offers Review and the
  // review hub has a real list to mount.
  for (let i = 0; i < 24; i++) {
    writeFileSync(
      path.join(main.dir, "src", "module-00", `unit-${String(i).padStart(2, "0")}.ts`),
      `export const edited${i} = ${i};\n`
    );
  }

  const other = createFixtureRepo({ name: "ilat-other", withMultipleFiles: true });
  cleanups.push(other.cleanup);
  writeSourceTree(other.dir, 4, 10);
  git("add -A", other.dir);
  git('commit -m "seed"', other.dir);

  const shared = mkdtempSync(path.join(tmpdir(), "daintree-e2e-ilat-"));
  cleanups.push(() => removePathSync(shared));
  const binDir = path.join(shared, "bin");
  mkdirSync(binDir, { recursive: true });
  const fake = path.join(binDir, process.platform === "win32" ? "claude.js" : "claude");
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) { console.log('claude code v9.9.9'); process.exit(0); }",
      `process.stdout.write('\\u256d\\u2500 fake claude \\u2500\\u256e\\n' + ${JSON.stringify(READY_TOKEN)} + '\\n');`,
      "process.stdin.resume();",
      "const keep = setInterval(() => {}, 1000);",
      "const stop = () => { clearInterval(keep); process.exit(0); };",
      "process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);",
      "",
    ].join("\n")
  );
  chmodSync(fake, 0o755);
  const zdotdir = path.join(shared, "zdotdir");
  mkdirSync(zdotdir, { recursive: true });
  writeFileSync(path.join(zdotdir, ".zshrc"), "PROMPT='ilat%# '\n");

  return {
    mainDir: main.dir,
    otherDir: other.dir,
    binDir,
    zdotdir,
    cleanup: () => {
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {
          // best effort
        }
      }
    },
  };
}

interface Scenario {
  id: string;
  label: string;
  reps?: number;
  setup?: () => Promise<void>;
  before?: (rep: number) => Promise<void>;
  trigger: (rep: number) => Promise<void>;
  cond: (rep: number) => DoneCondition;
  after?: (rep: number) => Promise<void>;
  cleanup?: () => Promise<void>;
  /** custom measurement (cross-view) — returns doneMs */
  measure?: (rep: number) => Promise<{ doneMs: number; firstFrameMs: number; timedOut: boolean }>;
}

interface Sample {
  rep: number;
  doneMs: number;
  firstFrameMs: number;
  loafCount: number;
  loafMaxMs: number;
  maxFrameGapMs: number;
  inputType: string | null;
  timedOut: boolean;
}

interface ScenarioResult {
  id: string;
  label: string;
  samples: Sample[];
  firstMs: number | null;
  warmMedianMs: number | null;
  warmP90Ms: number | null;
  warmMinMs: number | null;
  firstFrameMedianMs: number | null;
  error?: string;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pctile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

let ctx: AppContext;
let fixture: Fixture;
let page: Page;
let mainProjectId = "";
let otherProjectId = "";

async function settle(p: Page = page): Promise<void> {
  await p
    .evaluate(
      () =>
        new Promise<void>((r) => {
          const ric = (window as any).requestIdleCallback as
            ((cb: () => void, o: { timeout: number }) => void) | undefined;
          if (ric) ric(() => r(), { timeout: 1000 });
          else setTimeout(r, 50);
        })
    )
    .catch(() => undefined);
  await p.waitForTimeout(SETTLE_MS);
}

async function hoverClick(selector: string, p: Page = page): Promise<void> {
  const loc = p.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 10_000 });
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForTimeout(DWELL_MS);
  await p.mouse.down();
  await p.mouse.up();
}

async function resetInput(p: Page = page): Promise<void> {
  await p.evaluate(() => {
    const s = (window as any).__ilatState;
    if (s) {
      s.inputTs = null;
      s.inputType = null;
    }
  });
}

async function escape(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
  }
}

// Escape until `selector` is gone: a palette with a typed query spends its
// first Escape clearing the query, so one press can leave it open over every
// later scenario.
async function escapeUntilGone(selector: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (
      !(await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  await waitGone(selector);
}

async function waitGone(selector: string, timeout = 5_000): Promise<void> {
  await page
    .locator(selector)
    .first()
    .waitFor({ state: "hidden", timeout })
    .catch(() => undefined);
}

async function waitVisible(selector: string, timeout = 15_000): Promise<void> {
  await page.locator(selector).first().waitFor({ state: "visible", timeout });
}

// Scenarios that move the active worktree hand back to main, where the grid's
// panels live — later panel scenarios need them on screen.
async function returnToMainWorktree(): Promise<void> {
  const main = page.locator('[data-worktree-is-main="true"]').first();
  await main.click({ position: { x: 100, y: 10 } });
  await page
    .locator('[data-worktree-row]:has([data-worktree-is-main="true"])[aria-current="true"]')
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForTimeout(300);
}

async function dispatch(id: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    ([i, a]) => (window as any).__daintreeDispatchAction(i, a, { source: "user" }),
    [id, args] as const
  );
}

async function panelIds(): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-panel-id]"))
      .map((e) => e.getAttribute("data-panel-id") ?? "")
      .filter(Boolean)
  );
}

// Main admits PTY spawns through a leaky bucket (burst 6, then 1/s —
// electron/ipc/handlers/terminal/lifecycle.ts). Reps closer together than a
// person opens terminals would time the guard, not the spawn path.
let lastSpawnAt = 0;
async function spawnCooldown(): Promise<void> {
  const wait = lastSpawnAt + 1_150 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  lastSpawnAt = Date.now();
}

let panelsBefore: string[] = [];
async function snapshotPanels(): Promise<void> {
  panelsBefore = await panelIds();
}

async function killNewPanels(): Promise<void> {
  const now = await panelIds();
  const fresh = [...new Set(now.filter((id) => !panelsBefore.includes(id)))];
  for (const id of fresh) {
    await dispatch("terminal.kill", { terminalId: id, confirmed: true }).catch(() => undefined);
  }
  for (const id of fresh) await waitGone(`[data-panel-id="${id}"]`);
  // A confirm dialog may be staged for agent panes.
  const confirm = page.locator('[data-confirm-role="confirm"]');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

async function openTerminalUntimed(): Promise<string> {
  await spawnCooldown();
  const before = await panelIds();
  await dispatch("agent.terminal");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const now = await panelIds();
    const id = now.find((x) => !before.includes(x));
    if (id) {
      await page
        .locator(`[data-panel-id="${id}"] .xterm`)
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      return id;
    }
    await page.waitForTimeout(50);
  }
  throw new Error("terminal did not open");
}

async function forgeLatencyStub(channel: string, items: unknown[]): Promise<void> {
  await ctx.app.evaluate(
    ({ ipcMain }, { channel, response, latency }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(
        channel,
        async (_e: unknown, _path: unknown, opts: { search?: string } | undefined) => {
          await new Promise((r) => setTimeout(r, latency));
          const q = opts?.search?.toLowerCase();
          if (!q) return response;
          const items = response.items.filter((it: any) =>
            String(it.title).toLowerCase().includes(q)
          );
          return { ...response, items, totalCount: items.length };
        }
      );
    },
    {
      channel,
      latency: FORGE_LATENCY_MS,
      response: { items, nextCursor: null, hasMore: false, totalCount: items.length },
    }
  );
}

function fixturePR(n: number, title: string): Record<string, unknown> {
  const updatedAt = Date.now() - n * 60_000;
  return {
    number: n,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: `https://github.com/daintreehq/daintree/pull/${n}`,
    author: { login: "e2e-user", avatarUrl: "" },
    baseRef: "develop",
    headRef: `feature/issue-${n}`,
    commentCount: n % 4,
    createdAt: updatedAt,
    updatedAt,
    rawData: {},
  };
}

async function pageForProject(projectId: string): Promise<Page | null> {
  for (const w of ctx.app.windows()) {
    const id = await w
      .evaluate(() => (window as any).__DAINTREE_INITIAL_PROJECT__?.id ?? null)
      .catch(() => null);
    if (id === projectId) return w;
  }
  return null;
}

const SETTINGS_TABS = [
  "terminalAppearance",
  "keyboard",
  "notifications",
  "terminal",
  "worktree",
  "toolbar",
  "agents",
  "code-forge",
  "privacy",
  "integrations",
  "mcp",
  "plugins",
];

const TREE = '[data-testid="file-browser-tree-column"] [role="treeitem"]';
const LAUNCHER_ROWS = '[role="listbox"][aria-label="Launcher results"] [role="option"]';
const SIDEBAR = 'aside[aria-label="Sidebar"]';
const ASSISTANT = "aside#daintree-assistant-panel";

// Keydown → the first frame whose buffer ends with everything typed so far.
async function measureEcho(
  panelId: string,
  expected: string
): Promise<{ doneMs: number; firstFrameMs: number; timedOut: boolean }> {
  return page.evaluate(
    async ({ id, exp }) => {
      const w = window as any;
      const start = w.__ilatKeyStart as number;
      const read = w.__daintreeReadTerminalBuffer as (id: string) => string;
      const deadline = performance.now() + 3000;
      let first: number | null = null;
      while (performance.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.timeOrigin + performance.now();
        if (first === null) first = now;
        const lines = String(read(id))
          .split("\n")
          .filter((l) => l.trim());
        if ((lines[lines.length - 1] ?? "").endsWith(exp)) {
          return { doneMs: now - start, firstFrameMs: first - start, timedOut: false };
        }
      }
      return { doneMs: 3000, firstFrameMs: 0, timedOut: true };
    },
    { id: panelId, exp: expected }
  );
}

function scenarios(): Scenario[] {
  let fileBrowserPanel = "";
  let dockPanel = "";
  let closePanel = "";
  let shellPanel = "";
  let typed = "";
  return [
    // ── Toolbar popovers and palettes ──────────────────────────────────
    {
      id: "project-switcher-open",
      label: "Open project switcher (toolbar)",
      trigger: () => hoverClick('[data-testid="project-switcher-trigger"]'),
      cond: () => ({
        kind: "visible",
        selector: '[data-testid="project-switcher-palette"] [role="option"]',
      }),
      after: async () => {
        await escapeUntilGone('[data-testid="project-switcher-palette"]');
      },
    },
    {
      id: "project-switcher-shortcut",
      label: "Open project switcher (Cmd+Alt+P)",
      trigger: () => page.keyboard.press(`${MOD}+Alt+p`),
      // The shortcut opens the modal form, not the toolbar dropdown.
      cond: () => ({
        kind: "visible",
        selector: '[role="dialog"][aria-label="Project switcher"] [role="option"]',
      }),
      after: async () => {
        await escapeUntilGone('[role="dialog"][aria-label="Project switcher"]');
      },
    },
    {
      id: "issues-open",
      label: "Open GitHub Issues dropdown",
      trigger: () => hoverClick('[data-testid="forge-stat-pill-issues"]'),
      // Rows on screen is the answer; a background revalidate keeps
      // aria-busy set while cached rows are already showing.
      cond: () => ({
        kind: "visible",
        selector: '#github-issue-list [data-testid^="github-item-"]',
      }),
      after: async () => {
        await escapeUntilGone("#github-issue-list");
      },
    },
    {
      id: "prs-open",
      label: "Open GitHub Pull Requests dropdown",
      trigger: () => hoverClick('[data-testid="forge-stat-pill-prs"]'),
      // Rows on screen is the answer; a background revalidate keeps
      // aria-busy set while cached rows are already showing.
      cond: () => ({ kind: "visible", selector: '#github-pr-list [data-testid^="github-item-"]' }),
      after: async () => {
        await escapeUntilGone("#github-pr-list");
      },
    },
    {
      id: "commits-open",
      label: "Open commits dropdown",
      trigger: () => hoverClick('[data-testid="forge-stat-pill-commits"]'),
      cond: () => ({
        kind: "visible",
        selector: '[role="grid"][aria-label="Commits"] [role="row"]',
      }),
      after: async () => {
        await escapeUntilGone('[role="grid"][aria-label="Commits"]');
      },
    },
    {
      id: "notifications-open",
      label: "Open notification center",
      trigger: () => hoverClick('button[aria-label^="Notifications"]'),
      cond: () => ({
        kind: "visible",
        selector: '[data-testid="notification-center"] [role="listitem"]',
      }),
      after: async () => {
        await escapeUntilGone('[data-testid="notification-center"]');
      },
    },
    {
      id: "launcher-open",
      label: "Open agent launcher",
      trigger: () => hoverClick('[aria-label^="Launcher"]'),
      cond: () => ({ kind: "visible", selector: LAUNCHER_ROWS, minCount: 3 }),
      after: async () => {
        await escapeUntilGone(LAUNCHER_ROWS);
      },
    },
    {
      id: "launcher-type",
      label: "Type in launcher search",
      before: async () => {
        await hoverClick('[aria-label^="Launcher"]');
        await waitVisible(LAUNCHER_ROWS);
        await page.locator('[aria-label="Search agents, panels, and recipes"]').focus();
      },
      trigger: () => page.keyboard.type("b"),
      cond: () => ({ kind: "changed", selector: LAUNCHER_ROWS }),
      after: async () => {
        await escapeUntilGone(LAUNCHER_ROWS);
      },
    },
    {
      id: "quick-switcher-open",
      label: "Open quick switcher (Cmd+P)",
      trigger: () => page.keyboard.press(`${MOD}+p`),
      cond: () => ({ kind: "visible", selector: '#quick-switcher-list [role="option"]' }),
      after: async () => {
        await escapeUntilGone('[role="dialog"][aria-label="Quick switcher"]');
      },
    },
    {
      id: "quick-switcher-type",
      label: "Type in quick switcher",
      before: async () => {
        await page.keyboard.press(`${MOD}+p`);
        await waitVisible('#quick-switcher-list [role="option"]');
      },
      trigger: () => page.keyboard.type("x"),
      cond: () => ({ kind: "changed", selector: '#quick-switcher-list [role="option"]' }),
      after: async () => {
        await escapeUntilGone('[role="dialog"][aria-label="Quick switcher"]');
      },
    },
    {
      id: "command-palette-open",
      label: "Open command palette (Cmd+Shift+P)",
      trigger: () => page.keyboard.press(`${MOD}+Shift+p`),
      cond: () => ({ kind: "visible", selector: '#action-palette-list [role="option"]' }),
      after: async () => {
        await escapeUntilGone('[role="dialog"][aria-label="Command palette"]');
      },
    },
    {
      id: "command-palette-type",
      label: "Type in command palette",
      before: async () => {
        await page.keyboard.press(`${MOD}+Shift+p`);
        await waitVisible('#action-palette-list [role="option"]');
      },
      trigger: () => page.keyboard.type("w"),
      cond: () => ({ kind: "changed", selector: '#action-palette-list [role="option"]' }),
      after: async () => {
        await escapeUntilGone('[role="dialog"][aria-label="Command palette"]');
      },
    },
    {
      id: "panel-palette-open",
      label: "Open panel palette (Cmd+N)",
      trigger: () => page.keyboard.press(`${MOD}+n`),
      cond: () => ({ kind: "visible", selector: '#panel-list [role="option"]' }),
      after: async () => {
        await escapeUntilGone('[role="dialog"][aria-label="Panel palette"]');
      },
    },
    {
      id: "theme-palette-open",
      label: "Open theme picker (Cmd+K Cmd+T)",
      trigger: async () => {
        await page.keyboard.press(`${MOD}+k`);
        await resetInput();
        await page.keyboard.press(`${MOD}+t`);
      },
      cond: () => ({ kind: "visible", selector: '#theme-palette-list [role="option"]' }),
      after: async () => {
        await escapeUntilGone('[role="dialog"][aria-label="Theme palette"]');
      },
    },

    // ── Settings ───────────────────────────────────────────────────────
    {
      id: "settings-open",
      label: "Open settings (toolbar)",
      trigger: () => hoverClick('[aria-label="Open settings"]'),
      cond: () => ({
        kind: "all",
        conds: [
          { kind: "visible", selector: '.settings-sidebar [role="tab"]' },
          { kind: "visible", selector: "[data-settings-section-title]" },
        ],
      }),
      after: async () => {
        await escapeUntilGone(".settings-sidebar");
      },
    },
    {
      id: "settings-tab-first-visit",
      label: "Switch settings tab (first visit)",
      reps: SETTINGS_TABS.length,
      setup: async () => {
        await hoverClick('[aria-label="Open settings"]');
        await waitVisible("[data-settings-section-title]");
      },
      trigger: (rep) =>
        hoverClick(`.settings-sidebar [role="tab"][data-tab="${SETTINGS_TABS[rep]}"]`),
      cond: (rep) => ({
        kind: "visible",
        selector: `#settings-panel-${SETTINGS_TABS[rep]} [data-settings-section-title]`,
      }),
    },
    {
      id: "settings-tab-revisit",
      label: "Switch settings tab (revisit)",
      reps: SETTINGS_TABS.length,
      trigger: (rep) =>
        hoverClick(`.settings-sidebar [role="tab"][data-tab="${SETTINGS_TABS[rep]}"]`),
      cond: (rep) => ({
        kind: "visible",
        selector: `#settings-panel-${SETTINGS_TABS[rep]} [data-settings-section-title]`,
      }),
    },
    {
      id: "settings-search-first-key",
      label: "Settings search: first keystroke",
      before: async () => {
        const input = page.locator('[aria-label="Search settings"]');
        await input.fill("");
        await input.focus();
        await waitGone("#settings-search-results");
      },
      trigger: () => page.keyboard.type("f"),
      cond: () => ({ kind: "visible", selector: '#settings-search-results [role="option"]' }),
    },
    {
      id: "settings-search-refine",
      label: "Settings search: refine query",
      before: async () => {
        const input = page.locator('[aria-label="Search settings"]');
        await input.fill("t");
        await input.focus();
        await waitVisible('#settings-search-results [role="option"]');
      },
      trigger: () => page.keyboard.type("h"),
      cond: () => ({ kind: "changed", selector: '#settings-search-results [role="option"]' }),
    },
    {
      id: "settings-search-clear",
      label: "Settings search: clear",
      before: async () => {
        const input = page.locator('[aria-label="Search settings"]');
        await input.fill("font");
        await waitVisible('#settings-search-results [role="option"]');
      },
      trigger: () =>
        hoverClick(
          '.settings-sidebar ~ * [aria-label="Clear search"], [role="dialog"] [aria-label="Clear search"]'
        ),
      cond: () => ({ kind: "hidden", selector: "#settings-search-results" }),
      cleanup: async () => {
        await escapeUntilGone(".settings-sidebar");
      },
    },

    // ── Assistant ──────────────────────────────────────────────────────
    {
      id: "assistant-open",
      label: "Open Daintree Assistant",
      trigger: () => hoverClick('button[aria-label^="Daintree Assistant"]'),
      cond: () => ({ kind: "visible", selector: `${ASSISTANT}:not([inert])` }),
      after: async () => {
        await page.locator('button[aria-label^="Daintree Assistant"]').first().click();
        await page
          .waitForSelector(`${ASSISTANT}[inert]`, { state: "attached", timeout: 5_000 })
          .catch(() => undefined);
      },
    },
    {
      id: "assistant-close",
      label: "Close Daintree Assistant",
      before: async () => {
        await page.locator('button[aria-label^="Daintree Assistant"]').first().click();
        await waitVisible(`${ASSISTANT}:not([inert])`);
      },
      trigger: () => hoverClick('button[aria-label^="Daintree Assistant"]'),
      cond: () => ({ kind: "count", selector: `${ASSISTANT}:not([inert])`, op: "==", n: 0 }),
    },

    // ── Sidebar & worktrees ────────────────────────────────────────────
    {
      id: "worktree-search-type",
      label: "Worktree search: type query",
      before: async () => {
        const input = page.locator('[aria-label="Search worktrees"]');
        await input.fill("");
        await input.focus();
        await waitVisible('[data-worktree-branch="feat/alpha"]');
      },
      trigger: () => page.keyboard.type("x"),
      cond: () => ({
        kind: "all",
        conds: [
          { kind: "visible", selector: '[data-worktree-branch="feat/foxtrot"]' },
          { kind: "hidden", selector: '[data-worktree-branch="feat/alpha"]' },
        ],
      }),
    },
    {
      id: "worktree-search-clear",
      label: "Worktree search: clear",
      before: async () => {
        const input = page.locator('[aria-label="Search worktrees"]');
        await input.fill("x");
        await waitGone('[data-worktree-branch="feat/alpha"]');
      },
      trigger: () => hoverClick(`${SIDEBAR} [aria-label="Clear search"]`),
      cond: () => ({ kind: "visible", selector: '[data-worktree-branch="feat/alpha"]' }),
    },
    {
      id: "worktree-switch-click",
      label: "Switch worktree (click card)",
      setup: async () => {
        // Start from charlie so rep 0 (bravo) is a real switch.
        await dispatch("worktree.switch3").catch(() => undefined);
        await page
          .locator('[data-worktree-branch="feat/charlie"]')
          .first()
          .click({ position: { x: 100, y: 10 } });
        await page.waitForTimeout(500);
      },
      trigger: async (rep) => {
        const branch = rep % 2 === 0 ? "feat/bravo" : "feat/charlie";
        const card = page.locator(`[data-worktree-branch="${branch}"]`).first();
        const box = await card.boundingBox();
        if (!box) throw new Error("no card");
        await page.mouse.move(box.x + Math.min(100, box.width / 2), box.y + 10);
        await page.waitForTimeout(DWELL_MS);
        await page.mouse.down();
        await page.mouse.up();
      },
      cond: (rep) => ({
        kind: "attr",
        selector: `[data-worktree-row]:has([data-worktree-branch="${rep % 2 === 0 ? "feat/bravo" : "feat/charlie"}"])`,
        attr: "aria-current",
        value: "true",
      }),
      cleanup: returnToMainWorktree,
    },
    {
      id: "worktree-switch-shortcut",
      label: "Switch worktree (Cmd+Alt+number)",
      trigger: (rep) => page.keyboard.press(`${MOD}+Alt+${rep % 2 === 0 ? 2 : 3}`),
      cond: () => ({ kind: "changed", selector: '[data-worktree-row][aria-current="true"]' }),
      cleanup: returnToMainWorktree,
    },
    {
      id: "new-worktree-dialog",
      label: "Open new-worktree dialog",
      trigger: () => hoverClick('[aria-label="Create new worktree"]'),
      cond: () => ({
        kind: "all",
        conds: [
          { kind: "visible", selector: '[data-testid="branch-name-input"]' },
          { kind: "hidden", selector: '[aria-label="Loading branches"]' },
        ],
      }),
      after: async () => {
        await escapeUntilGone('[data-testid="new-worktree-dialog"]');
      },
    },
    {
      id: "worktree-filter-open",
      label: "Open worktree filter/sort popover",
      trigger: () => hoverClick('[aria-label^="Filter and sort worktrees"]'),
      cond: () => ({ kind: "visible", selector: '[data-testid="worktree-filter-popover"]' }),
      after: async () => {
        await escapeUntilGone('[data-testid="worktree-filter-popover"]');
      },
    },
    {
      id: "worktree-overview-open",
      label: "Open worktrees overview (Cmd+Alt+R)",
      trigger: () => page.keyboard.press(`${MOD}+Alt+r`),
      cond: () => ({ kind: "visible", selector: "[data-worktree-overview-cell]", minCount: 3 }),
      after: async () => {
        await escapeUntilGone('[data-testid="worktree-overview-modal"]');
      },
    },
    {
      id: "review-hub-open",
      label: "Open Review hub (changed files)",
      setup: async () => {
        await page
          .locator('[data-worktree-is-main="true"]')
          .first()
          .click({ position: { x: 100, y: 10 } });
        await page.waitForTimeout(500);
      },
      trigger: () => hoverClick('[aria-label^="Open Review &"]'),
      cond: () => ({
        kind: "all",
        conds: [
          { kind: "visible", selector: '[data-testid="review-hub-file-list-toggle"]' },
          { kind: "hidden", selector: '[aria-label="Loading review changes"]' },
        ],
      }),
      after: async () => {
        await escapeUntilGone('[data-testid="review-hub-content"]');
      },
    },
    {
      id: "sidebar-hide",
      label: "Hide sidebar (Cmd+B)",
      trigger: () => page.keyboard.press(`${MOD}+b`),
      cond: () => ({ kind: "attr", selector: SIDEBAR, attr: "aria-hidden", value: "true" }),
      after: async () => {
        await page.keyboard.press(`${MOD}+b`);
        await page.waitForTimeout(400);
      },
    },
    {
      id: "sidebar-show",
      label: "Show sidebar (Cmd+B)",
      before: async () => {
        await page.keyboard.press(`${MOD}+b`);
        await page.waitForTimeout(400);
      },
      trigger: () => page.keyboard.press(`${MOD}+b`),
      cond: () => ({ kind: "attr", selector: SIDEBAR, attr: "aria-hidden", value: "false" }),
    },

    // ── Added coverage ─────────────────────────────────────────────────
    {
      id: "worktree-palette-open",
      label: "Open worktree switcher (Cmd+K Cmd+O)",
      trigger: async () => {
        await page.keyboard.press(`${MOD}+k`);
        await resetInput();
        await page.keyboard.press(`${MOD}+o`);
      },
      cond: () => ({ kind: "visible", selector: '#worktree-palette-list [role="option"]' }),
      after: async () => {
        await escapeUntilGone("#worktree-palette-list");
      },
    },
    {
      id: "worktree-palette-type",
      label: "Type in worktree switcher",
      before: async () => {
        await page.keyboard.press(`${MOD}+k`);
        await page.keyboard.press(`${MOD}+o`);
        await waitVisible('#worktree-palette-list [role="option"]');
      },
      trigger: () => page.keyboard.type("x"),
      cond: () => ({ kind: "changed", selector: '#worktree-palette-list [role="option"]' }),
      after: async () => {
        await escapeUntilGone("#worktree-palette-list");
      },
    },
    {
      id: "worktree-next",
      label: "Next worktree (Cmd+Alt+])",
      trigger: () => page.keyboard.press(`${MOD}+Alt+BracketRight`),
      cond: () => ({ kind: "changed", selector: '[data-worktree-row][aria-current="true"]' }),
      cleanup: returnToMainWorktree,
    },
    {
      id: "pilot-open",
      label: "Open all-agents view (Cmd+Alt+O)",
      trigger: () => page.keyboard.press(`${MOD}+Alt+o`),
      cond: () => ({ kind: "visible", selector: '[data-testid="pilot-row"]' }),
      after: async () => {
        await escapeUntilGone('[data-testid="pilot-row"]');
        if (
          await page
            .locator('[data-testid="pilot-row"]')
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          await page.keyboard.press(`${MOD}+Alt+o`);
          await waitGone('[data-testid="pilot-row"]');
        }
      },
    },
    {
      id: "shortcuts-reference",
      label: "Open keyboard shortcuts (Cmd+/)",
      trigger: () => page.keyboard.press(`${MOD}+Slash`),
      cond: () => ({
        kind: "visible",
        selector: '[role="dialog"]:has([aria-label="Search shortcuts"]) [role="listitem"]',
      }),
      after: async () => {
        for (let i = 0; i < 3; i++) {
          if (
            !(await page
              .locator('[aria-label="Search shortcuts"]')
              .first()
              .isVisible()
              .catch(() => false))
          )
            break;
          await escape();
          await page.waitForTimeout(200);
        }
        await waitGone('[aria-label="Search shortcuts"]');
      },
    },
    {
      id: "settings-close",
      label: "Close settings (Escape)",
      before: async () => {
        // Settings reopens on the last tab visited, which need not carry a
        // section title — the sidebar is the tab-independent open marker.
        await page.keyboard.press(`${MOD}+Comma`);
        const opened = await page
          .locator(".settings-sidebar")
          .first()
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(
            () => true,
            () => false
          );
        if (!opened) await hoverClick('[aria-label="Open settings"]');
        await waitVisible(".settings-sidebar");
        await page.waitForTimeout(300);
      },
      trigger: () => page.keyboard.press("Escape"),
      // The exit animation starts in the commit that drops the backstop
      // marker; waiting for the node to leave would time the 120ms fade.
      cond: () => ({
        kind: "count",
        selector: "[data-escape-backstop-dialog]:has(.settings-sidebar)",
        op: "==",
        n: 0,
      }),
      after: () => waitGone(".settings-sidebar"),
    },
    {
      id: "terminal-find-open",
      label: "Find in terminal (Cmd+F)",
      before: async () => {
        await page
          .locator('[data-panel-location="grid"] .xterm')
          .first()
          .click({ force: true, timeout: 5_000 });
      },
      trigger: () => page.keyboard.press(`${MOD}+f`),
      cond: () => ({ kind: "visible", selector: "[data-terminal-search-input]" }),
      after: async () => {
        await escapeUntilGone("[data-terminal-search-input]");
      },
    },
    {
      id: "open-changes-diff",
      label: "Open worktree changes diff (Cmd+Shift+D)",
      setup: async () => {
        await page
          .locator('[data-worktree-is-main="true"]')
          .first()
          .click({ position: { x: 100, y: 10 } });
        await page.waitForTimeout(500);
      },
      trigger: () => page.keyboard.press(`${MOD}+Shift+d`),
      cond: () => ({ kind: "visible", selector: '[data-testid="diff-pane-body"]' }),
      after: async () => {
        await escapeUntilGone('[data-testid="diff-pane-body"]');
      },
    },
    {
      id: "review-file-diff",
      label: "Open a file diff from Review hub",
      setup: async () => {
        await hoverClick('[aria-label^="Open Review &"]');
        await waitVisible('[aria-label^="View diff: "]');
      },
      trigger: (rep) => hoverClick(`[aria-label^="View diff: "] >> nth=${rep % 4}`),
      cond: () => ({ kind: "visible", selector: '[data-testid="diff-pane-body"]' }),
      after: async () => {
        await page
          .locator(
            '[data-testid="panel-dialog"]:has([data-testid="diff-pane-body"]) [aria-label="Close dialog"]'
          )
          .first()
          .click();
        await waitGone('[data-testid="diff-pane-body"]');
      },
      cleanup: async () => {
        await escapeUntilGone('[data-testid="review-hub-content"]');
      },
    },
    {
      id: "issues-search",
      label: "Search in Issues dropdown",
      before: async () => {
        await hoverClick('[data-testid="forge-stat-pill-issues"]');
        await waitVisible('#github-issue-list [data-testid^="github-item-"]');
        const input = page.locator('[aria-label="Search issues"]');
        await input.fill("");
        await input.focus();
        await page.waitForTimeout(700);
      },
      trigger: () => page.keyboard.type("1"),
      cond: () => ({
        kind: "changed",
        selector: '#github-issue-list [data-testid^="github-item-"]',
      }),
      after: async () => {
        await page.locator('[aria-label="Search issues"]').fill("");
        await escapeUntilGone("#github-issue-list");
      },
    },
    {
      id: "commits-search",
      label: "Search in commits dropdown",
      before: async () => {
        await hoverClick('[data-testid="forge-stat-pill-commits"]');
        await waitVisible('[role="grid"][aria-label="Commits"] [role="row"]');
        const input = page.locator('[aria-label="Search commits"]');
        await input.fill("");
        await input.focus();
        await page.waitForTimeout(900);
      },
      trigger: () => page.keyboard.type("seed"),
      // The filtered answer, not the first transient row change.
      cond: () => ({
        kind: "all",
        conds: [
          {
            kind: "count",
            selector: '[role="grid"][aria-label="Commits"] [role="row"][id]',
            op: "==",
            n: 1,
          },
          {
            kind: "text",
            selector: '[role="grid"][aria-label="Commits"]',
            text: "seed source tree",
          },
        ],
      }),
      after: async () => {
        await page.locator('[aria-label="Search commits"]').fill("");
        await escapeUntilGone('[role="grid"][aria-label="Commits"]');
      },
    },
    {
      id: "portal-toggle",
      label: "Open web-chat portal (Cmd+\\)",
      trigger: () => page.keyboard.press(`${MOD}+Backslash`),
      cond: () => ({ kind: "visible", selector: 'aside[aria-label="Portal"]' }),
      after: async () => {
        await page.keyboard.press(`${MOD}+Backslash`);
        await waitGone('aside[aria-label="Portal"]');
      },
    },

    // ── Panels ─────────────────────────────────────────────────────────
    {
      id: "terminal-open",
      label: "Open terminal (toolbar) → pane visible",
      before: async () => {
        await spawnCooldown();
        await snapshotPanels();
      },
      trigger: () => hoverClick('[aria-label="Open terminal"]'),
      cond: () => ({ kind: "newPanel", inner: ".xterm" }),
      after: killNewPanels,
    },
    {
      id: "terminal-open-prompt",
      label: "Open terminal (Cmd+Alt+T) → shell prompt painted",
      before: async () => {
        await spawnCooldown();
        await snapshotPanels();
      },
      trigger: () => page.keyboard.press(`${MOD}+Alt+t`),
      cond: () => ({ kind: "newPanel", bufferText: "ilat%" }),
      after: killNewPanels,
    },
    {
      id: "agent-launch-launcher",
      label: "Launch Claude from launcher → agent output",
      before: async () => {
        await spawnCooldown();
        await snapshotPanels();
        await hoverClick('[aria-label^="Launcher"]');
        await waitVisible('[role="option"][aria-label^="Claude,"]');
      },
      trigger: () => hoverClick('[role="option"][aria-label^="Claude,"]'),
      cond: () => ({ kind: "newPanel", bufferText: READY_TOKEN }),
      after: killNewPanels,
    },
    {
      id: "agent-launch-shortcut",
      label: "Launch Claude (Cmd+Alt+C) → pane visible",
      before: async () => {
        await spawnCooldown();
        await snapshotPanels();
      },
      trigger: () => page.keyboard.press(`${MOD}+Alt+c`),
      cond: () => ({ kind: "newPanel", inner: ".xterm" }),
      after: killNewPanels,
    },
    {
      id: "browser-open",
      label: "Open browser panel (Cmd+Alt+B)",
      before: snapshotPanels,
      trigger: () => page.keyboard.press(`${MOD}+Alt+b`),
      cond: () => ({ kind: "newPanel", inner: '[data-testid="browser-address-bar"]' }),
      after: killNewPanels,
    },
    {
      id: "file-browser-open",
      label: "Open file browser panel",
      before: snapshotPanels,
      trigger: () => hoverClick('[aria-label="Browse files"]'),
      cond: () => ({ kind: "newPanel", inner: '[role="treeitem"]' }),
      after: killNewPanels,
    },
    {
      id: "file-open",
      label: "Open a file from the file browser",
      setup: async () => {
        await snapshotPanels();
        await hoverClick('[aria-label="Browse files"]');
        await waitVisible(TREE);
        const now = await panelIds();
        fileBrowserPanel = now.find((id) => !panelsBefore.includes(id)) ?? "";
      },
      trigger: (rep) =>
        hoverClick(
          `[data-panel-id="${fileBrowserPanel}"] [role="treeitem"]:has-text("${rep % 2 === 0 ? "bench-a.ts" : "bench-b.ts"}")`
        ),
      cond: (rep) => ({
        kind: "text",
        selector: `[data-panel-id="${fileBrowserPanel}"] .cm-content`,
        text: rep % 2 === 0 ? "BENCH_FILE_ALPHA" : "BENCH_FILE_BRAVO",
      }),
      cleanup: killNewPanels,
    },
    {
      id: "panel-maximize",
      label: "Maximize panel",
      trigger: () => hoverClick('[data-panel-location="grid"] [aria-label="Maximize"]'),
      cond: () => ({ kind: "visible", selector: '[aria-label="Restore grid view"]' }),
      after: async () => {
        await page.locator('[aria-label="Restore grid view"]').first().click();
        await waitVisible('[data-panel-location="grid"] [aria-label="Maximize"]');
      },
    },
    {
      id: "panel-restore",
      label: "Restore grid from maximized",
      before: async () => {
        await page.locator('[data-panel-location="grid"] [aria-label="Maximize"]').first().click();
        await waitVisible('[aria-label="Restore grid view"]');
      },
      trigger: () => hoverClick('[aria-label="Restore grid view"]'),
      cond: () => ({ kind: "visible", selector: '[data-panel-location="grid"]', minCount: 3 }),
    },
    {
      id: "panel-close",
      label: "Close a terminal panel",
      before: async () => {
        closePanel = await openTerminalUntimed();
        await settle();
      },
      trigger: () => hoverClick(`[data-panel-id="${closePanel}"] [data-testid="panel-close"]`),
      cond: () => ({ kind: "hidden", selector: `[data-panel-id="${closePanel}"]` }),
    },
    {
      id: "focus-next-panel",
      label: "Focus next panel (Ctrl+Tab)",
      trigger: () => page.keyboard.press("Control+Tab"),
      cond: () => ({ kind: "changed", selector: ".terminal-selected[data-panel-id]" }),
    },
    {
      id: "panel-to-dock",
      label: "Move panel to dock",
      before: async () => {
        dockPanel = await openTerminalUntimed();
        panelsBefore = (await panelIds()).filter((id) => id !== dockPanel);
      },
      trigger: () =>
        hoverClick(`[data-panel-id="${dockPanel}"] [data-testid="panel-move-to-dock"]`),
      cond: () => ({ kind: "visible", selector: `[data-dock-item-id="${dockPanel}"]` }),
      after: killNewPanels,
    },
    {
      id: "dock-chip-open",
      label: "Open docked panel preview",
      setup: async () => {
        dockPanel = await openTerminalUntimed();
        panelsBefore = (await panelIds()).filter((id) => id !== dockPanel);
        await page
          .locator(`[data-panel-id="${dockPanel}"] [data-testid="panel-move-to-dock"]`)
          .first()
          .click();
        await waitVisible(`[data-dock-item-id="${dockPanel}"]`);
      },
      before: async () => {
        for (let i = 0; i < 3; i++) {
          const open = await page
            .locator(`[data-dock-portal-target="${dockPanel}"] .xterm`)
            .first()
            .isVisible()
            .catch(() => false);
          if (!open) break;
          await escape();
          await page.waitForTimeout(250);
        }
      },
      trigger: () => hoverClick(`[data-dock-item-id="${dockPanel}"] [data-dock-item]`),
      cond: () => ({
        kind: "visible",
        selector: `[data-dock-portal-target="${dockPanel}"] .xterm`,
      }),
      // Escape goes to the focused terminal inside the preview; the chip
      // itself is the toggle.
      after: async () => {
        await page.waitForTimeout(600);
        await page.locator(`[data-dock-item-id="${dockPanel}"] [data-dock-item]`).first().click();
        await waitGone(`[data-dock-portal-target="${dockPanel}"] .xterm`);
        await page.waitForTimeout(600);
      },
      cleanup: killNewPanels,
    },
    {
      id: "terminal-keystroke",
      label: "Keystroke echo in focused shell",
      reps: REPS * 2,
      setup: async () => {
        await snapshotPanels();
        shellPanel = await openTerminalUntimed();
        await page.waitForFunction(
          (id) =>
            String((window as any).__daintreeReadTerminalBuffer?.(id) ?? "").includes("ilat%"),
          shellPanel,
          { timeout: 15_000 }
        );
        await page.locator(`[data-panel-id="${shellPanel}"] .xterm`).first().click();
        typed = "";
      },
      trigger: async () => {
        await page.keyboard.type("q");
        typed += "q";
      },
      // Unused: `measure` owns this scenario (the echo lands in xterm's
      // buffer, which no DOM condition can see under the WebGL renderer).
      cond: () => ({ kind: "text", selector: "body", text: "" }),
      measure: () => measureEcho(shellPanel, typed),
      cleanup: killNewPanels,
    },
  ];
}

async function measureKeystroke(sc: Scenario, rep: number): Promise<Sample> {
  await page.evaluate(() => {
    const w = window as any;
    w.__ilatKeyStart = 0;
    const h = (e: KeyboardEvent) => {
      if (!e.isTrusted) return;
      w.__ilatKeyStart = performance.timeOrigin + e.timeStamp;
      window.removeEventListener("keydown", h, true);
    };
    window.addEventListener("keydown", h, true);
  });
  const resultP = (async () => {
    await sc.trigger(rep);
    return sc.measure!(rep);
  })();
  const r = await resultP;
  return {
    rep,
    doneMs: r.doneMs,
    firstFrameMs: r.firstFrameMs,
    loafCount: 0,
    loafMaxMs: 0,
    maxFrameGapMs: 0,
    inputType: "keydown",
    timedOut: r.timedOut,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms);
    }),
  ]);
}

async function runScenario(sc: Scenario): Promise<ScenarioResult> {
  console.log(`[ilat-step] start ${sc.id}`);
  const reps = sc.reps ?? REPS;
  const samples: Sample[] = [];
  let error: string | undefined;
  try {
    if (sc.setup) await withTimeout(sc.setup(), 45_000, `${sc.id} setup`);
    for (let rep = 0; rep < reps; rep++) {
      if (sc.before) await withTimeout(sc.before(rep), 30_000, `${sc.id} before`);
      await withTimeout(settle(), 10_000, `${sc.id} settle`);
      let sample: Sample;
      if (sc.measure) {
        sample = await withTimeout(measureKeystroke(sc, rep), 20_000, `${sc.id} measure`);
      } else {
        const profiling = PROFILE.includes(sc.id) && rep < 2 && PROFILE_DIR;
        const cdp = profiling ? await page.context().newCDPSession(page) : null;
        if (cdp) {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
          await cdp.send("Profiler.start");
        }
        const tracing = TRACE.includes(sc.id) && rep === 1 && PROFILE_DIR;
        const traceCdp = tracing ? await page.context().newCDPSession(page) : null;
        const traceEvents: unknown[] = [];
        if (traceCdp) {
          traceCdp.on("Tracing.dataCollected", (e: any) => traceEvents.push(...e.value));
          await traceCdp.send("Tracing.start", {
            categories:
              "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,blink.user_timing,v8.execute",
            transferMode: "ReportEvents",
          });
        }
        await withTimeout(armProbe(page, sc.cond(rep), 15_000), 10_000, `${sc.id} arm`);
        await withTimeout(sc.trigger(rep), 20_000, `${sc.id} trigger`);
        const r = await withTimeout(probeResult(page), 25_000, `${sc.id} result`);
        if (traceCdp) {
          const done = new Promise<void>((res) =>
            traceCdp.once("Tracing.tracingComplete", () => res())
          );
          await traceCdp.send("Tracing.end");
          await done;
          mkdirSync(PROFILE_DIR, { recursive: true });
          writeFileSync(path.join(PROFILE_DIR, `${sc.id}.trace.json`), JSON.stringify(traceEvents));
          await traceCdp.detach();
        }
        if (cdp) {
          const { profile } = await cdp.send("Profiler.stop");
          mkdirSync(PROFILE_DIR, { recursive: true });
          writeFileSync(
            path.join(PROFILE_DIR, `${sc.id}-rep${rep}.cpuprofile`),
            JSON.stringify(profile)
          );
          await cdp.detach();
        }
        sample = { rep, ...r };
      }
      samples.push(sample);
      if (sc.after) await withTimeout(sc.after(rep), 30_000, `${sc.id} after`);
    }
    if (sc.cleanup) await withTimeout(sc.cleanup(), 45_000, `${sc.id} cleanup`);
  } catch (e) {
    error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    const alive = await withTimeout(
      page.evaluate(() => 1),
      5_000,
      "liveness"
    ).then(
      () => true,
      () => false
    );
    console.log(`[ilat-step] ${sc.id} failed: ${error} (renderer responsive: ${alive})`);
    if (OUT && alive) {
      await page
        .screenshot({ path: path.join(path.dirname(OUT), `fail-${LABEL}-${sc.id}.png`) })
        .catch(() => undefined);
    }
    if (!alive) error += " [renderer unresponsive]";
    await withTimeout(escape(3), 5_000, "escape").catch(() => undefined);
    // Later scenarios must not inherit this one's panels or overlays.
    if (sc.cleanup && alive) {
      await withTimeout(sc.cleanup(), 45_000, `${sc.id} cleanup after failure`).catch(
        () => undefined
      );
    }
  }
  const ok = samples.filter((s) => !s.timedOut);
  const warm = ok.filter((s) => s.rep > 0).map((s) => s.doneMs);
  const first = samples.find((s) => s.rep === 0);
  return {
    id: sc.id,
    label: sc.label,
    samples,
    firstMs: first && !first.timedOut ? first.doneMs : null,
    warmMedianMs: median(warm),
    warmP90Ms: pctile(warm, 90),
    warmMinMs: warm.length ? Math.min(...warm) : null,
    firstFrameMedianMs: median(ok.filter((s) => s.rep > 0).map((s) => s.firstFrameMs)),
    error:
      error ??
      (samples.some((s) => s.timedOut)
        ? `${samples.filter((s) => s.timedOut).length} timeouts`
        : undefined),
  };
}

async function measureProjectSwitch(rep: number): Promise<Sample> {
  const toOther = rep % 2 === 0;
  const fromId = toOther ? mainProjectId : otherProjectId;
  const toId = toOther ? otherProjectId : mainProjectId;
  const from = await pageForProject(fromId);
  const to = await pageForProject(toId);
  if (!from || !to) throw new Error("project views not both cached");
  const toName = toOther ? path.basename(fixture.otherDir) : path.basename(fixture.mainDir);
  await from.locator('[data-testid="project-switcher-trigger"]').first().click();
  const option = from
    .locator('[data-testid="project-switcher-palette"] [role="option"]')
    .filter({ hasText: toName })
    .first();
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await settle(from);
  await installProbe(to);
  await to.evaluate(
    ([name]) =>
      (window as any).__ilat.arm(
        {
          kind: "shown",
          inner: {
            kind: "all",
            conds: [
              {
                kind: "attr",
                selector: '[data-testid="project-switcher-trigger"]',
                attr: "aria-expanded",
                value: "false",
              },
              { kind: "visible", selector: "[data-worktree-row]" },
              { kind: "text", selector: '[data-testid="project-switcher-trigger"]', text: name },
            ],
          },
        },
        20_000
      ),
    [toName] as const
  );
  await armProbe(from, { kind: "hidden", selector: "body" }, 20_000);
  const box = await option.boundingBox();
  if (!box) throw new Error("no option box");
  await from.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await from.waitForTimeout(DWELL_MS);
  await from.mouse.down();
  await from.mouse.up();
  const inputTs = await from.evaluate(() => (window as any).__ilatState?.inputTs ?? null);
  if (inputTs === null) throw new Error("click not observed in source view");
  await to.evaluate((ts) => (window as any).__ilat.external(ts), inputTs);
  const r = await probeResult(to);
  page = to;
  await settle(to);
  return { rep, ...r };
}

const perfDescribe = process.env.RUN_PERF_INTERACTIONS ? test.describe.serial : test.describe.skip;

perfDescribe("Perf: everyday interaction latency", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    fixture = buildFixture();
    ctx = await launchApp({
      enableWebgl: true,
      env: {
        PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fixture.binDir,
        DAINTREE_IDENTITY_DEBUG_PASS: "1",
        DAINTREE_E2E_FAULT_MODE: "1",
        DAINTREE_E2E_SYSTEM_AVAILABLE_MEMORY_MB: "40000",
        ZDOTDIR: fixture.zdotdir,
        ...(process.env.ILAT_APP_VERBOSE ? { DAINTREE_VERBOSE: "1" } : {}),
        SHELL: "/bin/zsh",
      },
    });
    // The fixture's origin is a real github.com URL (forge surfaces only
    // render for a registered forge) and the seeded token is fake. Left
    // alone, background pollers reach the real API, collect 401s and put an
    // "Invalid GitHub token" prompt in the benchmark window — and add network
    // noise to the timings. Make api.github.com look offline instead; every
    // list the benchmark opens is served by an IPC stub anyway.
    await ctx.app.evaluate(() => {
      const g = globalThis as any;
      if (g.__ilatFetchPatched) return;
      g.__ilatFetchPatched = true;
      const orig = g.fetch.bind(g);
      g.fetch = (input: any, init?: any) => {
        const url = typeof input === "string" ? input : String(input?.url ?? input);
        if (/^https:\/\/(api\.)?github\.com\//.test(url)) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        return orig(input, init);
      };
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.otherDir, "other");
    otherProjectId = await ctx.window.evaluate(
      () => (window as any).__DAINTREE_INITIAL_PROJECT__?.id
    );
    ctx.window = await addAndSwitchToProject(
      ctx.app,
      ctx.window,
      fixture.mainDir,
      path.basename(fixture.mainDir)
    );
    page = ctx.window;
    mainProjectId = await page.evaluate(() => (window as any).__DAINTREE_INITIAL_PROJECT__?.id);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixture?.cleanup();
  });

  test("measures input → painted result for everyday interactions", async () => {
    test.setTimeout(3_600_000);

    await connectGitHub(ctx.app, page);
    await stubRepoStats(ctx.app, { issueCount: 42, prCount: 12, commitCount: 3 }, page);
    const issues = Array.from({ length: 30 }, (_, i) =>
      makeFixtureIssue(12000 - i, `Fixture issue ${i}: interaction latency sample title`)
    );
    await forgeLatencyStub("forge:list-issues", issues);
    await forgeLatencyStub(
      "forge:list-prs",
      Array.from({ length: 12 }, (_, i) =>
        fixturePR(12500 - i, `fix(area-${i}): fixture pull request`)
      )
    );
    await expect(page.locator('[data-testid="forge-stat-pill-issues"]')).not.toHaveAccessibleName(
      /Configure/,
      {
        timeout: 15_000,
      }
    );
    await seedNotificationHistory(
      page,
      Array.from({ length: 25 }, (_, i) => ({
        id: `ilat-${i}`,
        type: (i % 3 === 0 ? "success" : i % 3 === 1 ? "info" : "warning") as any,
        message: `Fixture notification ${i}`,
        title: `Agent finished task ${i}`,
        timestamp: Date.now() - i * 90_000,
      }))
    );

    // A realistic grid: two shells and an agent.
    for (let i = 0; i < 2; i++) await openTerminalUntimed();
    await dispatch("agent.launch", { agentId: "claude" });
    await page.waitForTimeout(3_000);
    await settle();

    const all = scenarios();
    const selected = ONLY.length ? all.filter((s) => ONLY.includes(s.id)) : all;
    const results: ScenarioResult[] = [];
    for (const sc of selected) {
      const r = await runScenario(sc);
      results.push(r);
      console.log(
        `[ilat] ${r.id.padEnd(28)} first=${r.firstMs?.toFixed(1) ?? "-"} warm-p50=${r.warmMedianMs?.toFixed(1) ?? "-"} p90=${r.warmP90Ms?.toFixed(1) ?? "-"} ff=${r.firstFrameMedianMs?.toFixed(1) ?? "-"}${r.error ? ` ERR ${r.error}` : ""}`
      );
    }

    if (!ONLY.length || ONLY.includes("project-switch-warm")) {
      const samples: Sample[] = [];
      let error: string | undefined;
      try {
        for (let rep = 0; rep < REPS; rep++) {
          samples.push(await withTimeout(measureProjectSwitch(rep), 45_000, "project switch"));
        }
      } catch (e) {
        error = e instanceof Error ? e.message.split("\n")[0] : String(e);
      }
      const warm = samples.filter((s) => !s.timedOut && s.rep > 0).map((s) => s.doneMs);
      const r: ScenarioResult = {
        id: "project-switch-warm",
        label: "Switch project (cached view, via switcher)",
        samples,
        firstMs: samples[0]?.doneMs ?? null,
        warmMedianMs: median(warm),
        warmP90Ms: pctile(warm, 90),
        warmMinMs: warm.length ? Math.min(...warm) : null,
        firstFrameMedianMs: median(samples.map((s) => s.firstFrameMs)),
        error,
      };
      results.push(r);
      console.log(
        `[ilat] ${r.id.padEnd(28)} first=${r.firstMs?.toFixed(1) ?? "-"} warm-p50=${r.warmMedianMs?.toFixed(1) ?? "-"} p90=${r.warmP90Ms?.toFixed(1) ?? "-"}${r.error ? ` ERR ${r.error}` : ""}`
      );
    }

    if (OUT) {
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(
        OUT,
        JSON.stringify(
          { label: LABEL, reps: REPS, generatedAt: new Date().toISOString(), results },
          null,
          2
        )
      );
    }
    // Reported, not gated on latency — but a scenario that produced no sample
    // measured nothing, and a green run must not hide that.
    expect(results.length, "PERF_INTERACTIONS_ONLY matched no scenario").toBeGreaterThan(0);
    const empty = results.filter((r) => !r.samples.some((sample) => !sample.timedOut));
    expect(empty.map((r) => `${r.id}: ${r.error ?? "no samples"}`)).toEqual([]);
  });
});
