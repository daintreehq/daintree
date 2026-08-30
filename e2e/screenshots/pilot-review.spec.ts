/**
 * Agent Pilot visual-review harness.
 *
 * The fleet overview is the one palette whose whole content is other people's
 * work in flight, so it cannot be reviewed on an empty app: the bands, the
 * demand chips, the park notes and the stall cue only exist when there is a
 * fleet making them. This harness manufactures one — several projects, and a
 * run in every band — and writes a tightly-cropped PNG of the surface so the
 * design can be judged against rendered pixels.
 *
 * The fleet is injected as a snapshot on the real broadcast channel rather than
 * grown from real agents. `FleetSnapshot` is main's whole contract with this
 * surface, so a synthetic one exercises exactly the code path a real fleet
 * does, and it lets a run be forty minutes old without the test waiting forty
 * minutes. The projects underneath are real, because their names, emoji and
 * recency come from the project store and not from the snapshot.
 *
 * Opt-in only, like its palette-review sibling:
 *
 *   DAINTREE_SHOT_THEME=daintree npx playwright test --project=screenshots pilot-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  theme id, or `all` to sweep every built-in theme
 *   DAINTREE_SHOT_TAG    optional suffix, to keep before/after rounds side by side
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: artifacts/pilot-shots/<theme>/<NN-slug>[-tag].png (gitignored).
 */

import { test, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { BUILT_IN_THEME_SOURCES } from "../../shared/theme/builtInThemeSources";

const THEME_INPUT = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const ARTIFACT_ROOT = path.resolve(process.cwd(), "artifacts", "pilot-shots");

const THEMES =
  THEME_INPUT === "all"
    ? BUILT_IN_THEME_SOURCES.map((t) => t.id)
    : THEME_INPUT
      ? [THEME_INPUT]
      : [];

const MOD = process.platform === "darwin" ? "Meta" : "Control";

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

/** The projects the fleet is spread across, in the order they are opened. */
const WORKSPACES = [
  { slug: "daintree", name: "Daintree", emoji: "🌴" },
  { slug: "daintree-website", name: "Daintree Website", emoji: "🌐" },
  { slug: "daintree-payments", name: "Daintree Payments", emoji: "💳" },
  { slug: "daintree-assistant", name: "Daintree Assistant", emoji: "🤖" },
  { slug: "assistant-backend", name: "Assistant Backend", emoji: "☁️" },
] as const;

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

async function snapSurface(
  page: Page,
  outDir: string,
  slug: string,
  selector: string,
  pad = 48
): Promise<void> {
  await settle(page);
  const box = await page.locator(selector).first().boundingBox();
  const file = path.join(outDir, `${slug}${TAG}.png`);
  if (!box) {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
    return;
  }
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
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
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await settle(page, 200);
  await page.keyboard.press("Escape").catch(() => {});
  await settle(page, 200);
}

/**
 * Push a fabricated fleet onto the real broadcast channel from main.
 *
 * Every renderer gets it, which is what the service itself does — the pilot
 * lives in whichever project view is active, and targeting one by hand would
 * make the harness guess at the window model.
 */
async function injectFleet(app: ElectronApplication, runs: unknown[]): Promise<void> {
  await app.evaluate(
    async ({ webContents }, payload) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        wc.send("fleet:snapshot-updated", payload);
      }
    },
    {
      runs,
      changedAt: Date.now(),
      degraded: false,
      lastSuccessfulAt: Date.now(),
    }
  );
}

/** Minutes ago, as an epoch stamp. */
function mins(n: number): number {
  return Date.now() - n * 60_000;
}

/**
 * A fleet with a run in every band, spread the way a real morning is: most of
 * the work running, one thing asking, one thing broken, one thing shelved.
 */
function buildRuns(ids: Record<string, string>): unknown[] {
  const w = (slug: string) => ids[slug] ?? slug;
  return [
    // Daintree — the current project. Working, a stalled worker, a hand-back.
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
      runId: "r-4",
      workspaceId: w("daintree"),
      agentId: "claude",
      agentState: "working",
      since: mins(2),
      spawnedAt: mins(3),
      title: "Issues dropdown design review",
      cwd: "/repos/daintree",
    },
    // Website — one plain worker.
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
    // Payments — the demand, and the failure.
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
    // Assistant — a worker and a parked run carrying its reason.
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
      park: { parkedAt: mins(55), note: "waiting on the xterm 6.1 beta" },
    },
    // Backend — a worker, a snooze and an exited shell.
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

/**
 * Register the five projects and stamp their identity, idempotently.
 *
 * Re-run after every launch rather than once: the store persists in the shared
 * user-data directory, so the second launch finds them all and only re-reads
 * the ids. `lastOpened` is stamped explicitly so the groups sort the way a real
 * morning does — the project you are in at the top, the rest behind it in the
 * order you last touched them. Left to the store, the order would be whatever
 * the harness's own loop produced.
 */
/**
 * Get the fabricated fleet on screen, and keep it there long enough to shoot.
 *
 * Two races, both real, both silent:
 *
 * 1. A push is one-shot. One that arrives before the renderer has subscribed is
 *    simply dropped, and since main suppresses unchanged broadcasts nothing
 *    ever replaces it — the surface then renders its (true) empty state forever.
 * 2. Main's own first real broadcast can land AFTER the rows appear, and an
 *    empty fleet IS a change from the injected one, so it wins and the rows
 *    vanish between the check and the shutter.
 *
 * So the check is repeated after the settle rather than before it, and the last
 * thing this does is confirm the rows survived. It throws if they did not: a
 * capture harness that quietly writes an empty-state PNG over a real one is
 * worse than a failing run.
 */
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

test("pilot review — the fleet overview, with a fleet", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the pilot-review capture",
  });
  test.skip(THEMES.length === 0, "Set DAINTREE_SHOT_THEME (an id, or `all`) to run this capture");

  const repoRoot = mkdtempSync(path.join(tmpdir(), "daintree-pilotshot-repos-"));
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-pilotshot-"));
  const dirs = WORKSPACES.map((ws) => createRepo(repoRoot, ws.slug));

  try {
    // One app per theme, sharing the user-data directory.
    //
    // `setAppTheme` reloads the renderer, and fifteen reloads inside one
    // session reliably crashed it around the fifth — this is a capture harness,
    // not a resilience test, and a cold app per theme costs about ten seconds
    // and never flakes. The projects survive in the store between launches, so
    // only the first launch pays for onboarding.
    for (const theme of THEMES) {
      const outDir = path.join(ARTIFACT_ROOT, theme);
      mkdirSync(outDir, { recursive: true });

      let ctx: AppContext | undefined;
      try {
        ctx = await launchApp({
          userDataDir,
          screenshotScale: SCALE,
          windowSize: { width: 1680, height: 1050 },
          extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
        });

        // The first project is opened for real, which is what makes one of the
        // groups the current workspace. Later launches reopen it themselves.
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

        // After the theme reload, so the snapshot lands on a live store.
        await injectFleet(ctx.app, buildRuns(ids));
        await settle(page, 400);

        await page.keyboard.press(`${MOD}+Alt+O`);
        const dialog = page.locator('[role="dialog"][aria-label="All agents"]');
        await dialog.waitFor({ state: "visible", timeout: 8000 });

        await holdFleet(page, ctx.app, ids);
        await snapSurface(
          page,
          outDir,
          "01-pilot-all-agents",
          '[role="dialog"][aria-label="All agents"]'
        );

        // The demand-only cut: what the surface looks like once the footer's
        // "agents need you" button has isolated the runs that are asking.
        await page
          .getByTestId("pilot-demand-action")
          .click()
          .catch(() => {});
        await holdFleet(page, ctx.app, ids);
        await snapSurface(
          page,
          outDir,
          "02-pilot-needs-you",
          '[role="dialog"][aria-label="All agents"]'
        );

        await closeOverlay(page);
      } finally {
        if (ctx) await closeApp(ctx.app).catch(() => {});
      }
    }
  } finally {
    // Best-effort, and never the reason a capture run reports failure. Electron
    // helpers can still be flushing crashpad and cache files as the tree comes
    // down, which surfaces as ENOTEMPTY on a directory the OS will reap anyway.
    for (const dir of [repoRoot, userDataDir]) {
      if (!existsSync(dir)) continue;
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        console.warn(`[pilot-shots] could not remove ${dir}:`, String(error).split("\n")[0]);
      }
    }
  }
});
