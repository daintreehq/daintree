/**
 * Schedules view visual-review harness (#15984, #15986).
 *
 * Boots a real project with a second worktree, captures the empty view, then
 * seeds schedules through the real store (`window.electron.schedules.create`
 * from the project's own view, the only sender main accepts) and walks the
 * list, a schedule's run history, the editor for a new and an existing
 * schedule, validation and the delete confirmation. A custom Claude preset
 * that skips permission prompts is seeded through agent settings, so the
 * editor shows the permission warning for the bare agent and not for the
 * preset.
 *
 * Run history: a fake Claude CLI goes first on PATH, so Run now launches a
 * real tracked run that stays open, and a schedule whose preset is gone shows
 * a refused Run now. Past runs, every outcome a run can settle on, are written
 * into the run history's own SQLite table (`scheduled_runs`) with the system
 * `sqlite3` CLI once the history is open, since no view can write a run. One
 * of them points at a live shell pane, so it offers Open.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_SCHEDULES=1 DAINTREE_SHOT_THEME=daintree,bondi \
 *     npx playwright test --project=screenshots schedules-view-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SCHEDULES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME      comma-separated theme ids (default: daintree)
 *   DAINTREE_SHOT_TAG        optional suffix, to keep rounds side by side
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *   DESIGN_CAPTURE_DIR       optional output directory
 *
 * Output: artifacts/schedules-shots/<theme>-<NN-slug>[-tag].png (gitignored),
 * or DESIGN_CAPTURE_DIR when set.
 */

import { test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { dispatchAction } from "../helpers/actions";
import { SEL } from "../helpers/selectors";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_SCHEDULES;
const THEMES = (process.env.DAINTREE_SHOT_THEME ?? "daintree")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "schedules-shots");

const DIALOG = '[data-testid="schedules-dialog"]';
const UNATTENDED_PRESET = "schedules-shot-unattended";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(root: string): { dir: string; worktreeDir: string } {
  const dir = path.join(root, "acme-api");
  mkdirSync(dir, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# acme-api\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  const worktreeDir = path.join(root, "acme-api-flaky-tests");
  git(`worktree add -b fix/flaky-tests "${worktreeDir}" main`, dir);
  return { dir, worktreeDir };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, theme: string, slug: string, expect: string): Promise<void> {
  await settle(page);
  if (!(await page.locator(expect).first().isVisible())) {
    throw new Error(`${slug}: expected ${expect} to be visible before capture`);
  }
  const box = await page.locator(DIALOG).first().boundingBox();
  if (!box) throw new Error(`${slug}: dialog has no box`);
  const pad = 24;
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const file = path.join(OUTPUT_DIR, `${theme}-${slug}${TAG}.png`);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
  if (!existsSync(file) || statSync(file).size < 4000) {
    throw new Error(`${slug}: capture missing or implausibly small`);
  }
}

/** Scroll the dialog body to its end, so the lower sections of the editor are in frame. */
async function scrollBodyToEnd(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    if (!dialog) throw new Error("schedules dialog missing");
    const scrollers = [...dialog.querySelectorAll<HTMLElement>("*")].filter(
      (el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible"
    );
    const body = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!body) throw new Error("schedules dialog has nothing to scroll");
    body.scrollTop = body.scrollHeight;
  }, DIALOG);
}

async function openView(page: Page, scheduleId?: string): Promise<void> {
  const result = await dispatchAction(
    page,
    "schedules.open",
    scheduleId ? { scheduleId } : undefined,
    {
      source: "user",
    }
  );
  if (!result.ok) throw new Error(`schedules.open failed: ${JSON.stringify(result)}`);
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 8000 });
}

async function closeView(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  // A page with unsaved edits asks before it lets go.
  const discard = page.getByRole("button", { name: "Discard changes" });
  if (await discard.isVisible({ timeout: 1000 }).catch(() => false)) await discard.click();
  await page.locator(DIALOG).waitFor({ state: "detached", timeout: 8000 });
  await settle(page, 200);
}

async function seedPreset(page: Page): Promise<void> {
  await page.evaluate(async (presetId) => {
    type Entry = Record<string, unknown>;
    const settings = (await window.electron.agentSettings.get()) as {
      agents?: Record<string, Entry | undefined>;
    };
    const entry = settings.agents?.claude ?? {};
    await window.electron.agentSettings.set("claude", {
      ...entry,
      customPresets: [
        {
          id: presetId,
          name: "Unattended",
          description: "Skips permission prompts for runs nobody is watching",
          dangerousMode: "on",
        },
      ],
    });
  }, UNATTENDED_PRESET);
}

interface SeededSchedules {
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  first: string;
  withCheck: string;
  paused: string;
  noRuns: string;
  presetGone: string;
}

/** Six schedules covering the list's shapes; returns the ids the walk opens. */
async function seedSchedules(page: Page): Promise<SeededSchedules> {
  const { id: worktreeId, path: worktreePath } = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const all = (await window.electron.worktree.getAll()) as Array<{
        id: string;
        path: string;
        isMainWorktree?: boolean;
      }>;
      const other = all.find((worktree) => !worktree.isMainWorktree);
      if (other) return { id: other.id, path: other.path };
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("second worktree never appeared");
  });

  return page
    .evaluate(
      async ({ worktreeId, presetId }) => {
        const make = async (input: Parameters<typeof window.electron.schedules.create>[0]) => {
          const outcome = await window.electron.schedules.create(input);
          if (outcome.status !== "saved") throw new Error(JSON.stringify(outcome));
          return outcome.schedule;
        };
        const first = await make({
          name: "Nightly dependency check",
          cron: "0 2 * * *",
          launch: {
            agentId: "claude",
            presetId,
            prompt:
              "Check for outdated dependencies, update the ones with no breaking changes, run the tests, and open a pull request with what changed.",
          },
        });
        await make({
          name: "Weekday PR triage",
          cron: "0 9 * * 1-5",
          launch: {
            agentId: "codex",
            prompt:
              "Summarise every open pull request that's waiting on review and who it's waiting on.",
          },
          policies: { onDone: "background" },
        });
        const withCheck = await make({
          name: "Flaky test sweep",
          cron: "*/30 * * * *",
          launch: {
            agentId: "claude",
            presetId,
            worktreeId,
            prompt:
              "Run the integration suite three times and file what failed only some of the time.",
          },
          policies: {
            overlap: "replace",
            precondition: { command: "git fetch -q && ! git diff --quiet HEAD @{u}" },
          },
        });
        const paused = await make({
          name: "Monthly licence audit",
          cron: "0 10 1 * *",
          launch: {
            agentId: "claude",
            prompt: "List every dependency whose licence changed this month.",
          },
        });
        await window.electron.schedules.setEnabled(paused.id, false);
        const noRuns = await make({
          name: "Rebuild the documentation search index and post the broken-link report to the team channel",
          cron: "15 3 */2 * 1-5",
          launch: {
            agentId: "claude",
            prompt: "Rebuild the docs search index, then report broken links.",
          },
          policies: { missedRuns: "skip" },
        });
        // A preset deleted after the schedule was made: Run now is refused at the
        // spawn, so nothing starts, and the refusal is what the page shows.
        const presetGone = await make({
          name: "Release notes draft",
          cron: "0 16 * * 5",
          launch: {
            agentId: "claude",
            presetId: "schedules-shot-deleted-preset",
            prompt: "Draft release notes from this week's merged pull requests.",
          },
        });
        const snapshot = await window.electron.schedules.list();
        if (!snapshot) throw new Error("schedules snapshot missing");
        return {
          projectId: snapshot.projectId,
          first: first.id,
          withCheck: withCheck.id,
          paused: paused.id,
          noRuns: noRuns.id,
          presetGone: presetGone.id,
        };
      },
      { worktreeId, presetId: UNATTENDED_PRESET }
    )
    .then((ids) => ({ ...ids, worktreeId, worktreePath }));
}

type RunRecord = Record<string, unknown> & {
  id: string;
  scheduleId: string;
  origin: { occurrenceKey: string | null };
  terminalId: string | null;
  createdAt: number;
};

/** The last `count` instants of a daily hh:mm in this machine's zone, newest first. */
function dailyOccurrences(hour: number, minute: number, count: number, now: number): number[] {
  const first = new Date(now);
  first.setHours(hour, minute, 0, 0);
  if (first.getTime() > now - 30 * MINUTE) first.setDate(first.getDate() - 1);
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(first);
    at.setDate(first.getDate() - i);
    return at.getTime();
  });
}

let runSeq = 0;
function runRecord(input: {
  scheduleId: string;
  projectId: string;
  trigger: "scheduled" | "catch-up" | "os-launch";
  dueAt: number;
  coalescedAfter?: number;
  startedAt: number | null;
  settledAt: number;
  outcome: string;
  evidence: Record<string, unknown>;
  pty: "exited" | "running" | "not-started";
  pane: "closed" | "open" | "none";
  terminalId?: string | null;
  resume: {
    sessionId: string | null;
    cwd: string;
    worktreeId: string | null;
  } | null;
}): RunRecord {
  runSeq += 1;
  const id = `shot-run-${runSeq}`;
  const occurrenceKey = new Date(input.dueAt).toISOString();
  const origin =
    input.trigger === "catch-up"
      ? {
          trigger: "catch-up",
          dueAt: input.dueAt,
          occurrenceKey,
          coalesced: { after: input.coalescedAfter ?? input.dueAt - DAY, through: input.dueAt },
        }
      : input.trigger === "os-launch"
        ? { trigger: "os-launch", dueAt: input.dueAt, occurrenceKey, coalesced: null }
        : { trigger: "scheduled", dueAt: input.dueAt, occurrenceKey, coalesced: null };
  const terminalId =
    input.terminalId === undefined
      ? input.pty === "not-started"
        ? null
        : `shot-terminal-${runSeq}`
      : input.terminalId;
  const pty =
    input.pty === "not-started"
      ? { state: "not-started" }
      : input.pty === "running"
        ? { state: "running", startedAt: input.startedAt }
        : {
            state: "exited",
            startedAt: input.startedAt,
            exitedAt: input.settledAt,
            exitCode:
              input.evidence.kind === "exit"
                ? (input.evidence.exitCode as number | null)
                : input.evidence.kind === "handback"
                  ? 0
                  : null,
            signal: null,
          };
  const pane =
    input.pane === "none"
      ? { state: "none" }
      : input.pane === "open"
        ? { state: "open", since: input.startedAt }
        : { state: "closed", closedAt: input.settledAt + MINUTE };
  return {
    id,
    scheduleId: input.scheduleId,
    projectId: input.projectId,
    origin,
    createdAt: (input.startedAt ?? input.dueAt) - 1000,
    terminalId,
    terminalSpawnedAt: input.pty === "not-started" ? null : input.startedAt,
    settlement: {
      state: "settled",
      settledAt: input.settledAt,
      outcome: input.outcome,
      evidence: input.evidence,
    },
    process: { agent: { state: "not-started" }, pty },
    pane,
    resume: input.resume && {
      agentId: "claude",
      agentSessionId: input.resume.sessionId,
      cwd: input.resume.cwd,
      worktreeId: input.resume.worktreeId,
      agentLaunchFlags: [],
      agentModelId: null,
      agentPresetId: UNATTENDED_PRESET,
    },
  };
}

/** Writes runs straight into the run history's table; rows that don't parse are skipped by main. */
function insertRuns(userDataDir: string, projectId: string, runs: RunRecord[]): void {
  const dbPath = path.join(userDataDir, "daintree.db");
  if (!existsSync(dbPath)) throw new Error(`run history database missing at ${dbPath}`);
  const quote = (value: string | number | null) =>
    value === null
      ? "NULL"
      : typeof value === "number"
        ? String(value)
        : `'${value.replace(/'/g, "''")}'`;
  const rows = runs.map((run) => {
    const settlement = run.settlement as { state: string };
    const pty = (run.process as { pty: { state: string } }).pty;
    const live = settlement.state === "open" || pty.state === "running" ? 1 : 0;
    return `INSERT INTO scheduled_runs (id, project_id, schedule_id, occurrence_key, terminal_id, live, created_at, record) VALUES (${[
      quote(run.id),
      quote(projectId),
      quote(run.scheduleId),
      quote(run.origin.occurrenceKey),
      quote(run.terminalId),
      String(live),
      String(run.createdAt),
      quote(JSON.stringify(run)),
    ].join(", ")});`;
  });
  const sqlFile = path.join(userDataDir, "seed-runs.sql");
  writeFileSync(sqlFile, `BEGIN;\n${rows.join("\n")}\nCOMMIT;\n`);
  execSync(`sqlite3 -cmd ".timeout 8000" "${dbPath}" < "${sqlFile}"`, { stdio: "pipe" });
}

/** A nightly schedule's last nine days: every outcome, trigger and action a run can show. */
function nightlyHistory(
  ids: SeededSchedules,
  repoDir: string,
  liveTerminalId: string,
  now: number
) {
  const due = dailyOccurrences(2, 0, 9, now);
  const at = (day: number, minutes: number) => due[day]! + minutes * MINUTE;
  const main = (sessionId: string | null) => ({ sessionId, cwd: repoDir, worktreeId: null });
  const base = { scheduleId: ids.first, projectId: ids.projectId };
  return [
    runRecord({
      ...base,
      trigger: "scheduled",
      dueAt: due[0]!,
      startedAt: at(0, 0.1),
      settledAt: at(0, 14.3),
      outcome: "done",
      evidence: {
        kind: "handback",
        report: "done",
        summary:
          "Updated vitest, zod and 2 other packages with no breaking changes; tests pass. Opened #812.",
        truncated: false,
      },
      pty: "exited",
      pane: "closed",
      resume: main("9b2f6c1e-8a43-4d0b-9e57-2c6f1d3a7b10"),
    }),
    runRecord({
      ...base,
      trigger: "scheduled",
      dueAt: due[1]!,
      startedAt: at(1, 0.1),
      settledAt: at(1, 9.2),
      outcome: "needs-you",
      evidence: {
        kind: "handback",
        report: "needs-you",
        summary:
          "react-router 8 drops the loader API we use in 14 routes. I stopped before changing them; notes are in UPGRADE.md.",
        truncated: false,
      },
      pty: "running",
      pane: "open",
      terminalId: liveTerminalId,
      resume: main("4e0a1d77-3b6c-4f2e-8d19-a5c2e9f04b33"),
    }),
    runRecord({
      ...base,
      trigger: "catch-up",
      dueAt: due[2]!,
      coalescedAfter: due[4]!,
      startedAt: at(2, 342),
      settledAt: at(2, 353),
      outcome: "done",
      evidence: { kind: "handback", report: "done", summary: null, truncated: false },
      pty: "exited",
      pane: "closed",
      resume: main("c71d5e02-6f98-4a1b-b3e4-0d8f2a6c9e51"),
    }),
    runRecord({
      ...base,
      trigger: "scheduled",
      dueAt: due[4]!,
      startedAt: at(4, 0.1),
      settledAt: at(4, 3.4),
      outcome: "failed",
      evidence: { kind: "exit", process: "pty", exitCode: 1, signal: null },
      pty: "exited",
      pane: "closed",
      resume: main("1f6b8e3a-92d4-4c07-a8b5-7e3d0c2f6a98"),
    }),
    runRecord({
      ...base,
      trigger: "scheduled",
      dueAt: due[5]!,
      startedAt: null,
      settledAt: at(5, 0.05),
      outcome: "skipped",
      evidence: {
        kind: "skip",
        reason: { kind: "precondition", exitCode: 1, signal: null, error: null },
      },
      pty: "not-started",
      pane: "none",
      resume: null,
    }),
    runRecord({
      ...base,
      trigger: "os-launch",
      dueAt: due[6]!,
      startedAt: at(6, 0.6),
      settledAt: at(6, 300),
      outcome: "interrupted",
      evidence: { kind: "interrupted" },
      pty: "exited",
      pane: "closed",
      resume: main("6a3c9f14-0e2b-4d8a-91f7-b4e5c8d2a061"),
    }),
    runRecord({
      ...base,
      trigger: "scheduled",
      dueAt: due[7]!,
      startedAt: at(7, 0.1),
      settledAt: at(7, 21),
      outcome: "lost",
      evidence: { kind: "lost" },
      pty: "exited",
      pane: "closed",
      resume: main(null),
    }),
    runRecord({
      ...base,
      trigger: "scheduled",
      dueAt: due[8]!,
      startedAt: null,
      settledAt: at(8, 0.02),
      outcome: "failed",
      evidence: {
        kind: "launch-error",
        message: "Claude couldn't start: its CLI wasn't found on PATH",
      },
      pty: "not-started",
      pane: "none",
      resume: null,
    }),
  ];
}

/** A half-hourly sweep's last six hours in another worktree: the history at its densest. */
function sweepHistory(ids: SeededSchedules, now: number) {
  // The newest slot is one whose run (up to 10 minutes) has had time to finish.
  const slot = Math.floor((now - 12 * MINUTE) / (30 * MINUTE)) * 30 * MINUTE;
  const base = { scheduleId: ids.withCheck, projectId: ids.projectId };
  const inWorktree = (sessionId: string | null, worktreeId = ids.worktreeId) => ({
    sessionId,
    cwd: ids.worktreePath,
    worktreeId,
  });
  const summaries = [
    "3 runs, all green. Nothing flaky this time.",
    "auth.spec.ts failed 1 of 3 runs (token refresh timing). Filed #904.",
    "3 runs, all green.",
  ];
  return Array.from({ length: 12 }, (_, i) => {
    const dueAt = slot - i * 30 * MINUTE;
    const skipped = i % 4 === 1;
    if (skipped) {
      return runRecord({
        ...base,
        trigger: "scheduled",
        dueAt,
        startedAt: null,
        settledAt: dueAt + 2000,
        outcome: "skipped",
        evidence: {
          kind: "skip",
          reason: { kind: "precondition", exitCode: 1, signal: null, error: null },
        },
        pty: "not-started",
        pane: "none",
        resume: null,
      });
    }
    return runRecord({
      ...base,
      trigger: "scheduled",
      dueAt,
      startedAt: dueAt + 3000,
      settledAt: dueAt + (6 + (i % 5)) * MINUTE,
      outcome: "done",
      evidence: {
        kind: "handback",
        report: "done",
        summary: summaries[i % summaries.length],
        truncated: false,
      },
      pty: "exited",
      pane: "closed",
      resume:
        i === 6
          ? inWorktree("d4b1e8f2-5a37-4c90-b6e2-81f0a9c3d725", "worktree-since-removed")
          : i === 10
            ? inWorktree(null)
            : inWorktree(`0c9e${String(i).padStart(4, "0")}-1d2e-4f3a-8b5c-6d7e8f9a0b1c`),
    });
  });
}

/** Open a terminal pane and return its id, for a run that still has one. */
async function openShellPane(page: Page): Promise<string> {
  const created = await dispatchAction<{ terminalId?: string }>(page, "terminal.new");
  if (!created.ok) throw new Error(`terminal.new failed: ${JSON.stringify(created.error)}`);
  const id = created.result?.terminalId;
  if (!id) throw new Error("terminal.new gave no terminal id");
  await page.locator(`[data-panel-id="${id}"]`).waitFor({ state: "visible", timeout: T_LONG });
  return id;
}

test("schedules view review — every state, per theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SCHEDULES is required for the schedules capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SCHEDULES=1 to run this capture");
  test.setTimeout(10 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const theme of THEMES) {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "daintree-schedshot-repos-"));
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-schedshot-"));
    const { dir } = createRepo(repoRoot);
    const fakeBinDir = installFakeAgent(dir);
    let ctx: AppContext | undefined;
    try {
      ctx = await launchApp({
        userDataDir,
        screenshotScale: SCALE,
        windowSize: { width: 1680, height: 1050 },
        env: fakeAgentEnv(fakeBinDir),
        extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      });
      const page = await openAndOnboardProject(ctx.app, ctx.window, dir, "Acme API");
      await seedPreset(page);
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      await page
        .locator(SEL.worktree.mainCard)
        .waitFor({ state: "visible", timeout: T_LONG })
        .catch(() => {});
      await settle(page, 800);

      // 01 — no schedules yet: what a schedule is, and the way to make one.
      await openView(page);
      await snap(page, theme, "01-empty", `${DIALOG} >> text=Run an agent on a schedule`);
      await closeView(page);

      const ids = await seedSchedules(page);
      await settle(page, 300);

      // The list's first read opens the run history, so it exists before runs are written.
      await openView(page);
      await page.locator(`${DIALOG} >> text=Monthly licence audit`).waitFor({ timeout: 8000 });
      await closeView(page);

      const shellPaneId = await openShellPane(page);
      const now = Date.now();
      insertRuns(userDataDir, ids.projectId, [
        ...nightlyHistory(ids, dir, shellPaneId, now),
        ...sweepHistory(ids, now),
      ]);

      // Run now for real: the fake Claude starts and stays, so the run is open.
      const started = await page.evaluate((id) => window.electron.schedules.runNow(id), ids.first);
      if (started.status !== "started") {
        throw new Error(`Run now didn't start: ${JSON.stringify(started)}`);
      }
      // The run is real once the history sees its terminal running; anything else is a failed seed.
      const runState = await page.evaluate(
        async ({ scheduleId, runId }) => {
          for (let attempt = 0; attempt < 60; attempt++) {
            const runs = await window.electron.scheduledRuns.listBySchedule({ scheduleId });
            const run = runs.find((candidate) => candidate.id === runId);
            if (
              run &&
              (run.process.pty.state === "running" || run.settlement.state === "settled")
            ) {
              return JSON.stringify({ pty: run.process.pty, settlement: run.settlement });
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          return "timeout";
        },
        { scheduleId: ids.first, runId: started.runId }
      );
      if (!runState.includes('"state":"running"') || runState.includes('"settled"')) {
        throw new Error(`Run now's run isn't running: ${runState}`);
      }
      await settle(page, 1500);

      // 02 — the list: on, paused, every-N, custom cron, another worktree, a long name, last runs.
      await openView(page);
      await snap(page, theme, "02-list", `${DIALOG} >> text=Monthly licence audit`);

      // 03 — a new schedule: #15974's defaults, and the bare agent's permission warning.
      await page.getByRole("button", { name: "New schedule" }).first().click();
      await snap(
        page,
        theme,
        "03-new-top",
        `${DIALOG} >> text=This run will stop at permission prompts`
      );

      // 04 — Create with nothing filled in and a cron out of range: every field says what's wrong.
      await page.locator(DIALOG).getByRole("combobox", { name: "Repeats" }).click();
      await page.getByRole("option", { name: "Custom cron expression" }).click();
      const cadence = page.locator(`${DIALOG} input[placeholder="0 9 * * *"]`);
      await cadence.fill("61 9 * * *");
      await page.getByRole("button", { name: "Create schedule" }).click();
      await snap(page, theme, "04-new-invalid", `${DIALOG} >> text=Name the schedule`);
      await scrollBodyToEnd(page);
      await snap(
        page,
        theme,
        "05-new-invalid-bottom",
        `${DIALOG} >> text=When the agent reports done`
      );
      await closeView(page);

      // 06 — a schedule opened straight to its page, as another surface would: its runs.
      await openView(page, ids.first);
      await page.getByText("react-router 8 drops the loader API").waitFor({ timeout: 8000 });
      await snap(page, theme, "06-runs-top", `${DIALOG} >> text=Run now`);
      await scrollBodyToEnd(page);
      await snap(page, theme, "07-runs-bottom", `${DIALOG} >> text=Didn't start`);

      // 08 — Edit schedule: the editor, reached from the schedule's page.
      await page.getByRole("button", { name: "Edit schedule" }).click();
      await page.locator(`${DIALOG} [data-schedule-focus="name"]`).waitFor({ timeout: 5000 });
      await snap(page, theme, "08-edit-top", `${DIALOG} >> text=What runs`);
      await scrollBodyToEnd(page);
      await snap(page, theme, "09-edit-bottom", `${DIALOG} >> text=Delete schedule…`);

      // 10 — delete asks first, naming the schedule.
      await page.getByRole("button", { name: "Delete schedule…" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "visible", timeout: 5000 });
      await snap(page, theme, "10-delete-confirm", '[role="alertdialog"]');
      await page.keyboard.press("Escape");
      await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5000 });

      // 11 — an edit, then Back: the draft isn't thrown away without asking.
      await page
        .locator(`${DIALOG} [data-schedule-focus="name"]`)
        .fill("Nightly dependency check and audit");
      await page.getByRole("button", { name: "Back to schedule" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "visible", timeout: 5000 });
      await snap(page, theme, "11-discard-confirm", '[role="alertdialog"]');
      await page.getByRole("button", { name: "Discard changes" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5000 });
      await closeView(page);

      // 12 — a half-hourly sweep in another worktree: the history at its densest, with a
      // run whose worktree is gone and one that kept no session.
      await openView(page, ids.withCheck);
      await page.getByText("Worktree removed").first().waitFor({ timeout: 8000 });
      await snap(page, theme, "12-runs-dense", `${DIALOG} >> text=Worktree removed`);

      // 13 — the same schedule's editor, with its precondition on and Replace.
      await page.getByRole("button", { name: "Edit schedule" }).click();
      await page.locator(`${DIALOG} [data-schedule-focus="name"]`).waitFor({ timeout: 5000 });
      await scrollBodyToEnd(page);
      await snap(
        page,
        theme,
        "13-check-on-bottom",
        `${DIALOG} >> text=Runs in a shell in the schedule's worktree`
      );
      await closeView(page);

      // 14 — no runs yet, on a paused schedule and an enabled one.
      await openView(page, ids.paused);
      await snap(page, theme, "14-runs-empty-paused", `${DIALOG} >> text=Start the first run`);
      await closeView(page);
      await openView(page, ids.noRuns);
      await snap(page, theme, "15-runs-empty", `${DIALOG} >> text=/^First run in/`);
      await closeView(page);

      // 16 — Run now refused: the schedule's preset is gone, so nothing starts, and the
      // refusal lands in the history as its newest run.
      await openView(page, ids.presetGone);
      await page.getByText("Missing preset").waitFor({ timeout: 8000 });
      await page.getByRole("button", { name: "Run now" }).click();
      await page
        .locator(`${DIALOG} li`)
        .getByText("Failed to launch", { exact: true })
        .waitFor({ timeout: 15_000 });
      await snap(page, theme, "16-run-now-refused", `${DIALOG} >> text=Failed to launch`);
      await closeView(page);

      // 17 — a run arriving while the pointer is over the history waits behind
      // "Show 1 new run" instead of pushing the rows down under it.
      await openView(page, ids.first);
      await page.getByText("react-router 8 drops the loader API").waitFor({ timeout: 8000 });
      await page.getByText("react-router 8 drops the loader API").hover();
      const again = await page.evaluate((id) => window.electron.schedules.runNow(id), ids.first);
      if (again.status !== "started") throw new Error(`Second Run now: ${JSON.stringify(again)}`);
      await page.getByRole("button", { name: "Show 1 new run" }).waitFor({ timeout: 15_000 });
      await snap(page, theme, "17-held-arrival", `${DIALOG} >> text=Show 1 new run`);
      await closeView(page);
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      for (const target of [repoRoot, userDataDir]) {
        if (!existsSync(target)) continue;
        try {
          rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
          console.warn(
            `[schedule-shots] could not remove ${target}:`,
            String(error).split("\n")[0]
          );
        }
      }
    }
  }
});
