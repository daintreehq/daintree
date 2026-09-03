import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { getPanelKindConfig, panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
import { logWarn } from "@/utils/logger";
import type {
  TerminalState,
  BackendTerminalInfo,
  TerminalReconnectResult,
} from "@shared/types/ipc/terminal";
import type { AgentSettings } from "@shared/types/agentSettings";
import type { WorktreeState } from "@shared/types";
import type { AgentPreset } from "@/config/agents";
import type { PanelKind } from "@shared/types/panel";
import type { ResourceProfile } from "@shared/types/resourceProfile";
import { type TerminalRestoreTask, getRestoreBatchParams, delay } from "./batchScheduler";
import { reconnectWithTimeout } from "./reconnectManager";
import {
  buildWorktreeMoveContext,
  resolveWorktreeMovePatch,
  type WorktreeMoveContext,
} from "./worktreeMoveRemap";
import { rebaseAbsolutePath } from "@shared/utils/projectPathRelocation";
import {
  inferKind,
  resolveAgentId,
  buildArgsForBackendTerminal,
  buildArgsForReconnectedFallback,
  buildArgsForRespawn,
  buildArgsForNonPtyRecreation,
  buildArgsForOrphanedTerminal,
  inferWorktreeIdFromCwd,
  resolveRespawnAgentId,
} from "./statePatcher";
import { buildResumeLatestCommand } from "@shared/types/agentSettings";
import { normalize as normalizePath } from "@shared/utils/path";
import type { HydrationOptions } from "./";
import { getAgentConfig } from "@/config/agents";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";
import { codexClient } from "@/clients/codexClient";
import { isValidTerminalGeometry } from "@shared/types/terminal";
import type { TerminalGeometry } from "@shared/types/terminal";

type AddPanelFn = HydrationOptions["addPanel"];

/**
 * The persisted grid for a saved pane, keyed by the id it was persisted under —
 * resolvable BEFORE `addPanel`, which is the whole point.
 *
 * A pane restored into a non-selected worktree never attaches: it sits prewarmed
 * at xterm's 80×24 default parsing everything its surviving PTY streams
 * (#11718). Feeding this into the xterm constructor closes the window entirely —
 * there is no moment at which the pane exists on the wrong grid.
 *
 * Rejects anything not a plausible grid rather than partially defaulting: a
 * half-valid entry would boot the pane on a geometry the PTY is not on, which
 * is the failure being fixed.
 */
function resolvePersistedGeometry(
  terminalSizes: Record<string, { cols: number; rows: number }> | undefined,
  terminalId: string
): TerminalGeometry | undefined {
  if (!terminalSizes || typeof terminalSizes !== "object") return undefined;
  const saved = terminalSizes[terminalId];
  return isValidTerminalGeometry(saved) ? saved : undefined;
}

/**
 * The grid a reconnecting pane must be BORN on, live PTY first.
 *
 * `ptyCols`/`ptyRows` come off the node-pty handle at query time, so for a
 * surviving PTY they are the truth by definition and no persisted value can
 * beat them. The persisted map is the fallback for the paths that have no live
 * PTY to ask (respawn after a cold restart) and for a host too old to report
 * the field.
 *
 * That ordering is deliberate belt-and-braces: the persisted map is written by
 * exactly one renderer code path, and when that path was dropped in `30ed7877f`
 * the map silently emptied and #11718's construction-geometry fix became a
 * no-op for four months. The PTY answer cannot rot the same way — nothing has
 * to remember to write it.
 *
 * Both resolvers feed the xterm CONSTRUCTOR and stop there. Restore must not
 * also park the result with `setTargetSize`, as these paths once did: on a cold
 * attach a parked target is not a hint but a REPLACEMENT — the attach rAF runs
 * `applyResize(targetCols, targetRows)` *instead of* `fit(id)`. A pane whose PTY
 * is 240×60, first revealed in a dock that fits 90×30, would be dragged back to
 * 240×60 with no SIGWINCH to follow it (the PTY is already there, so
 * `TerminalProcess.resize` takes its "unchanged" path) — stuck wide in a narrow
 * box, worse than the 80×24 default this replaces. It stayed latent only because
 * the map was empty, so `setTargetSize` was a no-op on every restore; feeding
 * geometry back in is exactly what would have armed it. The seed does the whole
 * job alone — it makes the pane correct while UNATTACHED, which is the bug — and
 * the first attach must stay free to measure the real container. Parking belongs
 * to the warm detach/reattach path that owns it.
 */
function resolveRestoreGeometry(
  live: { ptyCols?: number; ptyRows?: number } | null | undefined,
  terminalSizes: Record<string, { cols: number; rows: number }> | undefined,
  terminalId: string
): TerminalGeometry | undefined {
  const livePtyGrid = { cols: live?.ptyCols, rows: live?.ptyRows };
  if (isValidTerminalGeometry(livePtyGrid)) return livePtyGrid;
  return resolvePersistedGeometry(terminalSizes, terminalId);
}
type RestoreTerminalOrderFn = NonNullable<HydrationOptions["restoreTerminalOrder"]>;

/**
 * Scope key component for the resume-latest election: the directory a pane will
 * launch in, normalized lexically so two spellings of one directory share a slot.
 * Deliberately not realpath'd — the election must stay synchronous and the path
 * may no longer exist, so symlink aliases remain separate scopes.
 */
function resumeLatestScopeCwd(cwd: string): string {
  const normalized = normalizePath(cwd).normalize("NFC");
  // Windows paths are case-insensitive; fold so `C:/Repo` and `c:/repo` collide.
  return /^([A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * Compound key for the resume election. NUL-joined: neither an agent id, a path
 * nor a session id can contain it, so a key can never be forged by an unusual
 * path or a future custom agent id.
 */
function resumeKey(agentId: string, part: string): string {
  return `${agentId}\u0000${part}`;
}

/** Key for one (agent, directory) resume-latest scope. */
function resumeScopeKey(agentId: string, cwd: string): string {
  return resumeKey(agentId, resumeLatestScopeCwd(cwd));
}

/**
 * Which panes must be denied which resume on restore, so no two restored panes
 * end up writing into one agent conversation (#11461).
 */
interface ResumeSuppression {
  /** Panes denied their agent's resume-latest fallback. */
  resumeLatest: Set<string>;
  /** Panes denied the exact `agentSessionId` they carry, because a sibling owns it. */
  sessionId: Set<string>;
}

/**
 * Decide, before any restore task dispatches, which panes may resume what.
 *
 * Two collisions are possible and they need different answers.
 *
 * **The fallback resolves by recency, not identity.** `claude --continue` and
 * `codex resume --last` reopen whichever session in the directory was touched
 * last, and nothing about the command says which one that is. So a pane may use
 * it only when nothing else in its (agent, cwd) scope is already attached to a
 * session there. Two kinds of pane claim a scope: one carrying its own
 * `agentSessionId`, which replays into that exact transcript, and one whose PTY
 * survived, which reconnects to a conversation running right now. `lastActiveAt`
 * cannot rank around a claim — whether the fallback reaches the directory before
 * or after the claimant depends on launch order, not on which pane the user last
 * focused — so every candidate in a claimed scope is suppressed. Among candidates
 * in an UNCLAIMED scope the highest valid `lastActiveAt` takes the scope's single
 * slot, ties keeping the earlier saved entry, so the outcome is deterministic and
 * independent of restore order. A lone candidate in an unclaimed scope is never
 * recorded, so the common single-pane case keeps its behavior by construction.
 *
 * **Two panes can carry the SAME `agentSessionId`.** That is exactly what the bug
 * this guards against produces: two panes reopen one conversation, and the next
 * quit captures that one session id into both snapshots. Replaying both would put
 * two writers on one transcript, so one owner is elected per (agent, session id)
 * by the same ranking, and the losers resume nothing at all. A live PTY attached
 * to that session owns it outright rather than by ranking — it is writing now —
 * so every cold holder of its id loses, alone or not.
 *
 * A suppressed pane launches fresh with `sessionLostOnRestore`, which raises the
 * existing banner and leaves the conversation reachable from session history.
 * That is the trade throughout: one pane missing a resume beats two panes writing
 * into one conversation.
 *
 * Liveness is only as good as what is known synchronously. When the bulk probe
 * timed out there is no prefetched result, and a per-panel reconnect can still
 * find a live PTY after the election has run — that scope is then judged unclaimed
 * and its winner resumes latest into the live session. Deliberately accepted: the
 * election has to complete before any task dispatches (a claim taken after an
 * await races, the hazard #11052 fixed for restart), and treating unknown liveness
 * as a claim would cost every multi-pane scope its resume on a transient probe
 * failure. A failed prefetch degrades to the behavior that shipped with the
 * election rather than to something worse.
 */
function electResumeSuppression(
  panels: readonly (TerminalState | undefined)[],
  context: {
    projectRoot: string;
    backendTerminalMap: Map<string, BackendTerminalInfo>;
    prefetchedReconnectResults?: Record<string, TerminalReconnectResult>;
  }
): ResumeSuppression {
  const winnerByScope = new Map<string, { id: string; lastActiveAt: number }>();
  const candidateIdsByScope = new Map<string, string[]>();
  const claimedScopes = new Set<string>();
  const ownerBySession = new Map<string, { id: string; lastActiveAt: number }>();
  const holderIdsBySession = new Map<string, string[]>();
  const liveOwnedSessions = new Set<string>();

  // A corrupt or missing stamp ranks lowest rather than winning anything, and a
  // tie keeps the entry seen first — the saved array's order, not restore order.
  const recordBest = (
    best: Map<string, { id: string; lastActiveAt: number }>,
    key: string,
    saved: TerminalState
  ): void => {
    const stamp = saved.lastActiveAt ?? 0;
    const lastActiveAt = Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
    const current = best.get(key);
    if (current === undefined || lastActiveAt > current.lastActiveAt) {
      best.set(key, { id: saved.id, lastActiveAt });
    }
  };
  const pushId = (into: Map<string, string[]>, key: string, id: string): void => {
    const existing = into.get(key);
    if (existing === undefined) {
      into.set(key, [id]);
    } else {
      existing.push(id);
    }
  };

  for (const saved of panels) {
    if (saved === undefined) continue;
    if (isSmokeTestTerminalId(saved.id)) continue;

    // A pane with a backend record reconnects rather than respawns; the prefetched
    // probe stands in for the same thing when it reports a live PTY. Either way
    // the live record — not the snapshot — describes what is actually running, and
    // can supply an identity a legacy snapshot lacks.
    const backendTerminal = context.backendTerminalMap.get(saved.id);
    const prefetched = context.prefetchedReconnectResults?.[saved.id];
    const livePrefetch =
      backendTerminal === undefined && prefetched?.exists === true && prefetched.hasPty === true
        ? prefetched
        : undefined;
    const record = backendTerminal ?? livePrefetch;
    const reconnects = record !== undefined;
    // Holds an open conversation only with a live PTY. A `hasPty === false`
    // backend record is either dropped outright by the restore branch below (a
    // dead agent would be a phantom idle panel) or recreated with no session —
    // neither is something the fallback can collide with.
    const holdsLiveSession = reconnects && record.hasPty !== false;

    const kind = record?.kind ?? inferKind(saved);
    if (kind === "assistant" || !panelKindHasPty(kind)) continue;
    const savedAgentId = resolveRespawnAgentId(saved, inferKind(saved));

    if (reconnects) {
      if (!holdsLiveSession) continue;
      // Identity live-first, mirroring `buildArgsForBackendTerminal` — a stale
      // snapshot agent id would otherwise claim a scope this pane is not in, and
      // leave the one it IS in open to a colliding fallback. `saved.cwd` still
      // leads for the directory, because it is already rebased across a worktree
      // move (#11388) while the live record reports the pre-move path, and it is
      // the key every candidate uses; the live cwd fills in for a snapshot that
      // never recorded one.
      const liveAgentId = resolveAgentId(record.launchAgentId, savedAgentId);
      if (liveAgentId === undefined) continue;
      claimedScopes.add(
        resumeScopeKey(liveAgentId, saved.cwd || record.cwd || context.projectRoot)
      );
      // A live PTY owns its session outright: it is attached NOW, so a cold pane
      // holding the same id has nothing to rank against and must not replay it.
      const liveSessionId = record.agentSessionId ?? saved.agentSessionId;
      if (liveSessionId) {
        liveOwnedSessions.add(resumeKey(liveAgentId, liveSessionId));
      }
      continue;
    }

    // Respawning: identity is whatever the respawn itself will resolve.
    const agentId = savedAgentId;
    if (agentId === undefined) continue;
    const scope = resumeScopeKey(agentId, saved.cwd || context.projectRoot);

    if (saved.agentSessionId) {
      // Respawning with an exact id: claims the scope, and contends for sole
      // ownership of the session id itself.
      claimedScopes.add(scope);
      const sessionKey = resumeKey(agentId, saved.agentSessionId);
      pushId(holderIdsBySession, sessionKey, saved.id);
      recordBest(ownerBySession, sessionKey, saved);
      continue;
    }

    // Probe capability through the very builder the respawn branch calls, so
    // eligibility can't drift from behavior (covers custom/plugin agents too).
    if (buildResumeLatestCommand(agentId) === undefined) continue;

    pushId(candidateIdsByScope, scope, saved.id);
    recordBest(winnerByScope, scope, saved);
  }

  const resumeLatest = new Set<string>();
  const sessionId = new Set<string>();
  for (const [scope, ids] of candidateIdsByScope) {
    if (claimedScopes.has(scope)) {
      for (const id of ids) {
        resumeLatest.add(id);
      }
      continue;
    }
    if (ids.length < 2) continue;
    const winnerId = winnerByScope.get(scope)?.id;
    for (const id of ids) {
      if (id !== winnerId) resumeLatest.add(id);
    }
  }
  for (const [sessionKey, ids] of holderIdsBySession) {
    // A live PTY already owns the session, so every cold holder loses — including
    // a lone one, which has no rival among the snapshots but a very real one on
    // the other end of that transcript.
    const liveOwned = liveOwnedSessions.has(sessionKey);
    if (!liveOwned && ids.length < 2) continue;
    const ownerId = liveOwned ? undefined : ownerBySession.get(sessionKey)?.id;
    for (const id of ids) {
      if (id === ownerId) continue;
      // Denied the id it carries — and the fallback with it, since resume-latest
      // in that directory resolves to the very session the owner is replaying.
      sessionId.add(id);
      resumeLatest.add(id);
    }
  }
  return { resumeLatest, sessionId };
}

/**
 * The only agent whose resume-latest fallback can be resolved to a name before
 * launch. Claude's `--continue` and Gemini's `-r latest` have no equivalent
 * read-only index to ask, so they keep the anonymous fallback.
 */
const CODEX_AGENT_ID = "codex";

/**
 * Name the conversation a pane's resume-latest fallback is about to open, so it
 * launches as `codex resume <id>` rather than `codex resume --last` (#12178).
 *
 * `--last` leaves the pane running a session Daintree never learns the id of,
 * which is how the id was lost to begin with: the next teardown scrape becomes
 * the only capture path all over again. Asking Codex's own index which session
 * `--last` resolves to freezes that choice — the same conversation, on the
 * record from the moment the PTY exists.
 *
 * Deliberately narrow. Only a pane that is actually going to run the fallback
 * asks: one already carrying an exact id resumes that instead, and one the
 * election suppressed must not learn what the winner is holding, since the
 * whole point of suppressing it was to keep a second writer off that transcript.
 * Every failure is answered with `undefined`, which is today's behaviour.
 *
 * Which is also why a pane with its own `CODEX_HOME` is skipped outright. The
 * app-server answers from MAIN's profile while the pane spawns against its own
 * (the captured launch env is replayed on respawn, #10922), so a hit there
 * names a session the pane cannot open — and unlike `--last`, which resolves to
 * nothing and falls through, that id would be recorded and replayed on every
 * later restore. It is the one case where naming the session could be worse
 * than leaving it anonymous, so it does not run at all.
 */
async function resolveNamedResumeLatestSession(
  saved: TerminalState,
  kind: PanelKind,
  projectRoot: string,
  allowResumeLatest: boolean
): Promise<string | undefined> {
  if (!allowResumeLatest || saved.agentSessionId) return undefined;
  const agentId = resolveRespawnAgentId(saved, kind);
  if (agentId !== CODEX_AGENT_ID) return undefined;
  // The same capability probe the election and the respawn builder use, so a
  // Codex build whose config drops the fallback can't be queried for one.
  if (buildResumeLatestCommand(agentId) === undefined) return undefined;
  // The launch env is captured and persisted (#10922), so a pane that ever ran
  // under a redirected profile still carries it here — preset envs included.
  if (Object.keys(saved.env ?? {}).some((key) => key.toUpperCase() === "CODEX_HOME")) {
    return undefined;
  }
  const cwd = saved.cwd || projectRoot;
  if (!cwd) return undefined;

  try {
    return (await codexClient.resolveResumeLatestSession({ cwd })) ?? undefined;
  } catch {
    // A restore that can't reach main still has a pane to bring back.
    return undefined;
  }
}

/**
 * Rebase a restore arg's `cwd` from a moved worktree's old root to its new one.
 * No-op when the panel's worktree didn't move or the arg carries no cwd. Used on
 * the surviving-PTY paths, whose cwd comes from the live backend record (the old
 * path) rather than the already-rebased `saved.cwd` (#11388).
 */
function rebaseMovedArgsCwd(
  args: { cwd?: string },
  move: { oldRoot: string; newRoot: string } | undefined
): void {
  if (move === undefined || typeof args.cwd !== "string") return;
  args.cwd = rebaseAbsolutePath(args.cwd, move.oldRoot, move.newRoot);
}

export interface PanelRestoreContext {
  addPanel: AddPanelFn;
  withHydrationBatch: (run: () => Promise<void>) => Promise<void>;
  backendTerminalMap: Map<string, BackendTerminalInfo>;
  /**
   * Bulk-prefetched `terminal:reconnect` probe results keyed by saved panel id
   * (#10390). When a saved id is present here, `reconnectWithTimeout` consumes
   * the prefetched result instead of firing a per-panel IPC inside the
   * serialized spawn queue. Absent ids fall back to the individual probe.
   */
  prefetchedReconnectResults?: Record<string, TerminalReconnectResult>;
  terminalSizes: Record<string, { cols: number; rows: number }>;
  /**
   * The saved selection exactly as persisted — one app-global field shared by
   * every workspace, so in a worktree-less view it names another project's
   * worktree. Read `effectiveActiveWorktreeId` inside the phase, never this:
   * that local folds in {@link workspaceHasWorktreesPromise} once, so no
   * consumer can forget the gate.
   */
  activeWorktreeId: string | null;
  /**
   * Whether the workspace being restored can have git worktrees at all. `false`
   * for a scratch and for a folder opened without git (#11405): no panel there
   * may carry a `worktreeId`, so every restore path normalizes it away rather
   * than re-homing onto — or preserving — an id that belongs to some other
   * workspace. Without this the app-global saved `activeWorktreeId` (and any
   * id a previous run persisted onto a panel) restores panels into a worktree
   * bucket the grid never renders: a live PTY with no visible panel.
   *
   * A promise because only the workspace host can distinguish a folder with no
   * repository from one whose host has not reported yet, and the project row's
   * `gitBacked` column answers NULL for both a real repository and one never
   * classified (#11650). Awaiting costs nothing: every consumer below already
   * sits behind an await of `worktreesPromise`, which resolves from the same
   * fetch. Resolves `true` whenever the answer is unknown, so the boot race
   * keeps its saved state (#11234).
   */
  workspaceHasWorktreesPromise: Promise<boolean>;
  projectRoot: string;
  agentSettings: AgentSettings | undefined;
  clipboardDirectory: string | undefined;
  projectPresetsByAgent: Record<string, AgentPreset[]>;
  worktreesPromise: Promise<WorktreeState[] | null>;
  restoreTerminalOrder?: RestoreTerminalOrderFn;
  safeMode: boolean;
  /**
   * Saved id of the panel the user last had on screen (the head of the
   * per-project MRU list, see #10527). A matching PTY panel jumps to the front
   * of the restore queue ahead of the active-worktree priority tier, so the
   * terminal the user was actually looking at reconnects first instead of
   * waiting behind background batches. `undefined` (no MRU, or a non-terminal
   * MRU head) degrades cleanly to the existing worktree/recency ordering.
   */
  visiblePanelId?: string;
  /**
   * Active resource profile, read once by the caller (#10528). Scales the
   * staggered PTY restore batch size and inter-batch delay via
   * `getRestoreBatchParams` so capable machines restore faster. Defaults to
   * `balanced` when omitted.
   */
  resourceProfile?: ResourceProfile;
  logHydrationInfo: (message: string, context?: Record<string, unknown>) => void;
}

interface PanelRestoreTaskEntry {
  priority: number;
  isPty: boolean;
  execute: () => Promise<void>;
}

export interface PanelRestorePhaseResult {
  restoreTasks: TerminalRestoreTask[];
  /**
   * Sparse map of saved panel id → restored panel id, populated only for
   * panels whose restored id differs from their saved id (e.g. a PTY panel
   * whose reconnect timed out and was respawned with a freshly generated id,
   * see #10440). Consumers that reference saved ids — notably tab-group
   * hydration — must remap through this before validating against live ids,
   * or the membership is silently filtered out and the group destroyed.
   * Empty when every panel restored under its original saved id.
   */
  savedIdToRestoredId: Map<string, string>;
  /**
   * Worktree ids that are confirmed gone but still hold a restored panel whose
   * PTY survived, so each needs a deleted-worktree row to live on (#11911).
   *
   * Only surviving PTYs qualify. A cold respawn boots a NEW process and can
   * pick any live worktree, so it re-homes as before — recording a row for one
   * would resurrect a dead worktree in the sidebar for a session that never
   * ran there. Empty when nothing was stranded, which is the common case.
   */
  ghostedWorktreeIds: Set<string>;
}

/**
 * Restore saved panels (3-phase executor: non-PTY concurrent, priority PTY
 * sequential, background PTY staggered) and append orphan backend terminals.
 *
 * Load-bearing constraints (see #4911, #4945, #5087):
 *  - `backendTerminalMap` is mutated by reference; orphan detection depends
 *    on the surviving entries after the saved-panels loop.
 */
export async function restorePanelsPhase(
  savedPanels: TerminalState[] | undefined,
  ctx: PanelRestoreContext
): Promise<PanelRestorePhaseResult> {
  const {
    addPanel,
    withHydrationBatch,
    backendTerminalMap,
    prefetchedReconnectResults,
    terminalSizes,
    activeWorktreeId,
    workspaceHasWorktreesPromise,
    projectRoot,
    agentSettings,
    clipboardDirectory,
    projectPresetsByAgent,
    worktreesPromise,
    restoreTerminalOrder,
    safeMode,
    visiblePanelId,
    resourceProfile,
    logHydrationInfo,
  } = ctx;

  // Resolved once, up front, and folded straight into the active id every
  // consumer below reads. Per-consumer gating was the alternative and it is a
  // trap: the raw app-global id also feeds the restore-ordering comparison at
  // `isActiveWorktree`, where forgetting the gate silently changes which panels
  // restore first rather than failing loudly. One derived value cannot be
  // read past.
  //
  // Near-free rather than free: the PTY paths (through
  // `resolveRestoredWorktreeId`) and the orphan phase already await
  // `worktreesPromise`, which settles from the same fetch, so the usual restore
  // already carried this wait. What it does add is a wait for a workspace whose
  // panels are ALL non-PTY, which previously recreated without touching the
  // list. Accepted: those panels are cheap to recreate, hydration awaits the
  // same fetch before it finishes regardless, and the alternative is attributing
  // them to another project's worktree.
  const workspaceHasWorktrees = await workspaceHasWorktreesPromise;
  const effectiveActiveWorktreeId = workspaceHasWorktrees ? activeWorktreeId : null;

  const restoreTasks: TerminalRestoreTask[] = [];
  const savedIdToRestoredId = new Map<string, string>();
  // Adaptive staggered-restore params scaled to the machine's resource
  // profile (#10528). One source of truth for both the background and orphan
  // PTY phases below.
  const { batchSize: restoreBatchSize, delayMs: restoreBatchDelayMs } =
    getRestoreBatchParams(resourceProfile);

  // A panel can outlive its worktree (#11232): deleting a worktree leaves its
  // terminals running, and the sidebar row that holds them is in-memory only.
  // So a saved panel may point at a worktree that no longer exists, and both
  // the grid and the dock filter by the active worktree — restoring it as-is
  // would leave a live PTY on screen nowhere, unreachable even to close.
  // Re-home those to the active worktree instead.
  //
  // The id set is derived once and awaited at each use. `worktreesPromise` is
  // already in flight (the orphan phase below awaits the same one), so this
  // costs a microtask per panel once resolved — and unlike sampling a variable
  // the loader may not have filled yet, it cannot silently skip the re-home.
  //
  // An empty list counts as unknown, not as "every worktree is gone" (#11234).
  // Hydration races backend init by design, and `worktree.getAll()` answers []
  // while the window's workspace host is still registering. A successful git
  // enumeration never yields zero — `git worktree list` always reports the main
  // worktree — so [] only ever means "not ready", never a real count. Treating
  // it as authoritative re-homed every panel to the active worktree, and the
  // save loop then persisted that, compounding across restarts.
  // A single memoized correlation context off the in-flight worktree list,
  // shared by the known-id guard and the worktree-move remap below (#11388).
  let worktreeMoveContextPromise: Promise<WorktreeMoveContext | null> | null = null;
  const getWorktreeMoveContext = (): Promise<WorktreeMoveContext | null> => {
    worktreeMoveContextPromise ??= worktreesPromise.then((list) => buildWorktreeMoveContext(list));
    return worktreeMoveContextPromise;
  };
  const getKnownWorktreeIds = async (): Promise<Set<string> | null> => {
    const ctx = await getWorktreeMoveContext();
    return ctx?.knownIds ?? null;
  };
  const resolveRestoredWorktreeId = async (
    worktreeId: string | undefined
  ): Promise<string | undefined> => {
    // A workspace with no worktrees has no valid id to hold, so both halves of
    // the resolution below are wrong there: the re-home target would be another
    // workspace's worktree, and a saved id could only be one a buggy earlier run
    // stamped on. Normalize to none — the worktree-less bucket the grid renders
    // when nothing is selected.
    if (!workspaceHasWorktrees) return undefined;
    const known = await getKnownWorktreeIds();
    // Only re-home onto the active worktree when it is itself live. With a
    // complete, authoritative list (#11387) an activeWorktreeId absent from
    // `known` is a deleted/stale selection, so re-homing onto it would strand
    // the panel on a dead worktree — worse than keeping the saved id, which the
    // boot's own active-selection fallback (index.ts) repairs on this and the
    // next boot. When the list is unknown (null) there is nothing to validate
    // against, so preserve the prior behavior of trusting activeWorktreeId
    // (#11234). This closes PR #11235's own unaddressed follow-up.
    const rehomeTarget =
      effectiveActiveWorktreeId !== null && (known === null || known.has(effectiveActiveWorktreeId))
        ? effectiveActiveWorktreeId
        : undefined;
    // No saved worktree (undefined, or a corrupt empty string): fall to the
    // validated active worktree, or leave it unset rather than guess onto a
    // dead id — never echo back the falsy saved value.
    if (!worktreeId) return rehomeTarget;
    // With no worktree list there is nothing to check the id against, so
    // re-homing would be a guess — keep what was saved.
    if (known === null || known.has(worktreeId)) return worktreeId;
    return rehomeTarget ?? worktreeId;
  };

  // Worktrees proven gone that still hold a surviving PTY (#11911). Reported
  // out of the phase so hydration can give each one a deleted-worktree row.
  const ghostedWorktreeIds = new Set<string>();

  /**
   * Where a panel goes when its PTY outlived the worktree it was launched in.
   *
   * Re-homing is wrong for these: the process is still running in the deleted
   * directory, so moving the panel under a live worktree hides that fact and
   * throws away the only record of where the run came from. Worse, it erases
   * the row `deletedWorktreeCleanup` needs in order to ever retire the
   * survivors — which is how five finished agents can sit in a project for
   * hours, counted as needing input and reachable from nowhere.
   *
   * Keeping the dead id is only safe because a row is recorded for it: without
   * one, `cleanupOrphanedTerminals` treats the panel as orphaned and removes
   * it. The two changes are a pair.
   *
   * Everything else defers to {@link resolveRestoredWorktreeId}, including the
   * unknown-list case — a `null` list is "not ready", never proof of absence
   * (#11235), and ghosting off it would bury every live worktree in the
   * project behind a deleted row.
   */
  const resolveSurvivingPtyWorktreeId = async (
    worktreeId: string | undefined
  ): Promise<string | undefined> => {
    if (!workspaceHasWorktrees || !worktreeId) {
      return resolveRestoredWorktreeId(worktreeId);
    }
    const known = await getKnownWorktreeIds();
    if (known === null || known.has(worktreeId)) {
      return resolveRestoredWorktreeId(worktreeId);
    }
    ghostedWorktreeIds.add(worktreeId);
    return worktreeId;
  };

  if (savedPanels && savedPanels.length > 0) {
    // #11388: a worktree move (`git worktree move` or an external relocation)
    // changes its path-derived id while its stable `.git/worktrees/<name>`
    // handle is preserved. Remap panels whose worktree moved — matched via the
    // gitDir persisted with each panel — to the worktree's new id (rebasing
    // cwd/filePath) BEFORE anything keys off saved.worktreeId, so a moved
    // worktree's panels stay put instead of being treated as deleted. Legacy
    // snapshots without a stored gitDir, and genuinely-deleted worktrees, are
    // left untouched here and handled by resolveRestoredWorktreeId's re-home
    // below. The context is null when the list isn't ready (#11234), so this is
    // a no-op in that race — identical to the pre-#11388 behavior.
    // Skip the correlation — and its worktree-list await — entirely when no
    // saved panel even carries a gitDir handle. Legacy snapshots and
    // browser-only sessions then restore without waiting on worktree
    // enumeration, preserving the pre-#11388 time-to-first-panel.
    const anyMoveCandidate = savedPanels.some(
      (saved) =>
        saved !== undefined && saved.worktreeId !== undefined && saved.worktreeGitDir !== undefined
    );
    const moveContext = anyMoveCandidate ? await getWorktreeMoveContext() : null;
    // old→new root per remapped panel, so the surviving-PTY paths below (which
    // take cwd from the live backend record, not saved.cwd) can rebase it too.
    const movedRootsById = new Map<string, { oldRoot: string; newRoot: string }>();
    const panels = moveContext
      ? savedPanels.map((saved) => {
          if (saved === undefined) return saved;
          const patch = resolveWorktreeMovePatch(saved, moveContext);
          if (!patch) return saved;
          if (saved.worktreeId !== undefined) {
            movedRootsById.set(saved.id, { oldRoot: saved.worktreeId, newRoot: patch.worktreeId });
          }
          return { ...saved, ...patch };
        })
      : savedPanels;

    // Build a single-pass map of worktreeId → highest lastActiveAt across saved
    // panels. The restore predicate uses this to promote each non-active
    // worktree's most-recently-focused panel to the priority sequential tier,
    // matching browser tab-restore behavior. Panels without a worktreeId are
    // excluded — they never participate in per-worktree promotion. Old
    // snapshots (no lastActiveAt stamp) leave a worktree with no entry in the
    // map, which short-circuits promotion below via `!== undefined`.
    // `Number.isFinite` rejects NaN and ±Infinity so corrupted persisted
    // values never seed the map with values that would silently mis-promote.
    const maxLastActiveAtByWorktree = new Map<string, number>();
    for (const saved of panels) {
      if (saved === undefined) continue;
      if (saved.worktreeId === undefined) continue;
      if (!Number.isFinite(saved.lastActiveAt) || (saved.lastActiveAt ?? 0) <= 0) continue;
      const ts = saved.lastActiveAt as number;
      const current = maxLastActiveAtByWorktree.get(saved.worktreeId);
      if (current === undefined || ts > current) {
        maxLastActiveAtByWorktree.set(saved.worktreeId, ts);
      }
    }

    // Decide which panes may resume what, before any restore task runs. At most
    // one pane per (agent, cwd) may use the agent's resume-latest fallback, none
    // may where a sibling already holds a session in that directory, and only one
    // pane may replay a given session id. That fallback resolves to the most
    // recent session in scope (`codex resume --last`, `claude --continue`), so
    // panes sharing a directory would otherwise all reopen the SAME conversation
    // (#11461). Computed synchronously over static saved fields: same-tier tasks
    // run concurrently via Promise.allSettled, so a check-and-claim inside the
    // closures would race (the hazard already fixed once for restart, #11052).
    // Only suppressions are recorded, so a lone candidate in an unclaimed scope —
    // the common single-pane case — is never touched.
    const resumeSuppression = electResumeSuppression(panels, {
      projectRoot: projectRoot || "",
      backendTerminalMap,
      prefetchedReconnectResults,
    });

    const panelTasks: PanelRestoreTaskEntry[] = [];
    const restoredIdsByIndex = new Map<number, string>();

    for (let savedIndex = 0; savedIndex < panels.length; savedIndex++) {
      const saved = panels[savedIndex];
      if (saved === undefined) continue;
      if (isSmokeTestTerminalId(saved.id)) {
        logHydrationInfo(`Skipping smoke test terminal snapshot: ${saved.id}`);
        continue;
      }

      const savedWorktreeId = saved.worktreeId ?? null;
      const isActiveWorktree = savedWorktreeId === effectiveActiveWorktreeId;
      // A non-active worktree's last-focused panel earns priority restore so
      // each worktree's last active panel reactivates quickly on return.
      const isMostRecentInOtherWorktree =
        !isActiveWorktree &&
        saved.worktreeId !== undefined &&
        Number.isFinite(saved.lastActiveAt) &&
        (saved.lastActiveAt ?? 0) > 0 &&
        saved.lastActiveAt === maxLastActiveAtByWorktree.get(saved.worktreeId);

      // Determine isPty at task-build time so we can partition tasks
      // for concurrent (non-PTY) vs staggered (PTY) execution.
      const backendTerminal = backendTerminalMap.get(saved.id);
      let taskIsPty: boolean;
      if (backendTerminal) {
        taskIsPty = true;
      } else {
        const inferredKind = inferKind(saved);
        taskIsPty = inferredKind === "assistant" ? false : panelKindHasPty(inferredKind);
      }

      // The panel the user last had on screen (per-project MRU head, #10527)
      // jumps to a dedicated priority `-1` tier ahead of the active-worktree
      // queue, so the terminal they were actually looking at reconnects first.
      // Gated on `taskIsPty`: the `-1` tier only reorders PTY spawning, so a
      // visible non-PTY panel stays on the concurrent non-PTY path.
      const isVisible = taskIsPty && visiblePanelId !== undefined && saved.id === visiblePanelId;
      const priority = isVisible ? -1 : isActiveWorktree || isMostRecentInOtherWorktree ? 0 : 1;

      const capturedIndex = savedIndex;
      panelTasks.push({
        priority,
        isPty: taskIsPty,
        execute: async () => {
          if (backendTerminal) {
            // Skip dead agent backend terminals — they create phantom idle panels.
            const isDeadAgentBackend =
              backendTerminal.hasPty === false &&
              resolveAgentId(backendTerminal.launchAgentId) !== undefined;
            if (isDeadAgentBackend) {
              logHydrationInfo(`Skipping dead agent backend terminal: ${backendTerminal.id}`);
              backendTerminalMap.delete(saved.id);
              return;
            }

            logHydrationInfo(`Reconnecting to terminal: ${saved.id}`);

            const args = buildArgsForBackendTerminal(backendTerminal, saved, projectRoot || "");
            // Assign to the active worktree when the terminal has no worktree.
            // A named-but-deleted worktree keeps its id instead: the PTY is
            // still alive in it, and it earns a deleted-worktree row (#11911).
            args.worktreeId = await resolveSurvivingPtyWorktreeId(args.worktreeId);
            // A surviving backend PTY reports its live (old-path) cwd; rebase it
            // onto the moved worktree's new root so persisted state and a later
            // respawn don't reference the vanished path (#11388).
            rebaseMovedArgsCwd(args, movedRootsById.get(saved.id));
            // Born on the PTY's own grid, not 80×24 — the reconnected PTY is
            // already there and a hidden-worktree pane never gets fitted
            // (#11718).
            args.initialTerminalGeometry = resolveRestoreGeometry(
              backendTerminal,
              terminalSizes,
              saved.id
            );
            const location = args.location as "grid" | "dock";

            logHydrationInfo(`[HYDRATION] Adding terminal from backend:`, {
              id: backendTerminal.id,
              kind: args.kind,
              launchAgentId: args.launchAgentId,
              location,
              worktreeId: args.worktreeId,
              title: backendTerminal.title,
            });

            const restoredTerminalId = await addPanel(args);
            restoredIdsByIndex.set(capturedIndex, restoredTerminalId);

            if (backendTerminal.activityTier) {
              terminalInstanceService.initializeBackendTier(
                restoredTerminalId,
                backendTerminal.activityTier
              );
            }

            restoreTasks.push({
              terminalId: restoredTerminalId,
              label: saved.id,
              worktreeId: args.worktreeId,
              location,
            });

            backendTerminalMap.delete(saved.id);
          } else {
            const kind = inferKind(saved);

            if (kind === "assistant") {
              logHydrationInfo(`Skipping legacy assistant panel: ${saved.id}`);
              return;
            }

            const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

            if (panelKindHasPty(kind)) {
              const reconnectOutcome = await reconnectWithTimeout(
                saved.id,
                logHydrationInfo,
                prefetchedReconnectResults?.[saved.id]
              );
              // Both statuses mean "do not respawn under the saved id". A timeout
              // may have left the original alive; a conflict definitely did, and
              // it belongs to another workspace (#11652) — reusing the id would
              // re-place that terminal's PTY under this project.
              const mintFreshTerminalId =
                reconnectOutcome.status === "timeout" || reconnectOutcome.status === "conflict";
              const reconnectedTerminal =
                reconnectOutcome.status === "found" ? reconnectOutcome.terminal : null;

              if (reconnectedTerminal) {
                const reconnectArgs = buildArgsForReconnectedFallback(
                  reconnectedTerminal,
                  saved,
                  projectRoot || ""
                );
                // Mirrors the matched-backend path: a legacy saved panel with
                // no worktreeId takes the active worktree, while one naming a
                // deleted worktree keeps that id and earns a row (#11911) —
                // the reconnect just proved this PTY outlived it.
                reconnectArgs.worktreeId = await resolveSurvivingPtyWorktreeId(
                  reconnectArgs.worktreeId
                );
                // Rebase the reconnected PTY's live (old-path) cwd onto the
                // moved worktree's new root, like the matched-backend path.
                rebaseMovedArgsCwd(reconnectArgs, movedRootsById.get(saved.id));
                reconnectArgs.initialTerminalGeometry = resolveRestoreGeometry(
                  reconnectedTerminal,
                  terminalSizes,
                  saved.id
                );
                const restoredTerminalId = await addPanel(reconnectArgs);
                restoredIdsByIndex.set(capturedIndex, restoredTerminalId);

                if (reconnectedTerminal.activityTier) {
                  terminalInstanceService.initializeBackendTier(
                    restoredTerminalId,
                    reconnectedTerminal.activityTier
                  );
                }

                restoreTasks.push({
                  terminalId: restoredTerminalId,
                  label: saved.id,
                  worktreeId: reconnectArgs.worktreeId,
                  location,
                });
              } else {
                // not_found on cold app restart means the PTY process was killed
                // on quit and needs to be respawned.
                const savedAgentId = resolveAgentId(saved.launchAgentId);
                const allowResumeLatest = !resumeSuppression.resumeLatest.has(saved.id);
                // Both are lookups this respawn needs and neither depends on the
                // other, so they overlap rather than queue. The election already
                // ran synchronously over the saved array — nothing awaited here
                // can change who won a resume slot (#11052).
                const baseCommandPromise = savedAgentId
                  ? getCurrentLaunchCliDetail(savedAgentId).then((detail) =>
                      resolveAgentLaunchBaseCommand(
                        getAgentConfig(savedAgentId)?.command ?? savedAgentId,
                        detail
                      )
                    )
                  : Promise.resolve(undefined);
                const [resolvedAgentBaseCommand, resolvedResumeLatestSessionId] = await Promise.all(
                  [
                    baseCommandPromise,
                    resolveNamedResumeLatestSession(
                      saved,
                      kind,
                      projectRoot || "",
                      allowResumeLatest
                    ),
                  ]
                );
                const respawnArgs = buildArgsForRespawn(
                  saved,
                  kind,
                  projectRoot || "",
                  agentSettings,
                  mintFreshTerminalId,
                  clipboardDirectory,
                  projectPresetsByAgent,
                  {
                    resolvedAgentBaseCommand,
                    allowResumeLatest,
                    allowSessionIdResume: !resumeSuppression.sessionId.has(saved.id),
                    resolvedResumeLatestSessionId,
                  }
                );

                // Assign to the active worktree when the saved terminal has no
                // worktreeId, or names a deleted one — which also keeps the
                // respawn's cwd pointing at a directory that still exists.
                respawnArgs.worktreeId = await resolveRestoredWorktreeId(respawnArgs.worktreeId);

                // A respawn boots a NEW PTY, so this also pairs the spawn: the
                // renderer and the PTY start on one grid instead of the pane
                // being seeded wide while the agent paints for 80 columns.
                // Persisted-only by construction — the reconnect probe just
                // told us there is no live PTY left to ask.
                respawnArgs.initialTerminalGeometry = resolvePersistedGeometry(
                  terminalSizes,
                  saved.id
                );

                logHydrationInfo(
                  `Respawning PTY panel: ${saved.id} (${respawnArgs.launchAgentId ? "agent" : "terminal"})`
                );

                logHydrationInfo(`[HYDRATION-RESPAWN] Adding terminal:`, {
                  id: saved.id,
                  kind: respawnArgs.kind,
                  launchAgentId: respawnArgs.launchAgentId,
                  location: respawnArgs.location,
                  savedLocation: saved.location,
                  worktreeId: saved.worktreeId,
                  title: saved.title,
                });

                const restoredTerminalId = await addPanel(respawnArgs);
                restoredIdsByIndex.set(capturedIndex, restoredTerminalId);
              }
            } else {
              // Unregistered kind. Restore when the panel carries a
              // pluginId (current-format plugin panel) OR the kind string
              // contains a dot (legacy pre-#5580 plugin panel whose kind
              // was persisted as "${manifest.name}.${panel.id}" without a
              // pluginId field). Both cases let the renderer surface a
              // PluginMissingPanel placeholder (#5580) instead of silently
              // dropping the panel. Non-dotted unregistered kinds (e.g.
              // the "notes" built-in removed in #5616) are still skipped
              // to avoid "Unknown Panel Type" ghosts.
              if (!getPanelKindConfig(kind) && !saved.pluginId && !kind.includes(".")) {
                logHydrationInfo(
                  `Skipping persisted panel with unregistered kind: ${saved.id} (${kind})`
                );
                return;
              }
              logHydrationInfo(`Recreating ${kind} panel: ${saved.id}`);
              const nonPtyArgs = buildArgsForNonPtyRecreation(
                saved,
                kind,
                projectRoot || "",
                // The builder falls back to this when rescuing a non-dockable
                // dock panel that saved no worktree of its own. The clear below
                // already covers that today; passing the gated id keeps the two
                // from having to agree.
                effectiveActiveWorktreeId
              );
              // Same normalization the PTY paths get from
              // `resolveRestoredWorktreeId`: this builder keeps `saved.worktreeId`
              // untouched, so a worktree-less workspace needs it cleared here too.
              if (!workspaceHasWorktrees) nonPtyArgs.worktreeId = undefined;
              const nonPtyId = await addPanel(nonPtyArgs);
              restoredIdsByIndex.set(capturedIndex, nonPtyId);
            }
          }
        },
      });
    }

    // Execute panel restore tasks: non-PTY panels run concurrently (they only
    // do synchronous Zustand mutations with no IPC), then PTY panels restore
    // with priority ordering and staggered batching to throttle process spawning.
    const nonPtyTasks = panelTasks.filter((t) => !t.isPty);
    const ptyVisibleTasks = panelTasks.filter((t) => t.isPty && t.priority === -1);
    const ptyPriorityTasks = panelTasks.filter((t) => t.isPty && t.priority === 0);
    const ptyBackgroundTasks = panelTasks.filter((t) => t.isPty && t.priority === 1);

    // Restore all non-PTY panels concurrently (browser, dev-preview).
    // These only perform synchronous store mutations, so no throttling is needed.
    // The begin/flush wrapper collapses the N addPanel mutations into one store
    // commit, reducing this phase from N re-renders to 1.
    if (nonPtyTasks.length > 0) {
      logHydrationInfo(`Restoring ${nonPtyTasks.length} non-PTY panel(s) concurrently`);
      await withHydrationBatch(async () => {
        await Promise.allSettled(
          nonPtyTasks.map(async (task) => {
            try {
              await task.execute();
            } catch (error) {
              logWarn("Failed to restore non-PTY panel", { error });
            }
          })
        );
      });
    }

    // Restore the visible panel first (#10527). The terminal the user last had
    // on screen reconnects ahead of the active-worktree tier so it is
    // interactive the instant the grid paints, instead of waiting behind
    // background batches. At most one task here (a single MRU head), but
    // filtered like the others to stay robust; batched to match the rest.
    if (ptyVisibleTasks.length > 0) {
      await withHydrationBatch(async () => {
        for (const task of ptyVisibleTasks) {
          try {
            await task.execute();
          } catch (error) {
            logWarn("Failed to restore visible panel", { error });
          }
        }
      });
    }

    // Restore priority PTY panels in parallel (active worktree + each other
    // worktree's last-focused panel, for instant interactivity). The main
    // process serializes the spawn IPC anyway, so firing them concurrently
    // only removes the renderer-side sequential `await` latency ((N-1)×RTT)
    // without adding OS-level spawn pressure (#10528). The single
    // `withHydrationBatch` wrapper collapses all N addPanel mutations into one
    // store commit; a rejection in one task never blocks the others.
    if (ptyPriorityTasks.length > 0) {
      await withHydrationBatch(async () => {
        await Promise.allSettled(
          ptyPriorityTasks.map(async (task) => {
            try {
              await task.execute();
            } catch (error) {
              logWarn("Failed to restore priority panel", { error });
            }
          })
        );
      });
    }

    // Restore background PTY panels in staggered batches. Each batch is its own
    // hydration batch: we still want staggered spawning to throttle PTY pressure,
    // but within a batch the N panels commit in one render rather than N.
    // N background panels -> ceil(N / restoreBatchSize) renders instead of N.
    if (ptyBackgroundTasks.length > 0) {
      logHydrationInfo(
        `Staggering ${ptyBackgroundTasks.length} background PTY panel(s) in batches of ${restoreBatchSize}`
      );
      for (let i = 0; i < ptyBackgroundTasks.length; i += restoreBatchSize) {
        const batch = ptyBackgroundTasks.slice(i, i + restoreBatchSize);
        await withHydrationBatch(async () => {
          await Promise.allSettled(
            batch.map(async (task) => {
              try {
                await task.execute();
              } catch (error) {
                logWarn("Failed to restore background panel", { error });
              }
            })
          );
        });
        if (i + restoreBatchSize < ptyBackgroundTasks.length) {
          await delay(restoreBatchDelayMs);
        }
      }
    }

    // Restore saved panel order. The three-phase restore (non-PTY first, then
    // priority PTY, then background PTY) means panels end up in execution order
    // rather than saved order. Sort them back to match the saved state.
    if (restoreTerminalOrder && restoredIdsByIndex.size > 0) {
      const orderedIds = Array.from(restoredIdsByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, id]) => id);
      restoreTerminalOrder(orderedIds);
    }

    // Build the saved→restored id remap (#10440). Only panels whose restored
    // id diverged from the saved id need an entry; identity mappings (the
    // common clean-reconnect case) are skipped so downstream consumers can
    // fast-path on an empty map.
    for (const [index, restoredId] of restoredIdsByIndex.entries()) {
      const savedId = savedPanels[index]?.id;
      if (savedId !== undefined && savedId !== restoredId) {
        savedIdToRestoredId.set(savedId, restoredId);
      }
    }
  }

  // Restore any orphaned backend terminals not in saved state (append at end).
  // When no panels were saved (brand-new project), skip the startup "default"
  // terminal — it belongs to the previous project's bootstrap sequence, not this one.
  // In safe mode, skip orphan reconnection entirely to ensure a clean slate.
  const hasSavedPanels = Boolean(savedPanels && savedPanels.length > 0);
  const orphanedTerminals = safeMode
    ? []
    : Array.from(backendTerminalMap.values()).filter(
        (t) => !(t.id.startsWith("default-") && !hasSavedPanels) && t.hasPty !== false
      );
  if (orphanedTerminals.length > 0) {
    logHydrationInfo(
      `${orphanedTerminals.length} orphaned terminal(s) not in saved order, appending at end`
    );

    // Resolve worktreeId for orphaned terminals by matching the terminal's
    // cwd against known worktree paths (longest-prefix wins). worktreesPromise
    // is awaited once; if it resolves to null or hasn't loaded, orphans fall
    // back to activeWorktreeId so they still appear in the grid.
    const worktreesForInfer = await worktreesPromise;

    const restoreOrphan = async (terminal: (typeof orphanedTerminals)[number]): Promise<void> => {
      try {
        logHydrationInfo(`Reconnecting to orphaned terminal: ${terminal.id}`);

        const orphanArgs = buildArgsForOrphanedTerminal(terminal, projectRoot || "");
        // Orphaned backend terminals no longer carry worktreeId — infer it
        // from cwd against the loaded worktrees, then fall back to the
        // active worktree so the panel still appears in the grid filter.
        // Both are inferred attribution: the lifecycle ledger records the
        // provenance so cwd inference can never overwrite a worktree the
        // user explicitly chose later in this panel's life.
        // Neither attribution applies in a worktree-less workspace: there is no
        // worktree for the cwd to match, and the active id would belong to
        // another workspace (see `workspaceHasWorktrees`).
        const inferred = workspaceHasWorktrees
          ? inferWorktreeIdFromCwd(terminal.cwd, worktreesForInfer ?? undefined)
          : undefined;
        if (inferred) {
          orphanArgs.worktreeId = inferred;
          orphanArgs.worktreeIdSource = "inferred";
        } else if (effectiveActiveWorktreeId) {
          orphanArgs.worktreeId = effectiveActiveWorktreeId;
          orphanArgs.worktreeIdSource = "inferred";
        }
        // Same prewarm-before-target ordering as the saved-panel paths, and an
        // orphan can land in a worktree that is not the selected one. An orphan
        // is by definition a LIVE backend terminal, so its PTY grid is available
        // and authoritative.
        orphanArgs.initialTerminalGeometry = resolveRestoreGeometry(
          terminal,
          terminalSizes,
          terminal.id
        );
        const restoredTerminalId = await addPanel(orphanArgs);

        if (terminal.activityTier) {
          terminalInstanceService.initializeBackendTier(restoredTerminalId, terminal.activityTier);
        }

        restoreTasks.push({
          terminalId: restoredTerminalId,
          label: terminal.id,
          worktreeId: orphanArgs.worktreeId,
          location: "grid",
        });
      } catch (error) {
        logWarn(`Failed to reconnect to orphaned terminal ${terminal.id}`, { error });
      }
    };

    // Same staggered-batch pattern as the background PTY phase: one hydration
    // batch per spawn batch so orphan restores commit once per batch rather
    // than once per terminal.
    for (let i = 0; i < orphanedTerminals.length; i += restoreBatchSize) {
      const batch = orphanedTerminals.slice(i, i + restoreBatchSize);
      await withHydrationBatch(async () => {
        await Promise.allSettled(batch.map(restoreOrphan));
      });
      if (i + restoreBatchSize < orphanedTerminals.length) {
        await delay(restoreBatchDelayMs);
      }
    }
  }

  return { restoreTasks, savedIdToRestoredId, ghostedWorktreeIds };
}
