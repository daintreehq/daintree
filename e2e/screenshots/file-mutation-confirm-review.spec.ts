/**
 * Discard-changes / Delete-file confirm visual-review harness (#15122).
 *
 * The confirm is one dialog with many truths: what Discard does depends on the
 * file's state (a modification is lost for good, an addition goes to the Trash,
 * a deletion comes back), and what Delete costs depends on whether git has a
 * copy. Every state is reached the way a user reaches it: a real fixture repo
 * whose files sit in each state, a right-click on the real row, the real menu
 * item. Nothing about the dialog is stubbed.
 *
 *   - Review Hub rows for each git state, plus Delete on a tracked and an
 *     untracked file and a deeply nested path.
 *   - The diff opened from the Review Hub (the confirm stacked over two dialogs).
 *   - The file browser, on a tracked file with no changes.
 *   - The failure toast for each action, from a real failure: the file changes
 *     underneath the open confirm, so the operation refuses when confirmed.
 *   - One state across several themes, for the theme sheet.
 *
 * Every successful confirm is left with Cancel; only the two failure steps
 * press the primary, and only after making the operation impossible.
 *
 *   DAINTREE_SHOT_FILEMUTATION=1 DAINTREE_SHOT_OUT=/abs/dir \
 *     npx playwright test --project=screenshots file-mutation-confirm-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FILEMUTATION  required — any truthy value runs the capture
 *   DAINTREE_SHOT_OUT           required — absolute output dir, outside the repo
 *   DAINTREE_SHOT_THEMES        comma-separated theme ids for the sweep
 *   DAINTREE_SHOT_ONLY          comma-separated step filter (step names below)
 */

import { test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_FILEMUTATION;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_OUT ?? "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SWEEP_THEMES = (
  process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,svalbard,namib,redwoods,hokkaido"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
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
  [class*="animate-pulse-"] { opacity: 1 !important; }
`;

const FILE_LIST = '[role="listbox"][aria-label="Changed files"]';
const CONFIRM_BUTTON = '[data-confirm-role="confirm"]';
const CANCEL_BUTTON = '[data-confirm-role="cancel"]';

const P = {
  modified: "src/renderer/store/worktreeTopologyStore.ts",
  partial: "src/renderer/orchestration/useOrchestrationScheduler.ts",
  added: "src/main/services/workspace/reconciliationTelemetry.ts",
  renameFrom: "src/renderer/hooks/useDeferredWorkspaceSnapshot.ts",
  renamed: "src/renderer/hooks/useDeferredSnapshot.ts",
  deleted: "docs/architecture/legacy-notification-routing.md",
  untracked: "notes/agent-scratch-2026-10-29.md",
  untrackedDoomed: "notes/handoff-draft.md",
  deep: "packages/plugin-sdk/src/runtime/host-bridge/capabilities/consent/__fixtures__/workspaceTrustCapabilityNegotiationFixture.generated.ts",
  clean: "src/renderer/components/CommandPalette/commandPaletteScoring.ts",
  doomed: "src/renderer/lib/formatDuration.ts",
  replaced: "src/renderer/lib/featureFlags.ts",
} as const;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

const TOPOLOGY_V1 = `import { create } from "zustand";
import type { WorktreeSnapshot } from "@shared/types";

export interface TopologyState {
  byId: Map<string, WorktreeSnapshot>;
  order: string[];
  selectedId: string | null;
  hydrate: (snapshots: WorktreeSnapshot[]) => void;
  select: (id: string | null) => void;
}

function sortByPath(a: WorktreeSnapshot, b: WorktreeSnapshot): number {
  return a.path.localeCompare(b.path);
}

export const useWorktreeTopologyStore = create<TopologyState>()((set) => ({
  byId: new Map(),
  order: [],
  selectedId: null,

  hydrate: (snapshots) => {
    const sorted = [...snapshots].sort(sortByPath);
    set({
      byId: new Map(sorted.map((s) => [s.id, s])),
      order: sorted.map((s) => s.id),
    });
  },

  select: (id) => set({ selectedId: id }),
}));

export function selectWorktree(id: string): WorktreeSnapshot | undefined {
  return useWorktreeTopologyStore.getState().byId.get(id);
}

export function selectOrder(): string[] {
  return useWorktreeTopologyStore.getState().order;
}
`;

const TOPOLOGY_V2 = `import { create } from "zustand";
import type { WorktreeSnapshot } from "@shared/types";
import { compareWorktreesForSidebar } from "./worktreeOrdering";

export interface TopologyState {
  byId: Map<string, WorktreeSnapshot>;
  order: string[];
  selectedId: string | null;
  /** Ids whose snapshot arrived after the last full hydrate. */
  pendingIds: Set<string>;
  hydrate: (snapshots: WorktreeSnapshot[]) => void;
  upsert: (snapshot: WorktreeSnapshot) => void;
  select: (id: string | null) => void;
}

export const useWorktreeTopologyStore = create<TopologyState>()((set, get) => ({
  byId: new Map(),
  order: [],
  selectedId: null,
  pendingIds: new Set(),

  hydrate: (snapshots) => {
    const sorted = [...snapshots].sort(compareWorktreesForSidebar);
    set({
      byId: new Map(sorted.map((s) => [s.id, s])),
      order: sorted.map((s) => s.id),
      pendingIds: new Set(),
    });
  },

  upsert: (snapshot) => {
    const byId = new Map(get().byId);
    const isNew = !byId.has(snapshot.id);
    byId.set(snapshot.id, snapshot);
    const order = isNew ? [...get().order, snapshot.id] : get().order;
    set({ byId, order, pendingIds: new Set(get().pendingIds).add(snapshot.id) });
  },

  select: (id) => set({ selectedId: id }),
}));

export function selectWorktree(id: string): WorktreeSnapshot | undefined {
  return useWorktreeTopologyStore.getState().byId.get(id);
}
`;

const SCHEDULER_V1 = `import { useEffect, useRef } from "react";
import { scheduleTick, cancelTick } from "./tickScheduler";

const TICK_MS = 1000;

export function useOrchestrationScheduler(enabled: boolean, run: () => void): void {
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) return;
    const handle = scheduleTick(() => runRef.current(), TICK_MS);
    return () => cancelTick(handle);
  }, [enabled]);
}
`;

const SCHEDULER_STAGED = `import { useEffect, useRef } from "react";
import { scheduleTick, cancelTick } from "./tickScheduler";

const TICK_MS = 1000;
const IDLE_TICK_MS = 5000;

export function useOrchestrationScheduler(
  enabled: boolean,
  idle: boolean,
  run: () => void
): void {
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) return;
    const handle = scheduleTick(() => runRef.current(), idle ? IDLE_TICK_MS : TICK_MS);
    return () => cancelTick(handle);
  }, [enabled, idle]);
}
`;

const SCHEDULER_WORKTREE = `import { useEffect, useRef } from "react";
import { scheduleTick, cancelTick } from "./tickScheduler";
import { usePerformanceMode } from "@/hooks/usePerformanceMode";

const TICK_MS = 1000;
const IDLE_TICK_MS = 5000;
const PERFORMANCE_TICK_MS = 2500;

export function useOrchestrationScheduler(
  enabled: boolean,
  idle: boolean,
  run: () => void
): void {
  const runRef = useRef(run);
  runRef.current = run;
  const performanceMode = usePerformanceMode();

  useEffect(() => {
    if (!enabled) return;
    const base = idle ? IDLE_TICK_MS : TICK_MS;
    const interval = performanceMode ? Math.max(base, PERFORMANCE_TICK_MS) : base;
    const handle = scheduleTick(() => runRef.current(), interval);
    return () => cancelTick(handle);
  }, [enabled, idle, performanceMode]);
}
`;

const TELEMETRY = `import { logger } from "../../logger";

export interface ReconciliationSample {
  worktreeId: string;
  durationMs: number;
  changedFiles: number;
}

const samples: ReconciliationSample[] = [];
const MAX_SAMPLES = 200;

export function recordReconciliation(sample: ReconciliationSample): void {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();
  if (sample.durationMs > 2000) {
    logger.warn("slow reconciliation", sample);
  }
}

export function reconciliationP95(): number {
  if (samples.length === 0) return 0;
  const sorted = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
}
`;

const SNAPSHOT_V1 = `import { useDeferredValue } from "react";
import type { WorkspaceSnapshot } from "@shared/types";

export function useDeferredWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return useDeferredValue(snapshot);
}
`;

const SNAPSHOT_V2 = `import { useDeferredValue } from "react";
import type { WorkspaceSnapshot } from "@shared/types";

export function useDeferredSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return useDeferredValue(snapshot);
}
`;

const DEEP_V1 = Array.from(
  { length: 40 },
  (_, i) => `export const capability${i} = { id: "cap-${i}", consent: "prompt" } as const;`
).join("\n");

const DEEP_V2 = Array.from({ length: 40 }, (_, i) =>
  i % 9 === 3
    ? `export const capability${i} = { id: "cap-${i}", consent: "granted", scope: "workspace" } as const;`
    : `export const capability${i} = { id: "cap-${i}", consent: "prompt" } as const;`
).join("\n");

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "daintree-filemutation-shots-"));
  const dir = path.join(root, "helios-dashboard");
  const wtRoot = path.join(root, "helios-dashboard-worktrees");
  mkdirSync(dir, { recursive: true });
  mkdirSync(wtRoot, { recursive: true });
  const write = (rel: string, body: string): void => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body.endsWith("\n") ? body : `${body}\n`);
  };

  git(["init", "-b", "main", dir], root);
  git(["config", "user.email", "dev@daintree.dev"], dir);
  git(["config", "user.name", "Daintree Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);

  write("README.md", "# Helios Dashboard\n");
  write(P.modified, TOPOLOGY_V1);
  write(P.partial, SCHEDULER_V1);
  write(P.renameFrom, SNAPSHOT_V1);
  write(
    P.deleted,
    "# Legacy notification routing\n\nSuperseded by notification-system.md.\n\n" +
      Array.from({ length: 30 }, (_, i) => `- Rule ${i + 1}: route by severity.`).join("\n")
  );
  write(P.deep, DEEP_V1);
  write(
    P.clean,
    "export function scoreCommand(query: string, label: string): number {\n  return label.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;\n}\n"
  );
  write(
    P.doomed,
    "export function formatDuration(ms: number): string {\n  return `${Math.round(ms / 1000)}s`;\n}\n"
  );
  write(P.replaced, "export const FLAGS = { canopy: false, hosts: false } as const;\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial commit"], dir);
  git(["checkout", "-b", "feature/orchestration-preferences"], dir);

  // Staged: an addition, a rename, and the first half of a partial change.
  write(P.added, TELEMETRY);
  write(P.partial, SCHEDULER_STAGED);
  git(["mv", P.renameFrom, P.renamed], dir);
  write(P.renamed, SNAPSHOT_V2);
  git(["add", "--", P.added, P.partial, P.renamed], dir);

  // Unstaged: the rest.
  write(P.partial, SCHEDULER_WORKTREE);
  write(P.modified, TOPOLOGY_V2);
  write(P.deep, DEEP_V2);
  write(
    P.doomed,
    "export function formatDuration(ms: number): string {\n  return `${(ms / 1000).toFixed(1)}s`;\n}\n"
  );
  rmSync(path.join(dir, P.deleted));
  write(
    P.untracked,
    "# Agent scratch\n\n- Tried batching upserts; regressed sidebar order.\n- Next: compare with compareWorktreesForSidebar.\n"
  );
  write(P.untrackedDoomed, "# Handoff\n\nDraft for the morning stand-up.\n");
  // A staged deletion with a new file written back at the same path: the
  // restore would write over a file git has never seen.
  git(["rm", "-q", "--", P.replaced], dir);
  write(
    P.replaced,
    "// Rewritten by an agent; not yet added.\nexport const FLAGS = {\n  canopy: true,\n  hosts: true,\n  fleet: true,\n} as const;\n"
  );

  return {
    dir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

interface DispatchResult {
  ok?: boolean;
  error?: { message?: string };
  result?: { worktrees?: Array<{ id: string; isMain?: boolean }>; panelId?: string };
}

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<DispatchResult> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => Promise<DispatchResult>;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

async function mainWorktreeId(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const listed = await dispatchAction(page, "worktree.list");
    const id = (listed.result?.worktrees ?? []).find((w) => w.isMain)?.id;
    if (id !== undefined) return id;
    await page.waitForTimeout(250);
  }
  throw new Error("main worktree never resolved");
}

const written: string[] = [];
const stepFailures: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.some((o) => name.startsWith(o))) return;
  try {
    await fn();
  } catch (error) {
    stepFailures.push(`${name}: ${String(error).slice(0, 400)}`);
    console.warn(`[filemutation-shots] step "${name}" failed:`, String(error).slice(0, 400));
  }
}

/** The confirm's card: the dialog surface that holds a Cancel/confirm footer, topmost. */
function confirmCard(page: Page): Locator {
  return page
    .locator("[data-app-dialog-surface] > div")
    .filter({ has: page.locator(CANCEL_BUTTON) })
    .last();
}

/**
 * Waits for the open confirm to name `expectName` and finish reading whatever it
 * reads, then proves it again after the settle. A capture of a dialog that is
 * still mid-load, or of the wrong file's dialog, is refused rather than written.
 */
async function awaitConfirm(page: Page, expectName: string): Promise<Locator> {
  const card = confirmCard(page);
  await card.waitFor({ state: "visible", timeout: T_MEDIUM });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const bones = await card.locator("[data-skeleton-bone]").count();
    const busy = await card.locator('[aria-busy="true"]').count();
    if (bones === 0 && busy === 0) break;
    await page.waitForTimeout(150);
  }
  await settle(page, 400);
  const text = (await card.textContent()) ?? "";
  if (!text.includes(expectName)) {
    throw new Error(`confirm does not name ${expectName}: ${text.slice(0, 200)}`);
  }
  if ((await card.locator("[data-skeleton-bone]").count()) > 0) {
    throw new Error(`confirm for ${expectName} still loading at capture time`);
  }
  return card;
}

async function capture(page: Page, file: string, clip?: Locator, margin = 28): Promise<void> {
  const out = path.join(OUTPUT_DIR, file);
  if (clip) {
    const box = await clip.boundingBox();
    if (!box || box.width < 50 || box.height < 50) throw new Error(`${file}: no box to clip`);
    const viewport = page.viewportSize() ?? { width: 1440, height: 960 };
    const x = Math.max(0, box.x - margin);
    const y = Math.max(0, box.y - margin);
    await page.screenshot({
      path: out,
      type: "png",
      clip: {
        x,
        y,
        width: Math.min(viewport.width - x, box.width + margin * 2),
        height: Math.min(viewport.height - y, box.height + margin * 2),
      },
    });
  } else {
    await page.screenshot({ path: out, type: "png" });
  }
  if (!existsSync(out) || statSync(out).size < 2000) throw new Error(`${file}: not written`);
  written.push(file);
}

async function cancelConfirm(page: Page): Promise<void> {
  const card = confirmCard(page);
  await card.locator(CANCEL_BUTTON).click();
  await card.waitFor({ state: "hidden", timeout: T_MEDIUM });
  await settle(page, 250);
}

async function openHub(page: Page): Promise<void> {
  await dismissBlockingPalette(page);
  const hub = page.locator(SEL.reviewHub.container);
  if (!(await hub.isVisible().catch(() => false))) {
    const btn = page.locator(SEL.worktree.reviewHubButton).first();
    await btn.waitFor({ state: "visible", timeout: T_LONG });
    await btn.click();
    await hub.waitFor({ state: "visible", timeout: T_MEDIUM });
  }
  const toggle = hub.locator(SEL.reviewHub.fileListToggle);
  await toggle.waitFor({ state: "visible", timeout: T_MEDIUM });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.locator(FILE_LIST).waitFor({ state: "visible", timeout: T_MEDIUM });
  await page.locator(`[data-testid="file-stage-row-${P.modified}"]`).first().waitFor({
    state: "visible",
    timeout: T_LONG,
  });
  await settle(page, 600);
}

function hubRow(page: Page, rel: string, section: "staged" | "unstaged"): Locator {
  return page
    .locator(`[data-testid="review-hub-file-section-${section}"]`)
    .locator(`[data-testid="file-stage-row-${rel}"]`)
    .first();
}

async function menuChoose(page: Page, row: Locator, item: string): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: "right", position: { x: 60, y: 10 } });
  const menuItem = page.getByRole("menuitem", { name: item, exact: true });
  await menuItem.waitFor({ state: "visible", timeout: T_MEDIUM });
  await menuItem.click();
}

/** Right-click a hub row, pick `item`, capture the confirm, then Cancel. */
async function hubConfirm(
  page: Page,
  file: string,
  rel: string,
  section: "staged" | "unstaged",
  item: string
): Promise<void> {
  await openHub(page);
  await menuChoose(page, hubRow(page, rel, section), item);
  const card = await awaitConfirm(page, path.posix.basename(rel));
  await capture(page, file, card);
  await cancelConfirm(page);
}

async function toastCapture(page: Page, file: string, title: string): Promise<void> {
  const region = page.locator(SEL.notifications.toastRegion);
  const toast = region.locator("[data-toast]").filter({ hasText: title }).first();
  await toast.waitFor({ state: "visible", timeout: T_LONG });
  await page.mouse.move(5, 5);
  await settle(page, 500);
  await capture(page, file, toast, 20);
}

test("file mutation confirm review — discard and delete", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FILEMUTATION is required for the file mutation confirm capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_FILEMUTATION to run the file mutation confirm capture");
  test.setTimeout(20 * 60_000);
  if (!OUTPUT_DIR || !path.isAbsolute(OUTPUT_DIR)) {
    throw new Error("DAINTREE_SHOT_OUT must be an absolute directory outside the repo");
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-filemutationshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 960 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);

    await step("01-discard-modified-unstaged", () =>
      hubConfirm(
        page,
        "01-discard-modified-unstaged.png",
        P.modified,
        "unstaged",
        "Discard changes"
      )
    );
    await step("02-discard-modified-staged-and-unstaged", () =>
      hubConfirm(
        page,
        "02-discard-modified-staged-and-unstaged.png",
        P.partial,
        "unstaged",
        "Discard changes"
      )
    );
    await step("03-discard-added", () =>
      hubConfirm(page, "03-discard-added.png", P.added, "staged", "Discard changes")
    );
    await step("04-discard-renamed", () =>
      hubConfirm(page, "04-discard-renamed.png", P.renamed, "staged", "Discard changes")
    );
    await step("05-discard-deleted", () =>
      hubConfirm(page, "05-discard-deleted.png", P.deleted, "unstaged", "Discard changes")
    );
    await step("06-delete-untracked", () =>
      hubConfirm(page, "06-delete-untracked.png", P.untracked, "unstaged", "Trash file")
    );
    await step("07-delete-tracked-modified", () =>
      hubConfirm(page, "07-delete-tracked-modified.png", P.modified, "unstaged", "Trash file")
    );
    await step("08-discard-long-path", () =>
      hubConfirm(page, "08-discard-long-path.png", P.deep, "unstaged", "Discard changes")
    );

    await step("13-discard-overwrite", () =>
      hubConfirm(page, "13-discard-overwrite.png", P.replaced, "staged", "Discard changes")
    );
    await step("14-trash-staged-new", () =>
      hubConfirm(page, "14-trash-staged-new.png", P.added, "staged", "Trash file")
    );

    await step("09-nested-diff-discard", async () => {
      await openHub(page);
      await hubRow(page, P.modified, "unstaged").click({ position: { x: 60, y: 10 } });
      const diff = page.locator(SEL.reviewHub.diffDialog);
      await diff.waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 800);
      const sidebarRow = diff
        .locator(`[data-roving-row]:has([aria-label="Open ${P.partial}"])`)
        .first();
      await menuChoose(page, sidebarRow, "Discard changes");
      await awaitConfirm(page, path.posix.basename(P.partial));
      await capture(page, "09-nested-diff-discard.png");
      await cancelConfirm(page);
      await page.locator(SEL.reviewHub.diffDialogClose).first().click();
      await diff.waitFor({ state: "hidden", timeout: T_MEDIUM });
      await settle(page, 300);
    });

    await step("10-file-browser-delete-tracked", async () => {
      const hub = page.locator(SEL.reviewHub.container);
      if (await hub.isVisible().catch(() => false)) {
        await page.locator(SEL.reviewHub.close).first().click();
        await hub.waitFor({ state: "hidden", timeout: T_MEDIUM });
      }
      const worktreeId = await mainWorktreeId(page);
      const opened = await dispatchAction(page, "worktree.openFileBrowserPanel", {
        worktreeId,
        revealPath: P.clean,
        revealKind: "file",
      });
      const panelId = opened.result?.panelId;
      if (!panelId) throw new Error(`openFileBrowserPanel: ${opened.error?.message ?? "no id"}`);
      const panel = page.locator(`[data-panel-id="${panelId}"]`);
      await panel.waitFor({ state: "visible", timeout: T_MEDIUM });
      await settle(page, 1200);
      const row = panel.locator(`[role="treeitem"][id$="-${encodeURIComponent(P.clean)}"]`).first();
      await row.waitFor({ state: "visible", timeout: T_MEDIUM });
      await menuChoose(page, row, "Trash file");
      const card = await awaitConfirm(page, path.posix.basename(P.clean));
      await capture(page, "10-file-browser-delete-tracked.png");
      await capture(page, "10b-file-browser-delete-tracked-card.png", card);
      await cancelConfirm(page);
    });

    // Real failures, made underneath the open confirm. The discard's file is
    // reverted, so the reviewed changes no longer exist; the trash's folder is
    // made read-only, so the Trash refuses it.
    await step("11-toast-discard-failed", async () => {
      await openHub(page);
      await menuChoose(page, hubRow(page, P.doomed, "unstaged"), "Discard changes");
      const card = await awaitConfirm(page, path.posix.basename(P.doomed));
      git(["checkout", "--", P.doomed], repo.dir);
      await card.locator(CONFIRM_BUTTON).click();
      await card.waitFor({ state: "hidden", timeout: T_MEDIUM });
      await toastCapture(page, "11-toast-discard-failed.png", "discard");
    });

    await step("12-toast-delete-failed", async () => {
      await openHub(page);
      await menuChoose(page, hubRow(page, P.untrackedDoomed, "unstaged"), "Trash file");
      const card = await awaitConfirm(page, path.posix.basename(P.untrackedDoomed));
      const folder = path.join(repo.dir, path.posix.dirname(P.untrackedDoomed));
      chmodSync(folder, 0o555);
      try {
        await card.locator(CONFIRM_BUTTON).click();
        await card.waitFor({ state: "hidden", timeout: T_MEDIUM });
        await toastCapture(page, "12-toast-delete-failed.png", "trash");
      } finally {
        chmodSync(folder, 0o755);
      }
    });

    for (const theme of SWEEP_THEMES) {
      await step(`20-theme-${theme}`, async () => {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await settle(page, 800);
        await hubConfirm(
          page,
          `20-theme-${theme}-discard-partial.png`,
          P.partial,
          "unstaged",
          "Discard changes"
        );
        await hubConfirm(
          page,
          `21-theme-${theme}-delete-untracked.png`,
          P.untracked,
          "unstaged",
          "Trash file"
        );
      });
    }
  } finally {
    if (ctx) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`[filemutation-shots] wrote ${written.length} files to ${OUTPUT_DIR}`);
  if (stepFailures.length > 0) {
    throw new Error(`steps failed:\n${stepFailures.join("\n")}`);
  }
});
