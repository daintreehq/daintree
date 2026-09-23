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
 *   DAINTREE_SHOT_DIR     optional output dir (absolute), so review rounds can
 *                         write outside the repo
 *
 * Output: artifacts/card-shots/<NN-slug>[-tag].png (gitignored), or
 * DAINTREE_SHOT_DIR when set.
 *
 * The `commit-tooltip` and `commit-tooltip-themes` steps review the commit
 * hover card. They commit real (empty) commits into the quiet worktree with
 * chosen authors, dates and messages, so every card they shoot is one the app
 * built from `git log`. Gravatar is answered by a context route: one author has
 * a picture, everyone else gets the real `d=404`, which is what drives the
 * initials fallback.
 *
 * Hard rule, inherited from the other review harnesses and then some: this spec
 * never writes a PNG it has not verified. `snap()` asserts the target is on
 * screen and has a real box before it writes, and throws otherwise — a missing
 * file is a loud, correct failure, where a plausible-looking wrong file sends a
 * whole design review off reasoning about a screen that does not exist.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
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
  FAKE_AGENT_IDLE,
} from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_CARD;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const WITH_SESSIONS = process.env.DAINTREE_SHOT_SESSIONS !== "0";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "card-shots");

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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The one author Gravatar "knows"; every other email gets the real 404. */
const AVATAR_EMAIL = "avery@helios.dev";

const AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#c9a27e"/>
  <circle cx="32" cy="26" r="12" fill="#f1d3b5"/>
  <path d="M20 22c0-9 6-14 12-14s13 5 12 15c-3-5-8-7-12-7s-9 2-12 6z" fill="#4a2f22"/>
  <path d="M8 64c2-14 12-21 24-21s22 7 24 21z" fill="#35577a"/>
</svg>`;

interface CommitVariant {
  slug: string;
  subject: string;
  body: string;
  author: { name: string; email: string };
  ageMs: number;
}

/**
 * Commit shapes the hover card has to survive, committed in this order. The
 * last one stays HEAD for the theme sweep, so it is the richest.
 */
const COMMIT_VARIANTS: CommitVariant[] = [
  {
    slug: "recent-short",
    subject: "Fix typo in the retry docs",
    body: "",
    author: { name: "Avery Lindqvist", email: AVATAR_EMAIL },
    ageMs: 2 * MINUTE_MS,
  },
  {
    slug: "bot",
    subject: "Bump esbuild from 0.21.5 to 0.25.0",
    body: [
      "Bumps [esbuild](https://github.com/evanw/esbuild) from 0.21.5 to 0.25.0.",
      "- [Release notes](https://github.com/evanw/esbuild/releases)",
      "- [Changelog](https://github.com/evanw/esbuild/blob/main/CHANGELOG.md)",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: esbuild",
      "  dependency-type: direct:development",
      "",
      "Signed-off-by: dependabot[bot] <support@github.com>",
    ].join("\n"),
    author: {
      name: "dependabot[bot]",
      email: "49699333+dependabot[bot]@users.noreply.github.com",
    },
    ageMs: 2 * DAY_MS + 3 * HOUR_MS,
  },
  {
    slug: "agent",
    subject: "Add a jitter option to backoffDelay",
    body: "Per-attempt by default; per-request is opt-in until the ingest team weighs in.",
    author: { name: "Claude", email: "noreply@anthropic.com" },
    ageMs: 25 * MINUTE_MS,
  },
  {
    slug: "ancient",
    subject: "Initial import of the ingest console",
    body: "",
    author: { name: "Mo", email: "mo@helios.dev" },
    ageMs: 3 * 365 * DAY_MS,
  },
  {
    slug: "long-multiline",
    subject:
      "Stream multipart uploads through the retry ladder so a dropped part resumes instead of restarting the whole file",
    body: [
      "Large uploads restarted from byte zero whenever a single part hit a 5xx, which on a flaky link meant a 4 GB file could retry for an hour and never land.",
      "",
      "Thread the part index through the retry ladder and keep a per-part checksum, so a failed part is re-sent on its own and the server stitches the rest.",
      "",
      "- cap concurrent parts at 4",
      "- keep the part checksum in the resume manifest",
      "- surface the resumed byte offset in the progress event",
      "",
      "Co-authored-by: Sam Okafor <sam@helios.dev>",
      "Co-authored-by: Claude <noreply@anthropic.com>",
    ].join("\n"),
    author: { name: "Priya Raman", email: "priya@helios.dev" },
    ageMs: 3 * HOUR_MS + 10 * MINUTE_MS,
  },
];

/** A real commit with a chosen author, date and message — no store patching. */
function commitVariant(cwd: string, variant: CommitVariant): void {
  const when = new Date(Date.now() - variant.ageMs).toISOString();
  const msgFile = path.join(tmpdir(), `daintree-cardshot-msg-${variant.slug}-${process.pid}`);
  writeFileSync(
    msgFile,
    variant.body ? `${variant.subject}\n\n${variant.body}\n` : variant.subject
  );
  try {
    execSync(`git commit --allow-empty -q -F "${msgFile}"`, {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: variant.author.name,
        GIT_AUTHOR_EMAIL: variant.author.email,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      },
    });
  } finally {
    rmSync(msgFile, { force: true });
  }
}

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

/**
 * Shoot the union of several boxes — a hover card together with the trigger
 * and card it hangs off — padded so the pointer relationship is visible. Same
 * refusal rules as `snap()`: every part must be on screen with a real box.
 */
async function snapUnion(page: Page, slug: string, parts: Locator[], pad = 16): Promise<void> {
  await settle(page, 300);
  const boxes = [];
  for (const part of parts) {
    await expect(part, `"${slug}": part never became visible — refusing to write`).toBeVisible({
      timeout: T_LONG,
    });
    const box = await part.boundingBox();
    if (!box || box.width < 8 || box.height < 8) {
      throw new Error(`"${slug}": part box is ${JSON.stringify(box)} — refusing to write`);
    }
    boxes.push(box);
  }
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x, y, width: right - x, height: bottom - y },
  });
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
    // Gravatar is answered locally so the avatar tiers are deterministic: the
    // one known author gets a picture, everyone else the real d=404 miss.
    const avatarHash = createHash("sha256").update(AVATAR_EMAIL).digest("hex");
    await ctx.app.context().route("https://www.gravatar.com/avatar/**", (route) => {
      if (route.request().url().includes(avatarHash)) {
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: AVATAR_SVG });
      }
      return route.fulfill({ status: 404, body: "" });
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
      await snap(page, "30-card-details-expanded", flagship, "Changed files");
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

    // 7. Selected vs inactive. The right-edge accent and the background lift
    //    only mean anything as a comparison, so shoot the selected card and an
    //    unselected sibling from the same frame, and assert which is which —
    //    otherwise a card that was incidentally selected by an earlier step
    //    reads as "selection is invisible".
    await step("selected", async () => {
      const flagshipCard = flagship.locator(".sidebar-worktree-card").first();
      const quietCard = quiet.locator(".sidebar-worktree-card").first();
      await flagshipCard.click();
      await expect(flagshipCard, "flagship did not become active").toHaveAttribute(
        "data-active",
        "true",
        { timeout: T_LONG }
      );
      await expect(quietCard, "sibling card should not be active").not.toHaveAttribute(
        "data-active",
        "true"
      );
      await page.waitForTimeout(600);
      await snap(page, "60-card-selected", flagship);
      await snap(page, "62-card-inactive", quiet);
      await snap(page, "61-sidebar-selected", sidebar);
    });

    // 8. Card fully collapsed — disclosure as a pair with the expanded state.
    //
    //    Two different states, and the second is the one that repeats. A
    //    collapsed card that is active or hovered carries the focused sub-line,
    //    so it is two lines tall; every other collapsed card in the list is a
    //    single line, and that is the shape a sidebar full of collapsed cards
    //    actually shows. The pointer is parked off the sidebar first, because a
    //    card left under the cursor renders the hovered two-line form and the
    //    capture would be of the wrong state entirely.
    await step("collapsed", async () => {
      await setCardCollapsed(flagship, true);
      await snap(page, "70-card-collapsed", flagship);
      await snap(page, "71-sidebar-collapsed", sidebar);
      await setCardCollapsed(plain, true);
      await setCardCollapsed(quiet, true);
      await setCardCollapsed(long, true);
      await page.mouse.move(1600, 980);
      await snap(page, "72-card-collapsed-resting", plain);
      await snap(page, "73-card-collapsed-resting-issue", quiet);
      await snap(page, "74-sidebar-all-collapsed", sidebar);
      // The drag grip is `opacity-0` until the card is hovered, so at rest the
      // gutter is empty and its alignment against the title row cannot be
      // judged at all. A real hover does not survive the capture — Playwright
      // scrolls the element into view to shoot it and Chromium drops the hover
      // — so the grip is revealed for this one frame with a capture-only
      // override. Opacity is the only thing it changes; where the glyph lands
      // is layout, and layout is what this shot is for.
      const revealGrip = await page.addStyleTag({
        content: "[data-worktree-row-drag-handle] { opacity: 1 !important; }",
      });
      await snap(page, "75-card-collapsed-grip", plain);
      await revealGrip.evaluate((node) => node.remove());
      // The defect this shot exists for was a 4px offset between the grip and
      // the line it sits beside, which is small enough to survive a glance at
      // the PNG — so the harness measures it rather than trusting the reader.
      // The collapse toggle is the reference because it is the tallest thing in
      // the title row and therefore defines that row's centre.
      const gripGlyph = await plain
        .locator("[data-worktree-row-drag-handle] svg")
        .first()
        .boundingBox();
      const toggleBox = await plain
        .locator('[data-worktree-row-toolbar] [aria-label="Expand card"]')
        .first()
        .boundingBox();
      if (!gripGlyph || !toggleBox) {
        throw new Error("collapsed row: grip glyph or collapse toggle has no box to measure");
      }
      const gripCentre = gripGlyph.y + gripGlyph.height / 2;
      const rowCentre = toggleBox.y + toggleBox.height / 2;
      expect(
        Math.abs(gripCentre - rowCentre),
        `collapsed row is not on one centre line: grip at ${gripCentre}, row at ${rowCentre}`
      ).toBeLessThanOrEqual(1);
      await page.mouse.move(1600, 980);
      // The other collapsed shape: the active card grows a focused sub-line, so
      // it is two lines inside the same collapsed chrome. It is the only state
      // in which the header block's padding has something between it and the
      // card's bottom edge, which is exactly where a one-sided pad would show.
      await flagship.locator(".sidebar-worktree-card").first().click();
      await page.mouse.move(1600, 980);
      await snap(page, "76-card-collapsed-active", flagship);
      await setCardCollapsed(long, false);
      await setCardCollapsed(quiet, false);
      await setCardCollapsed(plain, false);
      await setCardCollapsed(flagship, false);
    });

    // 9. Keyboard focus. The row draws no ring by design (#8094); the toolbar,
    //    drag handle and the disclosure's own outline are the affordance, so
    //    they have to be legible.
    //
    //    This must be driven by real Tab presses. A scripted `.focus()` on a
    //    <button> does not satisfy Chromium's `:focus-visible` heuristic, so a
    //    shot taken that way shows the surface with NO focus styling and looks
    //    exactly like a missing focus ring — a capture that lies about the very
    //    state it is named for. Tab until the target matches `:focus-visible`,
    //    and refuse to shoot if it never does.
    await step("focus", async () => {
      const target = sectionButton(flagship, "details");
      await expect(target, "details disclosure is missing").toBeVisible({ timeout: T_LONG });
      await page.locator(SEL.worktree.searchInput).first().click();
      let reached = false;
      for (let i = 0; i < 60 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await target
          .evaluate((el) => el === document.activeElement && el.matches(":focus-visible"))
          .catch(() => false);
      }
      if (!reached) {
        throw new Error("never reached :focus-visible on the details disclosure by Tab");
      }
      await snap(page, "80-card-keyboard-focus", flagship);
      await snap(page, "81-sidebar-keyboard-focus", sidebar);
    });

    // 10. Sessions. Real PTYs in the flagship worktree so Active Sessions has
    //     agent identity, state and location to render — the densest row in
    //     the card and the one that shares a shell with Details.
    if (WITH_SESSIONS) {
      // Held across the two steps: `waiting` drives one of the panels `sessions`
      // launched, and relaunching there would give it a fresh working agent.
      let agentPanelIds: string[] = [];
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
        agentPanelIds = [];
        for (let i = 0; i < 2; i++) {
          const id = await launchAgentSession(page);
          if (id) agentPanelIds.push(id);
        }
        await page.waitForTimeout(1500);
        await dismissBlockingPalette(page);

        // Details stays collapsed for the session shots. A card with both
        // sections open is taller than the sidebar viewport, and an element
        // screenshot of that stitches the list's sticky overlays across the
        // very rows being reviewed — 101 keeps that combined shot for the
        // nesting evidence, but the session rows have to be legible somewhere.
        await setSection(flagship, "details", false);
        await setSection(flagship, "terminals", true);
        await snap(page, "100-card-sessions-expanded", flagship, "Active sessions");
        await snap(page, "102-sidebar-loaded", sidebar);
        await setSection(flagship, "terminals", false);
        await snap(page, "103-card-sessions-collapsed", flagship, "active");
        await setSection(flagship, "terminals", true);
        await setSection(flagship, "details", true);
        await snap(page, "101-card-details-and-sessions", flagship, "Active sessions");
        await setSection(flagship, "details", false);
      });

      // 10b. The status tick, which had no capture coverage at all until this
      //      step. `computeChipState` only marks a card when something is
      //      actually asking for attention, so the two agents launched above —
      //      both `working` — leave it null and every shot before this one
      //      shows a card with no mark. Stopping one agent's OSC heartbeat
      //      settles the FSM to `waiting` through the app's own path, which is
      //      the state the tick exists for. Faking the class instead would
      //      review a card the app never renders.
      await step("waiting", async () => {
        const panelId = agentPanelIds[0];
        if (!panelId) {
          throw new Error("[card-shots] no agent panel to drive to waiting");
        }
        const panel = page.locator(`[data-panel-id="${panelId}"]`);
        await writeTerminalInput(page, panel, `${FAKE_AGENT_IDLE}\r`);
        await expect
          .poll(() => panel.getAttribute("data-agent-state"), {
            timeout: T_LONG * 2,
            intervals: [500, 1000],
          })
          .toBe("waiting")
          .catch(() => {});
        // Assert rather than warn: a capture of the un-waiting card labelled
        // "waiting" is exactly the plausible-looking wrong artifact this
        // harness refuses to produce elsewhere.
        await expect(
          panel,
          "agent never reached waiting — the tick shot would be a lie"
        ).toHaveAttribute("data-agent-state", "waiting", { timeout: T_LONG });
        await settle(page, 800);
        await setSection(flagship, "terminals", false);
        await snap(page, "110-card-tick-waiting", flagship);
        await snap(page, "111-sidebar-tick-waiting", sidebar);
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

    // 14. The commit hover card. Each variant is a real commit in the quiet
    //     worktree; the card is shot hanging off the activity chip that opens
    //     it, with the card around it for scale.
    const quietDir = path.join(repo.worktreeRoot, WORKTREES.quiet.slug);
    const hoverCard = (text: string): Locator =>
      page.locator("[data-radix-popper-content-wrapper]").filter({ hasText: text }).first();
    const activityTriggers = (rowLocator: Locator): Locator =>
      rowLocator.locator('[role="group"][aria-label="Last activity"]');

    /**
     * Hover `trigger` until its card shows `text`. Git status is polled, so a
     * fresh commit can take a few seconds to reach the card; re-hover rather
     * than trusting the first open, which may be the previous HEAD.
     */
    async function openHoverCard(trigger: Locator, text: string): Promise<Locator> {
      const card = hoverCard(text);
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await page.mouse.move(1600, 980);
        await page.waitForTimeout(250);
        await trigger.hover();
        // `isVisible` never waits, whatever its timeout says; under load the
        // card opens after the check and the loop would move away from it.
        const opened = await card
          .waitFor({ state: "visible", timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (opened) return card;
        await page.waitForTimeout(1500);
      }
      throw new Error(`hover card never showed "${text}"`);
    }

    /**
     * Open the card and shoot it, then prove it was still open when the shot
     * landed. A status poll can re-render the row and close the card between
     * the visibility check and the capture, which leaves a PNG of the card's
     * empty surroundings — so a card gone afterwards means reshoot, and three
     * misses in a row is a failure, never a written lie.
     */
    async function shootHoverCard(slug: string, trigger: Locator, text: string): Promise<void> {
      for (let attempt = 0; attempt < 6; attempt++) {
        // The first open proves the new commit reached the card; the polls
        // that follow a commit keep re-rendering the row for a few seconds, so
        // let them land before the shot that counts.
        await openHoverCard(trigger, text);
        await page.mouse.move(1600, 980);
        await page.waitForTimeout(1500 + attempt * 1500);
        const card = await openHoverCard(trigger, text);
        await snapUnion(page, slug, [card, trigger]);
        if (await card.isVisible()) return;
        if (process.env.DAINTREE_SHOT_DEBUG) {
          const dump = await page
            .locator("[data-radix-popper-content-wrapper]")
            .evaluateAll((els) => els.map((e) => (e.textContent ?? "").slice(0, 60)));
          console.log(`[card-shots] ${slug} attempt ${attempt}: wrappers=${JSON.stringify(dump)}`);
        }
        written.delete(`${slug}${TAG}.png`);
        rmSync(path.join(OUTPUT_DIR, `${slug}${TAG}.png`), { force: true });
      }
      throw new Error(`"${slug}": hover card kept closing before the capture landed`);
    }

    const quietCard = quiet.locator(".sidebar-worktree-card").first();
    const needle = (v: CommitVariant) => v.subject.slice(0, 24);

    await step("commit-tooltip", async () => {
      await setSection(flagship, "details", false);
      await setSection(quiet, "details", false);
      if ((await quietCard.getAttribute("data-active")) !== "true") await quietCard.click();
      await expect(quietCard, "quiet card did not become active").toHaveAttribute(
        "data-active",
        "true",
        { timeout: T_LONG }
      );
      for (const variant of COMMIT_VARIANTS) {
        commitVariant(quietDir, variant);
        const chip = activityTriggers(quiet).first();
        await shootHoverCard(`300-commit-${variant.slug}`, chip, needle(variant));
      }
      const last = COMMIT_VARIANTS[COMMIT_VARIANTS.length - 1]!;

      // The second trigger: the "Last active" footer inside expanded Details.
      // Expanding swaps the header chip out, so the footer is the only
      // activity trigger left on the card — assert it is the footer line.
      await page.mouse.move(1600, 980);
      await setSection(quiet, "details", true);
      const footer = activityTriggers(quiet).last();
      await expect(footer, "details footer trigger missing").toContainText("Last active", {
        timeout: T_LONG,
      });
      await shootHoverCard("310-commit-details-footer", footer, needle(last));
      await page.mouse.move(1600, 980);
      await setSection(quiet, "details", false);

      for (const [slug, media] of [
        ["320-commit-prefers-contrast", { contrast: "more" as const }],
        ["321-commit-forced-colors", { forcedColors: "active" as const }],
      ] as const) {
        await page.emulateMedia(media);
        await shootHoverCard(slug, activityTriggers(quiet).first(), needle(last));
      }
      await page.emulateMedia({ contrast: "no-preference", forcedColors: "none" });
      await page.mouse.move(1600, 980);
    });

    await step("commit-tooltip-themes", async () => {
      const last = COMMIT_VARIANTS[COMMIT_VARIANTS.length - 1]!;
      // Runnable on its own (`DAINTREE_SHOT_ONLY=commit-tooltip-themes`): put
      // the richest commit at HEAD unless the previous step already did.
      if (!(await hoverCard(needle(last)).count())) {
        const head = execSync("git log -1 --format=%s", { cwd: quietDir }).toString().trim();
        if (head !== last.subject) commitVariant(quietDir, last);
      }
      const themes = SWEEP_THEMES.length > 0 ? SWEEP_THEMES : ALL_THEMES;
      for (const theme of themes) {
        await page.mouse.move(1600, 980);
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        const themedQuiet = row(page, WORKTREES.quiet.branch);
        await shootHoverCard(
          `400-commit-theme-${theme}`,
          activityTriggers(themedQuiet).first(),
          needle(last)
        );
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
