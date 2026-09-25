/**
 * Pilot park editor visual-review harness.
 *
 * The park editor is a mode of the Pilot dialog, so it only exists over a
 * fleet: its header names a run, and its gate list is every OTHER run in the
 * fleet. Like `pilot-review`, the fleet is a synthetic snapshot pushed on the
 * real broadcast channel, and the projects underneath are real.
 *
 * The synthetic runs are unknown to main's fleet service, so a real submit is
 * rejected by the handler's known-run check — which is exactly the error state
 * this harness wants to see, reached through the real IPC path.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_PARK=1 DAINTREE_SHOT_THEME=daintree,bondi \
 *     npx playwright test --project=screenshots pilot-park-editor-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PARK   required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME  comma-separated theme ids (default: daintree)
 *   DAINTREE_SHOT_TAG    optional suffix, to keep rounds side by side
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *   DESIGN_CAPTURE_DIR   optional output directory
 *
 * Output: artifacts/pilot-park-shots/<theme>-<NN-slug>[-tag].png (gitignored),
 * or DESIGN_CAPTURE_DIR when set.
 */

import { test, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_PARK;
const THEMES = (process.env.DAINTREE_SHOT_THEME ?? "daintree")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "pilot-park-shots");

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const DIALOG = '[role="dialog"][aria-label="All agents"]';
/** The dialog renames itself while the editor owns it, so shots find it by content. */
const EDITOR_DIALOG = '[role="dialog"]:has([data-testid="pilot-park-editor"])';

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

const WORKSPACES = [
  { slug: "daintree", name: "Daintree", emoji: "🌴" },
  { slug: "daintree-website", name: "Daintree Website", emoji: "🌐" },
  { slug: "daintree-payments", name: "Daintree Payments", emoji: "💳" },
  { slug: "daintree-assistant", name: "Daintree Assistant", emoji: "🤖" },
  { slug: "assistant-backend", name: "Assistant Backend", emoji: "☁️" },
] as const;

const LONG_TITLE =
  "Rework the onboarding checklist so a first-run agent launch survives a missing CLI and a stale PATH";

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(root: string, slug: string): string {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), `# ${slug}\n`);
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return dir;
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

function mins(n: number): number {
  return Date.now() - n * 60_000;
}

function buildRuns(ids: Record<string, string>): unknown[] {
  const w = (slug: string) => ids[slug] ?? slug;
  return [
    {
      runId: "r-1",
      workspaceId: w("daintree"),
      agentId: "claude",
      agentState: "working",
      since: mins(33),
      spawnedAt: mins(40),
      title: "Daintree Assistant CLI version update",
      cwd: "/repos/daintree",
    },
    {
      runId: "r-2",
      workspaceId: w("daintree"),
      agentId: "claude",
      agentState: "working",
      since: mins(47),
      spawnedAt: mins(50),
      quietSince: mins(12),
      title: "Terminal fabric sharding spike",
      cwd: "/repos/daintree",
    },
    {
      runId: "r-3",
      workspaceId: w("daintree"),
      agentId: "codex",
      agentState: "completed",
      since: mins(6),
      spawnedAt: mins(60),
      title: "Worktree design iteration",
      cwd: "/repos/daintree",
    },
    {
      runId: "r-5",
      workspaceId: w("daintree-website"),
      agentId: "claude",
      agentState: "working",
      since: mins(36),
      spawnedAt: mins(38),
      title: "Pricing page copy pass",
      cwd: "/repos/daintree-website",
    },
    {
      runId: "r-13",
      workspaceId: w("daintree-website"),
      agentId: "gemini",
      agentState: "working",
      since: mins(14),
      spawnedAt: mins(20),
      title: LONG_TITLE,
      cwd: "/repos/daintree-website",
    },
    {
      runId: "r-6",
      workspaceId: w("daintree-payments"),
      agentId: "codex",
      agentState: "waiting",
      waitingReason: "approval",
      since: mins(38),
      spawnedAt: mins(45),
      title: "Stripe webhook retry backoff",
      cwd: "/repos/daintree-payments",
    },
    {
      runId: "r-7",
      workspaceId: w("daintree-payments"),
      agentId: "gemini",
      agentState: "waiting",
      waitingReason: "error",
      since: mins(21),
      spawnedAt: mins(30),
      title: "Invoice reconciliation job",
      cwd: "/repos/daintree-payments",
    },
    {
      runId: "r-8",
      workspaceId: w("daintree-assistant"),
      agentId: "claude",
      agentState: "working",
      since: mins(37),
      spawnedAt: mins(40),
      title: "Custom commands mirroring",
      cwd: "/repos/daintree-assistant",
    },
    {
      runId: "r-9",
      workspaceId: w("daintree-assistant"),
      agentId: "opencode",
      agentState: "waiting",
      waitingReason: "prompt",
      since: mins(90),
      spawnedAt: mins(120),
      title: "Alt-screen corruption repro",
      cwd: "/repos/daintree-assistant",
      park: { parkedAt: mins(55), note: "waiting on the xterm 6.1 beta", gateRunId: "r-2" },
    },
    {
      runId: "r-10",
      workspaceId: w("assistant-backend"),
      agentId: "claude",
      agentState: "working",
      since: mins(10),
      spawnedAt: mins(12),
      title: "Together rate-limit backoff",
      cwd: "/repos/assistant-backend",
    },
    {
      runId: "r-11",
      workspaceId: w("assistant-backend"),
      agentId: "grok",
      agentState: "waiting",
      waitingReason: "question",
      since: mins(65),
      spawnedAt: mins(70),
      title: "Usage metering schema",
      cwd: "/repos/assistant-backend",
      snooze: { snoozedAt: mins(15), snoozedUntil: Date.now() + 45 * 60_000 },
    },
    {
      runId: "r-12",
      workspaceId: w("assistant-backend"),
      agentId: "claude",
      agentState: "exited",
      since: mins(130),
      spawnedAt: mins(180),
      title: "Deploy smoke check",
      cwd: "/repos/assistant-backend",
    },
  ];
}

async function injectFleet(app: ElectronApplication, runs: unknown[]): Promise<void> {
  await app.evaluate(
    async ({ webContents }, payload) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        wc.send("fleet:snapshot-updated", payload);
      }
    },
    { runs, changedAt: Date.now(), degraded: false, lastSuccessfulAt: Date.now() }
  );
}

/** Same two races as `pilot-review`'s: a dropped first push, and main's own later empty one. */
async function holdFleet(
  page: Page,
  app: ElectronApplication,
  ids: Record<string, string>
): Promise<void> {
  const rows = page.getByTestId("pilot-row");
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await rows.count()) === 0) {
      await injectFleet(app, buildRuns(ids));
      await settle(page, 500);
      continue;
    }
    await settle(page, 600);
    if ((await rows.count()) > 0) return;
  }
  throw new Error("fleet never stayed on screen long enough to capture");
}

async function ensureProjects(page: Page, dirs: string[]): Promise<Record<string, string>> {
  return page.evaluate(
    async ({ entries }) => {
      const out: Record<string, string> = {};
      for (const entry of entries) {
        const existing = (await window.electron.project.getAll()).find(
          (p: { path: string; id: string }) => p.path === entry.dir
        );
        const id = existing?.id ?? (await window.electron.project.add(entry.dir))?.id;
        if (!id) continue;
        await window.electron.project.update(id, {
          name: entry.name,
          emoji: entry.emoji,
          lastOpened: entry.lastOpened,
        });
        out[entry.slug] = id;
      }
      return out;
    },
    {
      entries: WORKSPACES.map((ws, i) => ({
        slug: ws.slug,
        name: ws.name,
        emoji: ws.emoji,
        dir: dirs[i]!,
        lastOpened: Date.now() - i * 90 * 60_000,
      })),
    }
  );
}

/**
 * Shoot the dialog, but only after proving the state is still on screen.
 *
 * A main broadcast can empty the fleet mid-settle, which unmounts the editor
 * and drops the dialog back to its empty state — a plausible-looking PNG of
 * the wrong thing. `expect` names the selector that must still be visible.
 */
async function snap(page: Page, theme: string, slug: string, expect: string): Promise<void> {
  await settle(page);
  if (!(await page.locator(expect).first().isVisible())) {
    throw new Error(`${slug}: expected ${expect} to be visible before capture`);
  }
  const box = await page.locator(EDITOR_DIALOG).first().boundingBox();
  if (!box) throw new Error(`${slug}: dialog has no box`);
  const pad = 32;
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

/** Filter the list down to one run and open its park editor with the real chord. */
async function openEditorFor(
  page: Page,
  app: ElectronApplication,
  ids: Record<string, string>,
  query: string
): Promise<void> {
  await holdFleet(page, app, ids);
  await page.keyboard.press(`${MOD}+A`);
  await page.keyboard.type(query);
  await settle(page, 300);
  await page.keyboard.press("Alt+Enter");
  await page.getByTestId("pilot-park-editor").waitFor({ state: "visible", timeout: 5000 });
}

async function closeEditor(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.getByTestId("pilot-park-editor").waitFor({ state: "detached", timeout: 5000 });
  await settle(page, 200);
}

test("pilot park editor review — every state, per theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PARK is required for the park editor capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PARK=1 to run this capture");
  test.setTimeout(10 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repoRoot = mkdtempSync(path.join(tmpdir(), "daintree-parkshot-repos-"));
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-parkshot-"));
  const dirs = WORKSPACES.map((ws) => createRepo(repoRoot, ws.slug));

  try {
    for (const theme of THEMES) {
      let ctx: AppContext | undefined;
      try {
        ctx = await launchApp({
          userDataDir,
          screenshotScale: SCALE,
          windowSize: { width: 1680, height: 1050 },
          extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
        });

        const alreadyOpen = await ctx.window
          .evaluate(async () => (await window.electron.project.getCurrent())?.id ?? null)
          .catch(() => null);
        const page =
          alreadyOpen === null
            ? await openAndOnboardProject(ctx.app, ctx.window, dirs[0]!, WORKSPACES[0]!.name)
            : ctx.window;

        const ids = await ensureProjects(page, dirs);

        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await page
          .locator(SEL.worktree.mainCard)
          .waitFor({ state: "visible", timeout: T_LONG })
          .catch(() => {});
        await settle(page, 800);

        await injectFleet(ctx.app, buildRuns(ids));
        await settle(page, 400);

        await page.keyboard.press(`${MOD}+Alt+O`);
        await page.locator(DIALOG).waitFor({ state: "visible", timeout: 8000 });

        // 01 — a fresh park, as the chord leaves it: note focused, no gate.
        await openEditorFor(page, ctx.app, ids, "Pricing page");
        await snap(page, theme, "01-new-park", '[data-testid="pilot-park-editor"]');

        // 02 — filled in from the keyboard: a note, then a gate chosen with the arrows.
        await page.keyboard.type("Waiting on marketing to sign off the tier names");
        await page.keyboard.press("Tab");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await snap(page, theme, "02-filled-gate-focused", '[data-testid="pilot-park-editor"]');

        // 03 — the handler rejects the synthetic run, so this is the real error path.
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Enter");
        await page
          .locator('[data-testid="pilot-park-editor"] [role="alert"]')
          .waitFor({ state: "visible", timeout: 8000 });
        await snap(
          page,
          theme,
          "03-submit-error",
          '[data-testid="pilot-park-editor"] [role="alert"]'
        );
        await closeEditor(page);

        // 04 — editing an existing gated park: note and gate prefilled, Unpark offered.
        await openEditorFor(page, ctx.app, ids, "Alt-screen");
        await snap(page, theme, "04-edit-existing-park", '[data-testid="pilot-park-unpark"]');
        await closeEditor(page);

        // 05 — a title long enough to truncate, with the gate list driven to its end.
        await openEditorFor(page, ctx.app, ids, "onboarding checklist");
        await page.keyboard.press("Tab");
        await page.keyboard.press("End");
        await snap(page, theme, "05-long-title-gate-end", '[data-testid="pilot-park-editor"]');
        await closeEditor(page);
      } finally {
        if (ctx) await closeApp(ctx.app).catch(() => {});
      }
    }
  } finally {
    for (const dir of [repoRoot, userDataDir]) {
      if (!existsSync(dir)) continue;
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        console.warn(`[park-shots] could not remove ${dir}:`, String(error).split("\n")[0]);
      }
    }
  }
});
