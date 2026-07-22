/**
 * AgentTerminalLifecycleLedger — bounded, in-memory audit ledger for agent
 * terminal lifecycle integrity (spawn → attach → resize → restore → close →
 * journal → resume).
 *
 * Each process that participates in the terminal lifecycle (renderer, main,
 * pty-host) owns its own instance; generations are monotonic per terminal id,
 * minted locally or adopted from the spawning process so cross-process events
 * (e.g. pty-host session captures) key to the same generation main minted.
 *
 * The ledger is a diagnostic/audit aid with one load-bearing duty: mutators
 * validate against the recorded generation and REJECT stale or duplicate
 * completions instead of applying them, so callers gate side effects (journal
 * writes, buffered resizes, restore merges) on the returned verdict rather
 * than on timing luck. Two validation regimes:
 *
 * - Live-state ops (resize, restore, attach, detection) apply only to the
 *   CURRENT generation — a stale completion must never touch a successor.
 * - Terminal-final ops (close, journal) are exactly-once PER generation and
 *   tolerate past generations — a kill's journal write may legitimately land
 *   after the same terminal id respawned, and must neither be dropped nor
 *   attributed to the successor.
 *
 * It never stores env values or terminal content — env is captured as sorted
 * key names plus a content hash (`computeEnvProvenance`), so diagnostics can
 * show provider provenance without exposing secrets.
 */

export type LedgerWorktreeSource = "explicit" | "inferred";

export interface LedgerEnvProvenance {
  /** Sorted env var names from the caller-resolved launch env. Never values. */
  keys: string[];
  /** FNV-1a hash over sorted `key=value` pairs — change detection, not content. */
  hash: string;
}

/** Immutable facts recorded once per launch generation. */
export interface LedgerLaunchFacts {
  launchAgentId?: string;
  cwd?: string;
  projectId?: string;
  worktreeId?: string;
  worktreeSource?: LedgerWorktreeSource;
  agentModelId?: string;
  agentPresetId?: string;
  originalPresetId?: string;
  agentLaunchFlags?: string[];
  env?: LedgerEnvProvenance;
  initialCols?: number;
  initialRows?: number;
  spawnedBy?: string;
  /** Session id this launch resumes, when relaunched from the journal. */
  resumedFromSessionId?: string;
}

export type LedgerRejectReason =
  | "unknown-terminal"
  | "stale-generation"
  | "future-generation"
  | "duplicate-journal"
  | "duplicate-close"
  | "inferred-worktree-overwrite";

export type LedgerVerdict =
  { accepted: true } | { accepted: false; reason: LedgerRejectReason; detail?: string };

export interface LedgerAnomaly {
  terminalId: string;
  /** Generation the stale/duplicate operation carried, when known. */
  generation: number | null;
  /** Generation the ledger held when the operation was rejected. */
  currentGeneration: number | null;
  op: string;
  reason: LedgerRejectReason;
  detail?: string;
  at: number;
}

export interface LedgerEntrySnapshot {
  terminalId: string;
  generation: number;
  facts: LedgerLaunchFacts;
  launchedAt: number;
  /** Detected-agent evolution for this generation, oldest first (bounded). */
  detectedAgentIds: string[];
  spawnResolvedAt?: number;
  spawnOk?: boolean;
  firstAttachCols?: number;
  firstAttachRows?: number;
  restoredAt?: number;
  closedAt?: number;
  closeReason?: string;
  exitCode?: number | null;
  journaledSessionId?: string;
  journaledAt?: number;
}

export interface LedgerDiagnostics {
  terminals: LedgerEntrySnapshot[];
  anomalies: LedgerAnomaly[];
}

export interface AgentLifecycleLedgerOptions {
  /** Max tracked terminals; closed entries are evicted first. Default 256. */
  maxTerminals?: number;
  /** Max retained anomalies (ring buffer). Default 128. */
  maxAnomalies?: number;
  /** Max retained close/journal generation marks (FIFO). Default 1024. */
  maxGenerationMarks?: number;
  /** Max retained detected-agent evolution entries per generation. Default 8. */
  maxDetectedAgents?: number;
  /**
   * Invoked on every rejected operation. Wire to a dev/test-only logger for
   * loud invariant checks; production callers rely on the returned verdict.
   */
  onAnomaly?: (anomaly: LedgerAnomaly) => void;
  /** Clock override for tests. */
  now?: () => number;
}

type LedgerEntry = LedgerEntrySnapshot;

/** Exactly-once bookkeeping for terminal-final ops, keyed per generation. */
interface GenerationMark {
  closed?: boolean;
  closeReason?: string;
  journaledSessionId?: string;
}

/** FNV-1a 32-bit over sorted `key=value` pairs. Stable, cheap, non-cryptographic. */
export function computeEnvProvenance(
  env: Record<string, string> | undefined
): LedgerEnvProvenance | undefined {
  if (!env) return undefined;
  const keys = Object.keys(env).sort();
  let hash = 0x811c9dc5;
  for (const key of keys) {
    const pair = `${key}=${env[key]}\n`;
    for (let i = 0; i < pair.length; i++) {
      hash ^= pair.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return { keys, hash: hash.toString(16).padStart(8, "0") };
}

export class AgentTerminalLifecycleLedger {
  private entries = new Map<string, LedgerEntry>();
  private generationMarks = new Map<string, GenerationMark>();
  private anomalies: LedgerAnomaly[] = [];
  private readonly maxTerminals: number;
  private readonly maxAnomalies: number;
  private readonly maxGenerationMarks: number;
  private readonly maxDetectedAgents: number;
  private readonly onAnomaly?: (anomaly: LedgerAnomaly) => void;
  private readonly now: () => number;

  constructor(options: AgentLifecycleLedgerOptions = {}) {
    this.maxTerminals = options.maxTerminals ?? 256;
    this.maxAnomalies = options.maxAnomalies ?? 128;
    this.maxGenerationMarks = options.maxGenerationMarks ?? 1024;
    this.maxDetectedAgents = options.maxDetectedAgents ?? 8;
    this.onAnomaly = options.onAnomaly;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a new launch of `terminalId` and mint (or adopt) its generation.
   * A relaunch of a known id (restart, respawn-after-host-crash) increments
   * the generation and resets per-generation state; live-state completions
   * carrying the previous generation are rejected from here on.
   *
   * `generation` adopts an externally minted token (the pty-host adopts
   * main's) instead of minting locally, so both processes key the same
   * incarnation identically.
   */
  recordLaunch(
    terminalId: string,
    facts: LedgerLaunchFacts,
    options?: { generation?: number }
  ): number {
    const previous = this.entries.get(terminalId);
    const generation = options?.generation ?? (previous?.generation ?? 0) + 1;
    // Re-insert so Map iteration order stays oldest-first for eviction.
    this.entries.delete(terminalId);
    this.entries.set(terminalId, {
      terminalId,
      generation,
      facts: { ...facts },
      launchedAt: this.now(),
      detectedAgentIds: [],
    });
    this.evictIfNeeded();
    return generation;
  }

  currentGeneration(terminalId: string): number | undefined {
    return this.entries.get(terminalId)?.generation;
  }

  isCurrent(terminalId: string, generation: number): boolean {
    return this.entries.get(terminalId)?.generation === generation;
  }

  recordSpawnResolved(terminalId: string, generation: number, ok: boolean): LedgerVerdict {
    return this.withCurrent("spawn-resolved", terminalId, generation, (entry) => {
      entry.spawnResolvedAt = this.now();
      entry.spawnOk = ok;
      return { accepted: true };
    });
  }

  /** First live attach dims — recorded once; later attaches are no-ops, not anomalies. */
  recordFirstAttach(
    terminalId: string,
    generation: number,
    cols: number,
    rows: number
  ): LedgerVerdict {
    return this.withCurrent("first-attach", terminalId, generation, (entry) => {
      if (entry.firstAttachCols === undefined) {
        entry.firstAttachCols = cols;
        entry.firstAttachRows = rows;
      }
      return { accepted: true };
    });
  }

  /**
   * Validate that a resize recorded under `generation` may apply to the
   * current generation. A resize buffered before a terminal was killed must
   * not become the initial dims of its successor.
   */
  recordResize(terminalId: string, generation: number, cols: number, rows: number): LedgerVerdict {
    return this.withCurrent(
      "resize",
      terminalId,
      generation,
      () => ({ accepted: true }),
      `${cols}x${rows}`
    );
  }

  recordDetectedAgent(terminalId: string, generation: number, agentId: string): LedgerVerdict {
    return this.withCurrent("detected-agent", terminalId, generation, (entry) => {
      const last = entry.detectedAgentIds[entry.detectedAgentIds.length - 1];
      if (last !== agentId) {
        entry.detectedAgentIds.push(agentId);
        if (entry.detectedAgentIds.length > this.maxDetectedAgents) {
          entry.detectedAgentIds.shift();
        }
      }
      return { accepted: true };
    });
  }

  /**
   * Update worktree attribution. Inferred attribution (derived from cwd) never
   * overwrites a differing explicit worktreeId recorded at launch or later.
   */
  recordWorktreeAttribution(
    terminalId: string,
    generation: number,
    worktreeId: string,
    source: LedgerWorktreeSource
  ): LedgerVerdict {
    return this.withCurrent("worktree-attribution", terminalId, generation, (entry) => {
      if (
        source === "inferred" &&
        entry.facts.worktreeSource === "explicit" &&
        entry.facts.worktreeId !== undefined &&
        entry.facts.worktreeId !== worktreeId
      ) {
        return {
          accepted: false,
          reason: "inferred-worktree-overwrite",
          detail: `explicit ${entry.facts.worktreeId} vs inferred ${worktreeId}`,
        };
      }
      entry.facts.worktreeId = worktreeId;
      entry.facts.worktreeSource = source;
      return { accepted: true };
    });
  }

  /**
   * Validate that a restore completion (session rehydration, metadata merge)
   * recorded under `generation` may still apply. A restore resolved after a
   * newer launch took the id must not overwrite the newer launch's metadata.
   */
  recordRestoreApplied(terminalId: string, generation: number): LedgerVerdict {
    return this.withCurrent("restore", terminalId, generation, (entry) => {
      entry.restoredAt = this.now();
      return { accepted: true };
    });
  }

  /**
   * At-most-once close per (terminalId, generation). Past generations are
   * accepted — an exit event for a killed terminal may arrive after the same
   * id respawned (restart flow) and still belongs to its own generation.
   */
  recordClose(
    terminalId: string,
    generation: number,
    reason?: string,
    exitCode?: number | null
  ): LedgerVerdict {
    return this.withGenerationMark("close", terminalId, generation, (mark, entry) => {
      if (mark.closed) {
        return { accepted: false, reason: "duplicate-close", detail: mark.closeReason };
      }
      mark.closed = true;
      mark.closeReason = reason;
      if (entry) {
        entry.closedAt = this.now();
        entry.closeReason = reason;
        if (exitCode !== undefined) entry.exitCode = exitCode;
      }
      return { accepted: true };
    });
  }

  /**
   * At-most-once session journaling per (terminalId, generation). Callers MUST
   * gate the journal write on this verdict — it is the exactly-once mechanism
   * for agent session history across the trash-expiry / kill / graceful-kill /
   * shutdown close paths. Past generations are accepted (see recordClose).
   *
   * The mark is a RESERVATION taken before the durable write; a failed write
   * must release it via {@link rescindJournal} or a later retry (and every
   * other close path for the generation) would be dropped as a duplicate.
   * Production journaling goes through `journalAgentSession`, which owns that
   * reserve/rollback pairing — do not call this directly from close paths.
   */
  recordJournal(terminalId: string, generation: number, sessionId: string): LedgerVerdict {
    return this.withGenerationMark("journal", terminalId, generation, (mark, entry) => {
      if (mark.journaledSessionId !== undefined) {
        return {
          accepted: false,
          reason: "duplicate-journal",
          detail: `already journaled ${mark.journaledSessionId}`,
        };
      }
      mark.journaledSessionId = sessionId;
      if (entry) {
        entry.journaledSessionId = sessionId;
        entry.journaledAt = this.now();
      }
      return { accepted: true };
    });
  }

  /**
   * Release a journal reservation after a failed durable write so a retry (or
   * another close path) can journal the generation. No-op when nothing is
   * reserved.
   */
  rescindJournal(terminalId: string, generation: number): void {
    const mark = this.generationMarks.get(`${terminalId}#${generation}`);
    if (mark) {
      mark.journaledSessionId = undefined;
    }
    const entry = this.entries.get(terminalId);
    if (entry && entry.generation === generation) {
      entry.journaledSessionId = undefined;
      entry.journaledAt = undefined;
    }
  }

  getEntry(terminalId: string): LedgerEntrySnapshot | undefined {
    const entry = this.entries.get(terminalId);
    return entry ? this.snapshotEntry(entry) : undefined;
  }

  getAnomalies(): LedgerAnomaly[] {
    return [...this.anomalies];
  }

  /** Secret-free snapshot for diagnostics/support bundles. */
  getDiagnostics(): LedgerDiagnostics {
    return {
      terminals: [...this.entries.values()].map((entry) => this.snapshotEntry(entry)),
      anomalies: this.getAnomalies(),
    };
  }

  clear(): void {
    this.entries.clear();
    this.generationMarks.clear();
    this.anomalies = [];
  }

  private snapshotEntry(entry: LedgerEntry): LedgerEntrySnapshot {
    return {
      ...entry,
      facts: { ...entry.facts },
      detectedAgentIds: [...entry.detectedAgentIds],
    };
  }

  /** Live-state ops: only the current generation may apply. */
  private withCurrent(
    op: string,
    terminalId: string,
    generation: number,
    apply: (entry: LedgerEntry) => LedgerVerdict,
    detail?: string
  ): LedgerVerdict {
    const entry = this.entries.get(terminalId);
    if (!entry) {
      return this.reject(op, terminalId, generation, null, "unknown-terminal", detail);
    }
    if (generation < entry.generation) {
      return this.reject(op, terminalId, generation, entry.generation, "stale-generation", detail);
    }
    if (generation > entry.generation) {
      return this.reject(op, terminalId, generation, entry.generation, "future-generation", detail);
    }
    const verdict = apply(entry);
    if (!verdict.accepted) {
      this.pushAnomaly({
        terminalId,
        generation,
        currentGeneration: entry.generation,
        op,
        reason: verdict.reason,
        detail: verdict.detail ?? detail,
        at: this.now(),
      });
    }
    return verdict;
  }

  /** Terminal-final ops: exactly-once per generation, past generations allowed. */
  private withGenerationMark(
    op: string,
    terminalId: string,
    generation: number,
    apply: (mark: GenerationMark, entry: LedgerEntry | undefined) => LedgerVerdict
  ): LedgerVerdict {
    const entry = this.entries.get(terminalId);
    if (!entry) {
      return this.reject(op, terminalId, generation, null, "unknown-terminal");
    }
    if (generation > entry.generation) {
      return this.reject(op, terminalId, generation, entry.generation, "future-generation");
    }
    const key = `${terminalId}#${generation}`;
    let mark = this.generationMarks.get(key);
    if (!mark) {
      mark = {};
      this.generationMarks.set(key, mark);
      if (this.generationMarks.size > this.maxGenerationMarks) {
        const oldest = this.generationMarks.keys().next().value;
        if (oldest !== undefined) this.generationMarks.delete(oldest);
      }
    }
    const verdict = apply(mark, generation === entry.generation ? entry : undefined);
    if (!verdict.accepted) {
      this.pushAnomaly({
        terminalId,
        generation,
        currentGeneration: entry.generation,
        op,
        reason: verdict.reason,
        detail: verdict.detail,
        at: this.now(),
      });
    }
    return verdict;
  }

  private reject(
    op: string,
    terminalId: string,
    generation: number,
    currentGeneration: number | null,
    reason: LedgerRejectReason,
    detail?: string
  ): LedgerVerdict {
    this.pushAnomaly({
      terminalId,
      generation,
      currentGeneration,
      op,
      reason,
      detail,
      at: this.now(),
    });
    return { accepted: false, reason, detail };
  }

  private pushAnomaly(anomaly: LedgerAnomaly): void {
    this.anomalies.push(anomaly);
    if (this.anomalies.length > this.maxAnomalies) {
      this.anomalies.splice(0, this.anomalies.length - this.maxAnomalies);
    }
    this.onAnomaly?.(anomaly);
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxTerminals) return;
    // Prefer evicting closed entries (oldest first); fall back to oldest live.
    for (const [id, entry] of this.entries) {
      if (entry.closedAt !== undefined) {
        this.entries.delete(id);
        if (this.entries.size <= this.maxTerminals) return;
      }
    }
    for (const id of this.entries.keys()) {
      this.entries.delete(id);
      if (this.entries.size <= this.maxTerminals) return;
    }
  }
}
