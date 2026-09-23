/**
 * NotificationCenter at fleet volume — visual-review harness.
 *
 * `notification-center-review` owns the popover's box and scrollport, and
 * `notification-entry-review` owns one row. Both seed a single project with
 * placeholder ids. This one seeds what the inbox actually holds after an hour
 * of a fleet run: dozens of entries across three projects and several
 * worktrees, threads of different lengths, more severe unread threads than the
 * pinned rail can hold, a "new since you last looked" boundary part way down,
 * and ids spelled the way the app spells them — a sha256 project id, a
 * worktree path. Grouped headers fall back to those ids when nothing resolves
 * them, so a placeholder like "helios-dashboard" hides exactly what a user
 * would see.
 *
 * Seeds through `seedHistory` and `setCenterLastClosedAt` on the E2E
 * notification backdoor (`src/lib/e2eNotificationBackdoor.ts`).
 *
 * Steps (each also a DAINTREE_SHOT_ONLY filter name):
 *
 *   fleet      the populated inbox at rest, popover + window
 *   boundary   scrolled to the "new since you last looked" boundary
 *   bottom     scrolled to the end of the list
 *   grouped    group-by-context on, top and scrolled
 *   focus      keyboard focus on a thread row
 *   menu       a row's overflow menu, then its Snooze submenu
 *   snoozekey  `h` on a focused row, which opens the durations directly
 *   snoozed    the Snoozed tab
 *   caughtup   everything read: the All tab without a rail, and Unread empty
 *   toast      a toast arriving while the inbox is closed
 *   forced     `forced-colors: active` on the fleet rest state
 *   light      the fleet rest state on a light palette
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_NOTIFVOLUME=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots notification-center-volume-review
 *
 * Output: $DESIGN_CAPTURE_DIR/<NN-slug>.png, or
 * artifacts/notification-center-volume-shots/ (gitignored) when unset, plus
 * `density.json` with row counts and heights per state.
 */

import { test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import {
  injectToast,
  seedNotificationHistory,
  waitForNotificationsBackdoor,
  type SeedHistoryEntry,
} from "../helpers/notifications";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_NOTIFVOLUME;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "notification-center-volume-shots");
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const LIGHT_THEME = process.env.DAINTREE_SHOT_LIGHT_THEME ?? "svalbard";

const POPOVER = SEL.notifications.center;

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8" });
}

interface FixtureRepo {
  dir: string;
  worktrees: { branch: string; id: string }[];
  cleanup: () => void;
}

function createFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-notifvolume-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  git("checkout develop", dir);
  for (const branch of ["feature/refine-inbox", "fix/panel-restore"]) {
    git(`worktree add -b ${branch} "${path.join(wtRoot, branch.replace("/", "-"))}"`, dir);
  }

  // Ids exactly as enumeration spells them: `pathResolve` of the porcelain path.
  const porcelain = git("worktree list --porcelain", dir);
  const worktrees: { branch: string; id: string }[] = [];
  let current: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) current = path.resolve(line.slice("worktree ".length));
    if (line.startsWith("branch refs/heads/") && current) {
      worktrees.push({ branch: line.slice("branch refs/heads/".length), id: current });
    }
  }

  return {
    dir,
    worktrees,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface FleetIds {
  heliosProjectId: string;
  heliosWorktrees: Record<string, string>;
}

// Two projects the inbox has heard from that are not open in this view — their
// ids never resolve here, which is the common case for a multi-project fleet.
const ATLAS = sha("/Users/dev/Projects/atlas-api");
const ATLAS_WT = "/Users/dev/Projects/atlas-api-worktrees/feature-rate-limits";
const TERN = sha("/Users/dev/Projects/tern-cli");

/**
 * About forty entries grouping into roughly thirty rows. Seven severe unread
 * threads, so the rail fills to its cap of five and reports overflow. The
 * newest nine rows land after `lastClosedAt`, so the boundary sits part way
 * down rather than at the top.
 */
function buildFleet(now: number, ids: FleetIds, opts: { allRead?: boolean } = {}) {
  const wt = ids.heliosWorktrees;
  const H = ids.heliosProjectId;
  const entries: SeedHistoryEntry[] = [];
  let n = 0;
  const add = (
    e: Omit<SeedHistoryEntry, "id" | "timestamp"> & { age: number; read?: boolean }
  ): void => {
    const { age, read, ...rest } = e;
    entries.push({
      id: `fleet-${n++}`,
      timestamp: now - age,
      seenAsToast: opts.allRead ? true : (read ?? false),
      ...rest,
    });
  };

  // Threads with several entries each, newest first within the thread.
  for (let i = 0; i < 5; i++) {
    add({
      type: "error",
      title: "Tests failed",
      message: `${12 - i} of 418 tests failed in src/components/Notifications.`,
      age: 3 * MINUTE + i * 4 * MINUTE,
      correlationId: "thr-tests-refine",
      context: { projectId: H, worktreeId: wt["feature/refine-inbox"], eventKind: "completed" },
    });
  }
  for (let i = 0; i < 3; i++) {
    add({
      type: "warning",
      title: "Claude is waiting for input",
      message: "Asked whether to keep the pinned rail's cap at five.",
      age: 6 * MINUTE + i * 9 * MINUTE,
      correlationId: "thr-waiting-refine",
      context: { projectId: H, worktreeId: wt["feature/refine-inbox"], eventKind: "waiting" },
    });
  }
  add({
    type: "error",
    title: "Push rejected",
    message: "The remote has commits your branch doesn't. Pull with rebase, then push again.",
    age: 9 * MINUTE,
    correlationId: "thr-push-panel",
    context: { projectId: H, worktreeId: wt["fix/panel-restore"], eventKind: "git" },
    actions: [
      { label: "Pull and rebase", actionId: "git.push" },
      { label: "Open review", actionId: "app.settings.openTab", variant: "secondary" },
    ],
  });
  add({
    type: "error",
    title: "Agent exited",
    message: "Codex exited with code 137 after running out of memory.",
    age: 11 * MINUTE,
    correlationId: "thr-exit-atlas",
    context: { projectId: ATLAS, worktreeId: ATLAS_WT, eventKind: "system" },
  });
  add({
    type: "warning",
    title: "4 terminals idle for 30 minutes",
    message: "Four background terminals in Atlas API have been idle past your threshold.",
    age: 14 * MINUTE,
    correlationId: "thr-idle-atlas",
    context: { projectId: ATLAS, eventKind: "system" },
    actions: [
      { label: "Close them", actionId: "terminal.kill" },
      { label: "Mute project", actionId: "app.settings.openTab", variant: "secondary" },
    ],
  });
  add({
    type: "success",
    title: "Build finished",
    message: "Renderer bundle built in 9.4s.",
    age: 16 * MINUTE,
    correlationId: "thr-build-main",
    context: { projectId: H, worktreeId: wt.develop, eventKind: "completed" },
  });
  add({
    type: "warning",
    title: "Gemini is waiting for input",
    message: "Wants approval to run `npm run db:generate`.",
    age: 19 * MINUTE,
    correlationId: "thr-waiting-tern",
    context: { projectId: TERN, eventKind: "waiting" },
  });
  add({
    type: "error",
    title: "Lint failed",
    message: "3 errors in electron/services/pty. The ratchet rejected a new warning.",
    age: 21 * MINUTE,
    correlationId: "thr-lint-panel",
    context: { projectId: H, worktreeId: wt["fix/panel-restore"], eventKind: "completed" },
  });
  add({
    type: "warning",
    title: "Disk space low",
    message:
      "The volume holding your worktrees has 4.2 GB free. A fleet run keeps build output per worktree, so the rest can go quickly.",
    age: 23 * MINUTE,
    correlationId: "thr-disk",
    context: { eventKind: "system" },
    actions: [{ label: "Open worktrees", actionId: "app.settings.openTab" }],
  });

  // Before the boundary: the user has seen these, mostly as toasts.
  const older: {
    type: SeedHistoryEntry["type"];
    title?: string;
    message: string;
    age: number;
    ctx: SeedHistoryEntry["context"];
    read?: boolean;
    thread?: number;
  }[] = [
    {
      type: "success",
      title: "Pull request opened",
      message: "#12044 Move the readiness rail behind a capability check.",
      age: 31 * MINUTE,
      ctx: { projectId: H, worktreeId: wt["feature/refine-inbox"], eventKind: "git" },
      read: true,
    },
    {
      type: "info",
      message: "Codex finished reviewing 6 files.",
      age: 38 * MINUTE,
      ctx: { projectId: ATLAS, worktreeId: ATLAS_WT, eventKind: "completed" },
      read: true,
    },
    {
      type: "error",
      title: "Migration failed",
      message: "drizzle could not apply 0042_notification_snooze: table already exists.",
      age: 44 * MINUTE,
      ctx: { projectId: TERN, eventKind: "system" },
    },
    {
      type: "success",
      title: "Worktree created",
      message: "fix/panel-restore is ready.",
      age: 52 * MINUTE,
      ctx: { projectId: H, worktreeId: wt["fix/panel-restore"], eventKind: "git" },
      read: true,
    },
    {
      type: "success",
      message: "Formatted 23 files with Prettier.",
      age: 58 * MINUTE,
      ctx: { projectId: H, worktreeId: wt.develop, eventKind: "system" },
      read: true,
    },
    {
      type: "info",
      title: "Agent started",
      message: "Claude started in feature/rate-limits.",
      age: 66 * MINUTE,
      ctx: { projectId: ATLAS, worktreeId: ATLAS_WT, eventKind: "system" },
      read: true,
      thread: 3,
    },
    {
      type: "warning",
      title: "Rate limited",
      message: "Anthropic API returned 429. Retrying in 40 seconds.",
      age: 71 * MINUTE,
      ctx: { projectId: ATLAS, worktreeId: ATLAS_WT, eventKind: "system" },
      read: true,
      thread: 4,
    },
    {
      type: "success",
      title: "Merged pull request #11967",
      message: "feature/issue-11965-move-remaining-stacked-label merged into develop.",
      age: 2 * HOUR,
      ctx: { projectId: TERN, eventKind: "git" },
      read: true,
    },
    {
      type: "error",
      title: "Dev server crashed",
      message: "vite exited with code 1: port 5173 is already in use.",
      age: 3 * HOUR,
      ctx: { projectId: H, worktreeId: wt.develop, eventKind: "system" },
    },
    {
      type: "info",
      message: "MCP server accepted a connection from an external agent.",
      age: 4 * HOUR,
      ctx: { eventKind: "system" },
      read: true,
    },
    {
      type: "success",
      title: "Tests passed",
      message: "418 tests passed in 3m 12s.",
      age: 5 * HOUR,
      ctx: { projectId: H, worktreeId: wt.develop, eventKind: "completed" },
      read: true,
    },
    {
      type: "warning",
      title: "Watchdog restarted the pty host",
      message: "It stopped answering health checks for 12 seconds.",
      age: 7 * HOUR,
      ctx: { eventKind: "system" },
      read: true,
    },
    {
      type: "info",
      title: "Plugin updated",
      message: "GitHub forge provider updated to 2.4.0.",
      age: 26 * HOUR,
      ctx: { eventKind: "system" },
      read: true,
    },
    {
      type: "success",
      title: "Release 0.9.4 published",
      message: "macOS, Linux and Windows artifacts uploaded.",
      age: 2 * DAY,
      ctx: { projectId: TERN, eventKind: "system" },
      read: true,
    },
  ];
  older.forEach((o, i) => {
    const count = o.thread ?? 1;
    for (let k = 0; k < count; k++) {
      add({
        type: o.type,
        title: o.title,
        message: o.message,
        age: o.age + k * 3 * MINUTE,
        correlationId: `thr-older-${i}`,
        context: o.ctx,
        read: o.read,
      });
    }
  });

  // Something to fill the Archived and Snoozed tabs.
  entries.push({
    id: "archived-release",
    type: "success",
    title: "Release 0.9.3 published",
    message: "macOS, Linux and Windows artifacts uploaded.",
    timestamp: now - 9 * DAY,
    archivedAt: now - 8 * DAY,
    seenAsToast: true,
    correlationId: "thr-archived",
    context: { projectId: TERN, eventKind: "system" },
  });
  add({
    type: "warning",
    title: "Dependency audit",
    message: "2 moderate advisories in electron-store's dependency tree.",
    age: 28 * MINUTE,
    correlationId: "thr-snoozed-audit",
    context: { projectId: H, worktreeId: wt.develop, eventKind: "system" },
  });
  add({
    type: "info",
    title: "Stale worktree",
    message: "chore/old-spike hasn't had a commit in 21 days.",
    age: 3 * DAY,
    correlationId: "thr-snoozed-stale",
    context: { projectId: ATLAS, eventKind: "git" },
    read: true,
  });

  entries.sort((a, b) => b.timestamp - a.timestamp);
  const snoozed = {
    "thr-snoozed-audit": now + 3 * HOUR,
    "thr-snoozed-stale": now + 4 * DAY,
  };
  return { entries, snoozed, lastClosedAt: now - 25 * MINUTE };
}

const failures: string[] = [];
const density: Record<string, unknown> = {};

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[notifvolume-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await page.emulateMedia({ forcedColors: null }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function closeCenter(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (
      !(await page
        .locator(POPOVER)
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

async function openCenter(page: Page): Promise<void> {
  await page.locator(SEL.notifications.bellButton).click();
  await page.locator(POPOVER).waitFor({ state: "visible", timeout: 8000 });
  await settle(page, 500);
}

/**
 * Seed with the panel closed, then pin the boundary AFTER the close — closing
 * writes `Date.now()` into the same watermark.
 */
async function seedAndOpen(
  page: Page,
  fleet: ReturnType<typeof buildFleet>,
  lastClosedAt = fleet.lastClosedAt
): Promise<void> {
  await closeCenter(page);
  await dismissBlockingPalette(page);
  await seedNotificationHistory(page, fleet.entries, fleet.snoozed);
  await waitForNotificationsBackdoor(page);
  await page.evaluate((ts) => {
    (
      window as unknown as {
        __daintreeNotificationsE2E?: { setCenterLastClosedAt: (t: number) => void };
      }
    ).__daintreeNotificationsE2E?.setCenterLastClosedAt(ts);
  }, lastClosedAt);
  await openCenter(page);
}

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}.png`);
  if (locator) {
    await page.locator(locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/** The popover plus anything portalled beside it (menus), in one crop. */
async function snapWithMenus(page: Page, slug: string): Promise<void> {
  await settle(page);
  const box = await page.evaluate((sel) => {
    const els = [
      document.querySelector(sel),
      ...Array.from(document.querySelectorAll('[role="menu"]')),
    ].filter(Boolean) as Element[];
    const rects = els.map((e) => e.getBoundingClientRect());
    const x = Math.max(0, Math.min(...rects.map((r) => r.left)) - 8);
    const y = Math.max(0, Math.min(...rects.map((r) => r.top)) - 8);
    const right = Math.min(window.innerWidth, Math.max(...rects.map((r) => r.right)) + 8);
    const bottom = Math.min(window.innerHeight, Math.max(...rects.map((r) => r.bottom)) + 8);
    return { x, y, width: right - x, height: bottom - y };
  }, POPOVER);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    clip: box,
    animations: "disabled",
    caret: "hide",
  });
}

type ScrollTarget = "top" | "bottom" | "boundary" | number;

/** Scroll the list's own scrollport. A number is a fraction of scrollHeight. */
async function scrollList(page: Page, target: ScrollTarget): Promise<void> {
  await page.evaluate(
    async ({ listSel, target }) => {
      const list = document.querySelector(listSel) as HTMLElement | null;
      let s: HTMLElement | null = list;
      while (s) {
        const oy = getComputedStyle(s).overflowY;
        if (oy === "auto" || oy === "scroll") break;
        s = s.parentElement;
      }
      if (!s) throw new Error("no scrollport found");
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (target === "boundary") {
        const d = s.querySelector('[data-testid="new-since-last-looked"]');
        if (!d) throw new Error("no boundary divider");
        s.scrollTop += d.getBoundingClientRect().top - s.getBoundingClientRect().top - 120;
      } else {
        // Re-assign until it stops moving: the panel's height settles from
        // FixedDropdown's positioning pass, so one early assignment lands short.
        for (let i = 0; i < 20; i++) {
          const before = s.scrollTop;
          s.scrollTop =
            target === "top" ? 0 : target === "bottom" ? s.scrollHeight : s.scrollHeight * target;
          await frame();
          if (Math.abs(s.scrollTop - before) < 1 && i > 1) break;
        }
      }
      await frame();
    },
    { listSel: SEL.notifications.centerList, target }
  );
  await settle(page, 300);
}

/** Rows visible, rows total, and how much of the scrollport one row costs. */
async function measure(page: Page, label: string, minRows: number): Promise<void> {
  const data = await page.evaluate(
    ({ popoverSel, listSel, rowSel }) => {
      const popover = document.querySelector(popoverSel) as HTMLElement | null;
      const list = document.querySelector(listSel) as HTMLElement | null;
      if (!popover || !list) return { error: "no popover or list" };
      let s: HTMLElement | null = list;
      while (s) {
        const oy = getComputedStyle(s).overflowY;
        if (oy === "auto" || oy === "scroll") break;
        s = s.parentElement;
      }
      const sBox = s?.getBoundingClientRect();
      const rows = Array.from(popover.querySelectorAll(rowSel)) as HTMLElement[];
      const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10);
      const visible = sBox
        ? rows.filter((r) => {
            const b = r.getBoundingClientRect();
            return b.top >= sBox.top - 1 && b.bottom <= sBox.bottom + 1;
          }).length
        : null;
      return {
        popover: {
          w: Math.round(popover.getBoundingClientRect().width),
          h: Math.round(popover.getBoundingClientRect().height),
        },
        scrollport: sBox
          ? { h: Math.round(sBox.height), scrollHeight: s!.scrollHeight, scrollTop: s!.scrollTop }
          : null,
        rows: rows.length,
        fullyVisibleRows: visible,
        rowHeight: {
          min: Math.min(...heights),
          max: Math.max(...heights),
          median: [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)],
        },
      };
    },
    {
      popoverSel: POPOVER,
      listSel: SEL.notifications.centerList,
      rowSel: SEL.notifications.centerRow,
    }
  );
  density[label] = data;
  const rows = (data as { rows?: number }).rows ?? 0;
  if (rows < minRows) throw new Error(`${label}: expected >= ${minRows} rows, saw ${rows}`);
}

test("notification center at fleet volume", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_NOTIFVOLUME is required for the fleet-volume inbox capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_NOTIFVOLUME to run the fleet-volume inbox capture");

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const f of readdirSync(OUTPUT_DIR)) {
    if (f.endsWith(".png") || f === "density.json") rmSync(path.join(OUTPUT_DIR, f));
  }

  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-notifvolumeshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    const project = (await page.evaluate(() =>
      (
        window as unknown as {
          electron: { project: { getCurrent: () => Promise<{ id: string } | null> } };
        }
      ).electron.project.getCurrent()
    )) as { id: string } | null;
    if (!project?.id) throw new Error("could not read the current project id");
    const ids: FleetIds = {
      heliosProjectId: project.id,
      heliosWorktrees: Object.fromEntries(repo.worktrees.map((w) => [w.branch, w.id])),
    };
    for (const b of ["develop", "feature/refine-inbox", "fix/panel-restore"]) {
      if (!ids.heliosWorktrees[b]) throw new Error(`fixture worktree ${b} missing`);
    }

    const now = Date.now();
    const fleet = buildFleet(now, ids);

    await step(page, "fleet", async () => {
      await seedAndOpen(page, fleet);
      await measure(page, "fleet-rest", 20);
      await snap(page, "01-fleet-rest-popover", POPOVER);
      await snap(page, "02-fleet-rest-window");
    });

    await step(page, "boundary", async () => {
      await seedAndOpen(page, fleet);
      await scrollList(page, "boundary");
      await measure(page, "fleet-boundary", 20);
      await snap(page, "03-fleet-boundary-popover", POPOVER);
    });

    await step(page, "bottom", async () => {
      await seedAndOpen(page, fleet);
      await scrollList(page, "bottom");
      await measure(page, "fleet-bottom", 20);
      await snap(page, "04-fleet-bottom-popover", POPOVER);
    });

    await step(page, "grouped", async () => {
      await seedAndOpen(page, fleet);
      await page.locator('button[aria-label="Group by project or worktree"]').first().click();
      await settle(page, 500);
      await measure(page, "fleet-grouped", 20);
      await snap(page, "05-fleet-grouped-popover", POPOVER);
      await scrollList(page, 0.45);
      await snap(page, "06-fleet-grouped-mid-popover", POPOVER);
      await scrollList(page, "top");
      await page.locator('button[aria-label="Group by project or worktree"]').first().click();
      await settle(page, 300);
    });

    await step(page, "focus", async () => {
      await seedAndOpen(page, fleet);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await settle(page, 300);
      const ok = await page.evaluate(
        () => document.activeElement?.getAttribute("role") === "listitem"
      );
      if (!ok) throw new Error("keyboard focus did not land on a row");
      await snap(page, "07-fleet-row-focus-popover", POPOVER);
    });

    await step(page, "menu", async () => {
      await seedAndOpen(page, fleet);
      const rows = page.locator(POPOVER).locator(SEL.notifications.centerRow);
      await rows.nth(1).hover();
      await rows.nth(1).locator('button[aria-label^="Options for "]').click();
      await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
      await snapWithMenus(page, "08-row-menu");
      await page.locator('[role="menuitem"]', { hasText: "Snooze" }).first().hover();
      await page.keyboard.press("ArrowRight");
      await page.locator('[role="menu"]').nth(1).waitFor({ state: "visible", timeout: 5000 });
      await snapWithMenus(page, "09-row-snooze-submenu");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });

    await step(page, "snoozekey", async () => {
      await seedAndOpen(page, fleet);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("h");
      await page
        .locator('[role="menu"]', { hasText: "For 1 hour" })
        .first()
        .waitFor({ state: "visible", timeout: 5000 });
      const onDuration = await page.evaluate(
        () => document.activeElement?.getAttribute("role") === "menuitem"
      );
      if (!onDuration) throw new Error("`h` did not put focus on a duration");
      await snapWithMenus(page, "09b-row-snooze-by-key");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });

    await step(page, "snoozed", async () => {
      await seedAndOpen(page, fleet);
      await page.locator(SEL.notifications.centerFilter("Snoozed")).first().click();
      await settle(page, 400);
      await measure(page, "snoozed", 2);
      await snap(page, "10-snoozed-tab-popover", POPOVER);
    });

    await step(page, "caughtup", async () => {
      const read = buildFleet(now, ids, { allRead: true });
      await seedAndOpen(page, read, 0);
      await measure(page, "all-read", 20);
      await snap(page, "11-all-read-popover", POPOVER);
      await page.locator(SEL.notifications.centerFilter("Unread")).first().click();
      await settle(page, 400);
      await snap(page, "12-unread-caught-up-popover", POPOVER);
    });

    await step(page, "toast", async () => {
      await seedAndOpen(page, fleet);
      await closeCenter(page);
      await injectToast(page, {
        type: "error",
        title: "Tests failed",
        message: "12 of 418 tests failed in src/components/Notifications.",
        correlationId: "thr-tests-refine",
        actionLabel: "Open terminal",
      });
      await settle(page, 800);
      await snap(page, "13-toast-window");
    });

    await step(page, "forced", async () => {
      await seedAndOpen(page, fleet);
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 500);
      if (!(await page.evaluate(() => matchMedia("(forced-colors: active)").matches))) {
        throw new Error("forced-colors emulation did not apply");
      }
      await snap(page, "14-fleet-forced-colors-popover", POPOVER);
    });

    await step(page, "light", async () => {
      await closeCenter(page);
      await setAppTheme(page, LIGHT_THEME);
      await settle(page, 800);
      await dismissBlockingPalette(page);
      await seedAndOpen(page, fleet);
      await measure(page, "light", 20);
      await snap(page, "15-fleet-light-popover", POPOVER);
      await page.locator('button[aria-label="Group by project or worktree"]').first().click();
      await settle(page, 400);
      await snap(page, "16-fleet-light-grouped-popover", POPOVER);
      await page.locator('button[aria-label="Group by project or worktree"]').first().click();
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    try {
      repo.cleanup();
    } catch {
      /* best effort */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  writeFileSync(path.join(OUTPUT_DIR, "density.json"), JSON.stringify(density, null, 2), "utf8");
  const pngs = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  console.warn(`[notifvolume-shots] wrote ${pngs.length} PNGs to ${OUTPUT_DIR}`);
  if (failures.length > 0) {
    throw new Error(`notification volume capture had failures:\n${failures.join("\n")}`);
  }
});
