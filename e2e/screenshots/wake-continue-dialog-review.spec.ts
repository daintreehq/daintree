/**
 * Continue-note dialog visual-review harness.
 *
 * `WakeContinueDialog` is where the note goes out to every agent a restore resumed: one
 * note, the fleet it reaches, and each pane's delivery once sending starts. It is reviewed
 * on rendered pixels across its three phases and the states that change what it says.
 *
 * Rebooting a real resumed fleet is out of reach in a capture, so the harness opens plain
 * terminals in three worktrees and parks an offer over them through
 * `__DAINTREE_E2E_SET_WAKE_OFFER__`, which stamps each pane's restore provenance the way a
 * restore pass does. The dialog then reads every row's outcome off the live panel store,
 * exactly as it does after a real wake. Nothing is ever sent: delivery states are parked.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_WAKE_CONTINUE is set. One boot per theme,
 * never in parallel:
 *
 *   for t in daintree hokkaido namib; do
 *     DAINTREE_SHOT_WAKE_CONTINUE=1 DAINTREE_SHOT_THEME=$t DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots wake-continue-dialog-review
 *   done
 *
 * Env knobs:
 *   DAINTREE_SHOT_WAKE_CONTINUE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME          optional theme id (default: daintree)
 *   DESIGN_CAPTURE_DIR           output directory (default: artifacts/wake-continue-shots)
 *   DAINTREE_SHOT_ONLY           comma-separated step filter (step names below)
 *
 * Output: <dir>/<NN-slug>-<theme>.png
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { getGridPanelIds } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_WAKE_CONTINUE;
const THEME = process.env.DAINTREE_SHOT_THEME || "daintree";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "wake-continue-shots");
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const WINDOW = { width: 1680, height: 1050 };
const DIALOG = '[role="dialog"]';

const BRANCH_A = "feature/oauth-device-flow";
const BRANCH_B = "fix/retry-backoff-jitter";

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

type Disposition = "resume" | "fresh" | "held";
type Delivery =
  | { status: "queued" | "starting" | "needs-you" | "sending" | "sent" | "unconfirmed" }
  | { status: "failed"; message: string; partial?: true };

interface Pane {
  terminalId: string;
  worktreeId: string | null;
}

interface EntrySpec {
  pane: Pane | "closed";
  title: string;
  agentId: string;
  outcome: "resumed" | "fresh" | "held";
  disposition?: Disposition;
  holdReason?: string;
  heldSessionId?: string;
  delivery?: Delivery;
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function worktreeDir(wtRoot: string, branch: string): string {
  return path.join(wtRoot, branch.replace(/[/]/g, "-"));
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-wakecont-repo-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  for (const branch of [BRANCH_A, BRANCH_B]) {
    git(`branch ${branch}`, dir);
    git(`worktree add ${JSON.stringify(worktreeDir(wtRoot, branch))} ${branch}`, dir);
  }
  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function dispatch(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    async ([id, a]) => {
      const fn = window.__daintreeDispatchAction;
      if (typeof fn !== "function") throw new Error("Action dispatch hook not available");
      return await fn(id, a, { source: "keybinding" });
    },
    [actionId, args] as const
  );
}

async function newPanelId(page: Page, before: Set<string>): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const id = (await getGridPanelIds(page).catch(() => [] as string[])).find(
      (candidate) => !before.has(candidate)
    );
    if (id) return id;
    await page.waitForTimeout(250);
  }
  throw new Error("new panel never appeared in the grid");
}

interface WorktreeRow {
  id: string;
  branch?: string;
  path: string;
  isMainWorktree?: boolean;
}

async function worktreeIdFor(page: Page, branch: string | null): Promise<string> {
  let match: WorktreeRow | undefined;
  await expect
    .poll(
      async () => {
        const rows = (await page
          .evaluate(() =>
            (
              window as unknown as { electron?: { worktree?: { getAll?: () => unknown } } }
            ).electron?.worktree?.getAll?.()
          )
          .catch(() => null)) as WorktreeRow[] | null;
        match = (rows ?? []).find((row) =>
          branch === null
            ? row.isMainWorktree === true
            : row.branch === branch || row.path.endsWith(branch.replace(/[/]/g, "-"))
        );
        return match !== undefined;
      },
      { timeout: 60_000, intervals: [250, 500] }
    )
    .toBe(true);
  return match!.id;
}

async function selectWorktree(page: Page, branch: string | null): Promise<string> {
  const worktreeId = await worktreeIdFor(page, branch);
  await dispatch(page, "worktree.select", { worktreeId });
  const card = branch
    ? `${SEL.worktree.card(branch)}[data-active="true"]`
    : `${SEL.worktree.mainCard}[data-active="true"]`;
  await expect(page.locator(card).first()).toBeAttached({ timeout: T_LONG });
  await settle(page, 400);
  return worktreeId;
}

async function openPane(page: Page, worktreeId: string, title: string): Promise<Pane> {
  const before = new Set(await getGridPanelIds(page));
  await dispatch(page, "terminal.new");
  const terminalId = await newPanelId(page, before);
  await dispatch(page, "terminal.rename", { terminalId, name: title });
  return { terminalId, worktreeId };
}

const RESTORED_AT = Date.now() - 90_000;

async function parkOffer(
  page: Page,
  phase: "offered" | "sending" | "done",
  specs: EntrySpec[]
): Promise<void> {
  const entries = specs.map((spec, index) => ({
    terminalId: spec.pane === "closed" ? `closed-pane-${index}` : spec.pane.terminalId,
    worktreeId: spec.pane === "closed" ? null : spec.pane.worktreeId,
    title: spec.title,
    agentId: spec.agentId,
    outcome: spec.outcome,
    holdReason: spec.holdReason,
    heldSessionId: spec.heldSessionId,
    restoredAt: RESTORED_AT,
    disposition: spec.disposition ?? (spec.outcome === "resumed" ? "resume" : spec.outcome),
    delivery: spec.delivery,
  }));
  await page.evaluate(
    ([p, e]) => {
      const park = window.__DAINTREE_E2E_SET_WAKE_OFFER__;
      if (typeof park !== "function") throw new Error("wake offer backdoor not installed");
      park({ phase: p, entries: e as never, open: true });
    },
    [phase, entries] as const
  );
}

/** Capture the dialog card; throws rather than writing a shot of no dialog or the wrong one. */
async function snapDialog(page: Page, slug: string, options: { window?: boolean } = {}) {
  const dialog = page.locator(DIALOG).last();
  await dialog.waitFor({ state: "visible", timeout: 8000 });
  await expect(page.getByTestId("wake-continue-entries")).toBeVisible({ timeout: 5000 });
  await settle(page, 500);
  const card = dialog.locator(":scope > div").first();
  const box = (await card.boundingBox()) ?? (await dialog.boundingBox());
  if (!box) throw new Error("dialog card has no bounding box");
  const pad = 24;
  const viewport = page.viewportSize() ?? WINDOW;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}-${THEME}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + pad * 2),
      height: Math.min(viewport.height - y, box.height + pad * 2),
    },
  });
  if (options.window) {
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `${slug}-window-${THEME}.png`),
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
  }
}

async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (
      !(await page
        .locator(DIALOG)
        .first()
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

const failures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 400);
    console.warn(`[wake-continue-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await closeDialog(page).catch(() => {});
  }
}

test("wake continue dialog review — every phase", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_WAKE_CONTINUE is required for the capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_WAKE_CONTINUE to run the capture");
  test.setTimeout(420_000);

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-wakecontshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WINDOW,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await setAppTheme(page, THEME);
    await page.setViewportSize(WINDOW);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    const wtA = await selectWorktree(page, BRANCH_A);
    const a1 = await openPane(page, wtA, "Claude");
    const a2 = await openPane(page, wtA, "Codex");
    const wtB = await selectWorktree(page, BRANCH_B);
    // The dialog shows a live panel's grid title, so the long one is the pane's own.
    const LONG_TITLE =
      "Claude · migrate the retry backoff to decorrelated jitter and update the docs";
    const b1 = await openPane(page, wtB, LONG_TITLE);
    const b2 = await openPane(page, wtB, "Gemini");
    const wtMain = await selectWorktree(page, null);
    const m1 = await openPane(page, wtMain, "Claude");
    const m2 = await openPane(page, wtMain, "Claude");
    const m3 = await openPane(page, wtMain, "Claude");
    await dismissBlockingPalette(page);
    await settle(page, 800);

    // Two default-titled Claudes in one worktree: the case the dialog is most often opened on.
    await step(page, "pair", async () => {
      await parkOffer(page, "offered", [
        { pane: m1, title: "Claude", agentId: "claude", outcome: "resumed" },
        { pane: m2, title: "Claude", agentId: "claude", outcome: "resumed" },
      ]);
      await snapDialog(page, "01-pair", { window: true });
    });

    const fleet: EntrySpec[] = [
      { pane: a1, title: "Claude", agentId: "claude", outcome: "resumed" },
      { pane: a2, title: "Codex", agentId: "codex", outcome: "resumed" },
      { pane: b1, title: LONG_TITLE, agentId: "claude", outcome: "resumed" },
      { pane: b2, title: "Gemini", agentId: "gemini", outcome: "fresh" },
      { pane: m1, title: "Claude", agentId: "claude", outcome: "resumed" },
      {
        pane: m2,
        title: "Claude",
        agentId: "claude",
        outcome: "held",
        holdReason: "resume-deferred",
        heldSessionId: "sess-held-1",
      },
      { pane: "closed", title: "Codex", agentId: "codex", outcome: "resumed" },
    ];

    await step(page, "fleet", async () => {
      // One of main's two Claudes sits in the dock: the qualifier the grid itself shows.
      await dispatch(page, "terminal.moveToDock", { terminalId: m2.terminalId });
      await settle(page, 400);
      await parkOffer(page, "offered", fleet);
      await snapDialog(page, "02-fleet", { window: true });
    });

    await step(page, "none-resumed", async () => {
      await parkOffer(page, "offered", [
        {
          pane: m1,
          title: "Claude",
          agentId: "claude",
          outcome: "held",
          holdReason: "resume-deferred",
          heldSessionId: "sess-held-a",
        },
        {
          pane: a1,
          title: "Codex",
          agentId: "codex",
          outcome: "held",
          holdReason: "resume-deferred",
          heldSessionId: "sess-held-b",
        },
      ]);
      await snapDialog(page, "03-none-resumed");
    });

    await step(page, "blank-note", async () => {
      await parkOffer(page, "offered", fleet.slice(0, 3));
      const note = page.getByTestId("wake-continue-note");
      await note.waitFor({ state: "visible", timeout: 5000 });
      await note.fill("");
      await snapDialog(page, "04-blank-note");
    });

    await step(page, "sending", async () => {
      await parkOffer(page, "sending", [
        { ...fleet[0], delivery: { status: "sent" } },
        { ...fleet[1], delivery: { status: "sending" } },
        { ...fleet[2], delivery: { status: "needs-you" } },
        { ...fleet[4], delivery: { status: "queued" } },
        {
          pane: m3,
          title: "Claude",
          agentId: "claude",
          outcome: "resumed",
          delivery: { status: "unconfirmed" },
        },
        {
          pane: "closed",
          title: "Codex",
          agentId: "codex",
          outcome: "resumed",
          delivery: { status: "failed", message: "Codex was closed — no note sent" },
        },
      ]);
      await snapDialog(page, "05-sending");
    });

    await step(page, "done", async () => {
      await parkOffer(page, "done", [
        { ...fleet[0], delivery: { status: "sent" } },
        { ...fleet[1], delivery: { status: "sent" } },
        { ...fleet[2], delivery: { status: "sent" } },
        { ...fleet[4], delivery: { status: "unconfirmed" } },
        fleet[3],
      ]);
      await snapDialog(page, "06-done");
    });

    const written = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`-${THEME}.png`));
    console.log(`[wake-continue-shots] ${THEME}: ${written.length} files`);
    if (failures.length > 0) throw new Error(`steps failed:\n${failures.join("\n")}`);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
