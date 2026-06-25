import { randomUUID } from "node:crypto";
import type {
  AssistantTurnRecord,
  McpAuditRecord,
  TurnOutcomeAlertClass,
  TurnOutcomeClass,
} from "../../../shared/types/ipc/mcpServer.js";
import {
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_MIN_RECORDS,
} from "../../../shared/types/ipc/mcpServer.js";
import { auditRingStore } from "../persistence/auditRingStore.js";
import { AUDIT_FLUSH_DEBOUNCE_MS, TIER_NOT_PERMITTED_CODE } from "./shared.js";

export interface TurnOutcomeLogStore {
  read(): unknown;
  write(records: AssistantTurnRecord[]): void;
}

// Persists the ring in the dedicated audit-logs store; see the matching note
// in auditLog.ts. Config flags stay in config.json.
const defaultLogStore: TurnOutcomeLogStore = {
  read: () => auditRingStore.readAll("mcpTurnOutcomeLog"),
  write: (records) =>
    auditRingStore.writeAll("mcpTurnOutcomeLog", records, MCP_AUDIT_DEFAULT_MAX_RECORDS),
};

/**
 * Per-terminal recent-output ring size. Mirrors the pty-host
 * `TerminalForensicsBuffer` cap; sized to capture the trailing assistant
 * response without retaining whole sessions.
 */
const RECENT_OUTPUT_RING_SIZE = 4000;
/**
 * Hard fallback when the per-terminal turn-start timestamp is unknown
 * (e.g. classification fires before any prior `idle → working` was seen).
 * Limits cross-turn audit poisoning to recent activity rather than the
 * full session history.
 */
const AUDIT_LOOKBACK_MS = 60_000;
/**
 * Number of trailing characters of `recentOutput` to scan for outcome
 * classification. Bounded well under the ring so a pathological prompt
 * never balloons the regex pass.
 */
const CLASSIFY_TAIL_CHARS = 2000;
/**
 * Output shorter than this is treated as effectively empty — common after a
 * just-started session or a cleared screen — and falls through to `unknown`
 * rather than being mis-attributed.
 */
const MIN_CLASSIFY_LENGTH = 50;
/**
 * Hibernate-resume-stale signals appear in the FIRST output of a resumed
 * session, not the trailing turn buffer. Scan only the leading chunk to
 * avoid false matches on later output that happens to mention "no sessions".
 */
const RESUME_STALE_PROBE_CHARS = 500;
/** Number of identical (toolId, argsSummary) calls within a turn window that triggers `reasoning-loop`. */
const REASONING_LOOP_THRESHOLD = 3;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;?]*[A-Za-z]|\][^]*(?:|\\)/g;

const REFUSED_PATTERNS: readonly RegExp[] = [
  /\b(?:i (?:cannot|can't|am unable to|won't))\b/i,
  /\bagainst (?:my|our) (?:guidelines|policies|instructions|rules)\b/i,
  /\bi(?:'m| am) not (?:able|going) to\b/i,
];

const HEDGED_PATTERNS: readonly RegExp[] = [
  /\bi(?:'m| am) not (?:sure|certain|aware|confident)\b/i,
  /\bi don'?t (?:know|have (?:enough )?(?:information|details?|context))\b/i,
  /\b(?:cannot|can't) (?:find|locate|determine)\b/i,
];

const DOCS_EMPTY_PATTERNS: readonly RegExp[] = [
  /\bno (?:results?|documentation|docs?|matches?) found\b/i,
  /\bno (?:relevant|matching) (?:docs?|documentation|results?)\b/i,
  /\bnothing (?:was )?(?:found|returned|available)\b/i,
  /\bempty (?:response|results?)\b/i,
];

const RESUME_STALE_PATTERNS: readonly RegExp[] = [
  /\bno conversations? (?:found )?to resume\b/i,
  /\bno (?:previous |prior )?(?:session|history) (?:found|available)\b/i,
  /\bno sessions? found\b/i,
];

/**
 * FSM state grouping. Mirrors the private `getStateGroup` in
 * `AgentStateService` — duplicated here intentionally rather than exported,
 * because the audit-side coupling on the FSM should be opt-in and minimal.
 */
function getStateGroup(state: string): "active" | "passive" | "unknown" {
  switch (state) {
    case "working":
    case "directing":
      return "active";
    case "idle":
    case "waiting":
    case "completed":
    case "exited":
      return "passive";
    default:
      return "unknown";
  }
}

export interface FsmTransition {
  state: string;
  previousState: string;
  trigger: string;
  terminalId: string;
  timestamp: number;
}

/**
 * Per-terminal turn classifier. Examines the trailing `recentOutput` buffer
 * plus audit records that fell inside the current turn window, and returns
 * one `TurnOutcomeClass`. Pure function aside from the audit-records
 * lookup — no IO.
 *
 * `recentAuditRecords` is expected to arrive newest-first (matches
 * `AuditService.getRecords()` ordering) — the classifier picks the
 * most-recent matching record. `turnStartTimestamp` is the lower bound for
 * which audit records belong to *this* turn; defaults to a fixed lookback
 * window when the caller has no boundary information.
 */
export function classifyTurnOutcome(args: {
  transition: FsmTransition;
  recentOutput: string;
  recentAuditRecords: readonly McpAuditRecord[];
  sessionId: string | null;
  turnStartTimestamp?: number;
}): TurnOutcomeClass {
  const { transition, recentOutput, recentAuditRecords, sessionId } = args;
  const turnStartTimestamp = args.turnStartTimestamp ?? transition.timestamp - AUDIT_LOOKBACK_MS;

  // Watchdog-driven `waiting → idle` is the agent-stuck signal — see #4974
  // and #4560 for why we trust the watchdog trigger as authoritative and
  // do not re-probe CPU/process state here.
  if (
    transition.trigger === "timeout" &&
    transition.previousState === "waiting" &&
    transition.state === "idle"
  ) {
    return "agent-stuck";
  }

  if (sessionId) {
    // recentAuditRecords arrives newest-first; the FIRST matching record is
    // the most recent. Filter to records that fall inside the current turn
    // window so a stale error from a prior turn cannot poison the
    // classification. Audit records carry the MCP transport id in
    // `sessionId`; `helpSessionId` is the field that matches the help
    // session id this classifier receives.
    const lastRecord = recentAuditRecords.find(
      (r) => r.helpSessionId === sessionId && r.timestamp >= turnStartTimestamp
    );
    if (lastRecord) {
      if (
        lastRecord.result === "unauthorized" ||
        lastRecord.errorCode === TIER_NOT_PERMITTED_CODE
      ) {
        return "tier-rejected";
      }
      if (lastRecord.result === "error" || lastRecord.result === "collision") {
        return "tool-error";
      }
    }

    const callCounts = new Map<string, number>();
    for (const r of recentAuditRecords) {
      if (r.helpSessionId === sessionId && r.timestamp >= turnStartTimestamp) {
        const key = `${r.toolId}::${r.argsSummary}`;
        const count = (callCounts.get(key) ?? 0) + 1;
        if (count >= REASONING_LOOP_THRESHOLD) {
          return "reasoning-loop";
        }
        callCounts.set(key, count);
      }
    }
  }

  const stripped = recentOutput.replace(ANSI_PATTERN, "");
  const tail = stripped.slice(-CLASSIFY_TAIL_CHARS);
  const head = stripped.slice(0, RESUME_STALE_PROBE_CHARS);

  if (tail.trim().length < MIN_CLASSIFY_LENGTH) {
    return "unknown";
  }

  if (RESUME_STALE_PATTERNS.some((p) => p.test(head))) {
    return "hibernate-resume-stale";
  }
  if (REFUSED_PATTERNS.some((p) => p.test(tail))) {
    return "refused";
  }
  if (HEDGED_PATTERNS.some((p) => p.test(tail))) {
    return "hedged";
  }
  if (DOCS_EMPTY_PATTERNS.some((p) => p.test(tail))) {
    return "docs-empty";
  }
  return "answered";
}

export interface TurnOutcomeServiceDeps {
  saveConfig: (patch: Record<string, unknown>) => void;
  readConfig: () => Record<string, unknown>;
  getSessionIdForTerminal: (terminalId: string) => string | null;
  getRecentAuditRecords: () => readonly McpAuditRecord[];
  logStore?: TurnOutcomeLogStore;
}

export class TurnOutcomeService {
  private records: AssistantTurnRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;
  /**
   * Per-terminal recent-output ring populated from `agent:output` events.
   * Lives in the main process so the classifier can read it synchronously
   * when an FSM transition fires. Bounded per-terminal; cleared on terminal
   * exit/trash by `dropTerminal()`.
   */
  private recentOutput = new Map<string, string>();
  /**
   * Tracks which terminals have already been billed an `agent-stuck`
   * outcome since their last `active` (working) transition. Cleared when
   * the terminal next enters an active state — that's a "new turn" boundary
   * for stuck-detection purposes. Without this guard, repeated watchdog
   * fires on the same dormant session would each append a record (#4974).
   */
  private stuckRecorded = new Set<string>();
  /**
   * Per-terminal timestamp of the most recent entry into an active state.
   * Used as the lower bound for audit-record lookup so a stale error from
   * a prior turn doesn't poison the current classification.
   */
  private turnStartByTerminal = new Map<string, number>();
  /**
   * Per-terminal UUID minted at the `toGroup === "active"` transition.
   * Shared with audit records written during the same turn window.
   */
  private turnIdByTerminal = new Map<string, string>();
  /**
   * Session-keyed mirror of `turnIdByTerminal` for O(1) audit-stamp lookup.
   * Populated eagerly at mint time when the terminal is already bound to a
   * help session; empty for unbound terminals (correct: pre-session turn
   * dispatches should carry no turnId).
   */
  private turnIdBySession = new Map<string, string>();
  /**
   * Optional renderer push for the two alertable outcomes (`agent-stuck`,
   * `reasoning-loop`). Wired after construction via
   * {@link setNotifyTurnOutcomeAlert} because the send path lives in
   * `HttpLifecycle`, which is constructed after this service. Null until then —
   * the persistence path never depends on it.
   */
  private notifyTurnOutcomeAlert:
    | ((outcome: TurnOutcomeAlertClass, helpSessionId: string, turnId: string | undefined) => void)
    | null = null;

  private readonly logStore: TurnOutcomeLogStore;

  constructor(private readonly deps: TurnOutcomeServiceDeps) {
    this.logStore = deps.logStore ?? defaultLogStore;
  }

  /**
   * Wire the live alert push for `agent-stuck` / `reasoning-loop` outcomes
   * (#10018). Called once by `McpServerService` after `HttpLifecycle` exists.
   * Kept separate from the constructor deps because the send path depends on
   * a collaborator built after this service.
   */
  setNotifyTurnOutcomeAlert(
    cb: (outcome: TurnOutcomeAlertClass, helpSessionId: string, turnId: string | undefined) => void
  ): void {
    this.notifyTurnOutcomeAlert = cb;
  }

  /**
   * Append a chunk of agent output to the per-terminal ring. Called from
   * the `agent:output` event subscriber. Skipped early when the terminal
   * has no help-session binding, to keep buffers from growing for plain
   * agent terminals that never produce a turn record.
   */
  appendOutput(terminalId: string, data: string): void {
    if (!terminalId || !data) return;
    if (this.deps.getSessionIdForTerminal(terminalId) === null) return;
    const existing = this.recentOutput.get(terminalId) ?? "";
    const next = existing + data;
    this.recentOutput.set(
      terminalId,
      next.length > RECENT_OUTPUT_RING_SIZE ? next.slice(-RECENT_OUTPUT_RING_SIZE) : next
    );
  }

  /**
   * Drop the recent-output ring + stuck-guard for a terminal. Called on
   * terminal trash/exit to release per-terminal memory.
   */
  dropTerminal(terminalId: string): void {
    this.recentOutput.delete(terminalId);
    this.stuckRecorded.delete(terminalId);
    this.turnStartByTerminal.delete(terminalId);
    const terminalTurnId = this.turnIdByTerminal.get(terminalId);
    this.turnIdByTerminal.delete(terminalId);
    const sessionId = this.deps.getSessionIdForTerminal(terminalId);
    if (sessionId !== null) {
      this.turnIdBySession.delete(sessionId);
    } else if (terminalTurnId !== undefined) {
      // Session binding was already revoked — fall back to a value scan
      // so the entry doesn't leak for the process lifetime.
      for (const [sid, tid] of this.turnIdBySession.entries()) {
        if (tid === terminalTurnId) {
          this.turnIdBySession.delete(sid);
          break;
        }
      }
    }
  }

  getRecentOutput(terminalId: string): string {
    return this.recentOutput.get(terminalId) ?? "";
  }

  /**
   * Return the current turnId for a help session, or null when the session
   * has no active turn. Called from the audit-write closure in
   * `buildSessionServerDeps` to stamp every dispatch with the turn it
   * belongs to.
   */
  getCurrentTurnIdForSession(sessionId: string): string | null {
    return this.turnIdBySession.get(sessionId) ?? null;
  }

  hydrate(): void {
    if (this.hydrated) return;
    const stored = this.logStore.read();
    const persisted = Array.isArray(stored) ? (stored as AssistantTurnRecord[]) : [];
    const cap = this.normalizeMaxRecords(this.deps.readConfig().auditMaxRecords);
    this.records =
      persisted.length > cap ? persisted.slice(persisted.length - cap) : [...persisted];
    this.hydrated = true;
  }

  normalizeMaxRecords(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return MCP_AUDIT_DEFAULT_MAX_RECORDS;
    if (n < MCP_AUDIT_MIN_RECORDS) return MCP_AUDIT_MIN_RECORDS;
    if (n > MCP_AUDIT_MAX_RECORDS) return MCP_AUDIT_MAX_RECORDS;
    return n;
  }

  /**
   * Handle an FSM state transition. Records a turn outcome only when:
   *   - the turn boundary is meaningful (active→passive, or watchdog timeout
   *     on waiting→idle), AND
   *   - the terminal is bound to a help session (sessionId resolves), AND
   *   - audit recording is enabled.
   *
   * Non-help terminals (no sessionId) are intentionally skipped — they
   * produce uncorrelated noise; the assistant-session audit is the target.
   */
  handleTransition(transition: FsmTransition): void {
    if (this.deps.readConfig().auditEnabled === false) return;

    const fromGroup = getStateGroup(transition.previousState);
    const toGroup = getStateGroup(transition.state);

    // Entering an active state marks the start of a new turn — reset the
    // stuck-recorded guard so a subsequent timeout in this fresh turn can
    // append its own record. Resetting on the *exit* would prevent the
    // very recording we just guarded against. Also stamp the turn-start
    // timestamp so the classifier can ignore audit records from prior
    // turns when this turn ends, and mint a fresh turnId to correlate
    // audit records written inside this window with the turn outcome.
    if (toGroup === "active") {
      this.stuckRecorded.delete(transition.terminalId);
      this.turnStartByTerminal.set(transition.terminalId, transition.timestamp);
      const turnId = randomUUID();
      this.turnIdByTerminal.set(transition.terminalId, turnId);
      const sessionId = this.deps.getSessionIdForTerminal(transition.terminalId);
      if (sessionId !== null) {
        this.turnIdBySession.set(sessionId, turnId);
      }
    }

    const isStuckTimeout =
      transition.trigger === "timeout" &&
      transition.previousState === "waiting" &&
      transition.state === "idle";
    const isActiveToPassive = fromGroup === "active" && toGroup === "passive";

    if (!isActiveToPassive && !isStuckTimeout) {
      return;
    }

    if (isStuckTimeout) {
      if (this.stuckRecorded.has(transition.terminalId)) return;
      this.stuckRecorded.add(transition.terminalId);
    }

    const sessionId = this.deps.getSessionIdForTerminal(transition.terminalId);
    if (sessionId === null) return;

    this.hydrate();

    const recentOutput = this.recentOutput.get(transition.terminalId) ?? "";
    const turnStartTimestamp = this.turnStartByTerminal.get(transition.terminalId);
    const outcome = classifyTurnOutcome({
      transition,
      recentOutput,
      recentAuditRecords: this.deps.getRecentAuditRecords(),
      sessionId,
      turnStartTimestamp,
    });

    const turnId = this.turnIdByTerminal.get(transition.terminalId);
    const record: AssistantTurnRecord = {
      id: randomUUID(),
      timestamp: transition.timestamp,
      terminalId: transition.terminalId,
      sessionId,
      outcome,
      trigger: transition.trigger,
      state: transition.state,
      previousState: transition.previousState,
    };
    if (turnId !== undefined) {
      record.turnId = turnId;
    }
    this.appendRecordInternal(record);
    // Surface the two "needs-a-look" outcomes to the bound help-session panel
    // as a live ambient pip (#10018). Best-effort and gated on the alert being
    // wired — a send failure must never block record persistence. `sessionId`
    // is the help-session id (the resolver's contract); `turnId` is absent for
    // `agent-stuck` because the prior active→passive boundary already cleared
    // it before the watchdog fired.
    if (
      this.notifyTurnOutcomeAlert &&
      (outcome === "agent-stuck" || outcome === "reasoning-loop")
    ) {
      try {
        this.notifyTurnOutcomeAlert(outcome, sessionId, turnId);
      } catch (err) {
        console.error("[MCP] turn-outcome alert callback threw:", err);
      }
    }
    // Drain the ring so the next active turn classifies on its own output
    // rather than re-matching the prior turn's trailing text.
    this.recentOutput.delete(transition.terminalId);
    // Clear the turnId so post-turn MCP dispatches (between this boundary
    // and the next active entry) are not incorrectly stamped with the prior
    // turn's ID. turnIdByTerminal is re-set on the next active transition.
    this.turnIdBySession.delete(sessionId);
    this.turnIdByTerminal.delete(transition.terminalId);
  }

  /**
   * Records an outcome that doesn't correspond to an FSM transition — used
   * for pre-turn failures like `mcp-not-ready`, where provisioning failed
   * before the agent ever spawned. Caller supplies whatever context it has
   * (sessionId may be null for `mcp-not-ready` because the session record
   * is rolled back on failure).
   */
  recordDirectOutcome(input: {
    outcome: TurnOutcomeClass;
    terminalId?: string | null;
    sessionId?: string | null;
    detail?: string;
  }): void {
    if (this.deps.readConfig().auditEnabled === false) return;
    this.hydrate();
    const record: AssistantTurnRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      terminalId: input.terminalId ?? null,
      sessionId: input.sessionId ?? null,
      outcome: input.outcome,
    };
    if (input.detail !== undefined) {
      record.detail = input.detail;
    }
    this.appendRecordInternal(record);
  }

  private appendRecordInternal(record: AssistantTurnRecord): void {
    this.records.push(record);
    const cap = this.normalizeMaxRecords(this.deps.readConfig().auditMaxRecords);
    if (this.records.length > cap) {
      this.records.splice(0, this.records.length - cap);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, AUDIT_FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (!this.hydrated) return;
    try {
      this.logStore.write([...this.records]);
    } catch (err) {
      console.error("[MCP] Failed to flush turn outcome log:", err);
    }
  }

  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  getRecords(): AssistantTurnRecord[] {
    this.hydrate();
    return [...this.records].reverse();
  }

  clear(): void {
    this.hydrate();
    this.records = [];
    this.flushNow();
  }

  /**
   * Drop turn-outcome records older than `retentionDays`, then flush if
   * anything was removed. Mirrors {@link AuditService.pruneByAge}:
   * `retentionDays <= 0` is "Off" (keep everything, count cap only), filtering
   * is on each record's own `.timestamp` (event time) not SQLite `created_at`,
   * and records with a non-finite timestamp are retained rather than dropped.
   */
  pruneByAge(retentionDays: number): void {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
    this.hydrate();
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const before = this.records.length;
    this.records = this.records.filter(
      (r) => !(typeof r.timestamp === "number" && r.timestamp < cutoff)
    );
    if (this.records.length !== before) {
      this.flushNow();
    }
  }
}
