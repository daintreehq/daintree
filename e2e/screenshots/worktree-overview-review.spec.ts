/**
 * `WorktreeOverviewModal` visual-review harness (#11989).
 *
 * The overview is the app-scale worktree browser: a near-full-window modal with
 * search, facet filters, clickable activity summaries, multi-selection, bulk
 * actions and a responsive card grid. Its design questions — does the frame read
 * as the same modal system as the other ~78 dialogs, does the header stay legible
 * once identity, counts, chips, toggles and close all share one row, and does
 * entering selection mode cost the user their result context — are all questions
 * about rendered pixels at a real width with a real number of cards. None of them
 * survive being reasoned about from the JSX.
 *
 * Everything is driven through the app's real seams:
 *   - Worktrees are real `git worktree add` linked worktrees, so branch labels,
 *     issue numbers, diff stats, ahead counts and type grouping are all genuine.
 *   - AI notes are real `<gitdir>/daintree/note` files, which is what
 *     NoteFileReader reads.
 *   - Agent activity comes from real PTYs running the shared fake-claude CLI, so
 *     the working/waiting summary chips are produced by the real FSM rather than
 *     a class name.
 *   - Filters, grouping, selection and both bulk confirmations are driven by
 *     clicking the actual controls.
 *
 * Two states the harness deliberately does not fake:
 *   - The `finished` summary chip needs `worktree.linked.pr`, which only a live
 *     forge lookup produces. There is no offline seam for it, and inventing one
 *     would mean reviewing a code path the app cannot reach in this fixture.
 *   - The loading skeleton (`isLoading && worktrees.length === 0`) is a race
 *     against the worktree MessagePort resolving; there is no handler to delay.
 * Both are recorded rather than faked.
 *
 * Opt-in only, like the sibling review harnesses:
 *
 *   DAINTREE_SHOT_OVERVIEW=1 npx playwright test --project=screenshots worktree-overview-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_OVERVIEW   required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME      optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG        optional suffix so review rounds sit side by side
 *   DAINTREE_SHOT_ONLY       comma-separated state filter (slugs below)
 *   DAINTREE_SHOT_DIR        output directory override
 *   DAINTREE_SHOT_SWEEP      only capture the states marked `sweep`
 *   DAINTREE_SHOT_SESSIONS   set to "0" to skip the (slow) agent launches
 *
 * Switching themes in place is not attempted — a sweep boots once per theme:
 *
 *   for t in arashiyama atacama bali bondi daintree fiordland galapagos highlands \
 *            hokkaido movile namib redwoods serengeti svalbard table-mountain; do
 *     DAINTREE_SHOT_OVERVIEW=1 DAINTREE_SHOT_SWEEP=1 DAINTREE_SHOT_SESSIONS=0 \
 *     DAINTREE_SHOT_THEME=$t npx playwright test --project=screenshots worktree-overview-review
 *   done
 *
 * Output: artifacts/overview-shots/<slug>--<theme>[-tag].png (gitignored).
 *
 * Hard rule, shared with the sibling harnesses: never write a PNG that has not
 * been verified. Every state asserts the content that makes it *that* state
 * after the settle and before the shot, and throws otherwise — a missing file is
 * a loud, correct failure, where a plausible-looking wrong file sends a whole
 * design review off reasoning about a screen that does not exist.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { getGridPanelIds } from "../helpers/panels";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import {
  installFakeAgent,
  fakeAgentEnv,
  FAKE_AGENT_READY,
  FAKE_AGENT_STOP,
} from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_OVERVIEW;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SWEEP_ONLY = !!process.env.DAINTREE_SHOT_SWEEP;
const WITH_SESSIONS = process.env.DAINTREE_SHOT_SESSIONS !== "0";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "overview-shots");

/** Wide enough that the header has room; the size a real fleet is driven at. */
const WIDE = { width: 1680, height: 1050 };
/** The width the issue is about — a normal laptop, where the header rows compete. */
const NARROW = { width: 1180, height: 900 };
/** Past the point where anything can be assumed to fit. */
const TIGHT = { width: 980, height: 820 };
/** A large external display: does the grid earn the extra 900px? */
const XL = { width: 2560, height: 1440 };

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

const MODAL = SEL.worktree.overviewModal;
const CELL = SEL.worktree.overviewCell;
const GRID = `${MODAL} [role="grid"]`;
/** Either confirmation this surface raises, whichever ARIA role it ends up with. */
const CONFIRM_DIALOG =
  ':is([role="dialog"],[role="alertdialog"]):has([data-confirm-role="confirm"])';

/**
 * Thirteen worktrees across seven branch prefixes. The count is the point: the
 * header's crowding, the grid's column behaviour and the type grouping are all
 * only visible at a density a real fleet reaches, and a three-card fixture shows
 * none of them. The long branch is the truncation case; the mixed prefixes give
 * `groupByType` seven real sections.
 */
const WORKTREES = [
  {
    branch: "feature/issue-4821-stream-upload-retry-with-backoff",
    slug: "stream-upload-retry",
    note: "Reworked the retry ladder so a 429 backs off on the server's Retry-After instead of the fixed 2s step. Still deciding whether the jitter is per-attempt or per-request.",
    dirty: true,
  },
  {
    branch:
      "feature/issue-9310-collapse-the-inspector-panel-when-the-window-narrows-below-the-medium-breakpoint",
    slug: "collapse-inspector",
    dirty: true,
  },
  { branch: "feature/issue-7702-dark-mode-token-audit", slug: "dark-mode-tokens" },
  {
    branch: "feature/issue-11204-overview-header-hierarchy",
    slug: "overview-header",
    note: "Header is carrying title, count, three chips, the main toggle, clear and close on one row.",
  },
  { branch: "fix/retry-backoff-jitter", slug: "retry-jitter", dirty: true },
  { branch: "fix/issue-5533-checksum-off-by-one", slug: "checksum-off-by-one", ahead: true },
  { branch: "chore/bump-electron-42", slug: "bump-electron" },
  { branch: "chore/issue-8801-drop-dead-tokens", slug: "drop-dead-tokens", ahead: true },
  { branch: "hotfix/issue-9002-crash-on-empty-branch", slug: "crash-empty-branch", dirty: true },
  { branch: "docs/architecture-refresh", slug: "architecture-refresh" },
  { branch: "refactor/issue-6120-extract-panel-registry", slug: "extract-panel-registry" },
  { branch: "perf/issue-7345-grid-virtualization", slug: "grid-virtualization", ahead: true },
] as const;

/** The worktree an agent is launched into for the `working` summary chip. */
const WORKING_WT = WORKTREES[0];
/** The worktree driven past the heartbeat stop, for the `waiting` chip. */
const WAITING_WT = WORKTREES[4];

const SEED_FILES: Record<string, string> = {
  "README.md": "# Helios Dashboard\n\nOperator console for the ingest fleet.\n",
  "src/index.ts": "export { startCheckout } from './checkout';\nexport { retry } from './retry';\n",
  "src/checkout.ts":
    "export async function startCheckout(cartId: string): Promise<string> {\n  return `charge_${cartId}`;\n}\n",
  "src/retry.ts":
    "export interface RetryOptions {\n  attempts: number;\n  baseDelayMs: number;\n}\n\nexport async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {\n  let lastError: unknown;\n  for (let i = 0; i < opts.attempts; i++) {\n    try {\n      return await fn();\n    } catch (error) {\n      lastError = error;\n    }\n  }\n  throw lastError;\n}\n",
  "src/upload/stream.ts":
    "export async function streamUpload(body: ReadableStream): Promise<void> {\n  void body;\n}\n",
  "src/upload/parts.ts": "export const PART_SIZE = 8 * 1024 * 1024;\n",
  "src/api/client.ts": "export const BASE_URL = 'https://api.helios.dev';\n",
  "docs/architecture.md": "# Architecture\n\nIngest -> queue -> worker -> store.\n",
};

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

interface FixtureRepo {
  dir: string;
  cleanup: () => void;
}

function createFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-overviewshots-"));
  const worktreeRoot = path.join(path.dirname(dir), `${path.basename(dir)}-worktrees`);
  mkdirSync(worktreeRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "avery@helios.dev"', dir);
  git('config user.name "Avery Lindqvist"', dir);
  writeFiles(dir, SEED_FILES);
  git("add -A", dir);
  git('commit -m "Set up the ingest console skeleton"', dir);

  for (const wt of WORKTREES) {
    const wtDir = path.join(worktreeRoot, wt.slug);
    git(`worktree add -b ${wt.branch} "${wtDir}" main`, dir);
    git('config user.email "avery@helios.dev"', wtDir);
    git('config user.name "Avery Lindqvist"', wtDir);

    if ("note" in wt && wt.note) {
      const noteDir = path.join(dir, ".git", "worktrees", wt.slug, "daintree");
      mkdirSync(noteDir, { recursive: true });
      writeFileSync(path.join(noteDir, "note"), wt.note);
    }

    if ("ahead" in wt && wt.ahead) {
      writeFiles(wtDir, {
        "src/retry.ts": SEED_FILES["src/retry.ts"] + "\nexport const J = 0.2;\n",
      });
      git("add -A", wtDir);
      git(`commit -m "Tune the retry ladder for ${wt.slug}"`, wtDir);
    }

    if ("dirty" in wt && wt.dirty) {
      writeFiles(wtDir, {
        "src/upload/stream.ts":
          "import { retry } from '../retry';\n\nexport async function streamUpload(body: ReadableStream): Promise<void> {\n  await retry(async () => {\n    void body;\n  }, { attempts: 5, baseDelayMs: 250 });\n}\n",
        "src/upload/checksum.ts":
          "export function checksum(chunk: Uint8Array): string {\n  return String(chunk.byteLength);\n}\n",
        "docs/retry-policy.md": "# Retry policy\n\nRespect Retry-After. Cap at 30s.\n",
      });
    }
  }

  return {
    dir,
    cleanup: () => {
      if (existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(s.width, s.height);
  }, size);
}

async function dispatch(page: Page, actionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const fn = window.__daintreeDispatchAction;
    if (typeof fn !== "function") throw new Error("Action dispatch hook not available");
    await fn(id, undefined, { source: "test" });
  }, actionId);
}

async function openOverview(page: Page): Promise<void> {
  if (
    await page
      .locator(MODAL)
      .isVisible()
      .catch(() => false)
  )
    return;
  await dismissBlockingPalette(page);
  await dispatch(page, "worktree.overview.open");
  await page.locator(MODAL).waitFor({ state: "visible", timeout: T_LONG });
  await page.locator(CELL).first().waitFor({ state: "visible", timeout: T_LONG });
}

async function closeOverview(page: Page): Promise<void> {
  if (
    !(await page
      .locator(MODAL)
      .isVisible()
      .catch(() => false))
  )
    return;
  // Escape clears selection first, so press it until the modal is actually gone.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
    if (
      !(await page
        .locator(MODAL)
        .isVisible()
        .catch(() => false))
    )
      return;
  }
  await page
    .locator(SEL.worktree.overviewClose)
    .first()
    .click()
    .catch(() => {});
  await page
    .locator(MODAL)
    .waitFor({ state: "hidden", timeout: T_LONG })
    .catch(() => {});
}

/** The search field the modal mounts below its header (`variant="modal"`). */
const searchInput = (page: Page) => page.locator(`${MODAL} ${SEL.worktree.searchInput}`).first();

async function typeQuery(page: Page, query: string): Promise<void> {
  const input = searchInput(page);
  await input.waitFor({ state: "visible", timeout: T_LONG });
  await input.fill(query);
  await settle(page, 400);
}

/**
 * Put the surface back to a known resting state: no query, no facet filters, no
 * selection, main visible, ungrouped. Filter state is persisted per project, so
 * a state that leaves a filter on silently poisons every state after it.
 */
async function resetSurface(page: Page): Promise<void> {
  // Sweep first. A state that left a confirmation up leaves its scrim swallowing
  // every click, and without this one bad state takes the whole rest of the run
  // down with it — which is exactly what a 22-state harness must not do.
  await cancelConfirm(page);
  await openOverview(page);

  // Deliberately NOT Escape. The modal listens for Escape on `document` in the
  // capture phase (`WorktreeOverviewModal.tsx:727`), so the key never reaches
  // whatever is actually on top — pressing it to clear a selection closes the
  // whole surface. The visible Clear control is the honest route.
  const clearSelection = page.locator(`${MODAL} [aria-label="Clear selection"]`).first();
  if (await clearSelection.isVisible().catch(() => false)) await clearSelection.click();

  const input = searchInput(page);
  if (await input.isVisible().catch(() => false)) {
    const value = await input.inputValue().catch(() => "");
    if (value) await input.fill("");
  }

  const clear = page.locator(`${MODAL} [aria-label="Clear all filters"]`).first();
  if (await clear.isVisible().catch(() => false)) await clear.click();

  await ensureMainVisible(page);
  // Grouping is not reset here: only `09-grouped` changes it and it restores
  // itself, and driving the facet popover open and shut on all 22 states costs
  // minutes and adds a failure mode for nothing.
  await settle(page, 350);
}

/** The `main` visibility switch lives in the default header. */
async function ensureMainVisible(page: Page): Promise<void> {
  const show = page.locator(`${MODAL} [aria-label="Show main worktree"]`).first();
  if (await show.isVisible().catch(() => false)) await show.click();
}

async function openFilterPopover(page: Page): Promise<void> {
  const trigger = page.locator(`${MODAL} ${SEL.worktree.filterButton}`).first();
  await trigger.waitFor({ state: "visible", timeout: T_LONG });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await page.locator(SEL.worktree.filterPopover).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 250);
}

/**
 * Close the facet popover by toggling its trigger, never with Escape.
 *
 * Escape here closes the entire overview: the modal's document-level capture
 * handler (`WorktreeOverviewModal.tsx:727`) sees the key first, calls
 * `stopPropagation()` and dismisses the dialog, so the popover the user was
 * actually looking at is never given the chance to consume it. That is a real
 * defect in the surface, recorded as a finding — the harness only has to avoid
 * tripping over it.
 */
async function closeFilterPopover(page: Page): Promise<void> {
  const popover = page.locator(SEL.worktree.filterPopover);
  if (!(await popover.isVisible().catch(() => false))) return;
  await page
    .locator(`${MODAL} ${SEL.worktree.filterButton}`)
    .first()
    .click()
    .catch(() => {});
  await popover.waitFor({ state: "hidden", timeout: T_LONG }).catch(() => {});
  await settle(page, 200);
}

async function ensureGrouped(page: Page, grouped: boolean): Promise<void> {
  await openFilterPopover(page);
  const box = page.locator(`${SEL.worktree.filterPopover} input[type="checkbox"]`).first();
  const checked = await box.isChecked().catch(() => false);
  if (checked !== grouped) await box.setChecked(grouped);
  await closeFilterPopover(page);
  await settle(page, 300);
}

/**
 * Clear a selection through the visible Clear control. Escape would do it too,
 * but only by way of the modal's capture-phase document handler, which on this
 * surface also closes the dialog outright — see {@link closeFilterPopover}.
 */
async function clearSelection(page: Page): Promise<void> {
  const clear = page.locator(`${MODAL} [aria-label="Clear selection"]`).first();
  if (await clear.isVisible().catch(() => false)) {
    await clear.click();
    await settle(page, 250);
  }
}

/**
 * Dismiss any confirmation that is up, by its own Cancel button.
 *
 * Page-scoped, not scoped under a dialog: `[role="dialog"]` also matches the
 * overview's own scrim, so `.first()` resolves to the overview and finds no
 * cancel — leaving the real confirmation open and its scrim swallowing every
 * click for the rest of the run. Loops, because a state can raise two.
 */
async function cancelConfirm(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const cancel = page.locator('[data-confirm-role="cancel"]').first();
    if (!(await cancel.isVisible().catch(() => false))) return;
    await cancel.click({ timeout: 5000 }).catch(() => {});
    await settle(page, 350);
  }
}

/**
 * Select N contiguous cells through the grid's own keyboard contract — Space to
 * anchor, Shift+ArrowRight to extend. Clicking would be the other route, but a
 * card is full of its own buttons and a modifier-click that lands on one selects
 * nothing; the keyboard path is both robust and the contract the surface
 * documents in its own footer.
 */
async function selectCells(page: Page, count: number): Promise<void> {
  const grid = page.locator(GRID).first();
  await grid.waitFor({ state: "visible", timeout: T_LONG });
  await grid.focus();
  await settle(page, 200);
  await page.keyboard.press("Space");
  for (let i = 1; i < count; i++) {
    await page.keyboard.press("Shift+ArrowRight");
    await settle(page, 80);
  }
  await settle(page, 250);
}

/**
 * Launch one fake-claude session in the currently active worktree and drive it
 * past the trust prompt, so the agent-state FSM reaches `working` for real.
 */
async function launchAgentSession(page: Page): Promise<string | null> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page).catch(() => {});
  await page
    .locator(SEL.agent.trayButton)
    .first()
    .click()
    .catch(() => {});
  await page
    .locator(SEL.agent.launcherRow("Claude"))
    .first()
    .click()
    .catch(() => {});

  let panelId: string | null = null;
  for (let i = 0; i < 60 && !panelId; i++) {
    const ids = await getGridPanelIds(page).catch(() => [] as string[]);
    panelId = ids.find((id) => !before.has(id)) ?? null;
    if (!panelId) await page.waitForTimeout(250);
  }
  if (!panelId) return null;

  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = (await getTerminalText(panel).catch(() => "")).toLowerCase();
    if (text.includes(FAKE_AGENT_READY.toLowerCase())) break;
    if (text.includes("enter to confirm") || text.includes("trust this folder")) {
      await writeTerminalInput(page, panel, "\r").catch(() => {});
      break;
    }
    await page.waitForTimeout(250);
  }
  await waitForTerminalText(panel, FAKE_AGENT_READY, T_LONG).catch(() => {});
  return panelId;
}

/**
 * Switch the active worktree through the overview itself. Going via the sidebar
 * looks simpler but is wrong: that list is virtualized, so a card below the fold
 * is not in the DOM at all and the click silently waits forever. The overview
 * renders every cell, and activating one there is a real user path — clicking a
 * card switches the worktree and closes the modal.
 */
async function activateWorktree(page: Page, branch: string): Promise<void> {
  await openOverview(page);
  // `data-worktree-branch` carries the DERIVED label, which drops the type
  // prefix — `perf/issue-7345-x` renders as `issue-7345-x`. Match the suffix, or
  // the locator can never resolve and the wait looks like a load failure.
  const leaf = branch.split("/").pop() ?? branch;
  const cell = page.locator(`${CELL}:has([data-worktree-branch$="${leaf}"])`).first();
  await cell.waitFor({ state: "visible", timeout: T_LONG });
  await cell.locator(`[aria-label^="Select worktree:"]`).first().click();
  await page
    .locator(MODAL)
    .waitFor({ state: "hidden", timeout: T_LONG })
    .catch(() => {});
  await settle(page, 700);
}

/**
 * Two real agent sessions: one left on its heartbeat (`working`), one stopped so
 * the idle debounce lands it on `waiting`. That is the only honest way to get the
 * header's activity summary chips on screen — the counts read the same FSM the
 * terminal chips do.
 */
async function seedAgentActivity(page: Page): Promise<void> {
  await activateWorktree(page, WORKING_WT.branch);
  await launchAgentSession(page);

  await activateWorktree(page, WAITING_WT.branch);
  const waitingPanelId = await launchAgentSession(page);
  if (waitingPanelId) {
    const panel = page.locator(`[data-panel-id="${waitingPanelId}"]`);
    await writeTerminalInput(page, panel, `${FAKE_AGENT_STOP}\r`).catch(() => {});
    await expect
      .poll(() => panel.getAttribute("data-agent-state"), {
        timeout: T_LONG,
        intervals: [400, 800],
      })
      .toBe("waiting");
  }
  await settle(page, 800);
}

interface OverviewState {
  slug: string;
  /** Included in the per-theme sweep. */
  sweep?: boolean;
  /** Also write a tight crop of the modal's top strip — the header question. */
  header?: boolean;
  /** `"page"` shoots the whole window: for portalled popovers and confirmations. */
  capture?: "modal" | "page";
  /** Requires the agent sessions; skipped under DAINTREE_SHOT_SESSIONS=0. */
  needsSessions?: boolean;
  /**
   * Window size for this state. Set explicitly for EVERY state rather than left
   * to a previous state's restore: `launchApp`'s initial size does not reliably
   * apply, and a missed restore silently relabels a capture — a shot filed as
   * "1680px" that actually rendered at 1200px sends the whole review reasoning
   * about a width that was never on screen.
   */
  size?: { width: number; height: number };
  arrange?: (page: Page, app: ElectronApplication) => Promise<void>;
  /** Asserted after the settle, before the shot. Throwing beats a wrong PNG. */
  verify: (page: Page) => Promise<void>;
  restore?: (page: Page, app: ElectronApplication) => Promise<void>;
}

const modalVisible = async (page: Page): Promise<void> => {
  await expect(page.locator(MODAL), "the overview modal is not on screen").toBeVisible({
    timeout: T_LONG,
  });
};

const cellsAtLeast = async (page: Page, n: number): Promise<void> => {
  await modalVisible(page);
  const count = await page.locator(CELL).count();
  if (count < n) throw new Error(`expected at least ${n} worktree cells, found ${count}`);
};

const STATES: OverviewState[] = [
  {
    // The resting surface at a comfortable width. Every header finding starts here.
    slug: "01-populated",
    sweep: true,
    header: true,
    verify: async (page) => {
      await cellsAtLeast(page, 8);
      await expect(page.locator(`${MODAL} #worktree-overview-title`)).toBeVisible();
    },
  },
  {
    // A large external display: the grid caps at 480px columns and centres, so the
    // question is whether 900 extra pixels buy anything.
    slug: "02-xl",
    size: XL,
    verify: async (page) => cellsAtLeast(page, 8),
  },
  {
    // The width the issue is actually about.
    slug: "03-narrow",
    sweep: true,
    header: true,
    size: NARROW,
    verify: async (page) => cellsAtLeast(page, 4),
  },
  {
    // Past the point where anything can be assumed to fit.
    slug: "04-tight",
    header: true,
    size: TIGHT,
    verify: async (page) => cellsAtLeast(page, 2),
  },
  {
    // A query narrows the set: the header's count must switch to "N of M".
    slug: "05-search",
    header: true,
    arrange: async (page) => typeQuery(page, "retry"),
    verify: async (page) => {
      await cellsAtLeast(page, 1);
      await expect(
        page.locator(`${MODAL} #worktree-overview-title`).locator("xpath=..")
      ).toContainText(/of \d+/);
    },
  },
  {
    // Nothing matches: the filtered-empty state, and what it offers instead.
    slug: "06-no-results",
    sweep: true,
    arrange: async (page) => typeQuery(page, "zzzznotathing"),
    verify: async (page) => {
      await modalVisible(page);
      await expect(page.locator(MODAL)).toContainText("No matches for");
      await expect(page.locator(CELL)).toHaveCount(0);
    },
  },
  {
    // A facet filter is on: the header grows a "Clear" control.
    slug: "07-filters-active",
    header: true,
    arrange: async (page) => {
      await openFilterPopover(page);
      // The Status section starts collapsed (`defaultOpen` keys off the active
      // count), and a collapsed section is `inert` — its chips are unclickable.
      const section = page
        .locator(`${SEL.worktree.filterPopover} button[aria-expanded]`)
        .filter({ hasText: "Status" })
        .first();
      if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
      await settle(page, 250);
      await page
        .locator(`${SEL.worktree.filterPopover} button`)
        .filter({ hasText: /^Dirty/ })
        .first()
        .click();
      await closeFilterPopover(page);
      await settle(page, 400);
    },
    verify: async (page) => {
      await modalVisible(page);
      await expect(page.locator(`${MODAL} [aria-label="Clear all filters"]`)).toBeVisible({
        timeout: T_LONG,
      });
    },
  },
  {
    // The facet popover open over the grid — the tallest thing the surface shows.
    slug: "08-filter-popover",
    capture: "page",
    arrange: async (page) => openFilterPopover(page),
    verify: async (page) => {
      await modalVisible(page);
      await expect(page.locator(SEL.worktree.filterPopover)).toBeVisible({ timeout: T_LONG });
    },
    restore: async (page) => closeFilterPopover(page),
  },
  {
    // Grouped by type: seven section headers break the grid at `col-[1/-1]`.
    slug: "09-grouped",
    arrange: async (page) => ensureGrouped(page, true),
    verify: async (page) => {
      await cellsAtLeast(page, 8);
      const headings = await page.locator(`${GRID} h3`).count();
      if (headings < 3) throw new Error(`expected grouped section headings, found ${headings}`);
    },
    restore: async (page) => ensureGrouped(page, false),
  },
  {
    // Main hidden: the toggle's own struck-through state, and one fewer card.
    slug: "10-main-hidden",
    header: true,
    arrange: async (page) => {
      const hide = page.locator(`${MODAL} [aria-label="Hide main worktree"]`).first();
      await hide.waitFor({ state: "visible", timeout: T_LONG });
      await hide.click();
      await settle(page, 400);
    },
    verify: async (page) => {
      await cellsAtLeast(page, 8);
      await expect(page.locator(`${MODAL} [aria-label="Show main worktree"]`)).toBeVisible();
    },
    restore: async (page) => ensureMainVisible(page),
  },
  {
    // One card selected — the moment the header swaps.
    slug: "11-select-one",
    header: true,
    arrange: async (page) => selectCells(page, 1),
    verify: async (page) => {
      await modalVisible(page);
      await expect(page.locator(MODAL)).toContainText("1 selected");
    },
    restore: async (page) => clearSelection(page),
  },
  {
    // Five selected: the bulk bar at the density where it matters.
    slug: "12-select-many",
    sweep: true,
    header: true,
    arrange: async (page) => selectCells(page, 5),
    verify: async (page) => {
      await modalVisible(page);
      await expect(page.locator(MODAL)).toContainText("5 selected");
      await expect(page.locator(SEL.worktree.bulkRemove)).toBeVisible();
    },
    restore: async (page) => clearSelection(page),
  },
  {
    // The selection bar at the narrow width: does it fit?
    slug: "13-select-narrow",
    header: true,
    size: NARROW,
    arrange: async (page) => selectCells(page, 5),
    verify: async (page) => {
      await modalVisible(page);
      await expect(page.locator(MODAL)).toContainText("5 selected");
    },
    restore: async (page) => clearSelection(page),
  },
  {
    // D3 bulk remove: typed-name gate over the real target list.
    slug: "14-bulk-remove-confirm",
    capture: "page",
    arrange: async (page) => {
      await selectCells(page, 3);
      await page.locator(SEL.worktree.bulkRemove).click();
      await settle(page, 500);
    },
    verify: async (page) => {
      // Not the count: main worktrees are filtered out at confirm-derive time, so
      // selecting three cells can legitimately yield a two-target confirmation
      // plus an "excluded" line. What must be true is that this is the D3 gate —
      // the typed-count sentence and the per-target blast-radius list.
      // `:is(dialog, alertdialog)` on purpose: this confirmation is destructive
      // and is NOT passed `hasPreview`, so AppDialog gives it `role="alertdialog"`
      // despite the scrollable target list inside it. Recorded as a finding; the
      // harness just has to match what actually renders.
      const confirm = page.locator(CONFIRM_DIALOG).first();
      await expect(confirm, "the bulk-remove confirmation never opened").toBeVisible({
        timeout: T_LONG,
      });
      await expect(
        confirm,
        "the confirmation is missing its typed-count gate — D3 safeguard"
      ).toContainText("Type the count to confirm");
    },
    restore: async (page) => {
      await cancelConfirm(page);
      await clearSelection(page);
    },
  },
  {
    // D1 close sessions.
    slug: "15-close-sessions-confirm",
    capture: "page",
    arrange: async (page) => {
      await selectCells(page, 2);
      await page.locator(SEL.worktree.bulkCloseSessions).click();
      await settle(page, 500);
    },
    verify: async (page) => {
      const confirm = page.locator(CONFIRM_DIALOG).first();
      await expect(confirm, "the close-sessions confirmation never opened").toBeVisible({
        timeout: T_LONG,
      });
      await expect(confirm).toContainText("Scrollback is lost");
    },
    restore: async (page) => {
      await cancelConfirm(page);
      await clearSelection(page);
    },
  },
  {
    // Where initial focus lands on open. The header crop is the evidence: a
    // keyboard user's first ring should be somewhere useful.
    slug: "16-focus-initial",
    header: true,
    arrange: async (page) => {
      await closeOverview(page);
      await settle(page, 400);
      await openOverview(page);
      // A real key event is required for :focus-visible to match at all.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await settle(page, 300);
    },
    verify: async (page) => {
      await cellsAtLeast(page, 8);
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          label: el?.getAttribute("aria-label") ?? el?.tagName ?? "none",
          visible: !!el?.matches(":focus-visible"),
        };
      });
      // Not an assertion about WHERE — that is the finding. Only that something
      // inside the modal owns a visible ring, so the crop shows a real state.
      if (!focused.visible) throw new Error(`no :focus-visible element (${focused.label})`);
    },
  },
  {
    // The grid focused, with its active descendant ring — the primary keyboard
    // affordance, and the only one arrow-key navigation depends on.
    slug: "17-focus-grid",
    header: true,
    arrange: async (page) => {
      await page.locator(GRID).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      await settle(page, 300);
    },
    verify: async (page) => {
      await cellsAtLeast(page, 8);
      await expect(page.locator(GRID)).toHaveAttribute("aria-activedescendant", /.+/, {
        timeout: T_LONG,
      });
    },
  },
  {
    // Windows High Contrast. Selection is indicated by a tint plus a neutral
    // inset ring; forced-colors drops backgrounds and box-shadows entirely.
    slug: "18-forced-colors",
    header: true,
    arrange: async (page) => {
      await selectCells(page, 3);
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 400);
    },
    verify: async (page) => {
      await modalVisible(page);
      await expect(page.locator(MODAL)).toContainText("3 selected");
    },
    restore: async (page) => {
      await page.emulateMedia({ forcedColors: "none" });
      await clearSelection(page);
    },
  },
  {
    // macOS "Increase contrast".
    slug: "19-contrast-more",
    header: true,
    arrange: async (page) => {
      await selectCells(page, 3);
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 400);
    },
    verify: async (page) => {
      await modalVisible(page);
      await expect(page.locator(MODAL)).toContainText("3 selected");
    },
    restore: async (page) => {
      await page.emulateMedia({ contrast: "no-preference" });
      await clearSelection(page);
    },
  },
  {
    // Reduced motion: the working chip's pulsing dot is `motion-safe:` gated, so
    // this is the shot that shows what a reduced-motion user actually sees.
    slug: "20-reduced-motion",
    header: true,
    needsSessions: true,
    arrange: async (page) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await settle(page, 400);
    },
    verify: async (page) => cellsAtLeast(page, 8),
    restore: async (page) => page.emulateMedia({ reducedMotion: "no-preference" }),
  },
  {
    // The activity summary chips, produced by two real agent FSMs.
    slug: "21-activity-chips",
    sweep: true,
    header: true,
    needsSessions: true,
    verify: async (page) => {
      await cellsAtLeast(page, 8);
      await expect(
        page.locator(`${MODAL} [aria-label="Filter by agent state"]`),
        "no activity summary chips — the agent sessions did not reach a reportable state"
      ).toBeVisible({ timeout: T_LONG });
    },
  },
  {
    // A quick-state chip engaged: the header's own filter, active.
    slug: "22-quickstate-active",
    header: true,
    needsSessions: true,
    arrange: async (page) => {
      await page.locator(`${MODAL} [aria-label="Filter by agent state"] button`).first().click();
      await settle(page, 400);
    },
    verify: async (page) => {
      await modalVisible(page);
      await expect(
        page.locator(`${MODAL} [aria-label="Filter by agent state"] button[aria-pressed="true"]`)
      ).toBeVisible({ timeout: T_LONG });
    },
    restore: async (page) => {
      await page
        .locator(`${MODAL} [aria-label="Filter by agent state"] button[aria-pressed="true"]`)
        .first()
        .click()
        .catch(() => {});
    },
  },
];

async function snap(page: Page, slug: string, target: string | null): Promise<void> {
  const locator = target === null ? page : page.locator(target).first();
  await locator.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}--${THEME_SLUG}${TAG}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
}

/**
 * The header crop. Clipped from the window rather than shot from a container so
 * the baseline needs no test id on product markup, and so the crop keeps the
 * scrim on either side — which is itself part of the frame question.
 */
async function snapHeader(page: Page, slug: string): Promise<void> {
  const box = await page.locator(MODAL).first().boundingBox();
  if (!box) throw new Error(`${slug}: modal has no box — refusing to write a header crop`);
  const height = Math.min(200, Math.round(box.height));
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}-header--${THEME_SLUG}${TAG}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x: Math.max(0, box.x - 24),
      y: Math.max(0, box.y - 24),
      width: Math.round(box.width) + 48,
      height: height + 24,
    },
  });
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const failures: string[] = [];
let captured = 0;

test("worktree overview review — frame, header hierarchy and selection mode", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_OVERVIEW is required for the worktree-overview capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_OVERVIEW to run the worktree-overview capture");

  failures.length = 0;
  captured = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const fakeBinDir = installFakeAgent(repo.dir);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-overviewshot-"));
  let ctx: AppContext | undefined;

  const planned = STATES.filter(
    (s) =>
      (ONLY.length === 0 || ONLY.includes(s.slug)) &&
      (!SWEEP_ONLY || s.sweep) &&
      (WITH_SESSIONS || !s.needsSessions)
  );

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);

    // Every worktree must be present before anything is judged, or the review is
    // looking at a project that had not finished loading. The check runs against
    // the overview's own grid rather than the sidebar: the sidebar list is
    // virtualized, so a card below the fold is simply not in the DOM and waiting
    // on one reports a load failure that never happened.
    await expect(
      page.locator(SEL.worktree.mainCard).first(),
      "the project never finished loading its worktrees"
    ).toBeVisible({ timeout: 60_000 });
    await settle(page, 1500);
    await openOverview(page);
    await expect
      .poll(() => page.locator(CELL).count(), { timeout: 60_000, intervals: [500, 1000] })
      .toBeGreaterThanOrEqual(WORKTREES.length);
    await closeOverview(page);
    await settle(page, 500);

    if (WITH_SESSIONS && planned.some((s) => s.needsSessions)) {
      await seedAgentActivity(page).catch((error) => {
        failures.push(`agent seeding: ${String(error).slice(0, 200)}`);
      });
    }

    for (const state of planned) {
      const app = ctx.app;
      try {
        await setWindowSize(app, state.size ?? WIDE);
        await settle(page, 450);
        await resetSurface(page);
        if (state.arrange) await state.arrange(page, app);
        await settle(page, 500);

        await state.verify(page);

        if (state.capture === "page") {
          await snap(page, `${state.slug}--page`, null);
        } else {
          await snap(page, state.slug, MODAL);
        }
        captured++;

        if (state.header) {
          await snapHeader(page, state.slug);
          captured++;
        }
      } catch (error) {
        const detail = String(error).slice(0, 400);
        console.warn(`[overview-shots] state "${state.slug}" failed:`, detail);
        failures.push(`${state.slug}: ${detail}`);
      } finally {
        if (state.restore) {
          await state.restore(page, app).catch((error) => {
            failures.push(`${state.slug} (restore): ${String(error).slice(0, 200)}`);
          });
        }
      }
    }
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // The exit code only means something if it accounts for what landed on disk.
  const expected = planned.reduce((n, s) => n + (s.header ? 2 : 1), 0);
  console.log(`[overview-shots] ${captured}/${expected} PNGs → ${OUTPUT_DIR}`);
  if (failures.length > 0) {
    throw new Error(`worktree-overview capture failed:\n  ${failures.join("\n  ")}`);
  }
  expect(captured, `expected ${expected} PNGs, wrote ${captured}`).toBe(expected);
});
