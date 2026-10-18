/**
 * MCP approval-dialog visual-review harness (#11981).
 *
 * `McpConfirmDialog` is the singleton approval surface for every action an MCP
 * client asks Daintree to run. It has to answer several trust questions at once
 * — what will run, who asked, why it is gated, what content it affects, what
 * arguments it carries — and the shape of that answer changes with the caller,
 * the danger tier, and whether the fresh preview has landed yet. Those axes
 * cross into far more states than anyone reads the JSX for, so the surface is
 * judged on rendered pixels.
 *
 * States are parked directly in the confirmation queue through the E2E store
 * backdoor (`window.__DAINTREE_E2E_ENQUEUE_MCP_CONFIRM__`, installed by
 * `useE2EBridges` under DAINTREE_E2E_MODE) rather than by standing up a real
 * MCP client and a real destructive dispatch — the store IS the seam the
 * production bridge writes through, so the dialog renders exactly what it
 * renders in the app.
 *
 *   assistant-*   pinned help-session dispatch: no callerInfo, so the
 *                 "Requested by" block is absent. The skeleton must not lurch
 *                 between this and the external shape.
 *   external-*    unpinned external/api-key dispatch carrying the requesting
 *                 bearer's identity (#9157).
 *   preview-*     the off-critical-path preview fetch: pending (approval
 *                 disabled), populated, and empty/unavailable.
 *   overflow      hostile lengths — an 8 KB-class user agent, a long redacted
 *                 args blob, a 40-line preview. Proves the action row survives.
 *   queued        three concurrent dispatches; only the head is visible.
 *   cooldown      captured inside the destructive read-time gate, so the
 *                 primary button is disabled for reasons the user must be able
 *                 to tell apart from a broken action.
 *   focus         keyboard focus ring on the primary action.
 *   contrast      prefers-contrast: more.
 *   forced        forced-colors: active.
 *
 * Opt-in only, like confirm-dialog-review: skips itself unless
 * DAINTREE_SHOT_MCP is set, so the marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_MCP=1 npx playwright test --project=screenshots mcp-confirm-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MCP      required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME    optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG      optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (see step names above)
 *   DAINTREE_SHOT_OUT      optional absolute output dir (default: artifacts/…)
 *
 * Output: artifacts/mcp-confirm-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_MCP;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "mcp-confirm-shots");

/**
 * The dialog CARD, so the shot is the approval surface rather than the whole app.
 * Not `[role="dialog"]` — `AppDialog` puts the role on the full-viewport backdrop
 * (AppDialog.tsx:414), so a role-based locator silently screenshots the entire
 * window and every "crop" comes back identical to the in-window shot.
 */
const DIALOG_BACKDROP = "[data-app-dialog-surface]";
const DIALOG = `${DIALOG_BACKDROP} > div`;

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

/** Minimal repo so the app has a project view to mount the singleton dialog in. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-mcp-shots-"));
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

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture payloads. Deliberately realistic: `argsSummary` is what
// `summarizeMcpArgs` actually produces (redacted, JSON-ish), preview lines are
// what `buildMcpConfirmPreview` actually emits, and the rationale strings are
// copied from real action definitions.
// ---------------------------------------------------------------------------

const RATIONALE_DELETE =
  "Permanently removes the worktree directory and every uncommitted change inside it. The branch is left in place; the working copy is not recoverable.";

const PREVIEW_DIRTY = [
  "3 files with uncommitted changes:",
  "  M  src/components/Terminal/HybridInputBar.tsx",
  "  M  src/store/panelStore.ts",
  "  ?? src/components/Terminal/InputHistory.tsx",
];

const PREVIEW_PUSH = [
  "Branch: feature/agent-fanout → origin/feature/agent-fanout",
  "2 local commits ahead:",
  "  a41c9de  Widen the fanout budget to the worktree count",
  "  7bd0f12  Drop the per-agent sleep now the queue is bounded",
];

const ARGS_SHORT = '{\n  "worktreeId": "wt-agent-fanout"\n}';

const ARGS_LONG = [
  "{",
  '  "worktreeId": "wt-agent-fanout",',
  '  "branch": "feature/agent-fanout",',
  '  "force": true,',
  '  "removeDirectory": true,',
  '  "apiKey": "[redacted]",',
  '  "token": "[redacted]",',
  '  "context": {',
  '    "projectId": "proj-helios-dashboard",',
  '    "requestedBy": "assistant",',
  '    "correlationId": "0f1c3b6a-9d4e-4b2a-8c71-5e3f9a0d2b14"',
  "  },",
  '  "reason": "Cleaning up the fanout worktrees after the batch merged"',
  "}",
].join("\n");

const LONG_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SomeVeryChattyMcpClient/4.19.2-nightly.20260814+build.7719 Chrome/148.0.0.0 Safari/537.36 mcp-sdk/1.24.0";

const PREVIEW_HUGE = [
  "41 files with uncommitted changes:",
  ...Array.from({ length: 40 }, (_, i) => `  M  src/components/generated/Module${i + 1}.tsx`),
];

type ShotPayload = {
  requestId: string;
  actionId: string;
  actionTitle: string;
  actionDescription: string;
  argsSummary: string;
  danger: "safe" | "confirm" | "restricted";
  sessionOrigin?: "help" | "external";
  dangerRationale?: string;
  callerInfo?: { token4LastChars: string; userAgent: string };
  preview?: string[];
  previewTitle?: string;
  previewPending?: boolean;
  subject?: string;
  offerSessionApproval?: boolean;
  approvalReason?: "above-tier" | "protected-close";
  typedNameTarget?: string;
  selectableTargets?: {
    id: string;
    name: string;
    worktree?: string;
    kindLabel: string;
    agentRunning: boolean;
  }[];
  selectionConfirmLabel?: { verb: string; one: string; many: string };
};

/** An agent pane: main authenticated it with a per-pane bearer, so it may hold a session grant. */
const AGENT_PANE = { sessionOrigin: "external" as const, offerSessionApproval: true };

const PANEL_TARGETS = [
  ["Claude — fanout", "feature/agent-fanout", "Claude", true],
  ["Dev server", "feature/agent-fanout", "Terminal", false],
  ["Codex — review", "fix/review-queue", "Codex", false],
  ["Docs preview", "develop", "Browser", false],
  ["Gemini — docs sweep", "chore/docs-sweep", "Gemini", true],
  ["Test watcher", "fix/review-queue", "Terminal", false],
  ["Storybook", "develop", "Browser", false],
  ["Claude — migration", "feat/db-migration-0042", "Claude", false],
  ["Shell", "feat/db-migration-0042", "Terminal", false],
  ["Release notes", "release/0.9", "Terminal", false],
  ["opencode — triage", "chore/issue-triage", "opencode", false],
  ["Logs tail", "develop", "Terminal", false],
].map(([name, worktree, kindLabel, agentRunning], i) => ({
  id: `panel-7f3c${String(i).padStart(2, "0")}a91e${i}`,
  name: name as string,
  worktree: worktree as string,
  kindLabel: kindLabel as string,
  agentRunning: agentRunning as boolean,
}));

const EXTERNAL_CALLER = { token4LastChars: "8f3a", userAgent: "Claude Code 2.4.1 (darwin)" };

/** Mirrors CONFIRM_COOLDOWN_MS in src/components/McpConfirmDialog.tsx. */
const CONFIRM_COOLDOWN_MS = 1_200;

function deleteWorktree(over: Partial<ShotPayload> = {}): ShotPayload {
  return {
    requestId: `shot-${Math.abs(hash(JSON.stringify(over)))}`,
    actionId: "worktree.delete",
    actionTitle: "Delete worktree",
    actionDescription: "Permanently delete a git worktree and its directory.",
    argsSummary: ARGS_SHORT,
    danger: "confirm",
    dangerRationale: RATIONALE_DELETE,
    ...over,
  };
}

/** Stable id per payload so a re-run of one step reuses its cooldown key. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return h;
}

// ---------------------------------------------------------------------------

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Screenshot a state. `snap` is the only thing that writes a PNG, and it waits
 * for the dialog to actually be on screen first — a shot taken of an empty
 * workbench because a state failed to park is a plausible-looking artifact that
 * would poison the review.
 */
async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    const target = page.locator(locator).last();
    await target.waitFor({ state: "visible", timeout: 5000 });
    await target.screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/** Clear the queue, then park exactly these items (FIFO — index 0 becomes visible). */
async function park(page: Page, items: ShotPayload[]): Promise<void> {
  await page.evaluate((payloads) => {
    window.__DAINTREE_E2E_RESET_MCP_CONFIRM__?.();
    for (const payload of payloads) {
      window.__DAINTREE_E2E_ENQUEUE_MCP_CONFIRM__?.(payload);
    }
  }, items);
  await page.locator(DIALOG).last().waitFor({ state: "visible", timeout: 8000 });
  // Past the destructive read-time gate, so a state captured through park() shows
  // the primary button ENABLED. Without this every shot silently captures the
  // 1.2s cooldown and the review scores a disabled button as the resting state.
  await page.waitForTimeout(CONFIRM_COOLDOWN_MS + 300);
}

async function clearQueue(page: Page): Promise<void> {
  await page.evaluate(() => window.__DAINTREE_E2E_RESET_MCP_CONFIRM__?.());
  await page
    .locator(DIALOG)
    .last()
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
}

/**
 * Every built-in theme. Switching themes in place crashes the project view
 * under this harness (same constraint as confirm-dialog-review), so the sweep
 * boots once per theme:
 *
 *   for t in <these ids>; do
 *     DAINTREE_SHOT_MCP=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     npx playwright test --project=screenshots mcp-confirm-review
 *   done
 */
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

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — the other shots are still worth
// having. But the run must still FAIL, or a silent exit 0 with a half-empty
// output directory reads as success.
const failures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[mcp-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    // Unconditionally: a step that dies holding an open modal would wedge every
    // step after it.
    await clearQueue(page).catch((error) => {
      failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
    });
  }
}

test("MCP approval dialog review — trust hierarchy across caller, danger, and preview states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MCP is required for the approval-dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_MCP to run the approval-dialog capture");

  // Module-scoped so `step()` can reach it; cleared here so a Playwright retry
  // starts from a clean slate rather than inheriting the previous attempt's.
  failures.length = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-mcpshot-"));
  let ctx: AppContext | undefined;
  let expectedShots = 0;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    // The backdoor is the whole harness. If it never attached, every later step
    // would "succeed" against an empty workbench, so fail loudly here instead.
    const hasBackdoor = await page.evaluate(
      () => typeof window.__DAINTREE_E2E_ENQUEUE_MCP_CONFIRM__ === "function"
    );
    expect(hasBackdoor, "MCP confirm E2E backdoor is not installed (DAINTREE_E2E_MODE?)").toBe(
      true
    );

    // ---- Assistant-owned dispatch: no provenance block ----------------------
    await step(page, "assistant", async () => {
      await park(page, [
        {
          requestId: "shot-assist-safe",
          actionId: "worktree.list",
          actionTitle: "List worktrees",
          actionDescription: "List every git worktree in the current project.",
          argsSummary: "(none)",
          danger: "safe",
          // Without an origin these render the "Unidentified client" fallback,
          // so the shot named "assistant" would prove the wrong branch.
          sessionOrigin: "help",
        },
      ]);
      await snap(page, "10-assistant-safe-no-preview", DIALOG);
      expectedShots++;

      await park(page, [
        deleteWorktree({
          requestId: "shot-assist-destructive",
          sessionOrigin: "help",
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "11-assistant-destructive-with-preview", DIALOG);
      await snap(page, "12-assistant-destructive-in-window");
      expectedShots += 2;

      // Neither an external client nor the assistant: a session whose token
      // hash was never registered. It must not borrow the assistant's standing.
      await park(page, [
        deleteWorktree({
          requestId: "shot-unidentified",
          sessionOrigin: "external",
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "13-unidentified-caller", DIALOG);
      expectedShots++;
    });

    // ---- External client: the "Requested by" identity ----------------------
    await step(page, "external", async () => {
      await park(page, [
        deleteWorktree({
          requestId: "shot-ext-destructive",
          callerInfo: EXTERNAL_CALLER,
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "20-external-destructive", DIALOG);
      expectedShots++;

      // Same action, non-destructive tier — the consequence hierarchy must
      // differ from 20 by more than the button colour.
      await park(page, [
        {
          requestId: "shot-ext-safe",
          actionId: "git.status",
          actionTitle: "Show git status",
          actionDescription: "Report the working-tree status for a worktree.",
          argsSummary: ARGS_SHORT,
          danger: "safe",
          callerInfo: EXTERNAL_CALLER,
        },
      ]);
      await snap(page, "21-external-safe", DIALOG);
      expectedShots++;

      // A different preview shape: git.push previews commits, not files.
      await park(page, [
        deleteWorktree({
          requestId: "shot-ext-push",
          actionId: "git.push",
          actionTitle: "Push branch",
          actionDescription: "Push the current branch to its remote.",
          dangerRationale:
            "Publishes local commits to the shared remote, where other people and CI will act on them. Pushed history cannot be quietly withdrawn.",
          callerInfo: EXTERNAL_CALLER,
          preview: PREVIEW_PUSH,
          previewTitle: "Branch and local commits",
        }),
      ]);
      await snap(page, "22-external-push-commit-preview", DIALOG);
      expectedShots++;
    });

    // ---- Preview lifecycle -------------------------------------------------
    await step(page, "preview", async () => {
      await park(page, [
        deleteWorktree({
          requestId: "shot-preview-pending",
          callerInfo: EXTERNAL_CALLER,
          previewPending: true,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "30-preview-pending", DIALOG);
      expectedShots++;

      // The same item after the fetch lands — the transition a real approver
      // watches happen in place.
      await page.evaluate(() =>
        window.__DAINTREE_E2E_SET_MCP_PREVIEW__?.("shot-preview-pending", [
          "3 files with uncommitted changes:",
          "  M  src/components/Terminal/HybridInputBar.tsx",
          "  M  src/store/panelStore.ts",
          "  ?? src/components/Terminal/InputHistory.tsx",
        ])
      );
      await snap(page, "31-preview-landed", DIALOG);
      expectedShots++;

      // Empty preview: the fetch succeeded and found nothing, or failed soft.
      // Today this drops the whole block.
      await park(page, [
        deleteWorktree({
          requestId: "shot-preview-empty",
          callerInfo: EXTERNAL_CALLER,
          preview: [],
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "32-preview-empty", DIALOG);
      expectedShots++;

      // No preview target at all (most actions), and no arguments either.
      await park(page, [
        {
          requestId: "shot-no-args",
          actionId: "app.reloadWindow",
          actionTitle: "Reload window",
          actionDescription: "Reload the Daintree window.",
          argsSummary: "",
          danger: "confirm",
          dangerRationale: "Discards unsaved renderer state in every open panel.",
          callerInfo: EXTERNAL_CALLER,
        },
      ]);
      await snap(page, "33-no-preview-no-args", DIALOG);
      expectedShots++;
    });

    // ---- Hostile lengths ---------------------------------------------------
    await step(page, "overflow", async () => {
      await park(page, [
        deleteWorktree({
          requestId: "shot-overflow",
          callerInfo: { token4LastChars: "c19d", userAgent: LONG_USER_AGENT },
          argsSummary: ARGS_LONG,
          preview: PREVIEW_HUGE,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "40-overflow-dialog", DIALOG);
      // The in-window shot is the one that proves the action row is reachable.
      await snap(page, "41-overflow-in-window");
      expectedShots += 2;
    });

    // ---- Queue depth -------------------------------------------------------
    await step(page, "queued", async () => {
      await park(page, [
        deleteWorktree({
          requestId: "shot-queue-1",
          callerInfo: EXTERNAL_CALLER,
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
        deleteWorktree({
          requestId: "shot-queue-2",
          actionTitle: "Push branch",
          callerInfo: { token4LastChars: "2b71", userAgent: "codex-cli/0.42.0" },
        }),
        {
          requestId: "shot-queue-3",
          actionId: "terminal.kill",
          actionTitle: "Kill terminal",
          actionDescription: "Terminate a running terminal process.",
          argsSummary: '{\n  "terminalId": "pty-7"\n}',
          danger: "confirm",
          callerInfo: EXTERNAL_CALLER,
        },
      ]);
      await snap(page, "50-three-queued-head-visible", DIALOG);
      expectedShots++;

      // The control: the SAME head payload with nothing queued behind it. If 50
      // and 51 come back byte-identical, the surface tells the approver nothing
      // about how many more requests are stacked behind the one they are reading.
      await park(page, [
        deleteWorktree({
          requestId: "shot-queue-1",
          callerInfo: EXTERNAL_CALLER,
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "51-single-not-queued-control", DIALOG);
      expectedShots++;
    });

    // ---- Cooldown: disabled for a reason ------------------------------------
    await step(page, "cooldown", async () => {
      // No settle before the shot — the destructive read-time gate is only
      // 1200ms, so this has to be captured immediately after parking.
      await page.evaluate(() => {
        window.__DAINTREE_E2E_RESET_MCP_CONFIRM__?.();
        window.__DAINTREE_E2E_ENQUEUE_MCP_CONFIRM__?.({
          requestId: "shot-cooldown",
          actionId: "worktree.delete",
          actionTitle: "Delete worktree",
          actionDescription: "Permanently delete a git worktree and its directory.",
          argsSummary: '{\n  "worktreeId": "wt-agent-fanout"\n}',
          danger: "confirm",
          dangerRationale:
            "Permanently removes the worktree directory and every uncommitted change inside it. The branch is left in place; the working copy is not recoverable.",
          callerInfo: { token4LastChars: "8f3a", userAgent: "Claude Code 2.4.1 (darwin)" },
          preview: [
            "3 files with uncommitted changes:",
            "  M  src/components/Terminal/HybridInputBar.tsx",
            "  M  src/store/panelStore.ts",
            "  ?? src/components/Terminal/InputHistory.tsx",
          ],
          previewTitle: "Working tree changes",
        });
      });
      await page.locator(DIALOG).last().waitFor({ state: "visible", timeout: 8000 });
      const file = path.join(OUTPUT_DIR, `60-cooldown-active${TAG}.png`);
      await page.locator(DIALOG).last().screenshot({ path: file, type: "png" });
      expectedShots++;

      // And the same dialog once the gate clears, so the two are comparable.
      await page.waitForTimeout(1600);
      await snap(page, "61-cooldown-cleared", DIALOG);
      expectedShots++;
    });

    // ---- Keyboard focus ----------------------------------------------------
    await step(page, "focus", async () => {
      await park(page, [
        deleteWorktree({
          requestId: "shot-focus",
          callerInfo: EXTERNAL_CALLER,
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await page.keyboard.press("Tab");
      await snap(page, "70-keyboard-focus-first", DIALOG);
      await page.keyboard.press("Tab");
      await snap(page, "71-keyboard-focus-second", DIALOG);
      expectedShots += 2;
    });

    // ---- Design review: reading sequence across request shapes -------------
    // The shapes added since the August harness: an agent pane offered a session
    // grant, the assistant's standing confirmation preference, the per-target
    // checklist and the typed-name gate — alone and all at once.
    await step(page, "design", async () => {
      // Minimal: safe, identified caller, nothing to preview, no arguments.
      await park(page, [
        {
          requestId: "shot-d-minimal",
          actionId: "worktree.list",
          actionTitle: "List worktrees",
          actionDescription: "List every git worktree in the current project.",
          argsSummary: "",
          danger: "safe",
          callerInfo: EXTERNAL_CALLER,
        },
      ]);
      await snap(page, "90-minimal", DIALOG);
      expectedShots++;

      // Everything an agent pane can carry at once: above-tier, destructive,
      // consequence, preview, arguments and the session grant.
      await park(page, [
        deleteWorktree({
          requestId: "shot-d-everything-pane",
          ...AGENT_PANE,
          approvalReason: "above-tier",
          subject: "feature/agent-fanout",
          argsSummary: ARGS_LONG,
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "91-everything-agent-pane", DIALOG);
      await snap(page, "91b-everything-agent-pane-in-window");
      expectedShots += 2;

      // The same, with the session grant ticked: the footer has to say what the
      // click will now do.
      await page.locator(`${DIALOG} [role="checkbox"]`).last().click();
      await snap(page, "92-everything-session-checked", DIALOG);
      expectedShots++;

      // The assistant's own request carrying everything: protected close with a
      // target checklist, plus the standing confirmation preference.
      await park(page, [
        {
          requestId: "shot-d-everything-assistant",
          actionId: "terminal.close",
          actionTitle: "Close panels",
          actionDescription: "Close panels in the current project.",
          argsSummary:
            '{\n  "terminalIds": ["panel-7f3c00a91e0", "panel-7f3c01a91e1", "panel-7f3c02a91e2"]\n}',
          danger: "confirm",
          sessionOrigin: "help",
          approvalReason: "protected-close",
          dangerRationale:
            "Closing a panel ends its process. An agent that is mid-task loses the turn it was working on.",
          selectableTargets: PANEL_TARGETS.slice(0, 3),
          selectionConfirmLabel: { verb: "Close", one: "panel", many: "panels" },
        },
      ]);
      await snap(page, "93-everything-assistant-preference", DIALOG);
      await snap(page, "93b-everything-assistant-in-window");
      expectedShots += 2;

      // Assistant, safe-but-confirmed action, preference visible on its own.
      await park(page, [
        deleteWorktree({
          requestId: "shot-d-assistant-pref",
          sessionOrigin: "help",
          subject: "feature/agent-fanout",
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "94-assistant-destructive-preference", DIALOG);
      expectedShots++;

      // The standing preference opened: a deliberate second step.
      await page
        .locator(`${DIALOG} button[aria-expanded]`)
        .filter({ hasText: /Daintree confirmations/ })
        .first()
        .click();
      await snap(page, "94b-assistant-preference-expanded", DIALOG);
      expectedShots++;

      // Agent pane, harmless action that is merely above its tier.
      await park(page, [
        {
          requestId: "shot-d-pane-above-tier",
          actionId: "worktree.create",
          actionTitle: "Create worktree",
          actionDescription: "Create a git worktree on a new branch.",
          argsSummary: '{\n  "branch": "feature/agent-fanout-2"\n}',
          danger: "safe",
          ...AGENT_PANE,
          approvalReason: "above-tier",
        },
      ]);
      await snap(page, "95-agent-pane-above-tier-safe", DIALOG);
      expectedShots++;

      // The barest session offer: nothing focusable before the grant itself, so
      // this is where initial focus would land on it if Cancel did not claim it.
      await park(page, [
        {
          requestId: "shot-d-pane-bare",
          actionId: "worktree.list",
          actionTitle: "List worktrees",
          actionDescription: "List every git worktree in the current project.",
          argsSummary: "",
          danger: "safe",
          ...AGENT_PANE,
          approvalReason: "above-tier",
        },
      ]);
      await snap(page, "95b-agent-pane-bare-session-offer", DIALOG);
      expectedShots++;

      // Agent pane without a session offer (a target-picking tool).
      await park(page, [
        deleteWorktree({
          requestId: "shot-d-pane-no-session",
          sessionOrigin: "external",
          callerInfo: { token4LastChars: "", userAgent: "claude-code/2.4.1" },
          approvalReason: "above-tier",
          subject: "feature/agent-fanout",
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "96-destructive-no-session-offer", DIALOG);
      expectedShots++;

      // Long target list.
      await park(page, [
        {
          requestId: "shot-d-long-targets",
          actionId: "terminal.killBatch",
          actionTitle: "Kill terminals",
          actionDescription: "Terminate running terminal processes.",
          argsSummary: ARGS_SHORT,
          danger: "confirm",
          callerInfo: EXTERNAL_CALLER,
          dangerRationale:
            "Ends every selected process immediately. Unsaved shell state and any agent turn in progress are lost.",
          selectableTargets: PANEL_TARGETS,
          selectionConfirmLabel: { verb: "Kill", one: "terminal", many: "terminals" },
        },
      ]);
      await snap(page, "97-long-target-list", DIALOG);
      expectedShots++;

      // Identical titles in one long-named worktree: only the id separates them.
      const LONG_WT = "feature/agent-fanout-with-a-very-long-descriptive-branch-name";
      await park(page, [
        {
          requestId: "shot-d-twin-targets",
          actionId: "terminal.killBatch",
          actionTitle: "Kill terminals",
          actionDescription: "Terminate running terminal processes.",
          argsSummary: ARGS_SHORT,
          danger: "confirm",
          callerInfo: EXTERNAL_CALLER,
          selectableTargets: [0, 1, 2].map((i) => ({
            id: `panel-twin-${i}c8e1f`,
            name: "Shell",
            worktree: LONG_WT,
            kindLabel: "Terminal",
            agentRunning: false,
          })),
          selectionConfirmLabel: { verb: "Kill", one: "terminal", many: "terminals" },
        },
      ]);
      await snap(page, "97b-twin-targets-long-worktree", DIALOG);
      expectedShots++;

      // Session ticked while the preview is still pending, behind a queue: the
      // longest label beside the longest hint.
      await park(page, [
        deleteWorktree({
          requestId: "shot-d-session-pending",
          ...AGENT_PANE,
          approvalReason: "above-tier",
          previewPending: true,
          previewTitle: "Working tree changes",
        }),
        deleteWorktree({ requestId: "shot-d-session-pending-2", ...AGENT_PANE }),
      ]);
      await page.locator(`${DIALOG} [role="checkbox"]`).last().click();
      await snap(page, "92b-session-checked-preview-pending", DIALOG);
      expectedShots++;

      // Long argument payload, disclosed.
      await park(page, [
        deleteWorktree({
          requestId: "shot-d-long-args",
          callerInfo: EXTERNAL_CALLER,
          subject: "feature/agent-fanout",
          argsSummary: ARGS_LONG,
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await page
        .locator(`${DIALOG} button[aria-expanded]`)
        .filter({ hasText: /argument/i })
        .first()
        .click();
      await snap(page, "98-long-args-expanded", DIALOG);
      expectedShots++;

      // Typed-name gate (D3 force delete) on top of a large preview.
      await park(page, [
        deleteWorktree({
          requestId: "shot-d-typed",
          callerInfo: EXTERNAL_CALLER,
          subject: "feature/agent-fanout",
          typedNameTarget: "feature/agent-fanout",
          preview: PREVIEW_HUGE,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "99-typed-name-large-preview", DIALOG);
      expectedShots++;
    });

    // ---- Accessibility media modes -----------------------------------------
    await step(page, "contrast", async () => {
      await page.emulateMedia({ contrast: "more" }).catch(() => {});
      await park(page, [
        deleteWorktree({
          requestId: "shot-contrast",
          callerInfo: EXTERNAL_CALLER,
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "80-prefers-contrast-more", DIALOG);
      expectedShots++;
      await page.emulateMedia({ contrast: "no-preference" }).catch(() => {});
    });

    await step(page, "forced", async () => {
      await page.emulateMedia({ forcedColors: "active" }).catch(() => {});
      await park(page, [
        deleteWorktree({
          requestId: "shot-forced",
          callerInfo: EXTERNAL_CALLER,
          preview: PREVIEW_DIRTY,
          previewTitle: "Working tree changes",
        }),
      ]);
      await snap(page, "81-forced-colors-active", DIALOG);
      expectedShots++;
      await page.emulateMedia({ forcedColors: "none" }).catch(() => {});
    });
  } finally {
    // Each cleanup runs even if an earlier one throws.
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

  if (failures.length > 0) {
    throw new Error(`[mcp-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }

  // Count the files rather than trusting the exit code: a harness that reports
  // success while writing nothing is worse than one that fails.
  const written = readdirSync(OUTPUT_DIR).filter(
    (f) => f.endsWith(`${TAG}.png`) || (TAG === "" && f.endsWith(".png"))
  );
  expect(
    written.length,
    `[mcp-shots] expected ${expectedShots} PNGs in ${OUTPUT_DIR}, found ${written.length}`
  ).toBeGreaterThanOrEqual(expectedShots);
});
