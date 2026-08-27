/**
 * Sidebar `WorktreeCard` visual-review harness.
 *
 * Boots a fixture repo whose worktrees are shaped to exercise the card's real
 * variation — an issue-derived headline, a very long one, a plain branch label,
 * a dirty tree with a live AI note, a clean tree with nothing to say — then
 * writes PNGs of every state that carries design weight so the card can be
 * judged against rendered pixels rather than JSX.
 *
 * Everything is driven through the app's real seams:
 *   - Issue number + headline come from the branch name (`issue-<n>-<slug>`),
 *     which is what `extractIssueNumberSync` / `deriveBranchTitle` read offline.
 *   - The AI note is a real `<gitdir>/daintree/note` file, read by NoteFileReader.
 *   - Changed files, diff stats, last commit, author and ahead/behind are real git.
 *   - Sessions are real PTYs; agent rows use the shared fake-claude CLI.
 * Nothing is faked at the component level, so a capture shows a state the app
 * can actually produce.
 *
 * Opt-in only, like the sibling review harnesses: skips itself unless
 * DAINTREE_SHOT_CARD is set, so the marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_CARD=1 npx playwright test --project=screenshots worktree-card-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CARD    required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME   optional theme id for the single-theme states
 *   DAINTREE_SHOT_TAG     optional suffix so review rounds sit side by side
 *   DAINTREE_SHOT_ONLY    comma-separated step filter (step names below)
 *   DAINTREE_SHOT_THEMES  comma-separated theme sweep (default: every built-in)
 *   DAINTREE_SHOT_SESSIONS  set to "0" to skip the (slow) session launches
 *
 * Output: artifacts/card-shots/<NN-slug>[-tag].png (gitignored).
 *
 * Hard rule, inherited from the other review harnesses and then some: this spec
 * never writes a PNG it has not verified. `snap()` asserts the target is on
 * screen and has a real box before it writes, and throws otherwise — a missing
 * file is a loud, correct failure, where a plausible-looking wrong file sends a
 * whole design review off reasoning about a screen that does not exist.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { getGridPanelIds } from "../helpers/panels";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import { installFakeAgent, fakeAgentEnv, FAKE_AGENT_READY } from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_CARD;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const WITH_SESSIONS = process.env.DAINTREE_SHOT_SESSIONS !== "0";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "card-shots");

/** Every built-in theme. The sweep reloads in place; no re-boot needed. */
export const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const SWEEP_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

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

const SIDEBAR_RESIZE = '[role="separator"][aria-label^="Resize sidebar"]';

/**
 * The cards, in sidebar order. Each one exists to make a different part of the
 * card's variation visible — see `why`.
 */
const WORKTREES = {
  /**
   * The flagship. Issue-derived headline, dirty tree with a realistic diff
   * stat, a live AI note, a multi-line last commit, and (when sessions are on)
   * the Active Sessions list. Nearly every review finding lands on this card.
   */
  flagship: {
    branch: "feature/issue-4821-stream-upload-retry-with-backoff",
    slug: "stream-upload-retry",
    note: "Reworked the retry ladder so a 429 backs off on the server's Retry-After instead of the fixed 2s step. Still need to decide whether the jitter is per-attempt or per-request — see https://github.com/daintreehq/daintree/issues/4821",
  },
  /** Long headline + long branch: the truncation and overflow case. */
  long: {
    branch:
      "feature/issue-9310-collapse-the-inspector-panel-when-the-window-narrows-below-the-medium-breakpoint",
    slug: "collapse-inspector",
    note: undefined,
  },
  /** No issue number → the BranchLabel path rather than IssueBadge. */
  plain: {
    branch: "fix/retry-backoff-jitter",
    slug: "retry-jitter",
    note: undefined,
  },
  /** Clean tree, no note: the narrative slot falls through to the last commit. */
  quiet: {
    branch: "feature/issue-7702-dark-mode-token-audit",
    slug: "dark-mode-tokens",
    note: undefined,
  },
} as const;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Realistic file bodies — sparse fixtures hide the defects worth finding. */
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

interface FixtureRepo {
  dir: string;
  worktreeRoot: string;
  cleanup: () => void;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

/**
 * Repo + linked worktrees, each shaped for the card state it has to produce.
 * The AI note goes to `<gitdir>/daintree/note`, which is the file NoteFileReader
 * actually reads — not a store patch.
 */
function createFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-cardshots-"));
  const worktreeRoot = path.join(path.dirname(dir), `${path.basename(dir)}-worktrees`);
  mkdirSync(worktreeRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "avery@helios.dev"', dir);
  git('config user.name "Avery Lindqvist"', dir);
  writeFiles(dir, SEED_FILES);
  git("add -A", dir);
  git('commit -m "Set up the ingest console skeleton"', dir);

  for (const wt of Object.values(WORKTREES)) {
    const wtDir = path.join(worktreeRoot, wt.slug);
    git(`worktree add -b ${wt.branch} "${wtDir}" main`, dir);
    git('config user.email "avery@helios.dev"', wtDir);
    git('config user.name "Avery Lindqvist"', wtDir);

    if (wt.note) {
      // The note lives in the worktree's own git dir, which for a linked
      // worktree is `<main>/.git/worktrees/<name>`.
      const gitDir = path.join(dir, ".git", "worktrees", wt.slug, "daintree");
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(path.join(gitDir, "note"), wt.note);
    }
  }

  // Flagship: a real commit with a real multi-line message, then a dirty tree
  // across several folders so the diff stat and the grouped file list both fill.
  const flagshipDir = path.join(worktreeRoot, WORKTREES.flagship.slug);
  writeFiles(flagshipDir, {
    "src/retry.ts":
      "export interface RetryOptions {\n  attempts: number;\n  baseDelayMs: number;\n  respectRetryAfter?: boolean;\n}\n",
  });
  git("add -A", flagshipDir);
  git(
    'commit -m "Honour Retry-After on 429 responses" -m "The fixed 2s ladder hammered the ingest API during a partial outage. Read the header when the server sends one and fall back to the exponential step otherwise."',
    flagshipDir
  );
  writeFiles(flagshipDir, {
    "src/retry.ts":
      "export interface RetryOptions {\n  attempts: number;\n  baseDelayMs: number;\n  respectRetryAfter?: boolean;\n  jitter?: 'per-attempt' | 'per-request';\n}\n\nexport function backoffDelay(attempt: number, opts: RetryOptions): number {\n  return opts.baseDelayMs * 2 ** attempt;\n}\n",
    "src/upload/stream.ts":
      "import { retry } from '../retry';\n\nexport async function streamUpload(body: ReadableStream): Promise<void> {\n  await retry(async () => {\n    void body;\n  }, { attempts: 5, baseDelayMs: 250, respectRetryAfter: true });\n}\n",
    "src/upload/parts.ts": "export const PART_SIZE = 16 * 1024 * 1024;\n",
    "src/api/client.ts":
      "export const BASE_URL = 'https://api.helios.dev';\nexport const RETRY_AFTER_CAP_MS = 30_000;\n",
    "src/upload/checksum.ts":
      "export function checksum(chunk: Uint8Array): string {\n  return String(chunk.byteLength);\n}\n",
    "docs/retry-policy.md": "# Retry policy\n\nRespect Retry-After. Cap at 30s.\n",
  });

  // Long-title card: one modified file, so it is dirty but not busy.
  const longDir = path.join(worktreeRoot, WORKTREES.long.slug);
  writeFiles(longDir, {
    "src/index.ts":
      "export { startCheckout } from './checkout';\nexport { retry } from './retry';\nexport { useBreakpoint } from './breakpoint';\n",
  });

  // Plain branch: committed and ahead of main, clean tree.
  const plainDir = path.join(worktreeRoot, WORKTREES.plain.slug);
  writeFiles(plainDir, {
    "src/retry.ts": SEED_FILES["src/retry.ts"] + "\nexport const JITTER = 0.2;\n",
  });
  git("add -A", plainDir);
  git('commit -m "Add a jitter constant"', plainDir);

  // Quiet card stays exactly as branched: clean, no note, nothing to report.

  return {
    dir,
    worktreeRoot,
    cleanup: () => {
      if (existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written = new Set<string>();

/**
 * Capture, but only after proving there is something real to capture.
 *
 * A harness that swallows a failed step reports success while producing no
 * files, and one that shoots too early writes a plausible empty-state PNG over
 * a good one. So: settle, assert the target is visible with a non-degenerate
 * box, optionally assert the content that makes this state *this* state, and
 * only then write. Anything else throws.
 */
async function snap(
  page: Page,
  slug: string,
  target?: Locator,
  expectText?: string | RegExp
): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);

  if (target) {
    await expect(target, `"${slug}": target never became visible — refusing to write`).toBeVisible({
      timeout: T_LONG,
    });
    const box = await target.boundingBox();
    if (!box || box.width < 40 || box.height < 16) {
      throw new Error(`"${slug}": target box is ${JSON.stringify(box)} — refusing to write`);
    }
    if (expectText !== undefined) {
      await expect(target, `"${slug}": expected content missing — refusing to write`).toContainText(
        expectText,
        { timeout: T_LONG }
      );
    }
    await target.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }

  written.add(`${slug}${TAG}.png`);
}

/** Every capture step is named so `DAINTREE_SHOT_ONLY` can select it. */
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];

/**
 * Steps do not silently swallow: a failure is recorded and re-reported at the
 * end so the run fails loudly, while later steps still get to produce their
 * shots (one broken state should not cost the whole round).
 */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 400);
    stepFailures.push(`${name}: ${detail}`);
    console.warn(`[card-shots] step "${name}" FAILED:`, detail);
  }
}

const row = (page: Page, branch: string): Locator => page.locator(SEL.worktree.row(branch)).first();

const sectionButton = (rowLocator: Locator, kind: "details" | "terminals"): Locator =>
  rowLocator.locator(`[id$="-${kind}-button"]`).first();

/** Toggle a disclosure only when it is not already in the wanted state. */
async function setSection(
  rowLocator: Locator,
  kind: "details" | "terminals",
  expanded: boolean
): Promise<void> {
  const button = sectionButton(rowLocator, kind);
  if (!(await button.isVisible().catch(() => false))) return;
  const current = (await button.getAttribute("aria-expanded")) === "true";
  if (current !== expanded) {
    await button.click();
    await rowLocator.page().waitForTimeout(350);
  }
}

/**
 * Card-level collapse lives on the header toolbar, not the section buttons.
 * The toolbar also holds the "More actions" trigger, which carries its own
 * `aria-expanded` — so target the collapse control by its label, and verify the
 * card actually reached the wanted state. A silently-failed restore leaves the
 * card collapsed, which makes every later step shoot the wrong component.
 */
async function setCardCollapsed(rowLocator: Locator, collapsed: boolean): Promise<void> {
  const toggle = rowLocator
    .locator(
      '[data-worktree-row-toolbar] [aria-label="Expand card"], [data-worktree-row-toolbar] [aria-label="Collapse card"]'
    )
    .first();
  await expect(toggle, "card collapse toggle is missing").toBeVisible({ timeout: T_LONG });
  const expanded = (await toggle.getAttribute("aria-expanded")) === "true";
  if (expanded === collapsed) {
    await toggle.click();
    await rowLocator.page().waitForTimeout(400);
  }
  await expect(toggle, `card did not reach collapsed=${collapsed}`).toHaveAttribute(
    "aria-expanded",
    collapsed ? "false" : "true",
    { timeout: T_LONG }
  );
}

/** Nudge the sidebar to a target width through its real keyboard resize path. */
async function setSidebarWidth(page: Page, target: number): Promise<void> {
  const handle = page.locator(SIDEBAR_RESIZE).first();
  if (!(await handle.isVisible().catch(() => false))) return;
  await handle.focus();
  const current = Number((await handle.getAttribute("aria-valuenow")) ?? "0");
  const key = target < current ? "ArrowLeft" : "ArrowRight";
  for (let i = 0; i < 60; i++) {
    const now = Number((await handle.getAttribute("aria-valuenow")) ?? "0");
    if (Math.abs(now - target) <= 12) break;
    if (target < current && now <= target) break;
    if (target > current && now >= target) break;
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(250);
}

/**
 * Launch one fake-claude session in the active worktree and drive it past the
 * trust prompt so the row renders a real agent state rather than a cold shell.
 */
async function launchAgentSession(page: Page): Promise<string | null> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page).catch(() => {});
  await page
    .locator(SEL.agent.trayButton)
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

test("sidebar worktree card review — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CARD is required for the worktree-card capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_CARD to run the worktree-card capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const fakeBinDir = installFakeAgent(repo.dir);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-cardshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);

    const sidebar = page.locator(SEL.sidebar.aside).first();
    const flagship = row(page, WORKTREES.flagship.branch);
    const long = row(page, WORKTREES.long.branch);
    const plain = row(page, WORKTREES.plain.branch);
    const quiet = row(page, WORKTREES.quiet.branch);

    // Every card must exist before any capture, or the whole run is judging a
    // sidebar that never finished loading.
    for (const [name, locator] of Object.entries({ flagship, long, plain, quiet })) {
      await expect(locator, `worktree card "${name}" never rendered`).toBeVisible({
        timeout: T_LONG,
      });
    }
    // Git status is polled, so wait for the flagship's diff stat to arrive
    // rather than shooting the pre-status card.
    await expect(flagship, "flagship card never reported its changed files").toContainText(
      /\d+ files/,
      { timeout: T_LONG }
    );
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    // 1. The sidebar as a whole — the only shot that shows what repetition does.
    await step("sidebar", async () => {
      await snap(page, "10-sidebar-rest", sidebar);
      await snap(page, "11-window-rest");
    });

    // 2. The flagship card with Details collapsed: the resting card, and the
    //    single most repeated shape in the app.
    await step("resting", async () => {
      await setSection(flagship, "details", false);
      await snap(page, "20-card-resting", flagship, /\d+ files/);
    });

    // 3. Details expanded — the nested-card stack the issue is about.
    await step("expanded", async () => {
      await setSection(flagship, "details", true);
      await snap(page, "30-card-details-expanded", flagship, "Changed Files");
    });

    // 4. The quiet card expanded: clean tree, no note, so the narrative slot
    //    falls through to the last commit message. (The "No AI summary yet"
    //    placeholder is not reachable here — a real worktree always has a last
    //    commit, which wins the slot before the placeholder is considered.)
    await step("quiet", async () => {
      await setSection(quiet, "details", true);
      await snap(page, "40-card-clean-expanded", quiet, "Set up the ingest console skeleton");
      await setSection(quiet, "details", false);
    });

    // 5. Long headline and long branch — truncation and overflow.
    await step("long", async () => {
      await setSection(long, "details", true);
      await snap(page, "50-card-long-title", long);
      await setSection(long, "details", false);
    });

    // 6. Plain branch label rather than an issue headline.
    await step("plain", async () => {
      await snap(page, "55-card-plain-branch", plain);
    });

    // 7. Selected. The right-edge accent, the background lift, and how the
    //    expanded chrome reads on the elevated surface.
    await step("selected", async () => {
      await flagship.click({ position: { x: 120, y: 12 } });
      await page.waitForTimeout(600);
      await snap(page, "60-card-selected", flagship);
      await snap(page, "61-sidebar-selected", sidebar);
    });

    // 8. Card fully collapsed — disclosure as a pair with the expanded state.
    await step("collapsed", async () => {
      await setCardCollapsed(flagship, true);
      await snap(page, "70-card-collapsed", flagship);
      await snap(page, "71-sidebar-collapsed", sidebar);
      await setCardCollapsed(flagship, false);
    });

    // 9. Keyboard focus. The row draws no ring by design (#8094); the toolbar
    //    and drag handle revealing IS the affordance, so it has to be legible.
    await step("focus", async () => {
      await sectionButton(flagship, "details").focus();
      await snap(page, "80-card-keyboard-focus", flagship);
    });

    // 10. Sessions. Real PTYs in the flagship worktree so Active Sessions has
    //     agent identity, state and location to render — the densest row in
    //     the card and the one that shares a shell with Details.
    if (WITH_SESSIONS) {
      await step("sessions", async () => {
        // Sessions land in the ACTIVE worktree, so the flagship has to be it.
        // The `selected` step already selected it; re-clicking by coordinate is
        // unreliable once the row is taller than the sidebar viewport, so
        // assert rather than click, and only click if the assertion would fail.
        const card = flagship.locator(".sidebar-worktree-card").first();
        if ((await card.getAttribute("data-active")) !== "true") {
          await card.click();
        }
        await expect(card, "flagship is not the active worktree").toHaveAttribute(
          "data-active",
          "true",
          { timeout: T_LONG }
        );
        await page.waitForTimeout(800);
        await launchAgentSession(page);
        await launchAgentSession(page);
        await page.waitForTimeout(1500);
        await dismissBlockingPalette(page);

        await setSection(flagship, "terminals", true);
        await snap(page, "100-card-sessions-expanded", flagship, "Active Sessions");
        await setSection(flagship, "details", true);
        await snap(page, "101-card-details-and-sessions", flagship, "Active Sessions");
        await snap(page, "102-sidebar-loaded", sidebar);
        await setSection(flagship, "terminals", false);
        await snap(page, "103-card-sessions-collapsed", flagship, "active");
        await setSection(flagship, "terminals", true);
      });
    }

    // 11. Narrow sidebar — where truncation and the trailing cluster compete.
    await step("narrow", async () => {
      await setSidebarWidth(page, 240);
      await snap(page, "90-sidebar-narrow", sidebar);
      await snap(page, "91-card-narrow", flagship);
      await setSidebarWidth(page, 320);
    });

    // 12. High contrast. macOS fires prefers-contrast; forced-colors is the
    //     Windows half. Both are emulated so the pair can be compared.
    await step("contrast", async () => {
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 400);
      await snap(page, "110-card-prefers-contrast", flagship);
      await page.emulateMedia({ contrast: "no-preference" });
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 400);
      await snap(page, "111-card-forced-colors", flagship);
      await page.emulateMedia({ forcedColors: "none" });
      await settle(page, 400);
    });

    // 13. Theme sweep of the state everything else is judged against. Theme
    //     collapse is real and only a sweep across all of them finds it.
    await step("themes", async () => {
      const themes = SWEEP_THEMES.length > 0 ? SWEEP_THEMES : ALL_THEMES;
      for (const theme of themes) {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        const themedRow = row(page, WORKTREES.flagship.branch);
        await expect(themedRow, `card missing after switching to ${theme}`).toBeVisible({
          timeout: T_LONG,
        });
        await setSection(themedRow, "details", true);
        await settle(page, 800);
        await snap(page, `200-theme-${theme}`, themedRow);
      }
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // Count the outputs ourselves. A passing exit code says nothing about
  // whether the harness actually produced anything.
  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`));
  console.log(`[card-shots] wrote ${written.size} shots; ${onDisk.length} PNGs on disk`);
  if (written.size === 0) {
    throw new Error("[card-shots] produced no screenshots at all");
  }
  if (stepFailures.length > 0) {
    throw new Error(
      `[card-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
