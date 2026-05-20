import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  PanelSummary,
  PendingCrash,
  QuarantinedPanelSummary,
} from "../../shared/types/ipc/crashRecovery.js";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";

const LEDGER_FILENAME = "panel-suspect-ledger.json";

// Number of consecutive crashed boots a panel must be flagged `isSuspect` on
// before the next safe-mode hydration quarantines it. 2 stops a deterministic
// crash loop one boot earlier than the global safe-mode trigger and aligns
// with Firefox's `max_resumed_crashes` default (quarantine after first
// re-crash on a recovered tab). A false positive at threshold=2 is recoverable
// via the "Restore panel" affordance; a missing true-positive at threshold=3
// means a third user-visible crash.
export const PANEL_QUARANTINE_THRESHOLD = 2;

// Clean launches required before a quarantine record decays. Each call to
// `markCleanLaunch()` (one per graceful shutdown) increments every record's
// `cleanLaunchesSince`; reaching this count removes the record.
export const PANEL_DECAY_CLEAN_LAUNCHES = 3;

// Wall-clock fallback decay so a panel never stays quarantined indefinitely
// for users who rarely shut the app down. Evaluated lazily at boot alongside
// the clean-launch decay.
export const PANEL_DECAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Grace window before a leftover `.tmp` from `resilientAtomicWriteFileSync` is
// swept. Matches `CrashLoopGuardService` — long enough to dodge concurrent
// boots, short enough to keep the userData dir tidy.
const TMP_ORPHAN_TTL_MS = 5 * 60 * 1000;
// Number of `.corrupted.*` siblings to retain for forensics. Older entries are
// pruned at boot so a chronic crash loop can't fill the userData directory.
const KEEP_CORRUPTED_SIBLINGS = 3;

const TMP_FILE_RE = /^panel-suspect-ledger\.json\.(\d+)-[a-z0-9]+\.tmp$/;
const CORRUPTED_FILE_RE = /^panel-suspect-ledger\.json\.corrupted\.(\d+)$/;

export interface PanelSuspectRecord {
  /** Consecutive crashed boots where the panel was within the SUSPECT_WINDOW_MS of crash time. */
  consecutiveSuspectCount: number;
  /** Clean shutdowns since this panel was last flagged suspect. Reset to 0 on every suspect hit. */
  cleanLaunchesSince: number;
  /** ms timestamp of the most recent suspect hit; powers the TTL fallback decay. */
  lastSuspectAt: number;
  /** Display title at the time of the most recent suspect hit (refreshed each pass). */
  title: string;
  /** Panel kind ("terminal" | "browser" | "dev-preview"); refreshed each pass. */
  kind: string;
  cwd?: string;
  worktreeId?: string;
}

interface PanelSuspectLedger {
  version: 1;
  panels: Record<string, PanelSuspectRecord>;
}

function freshLedger(): PanelSuspectLedger {
  return { version: 1, panels: {} };
}

function tightenFilePermissions(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    console.warn("[PanelSuspectLedger] Failed to tighten file permissions:", filePath, err);
  }
}

function isValidRecord(value: unknown): value is PanelSuspectRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<PanelSuspectRecord>;
  return (
    typeof r.consecutiveSuspectCount === "number" &&
    Number.isFinite(r.consecutiveSuspectCount) &&
    typeof r.cleanLaunchesSince === "number" &&
    Number.isFinite(r.cleanLaunchesSince) &&
    typeof r.lastSuspectAt === "number" &&
    Number.isFinite(r.lastSuspectAt) &&
    typeof r.title === "string" &&
    typeof r.kind === "string" &&
    (r.cwd === undefined || typeof r.cwd === "string") &&
    (r.worktreeId === undefined || typeof r.worktreeId === "string")
  );
}

export class PanelSuspectLedgerService {
  private userData: string;
  private ledgerPath: string;
  private ledger: PanelSuspectLedger = freshLedger();
  private initialized = false;
  private quarantinedLedgerPath: string | null = null;

  constructor() {
    this.userData = app.getPath("userData");
    this.ledgerPath = path.join(this.userData, LEDGER_FILENAME);
  }

  /**
   * Read the ledger, then fold the pending crash's panel summaries into it:
   * - For each panel marked `isSuspect`, increment `consecutiveSuspectCount`
   *   and reset `cleanLaunchesSince` to 0.
   * - For panels present in the pending-crash summary but NOT suspect, treat
   *   the crash as a clean signal for that panel and increment its
   *   `cleanLaunchesSince`.
   * - Records not referenced this boot are untouched (no decay applied — decay
   *   accrues only via `markCleanLaunch` on graceful shutdown, where we have
   *   ground truth that the session ended cleanly).
   * - Apply TTL-based decay (any record older than `PANEL_DECAY_TTL_MS` is
   *   removed regardless of clean-launch count).
   * - Apply clean-launch decay (any record with `cleanLaunchesSince` past
   *   threshold is removed).
   *
   * The pending crash may be `null` (no marker, i.e., this is a clean boot
   * after a clean shutdown) — in that case we still load the ledger so the
   * in-memory state is correct, but make no mutations beyond TTL decay.
   */
  initialize(pendingCrash: PendingCrash | null): void {
    if (this.initialized) return;
    this.initialized = true;

    this.sweepStaleTmpFiles();
    this.pruneCorruptedSiblings();

    this.ledger = this.readLedger();

    const now = Date.now();
    const panels = pendingCrash?.panels ?? null;

    if (panels && panels.length > 0) {
      this.foldPendingCrash(panels, now);
    }

    this.applyDecay(now);

    try {
      this.writeLedger();
    } catch (err) {
      console.error("[PanelSuspectLedger] Failed to persist ledger during initialize:", err);
    }

    const quarantinedCount = this.countQuarantined();
    console.log(
      `[PanelSuspectLedger] Initialized — tracked: ${Object.keys(this.ledger.panels).length}, quarantined: ${quarantinedCount}`
    );
  }

  /** True when `initialize()` has run. Exposed for tests; main code paths should not gate on this. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /** Set of panel IDs currently at or above the quarantine threshold. */
  getQuarantinedPanelIds(): Set<string> {
    const ids = new Set<string>();
    for (const [id, record] of Object.entries(this.ledger.panels)) {
      if (record.consecutiveSuspectCount >= PANEL_QUARANTINE_THRESHOLD) {
        ids.add(id);
      }
    }
    return ids;
  }

  /** Renderer-facing summaries for every quarantined panel currently in the ledger. */
  getQuarantinedPanels(): QuarantinedPanelSummary[] {
    const summaries: QuarantinedPanelSummary[] = [];
    for (const [id, record] of Object.entries(this.ledger.panels)) {
      if (record.consecutiveSuspectCount >= PANEL_QUARANTINE_THRESHOLD) {
        summaries.push({
          id,
          kind: record.kind,
          title: record.title,
          cwd: record.cwd,
          worktreeId: record.worktreeId,
        });
      }
    }
    return summaries;
  }

  /**
   * Remove a panel's quarantine record on user request (from
   * `SafeModeBanner`'s "Restore panel" affordance). Returns `true` when a
   * record was present and cleared, `false` otherwise. Next-restart-only —
   * does not re-hydrate the panel in the current session.
   */
  clearQuarantinedPanel(panelId: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(this.ledger.panels, panelId)) {
      return false;
    }
    delete this.ledger.panels[panelId];
    try {
      this.writeLedger();
    } catch (err) {
      console.error("[PanelSuspectLedger] Failed to persist after clearQuarantinedPanel:", err);
    }
    return true;
  }

  /**
   * Increment `cleanLaunchesSince` on every record, then apply decay so any
   * record that crossed the threshold is removed. Called from
   * `shutdown.ts` alongside `CrashLoopGuard.markCleanExit` so the two
   * "clean exit" markers stay in lockstep.
   */
  markCleanLaunch(): void {
    const now = Date.now();
    for (const record of Object.values(this.ledger.panels)) {
      record.cleanLaunchesSince += 1;
    }
    this.applyDecay(now);
    try {
      this.writeLedger();
    } catch (err) {
      console.error("[PanelSuspectLedger] Failed to persist clean launch:", err);
    }
  }

  /**
   * Path of the corrupt ledger file that was quarantined during `initialize()`,
   * or `null` when no corruption was detected. Mirrors the pattern in
   * `CrashLoopGuardService.getQuarantinedStatePath()`.
   */
  getQuarantinedLedgerPath(): string | null {
    return this.quarantinedLedgerPath;
  }

  dispose(): void {
    // No resources held — kept for API stability.
  }

  private foldPendingCrash(panels: PanelSummary[], now: number): void {
    for (const panel of panels) {
      if (!panel.id) continue;
      const existing = this.ledger.panels[panel.id];
      if (panel.isSuspect) {
        const next: PanelSuspectRecord = {
          consecutiveSuspectCount: (existing?.consecutiveSuspectCount ?? 0) + 1,
          cleanLaunchesSince: 0,
          lastSuspectAt: now,
          title: panel.title,
          kind: panel.kind,
          cwd: panel.cwd,
          worktreeId: panel.worktreeId,
        };
        this.ledger.panels[panel.id] = next;
      } else if (existing) {
        // Crash recorded but this panel wasn't near the failure window —
        // treat it as a clean launch for that panel only. Don't reset the
        // suspect count: a long-lived panel that survived one crash unscathed
        // shouldn't yet be cleared if it was about to cross the threshold.
        // The clean-launch decay will remove it after the configured
        // number of consecutive clean appearances.
        existing.cleanLaunchesSince += 1;
        // Keep the display metadata current — a renamed panel should surface
        // with its new title on the next quarantine.
        existing.title = panel.title;
        existing.kind = panel.kind;
        existing.cwd = panel.cwd;
        existing.worktreeId = panel.worktreeId;
      }
    }
  }

  private applyDecay(now: number): void {
    for (const [id, record] of Object.entries(this.ledger.panels)) {
      const ttlExpired = now - record.lastSuspectAt > PANEL_DECAY_TTL_MS;
      const decayed = record.cleanLaunchesSince >= PANEL_DECAY_CLEAN_LAUNCHES;
      if (ttlExpired || decayed) {
        delete this.ledger.panels[id];
      }
    }
  }

  private countQuarantined(): number {
    let count = 0;
    for (const record of Object.values(this.ledger.panels)) {
      if (record.consecutiveSuspectCount >= PANEL_QUARANTINE_THRESHOLD) count += 1;
    }
    return count;
  }

  private readLedger(): PanelSuspectLedger {
    if (!fs.existsSync(this.ledgerPath)) {
      return freshLedger();
    }
    try {
      const raw = fs.readFileSync(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PanelSuspectLedger>;
      if (
        parsed.version === 1 &&
        typeof parsed.panels === "object" &&
        parsed.panels !== null &&
        !Array.isArray(parsed.panels)
      ) {
        // Per-entry validation — drop malformed records, keep the rest. A
        // single corrupt entry shouldn't wipe the whole ledger.
        const cleaned: Record<string, PanelSuspectRecord> = {};
        for (const [id, record] of Object.entries(parsed.panels)) {
          if (typeof id === "string" && id.length > 0 && isValidRecord(record)) {
            cleaned[id] = record;
          }
        }
        return { version: 1, panels: cleaned };
      }
      console.warn("[PanelSuspectLedger] Invalid ledger structure — quarantining and resetting");
      this.quarantineLedgerFile();
      return freshLedger();
    } catch (err) {
      console.warn(
        "[PanelSuspectLedger] Failed to parse ledger file — quarantining and resetting",
        err
      );
      this.quarantineLedgerFile();
      return freshLedger();
    }
  }

  private quarantineLedgerFile(): void {
    const quarantinePath = `${this.ledgerPath}.corrupted.${Date.now()}`;
    try {
      fs.renameSync(this.ledgerPath, quarantinePath);
    } catch (err) {
      console.warn("[PanelSuspectLedger] Failed to quarantine corrupt ledger:", err);
      return;
    }
    tightenFilePermissions(quarantinePath);
    if (this.quarantinedLedgerPath === null) {
      this.quarantinedLedgerPath = quarantinePath;
    }
    console.log(`[PanelSuspectLedger] Quarantined corrupt ledger to ${quarantinePath}`);
  }

  private sweepStaleTmpFiles(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.userData);
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of entries) {
      const match = TMP_FILE_RE.exec(entry);
      if (!match) continue;
      const ts = Number.parseInt(match[1]!, 10);
      if (!Number.isFinite(ts)) continue;
      if (now - ts < TMP_ORPHAN_TTL_MS) continue;
      const tmpPath = path.join(this.userData, entry);
      try {
        fs.unlinkSync(tmpPath);
        console.log(`[PanelSuspectLedger] Swept stale tmp file ${tmpPath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[PanelSuspectLedger] Failed to sweep tmp file ${tmpPath}:`, err);
        }
      }
    }
  }

  private pruneCorruptedSiblings(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.userData);
    } catch {
      return;
    }
    const corrupted: Array<{ entry: string; ts: number }> = [];
    for (const entry of entries) {
      const match = CORRUPTED_FILE_RE.exec(entry);
      if (!match) continue;
      const ts = Number.parseInt(match[1]!, 10);
      if (!Number.isFinite(ts)) continue;
      corrupted.push({ entry, ts });
    }
    if (corrupted.length <= KEEP_CORRUPTED_SIBLINGS) return;
    corrupted.sort((a, b) => b.ts - a.ts);
    for (const { entry } of corrupted.slice(KEEP_CORRUPTED_SIBLINGS)) {
      const corruptedPath = path.join(this.userData, entry);
      try {
        fs.unlinkSync(corruptedPath);
        console.log(`[PanelSuspectLedger] Pruned old corrupted sibling ${corruptedPath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[PanelSuspectLedger] Failed to prune ${corruptedPath}:`, err);
        }
      }
    }
  }

  private writeLedger(): void {
    const data = JSON.stringify(this.ledger);
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    resilientAtomicWriteFileSync(this.ledgerPath, data, "utf-8");
  }
}

let instance: PanelSuspectLedgerService | null = null;

export function getPanelSuspectLedger(): PanelSuspectLedgerService {
  if (!instance) {
    instance = new PanelSuspectLedgerService();
  }
  return instance;
}

export function initializePanelSuspectLedger(
  pendingCrash: PendingCrash | null
): PanelSuspectLedgerService {
  const service = getPanelSuspectLedger();
  service.initialize(pendingCrash);
  return service;
}

// Test-only reset hook. Not exported from the public service surface — tests
// import this directly to clear the module-scoped singleton between cases.
export function __resetPanelSuspectLedgerForTesting(): void {
  instance = null;
}
