import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";
import type {
  PanelSummary,
  QuarantinedPanelInfo,
} from "../../shared/types/ipc/crashRecovery.js";

const LEDGER_FILENAME = "panel-suspect-ledger.json";

/**
 * Strikes required to quarantine a panel from safe-mode restoration. A single
 * isSuspect-on-crash isn't enough — transient OOMs or unrelated host crashes
 * during a panel's startup window would otherwise quarantine a healthy panel.
 */
export const PANEL_SUSPECT_THRESHOLD = 2;

/**
 * Consecutive clean boots (with the panel present) required to decrement a
 * panel's strike count by one. Uses boot-count decay rather than wall-clock
 * decay because the app may be closed for days between launches.
 */
export const PANEL_CLEAN_DECAY_COUNT = 3;

interface PanelLedgerState {
  version: 1;
  /** panelId → consecutive isSuspect-on-crash strike count */
  suspects: Record<string, number>;
  /** panelId → consecutive clean-boot count since last strike (for decay) */
  cleanCounts: Record<string, number>;
}

function freshLedger(): PanelLedgerState {
  return { version: 1, suspects: {}, cleanCounts: {} };
}

function coerceCount(value: unknown): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return Math.floor(value);
}

function coerceCountMap(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    const count = coerceCount(raw);
    if (count > 0) out[key] = count;
  }
  return out;
}

export class PanelSuspectLedgerService {
  private userData: string;
  private ledgerPath: string;
  private state: PanelLedgerState = freshLedger();
  private initialized = false;
  private quarantined: QuarantinedPanelInfo[] = [];

  constructor() {
    this.userData = app.getPath("userData");
    this.ledgerPath = path.join(this.userData, LEDGER_FILENAME);
  }

  /**
   * Reconcile the ledger against the pending crash's panel summaries.
   *
   * Each panel marked `isSuspect` in the pre-crash backup gets a strike,
   * its `cleanCount` resets. Panels present in the snapshot that weren't
   * suspects accrue a clean-launch credit toward decay. Returns the list
   * of panels whose strike count meets the quarantine threshold.
   *
   * Call once per boot, after `consumeMarker()` resolves and before
   * `handleAppHydrate` returns — the result is what the renderer surfaces
   * in the safe-mode banner.
   */
  initialize(panelSummaries: PanelSummary[]): QuarantinedPanelInfo[] {
    if (this.initialized) {
      return this.quarantined;
    }
    this.initialized = true;
    this.state = this.readLedger();

    const seenIds = new Set<string>();
    for (const summary of panelSummaries) {
      if (typeof summary.id !== "string" || summary.id.length === 0) continue;
      seenIds.add(summary.id);
      if (summary.isSuspect) {
        const next = (this.state.suspects[summary.id] ?? 0) + 1;
        this.state.suspects[summary.id] = next;
        // A fresh strike invalidates whatever clean-launch streak existed.
        delete this.state.cleanCounts[summary.id];
      } else {
        this.applyCleanCredit(summary.id);
      }
    }

    // Panels that no longer exist in the snapshot can't be quarantined or
    // restored. Drop them so the ledger doesn't grow unbounded across
    // panel-creation churn.
    for (const id of Object.keys(this.state.suspects)) {
      if (!seenIds.has(id)) {
        delete this.state.suspects[id];
        delete this.state.cleanCounts[id];
      }
    }
    for (const id of Object.keys(this.state.cleanCounts)) {
      if (!seenIds.has(id)) {
        delete this.state.cleanCounts[id];
      }
    }

    this.quarantined = this.buildQuarantineList(panelSummaries);
    this.persist();
    return this.quarantined;
  }

  /**
   * Decay every ledger entry by one clean-launch credit. Called on boots
   * where no crash marker was consumed — the previous session exited
   * cleanly, so every panel that survived earns a tick toward decay.
   *
   * Idempotent because `initialized` is set on first call: a single boot
   * triggers either `initialize()` (after crash) or `recordCleanLaunch()`
   * (after clean exit), never both.
   */
  recordCleanLaunch(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.state = this.readLedger();

    for (const id of Object.keys(this.state.suspects)) {
      this.applyCleanCredit(id);
    }

    this.quarantined = [];
    this.persist();
  }

  /**
   * Clear a single panel's strike count so the next safe-mode boot
   * restores it. Used by the per-panel "Restore panel" affordance in
   * the safe-mode banner.
   */
  restorePanel(panelId: string): void {
    if (!this.initialized) {
      this.state = this.readLedger();
      this.initialized = true;
    }
    let mutated = false;
    if (panelId in this.state.suspects) {
      delete this.state.suspects[panelId];
      mutated = true;
    }
    if (panelId in this.state.cleanCounts) {
      delete this.state.cleanCounts[panelId];
      mutated = true;
    }
    this.quarantined = this.quarantined.filter((p) => p.id !== panelId);
    if (mutated) {
      this.persist();
    }
  }

  /**
   * Current quarantined panel list, populated by the most recent
   * `initialize()` call. Empty after `recordCleanLaunch()`.
   */
  getQuarantinedPanels(): QuarantinedPanelInfo[] {
    return this.quarantined;
  }

  /** Set of panel IDs the hydrate handler must filter out of `terminalsToUse`. */
  getQuarantinedPanelIds(): Set<string> {
    return new Set(this.quarantined.map((p) => p.id));
  }

  private applyCleanCredit(panelId: string): void {
    const currentStrikes = this.state.suspects[panelId];
    if (currentStrikes === undefined || currentStrikes <= 0) {
      // No strikes — nothing to decay.
      delete this.state.cleanCounts[panelId];
      return;
    }
    const next = (this.state.cleanCounts[panelId] ?? 0) + 1;
    if (next >= PANEL_CLEAN_DECAY_COUNT) {
      const decremented = currentStrikes - 1;
      if (decremented <= 0) {
        delete this.state.suspects[panelId];
      } else {
        this.state.suspects[panelId] = decremented;
      }
      delete this.state.cleanCounts[panelId];
    } else {
      this.state.cleanCounts[panelId] = next;
    }
  }

  private buildQuarantineList(panelSummaries: PanelSummary[]): QuarantinedPanelInfo[] {
    const out: QuarantinedPanelInfo[] = [];
    const summaryById = new Map(panelSummaries.map((p) => [p.id, p]));
    for (const [id, count] of Object.entries(this.state.suspects)) {
      if (count < PANEL_SUSPECT_THRESHOLD) continue;
      const summary = summaryById.get(id);
      if (!summary) continue;
      out.push({
        id,
        kind: summary.kind,
        title: summary.title,
        cwd: summary.cwd,
        worktreeId: summary.worktreeId,
        suspectCount: count,
      });
    }
    return out;
  }

  private readLedger(): PanelLedgerState {
    try {
      if (!fs.existsSync(this.ledgerPath)) {
        return freshLedger();
      }
      const raw = fs.readFileSync(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PanelLedgerState>;
      if (parsed && typeof parsed === "object" && parsed.version === 1) {
        return {
          version: 1,
          suspects: coerceCountMap(parsed.suspects),
          cleanCounts: coerceCountMap(parsed.cleanCounts),
        };
      }
      console.warn("[PanelSuspectLedger] Invalid ledger file, quarantining and using fresh state");
      this.quarantineCorruptLedger();
      return freshLedger();
    } catch {
      console.warn("[PanelSuspectLedger] Failed to read ledger file, quarantining and using fresh state");
      this.quarantineCorruptLedger();
      return freshLedger();
    }
  }

  private quarantineCorruptLedger(): void {
    try {
      if (!fs.existsSync(this.ledgerPath)) return;
      const dest = `${this.ledgerPath}.corrupted.${Date.now()}`;
      fs.renameSync(this.ledgerPath, dest);
      console.warn(`[PanelSuspectLedger] Quarantined corrupt ledger to ${dest}`);
    } catch (err) {
      console.error("[PanelSuspectLedger] Failed to quarantine corrupt ledger:", err);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.ledgerPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      resilientAtomicWriteFileSync(
        this.ledgerPath,
        JSON.stringify(this.state),
        "utf-8"
      );
    } catch (err) {
      console.error("[PanelSuspectLedger] Failed to persist ledger:", err);
    }
  }
}

let instance: PanelSuspectLedgerService | null = null;

export function getPanelSuspectLedger(): PanelSuspectLedgerService {
  if (!instance) {
    instance = new PanelSuspectLedgerService();
  }
  return instance;
}

// Exported for tests that need to construct a fresh service with a stubbed userData path.
export function resetPanelSuspectLedgerForTesting(): void {
  instance = null;
}
