// eager-import-allow: reads help-session state via store.get synchronously
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { store } from "../store.js";
import { getHelpFolderPath } from "./HelpService.js";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { probeMcpServer, probeMcpSseServer } from "./mcp-server/readinessProbe.js";
import { getAssistantWiredAgentIds } from "../../shared/config/agentRegistry.js";
import type { HelpAssistantTier } from "../../shared/types/ipc/maps.js";
import type { ActionContext } from "../../shared/types/actions.js";
import type { PtyClient } from "./PtyClient.js";
import { ASSISTANT_SCRATCH_ENV_VAR, getScratchDirForSession } from "./AssistantScratchService.js";
import { syncAssistantContent } from "./AssistantContentMirror.js";
import type {
  PendingHelpHibernation,
  PendingHelpHibernationStore,
} from "./PendingHelpHibernationStore.js";
import {
  ASSISTANT_LANE_CONFIG_DIR,
  ASSISTANT_SLOTS,
  assistantLaneMcpConfigName,
  assistantSessionDirName,
  assistantSlotKey,
  isAssistantSessionDirName,
  isValidAssistantSlot,
  sessionIdFromLaneMcpConfigName,
} from "../../shared/config/assistantSlots.js";

// Narrow type so the test suite (and any future caller) can satisfy this
// dependency without instantiating a full PtyClient. `kill` is the original
// displacement path (fire-and-forget); `gracefulKill` is used by the
// eviction-revoke path to capture the agent's resume session ID before
// killing — that's what powers the renderer's `[[hibernateSessions]]` resume
// the next time the user reopens the project.
type PtyKillClient = Pick<PtyClient, "kill" | "gracefulKill">;

const SESSIONS_DIR_NAME = "help-sessions";
const META_FILE_NAME = "meta.json";
const SESSION_TOKEN_BYTES = 32;
// SHA-256 → 16-char hex slice. Stable per absolute project path; collisions
// in 64 bits of project-path-derived entropy are not a real concern for a
// machine-local set of projects.
const PROJECT_HASH_LEN = 16;
// Copilot substitutes this from PTY env at spawn rather than baking a literal
// bearer into `.mcp.json`, so the stale-entry sweep has to recognize it.
const COPILOT_BEARER_PLACEHOLDER = "$DAINTREE_MCP_TOKEN";
// Stamp file written into the per-project session dir after a successful
// `fs.cp` of the bundled help template. Lives inside the session dir (not
// inside `helpFolder`), so it's never part of the source being hashed and
// gets reaped along with the dir. Filename starts with `.` so it's hidden
// from casual `ls` and unlikely to collide with anything the help template
// might grow to ship.
const TEMPLATE_HASH_FILE = ".template-hash";

// `action` is the deliberate default tier for assistant sessions, including the
// headless Daintree Assistant CLI (#10640): it covers orchestration, terminal
// driving, branch setup, recipes, reads, and — since #12116 — the confirm-gated
// worktree cleanup that follows them, while leaving git and forge writes above
// the floor. What the promotion rests on is that admission and approval are
// separate gates: a `danger: "confirm"` tool admitted here still goes to the
// renderer for a native ConfirmDialog, so the tier hands the agent nothing it
// could not have asked a human for. (An explicit native automation grant does
// pre-authorise that modal, but issuing one is itself a user decision and was
// never tier-gated.) What the tier permits vs. withholds is locked by the
// policy guard in `mcp-server/__tests__/tierAuth.test.ts`; this constant
// selects it as the provisioning default.
const DEFAULT_TIER: HelpAssistantTier = "action";
const DEFAULT_DAINTREE_CONTROL = true;
const DEFAULT_DOC_SEARCH = true;
const DEFAULT_BYPASS_PERMISSIONS = false;
const DEFAULT_DEBUG_LOGGING = false;

// Belt-and-suspenders bound for orphaned provisional bearers (#10698). A
// session record is minted at provision time, then bound to a PTY terminal once
// the agent spawns. If the launch hangs past the renderer watchdog AND the
// watchdog's revoke somehow didn't run (renderer crash, view torn down
// mid-launch), the record can outlive the launch with a live token but no bound
// terminal. The periodic sweep revokes any such unbound record older than this
// ceiling. Bound sessions are never swept regardless of age — they're healthy
// long-lived assistants. 30 min mirrors the MCP idle-reaper horizon; an orphan
// is reaped between 30 and ~35 min old (this floor plus up to one sweep
// interval). The 90s launch watchdog is the primary fix — this is the
// renderer-crash backstop, so the coarse timing is intentional.
const ORPHAN_SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const ORPHAN_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function isHelpAssistantTier(value: unknown): value is HelpAssistantTier {
  return value === "workbench" || value === "action" || value === "system";
}

interface ProvisionInput {
  projectId: string;
  projectPath: string;
  agentId: string;
  windowId: number;
  projectViewWebContentsId: number;
  /**
   * Which assistant lane this session occupies (#12108). Optional on the way
   * in so pre-slot callers and fixtures still mean slot 0, but an explicitly
   * supplied out-of-range slot is rejected by `validateProvisionInput` rather
   * than clamped — silently landing in a neighbouring lane would displace a
   * session the caller never named.
   */
  slot?: number;
  /**
   * Snapshot of the renderer's `ActionContext` captured synchronously when
   * the user launched the assistant, before any `await`. Bound to the MCP
   * session at handshake and replayed as `contextOverride` on every tool
   * dispatch so a focus shift during the model's turn can't retarget the
   * action onto the wrong worktree/terminal (#8317). Optional — older
   * renderers / test fixtures omit it and fall back to live context.
   */
  actionContext?: ActionContext;
}

export interface ProvisionResult {
  sessionId: string;
  sessionPath: string;
  token: string;
  tier: HelpAssistantTier;
  mcpUrl: string | null;
  windowId: number;
}

interface HelpSessionRecord {
  sessionId: string;
  token: string;
  windowId: number;
  projectViewWebContentsId: number;
  projectId: string;
  /**
   * The assistant lane this record owns (#12108). Required — every internal
   * lookup that used to key on `projectId` alone now keys on
   * `assistantSlotKey(projectId, slot)`, and a record whose lane were unknown
   * could neither be displaced by its successor nor protected from its
   * siblings.
   */
  slot: number;
  projectPath: string;
  sessionPath: string;
  agentId: string;
  tier: HelpAssistantTier;
  /**
   * Snapshot at provision time of the user's CLI bypass preference. Consumed
   * by `lifecycle.ts` to decide whether to append `--dangerously-skip-permissions`
   * to the spawn command. Decoupled from `tier` so a `tier="action"` session
   * can still bypass Claude's confirmation gate (and vice versa).
   */
  bypassPermissions: boolean;
  /**
   * Snapshot at provision time of the user's debug-logging preference. Consumed
   * by `lifecycle.ts` to decide whether to inject `DAINTREE_ASSISTANT_DEBUG_LOG=1`
   * into the spawn env. Only the `daintree-assistant` backend reads that var.
   */
  debugLogging: boolean;
  createdAt: number;
  revoked: boolean;
  /**
   * Renderer `ActionContext` snapshot bound at provision time. Returned by
   * `getActionContextForToken` so the MCP handshake can pin every tool call
   * to the worktree/terminal the user had focused when they launched the
   * assistant (#8317). Undefined when the renderer didn't supply one.
   */
  actionContext?: ActionContext;
  /** Computed at provision for codex sessions; consumed by lifecycle.ts. */
  codexLaunchArgs?: string[];
  /** Computed at provision for copilot sessions; consumed by lifecycle.ts. */
  copilotLaunchArgs?: string[];
  /**
   * Claude sessions only: the per-lane `--mcp-config` file holding this lane's
   * literal bearer. Lives inside the shared session directory under
   * `ASSISTANT_LANE_CONFIG_DIR`, is removed on revoke, and is what lets three
   * lanes share one cwd without sharing one `.mcp.json`.
   */
  laneMcpConfigPath?: string;
  /** Computed at provision for claude sessions; consumed by lifecycle.ts. */
  claudeLaunchArgs?: string[];
  /**
   * Per-session scratch directory under
   * `userData/assistant-scratch/<instanceId>/<sessionId>/`. Cleared on every
   * app start; injected into the PTY spawn env as `DAINTREE_ASSISTANT_SCRATCH_DIR`
   * and mentioned in the per-agent CLAUDE.md / AGENTS.md addendum.
   */
  scratchPath: string;
}

interface SessionMeta {
  projectId: string;
  projectPath: string;
  lastUsedAt: number;
}

interface BundledClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  defaultMode?: string;
  enableAllProjectMcpServers?: boolean;
  [key: string]: unknown;
}

function deepClonePlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectPathHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, PROJECT_HASH_LEN);
}

/**
 * Deterministic SHA-256 over the bundled help template. The hash is content-
 * only (no mtimes, no inode metadata): walk the tree, sort by full relative
 * path normalized to forward slashes, and feed `<rel>\0<contents>` for each
 * file into one running hash. Skips symlinks and empty dirs by virtue of
 * the `isFile()` filter. The null-byte separator stops `"a"+"bc"` colliding
 * with `"ab"+"c"` across path/content boundaries.
 *
 * `Dirent.parentPath` is the absolute dir of each entry — we use it (not the
 * deprecated `.path`, which is removed in Node 24) and rejoin with `name`
 * to derive the absolute path. Sorting by the full relative path string —
 * not just `name` — ensures files with identical basenames in different
 * subdirs hash deterministically across runs.
 */
async function computeTemplateHash(helpFolder: string): Promise<string> {
  const entries = await fs.readdir(helpFolder, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      absolute: path.join(entry.parentPath, entry.name),
      relative: path
        .relative(helpFolder, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    }))
    .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(await fs.readFile(file.absolute));
  }
  return hash.digest("hex");
}

/**
 * Reads the on-disk template hash stamp. Returns null when the stamp is
 * absent (first provision, or the user manually removed the dir contents).
 * Non-ENOENT failures (e.g. EACCES on a corrupt stamp) are warn-and-treat-
 * as-missing — the stamp is a copy-skip optimization, not a security gate,
 * and the next launch shouldn't be blocked because this file is unreadable.
 */
async function readTemplateHashStamp(sessionPath: string): Promise<string | null> {
  const stampPath = path.join(sessionPath, TEMPLATE_HASH_FILE);
  try {
    const raw = await fs.readFile(stampPath, "utf-8");
    return raw.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.warn(
      "[HelpSessionService] Failed to read template hash stamp; treating as missing:",
      stampPath,
      err
    );
    return null;
  }
}

/**
 * Typed provision failure surfaced through the IPC layer with a structured
 * code so the renderer can match-and-display without parsing prose. Used when
 * Daintree control is enabled but the in-process assistant services can't be
 * made ready, which would otherwise launch the assistant with broken wiring.
 *
 * The two failure modes are distinguished so the renderer can show distinct
 * recovery copy: `MCP_SERVER_NOT_STARTED` means the in-process server never
 * came up, while `MCP_PROBE_FAILED` means it bound a port and minted a session
 * but the readiness probe didn't respond in time. `MCP_NOT_READY` is retained
 * as a legacy alias the renderer still classifies (falling back to the
 * probe-failed shape) so older serialized errors keep displaying.
 *
 * `USER_CONTENT_SYNC_FAILED` means the user commands/skills mirror could not
 * reconcile the session dir — either a source folder was unreadable (desired
 * state unprovable) or a stale managed skill could not be removed. Launching
 * anyway would run the session with outdated or unowned skill instructions,
 * so provisioning fails closed and the renderer shows a retryable error.
 */
export type HelpSessionErrorCode =
  | "MCP_NOT_READY"
  | "MCP_SERVER_NOT_STARTED"
  | "MCP_PROBE_FAILED"
  | "USER_CONTENT_SYNC_FAILED"
  | "MIXED_AGENT_LANES";

export class HelpSessionError extends Error {
  readonly code: HelpSessionErrorCode;
  constructor(code: HelpSessionErrorCode, message: string) {
    super(message);
    this.name = "HelpSessionError";
    this.code = code;
  }
}

export class HelpSessionService {
  private readonly sessionsByToken = new Map<string, HelpSessionRecord>();
  private readonly sessionsById = new Map<string, HelpSessionRecord>();
  // Per-project-path serialization — concurrent provisions for the same
  // project (e.g. two windows opening the assistant simultaneously) would
  // otherwise race the .mcp.json overwrite, producing a Claude instance
  // authenticating with the wrong session record.
  private readonly provisionLocks = new Map<string, Promise<void>>();
  // Single-backend invariant (#7509), scoped to a lane since #12108: at most
  // one assistant PTY per (project, slot) at any given time. The renderer's
  // cooperative cleanup paths (removePanel, gracefulKill on hibernate,
  // visibilitychange tearDown) are fire-and-forget and can drop the kill IPC,
  // leaving an orphan PTY that keeps dispatching MCP tool calls under a
  // still-valid bearer. These maps let the main process displace prior
  // backends regardless of what the renderer did.
  //
  // Narrowing the key from project to lane does not weaken the property: the
  // decisive step is removing the record from `sessionsByToken` BEFORE the
  // fire-and-forget kill, so a lost kill IPC still leaves an orphan whose
  // bearer no longer validates. What changes is only which sessions count as
  // priors — a sibling in another lane is a live session the user asked for,
  // not an orphan.
  private readonly activeHelpTerminalBySlotKey = new Map<string, string>();
  private readonly terminalBySessionId = new Map<string, string>();
  private mcpRegistry: WindowRegistry | null = null;
  private ptyClient: PtyKillClient | null = null;
  private pendingHibernationStore: PendingHelpHibernationStore | null = null;
  // #9639: tracks the in-flight capture owner per lane (slot key →
  // sessionId) while `gracefulKill` is outstanding. A placeholder
  // pending-hibernation entry is written synchronously before the kill so a
  // racing project switch-back resumes instead of fresh-launching; this map
  // decides who is allowed to overwrite/clear that placeholder afterwards so a
  // mid-kill displacement can't let a stale resume ID shadow the new session.
  // In-memory only — no in-flight capture is meaningful across an app restart.
  private readonly pendingCapturesBySlotKey = new Map<string, string>();
  // #11477: the entry most recently handed out by `takePendingHibernation`, per
  // project, so a taker whose launch aborts can put it back verbatim via
  // `restorePendingHibernation` — original `capturedAt` intact, `panelWasOpen`
  // stripped. Holding it here rather than round-tripping it through the
  // renderer means the put-back carries no entry data at all, so there is no
  // way to write a fabricated agentId/cwd into the persistent store.
  //
  // `claimId` + `ownerWebContentsId` make the put-back a compare-and-swap on
  // the specific take rather than on the project: only the view that took this
  // entry, quoting the id it was handed, can put it back. Without that pair a
  // release is merely project-scoped, so a duplicate or late release could
  // restore a stash a LATER take had already replaced, and a stash left behind
  // by a successfully-resumed launch would stay restorable indefinitely.
  //
  // In-memory only, one deep per project: a take that is never answered is
  // dropped, and a later take supersedes the stash outright.
  private readonly lastTakenBySlotKey = new Map<
    string,
    { entry: PendingHelpHibernation; claimId: string; ownerWebContentsId: number | null }
  >();
  // #10815: per-project assistant-panel visibility, reported by the renderer
  // whenever its `isOpen` changes. Read at capture time to stamp
  // `panelWasOpen` onto the eviction hibernation entry so cold switch-back can
  // auto-reopen + auto-resume only when the panel was actually open. In-memory
  // only — a panel-open state has no meaning across an app restart.
  // Keyed by projectId (not webContents/window) on purpose: the
  // pending-hibernation store and its resume token are themselves projectId-
  // scoped (one entry per project regardless of how many windows view it), so
  // "was the assistant open for this project" is the matching granularity. In a
  // multi-window/same-project setup the last reporter wins, which at worst
  // reopens a panel both windows would resume into the same shared session.
  private readonly panelOpenByProjectId = new Map<string, boolean>();
  /**
   * Which workspaces have the assistant actually ON SCREEN, as opposed to
   * merely open. Focus mode slides the panel off-canvas without touching
   * `isOpen` (`AppLayout`'s `showAssistant`), so the two answers differ and the
   * tallies want this one.
   */
  private readonly panelVisibleByProjectId = new Map<string, boolean>();
  private onMcpSessionRevokedFn: ((token: string) => void) | null = null;
  private disposed = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  setMcpRegistry(registry: WindowRegistry): void {
    this.mcpRegistry = registry;
  }

  setPtyClient(client: PtyKillClient | null): void {
    this.ptyClient = client;
  }

  /**
   * Wire the eager MCP-session teardown invoked on revoke (#9151). Given the
   * revoked help session's raw bearer token, the callback drops the live MCP
   * session(s) it owns so tier/grants/pin don't linger until the idle reaper.
   * Idempotent — re-set on every `ensureMcpServerReady`.
   */
  setOnMcpSessionRevoked(cb: ((token: string) => void) | null): void {
    this.onMcpSessionRevokedFn = cb;
  }

  setPendingHibernationStore(store: PendingHelpHibernationStore | null): void {
    this.pendingHibernationStore = store;
  }

  /**
   * #10815: record whether the assistant panel is currently open for a
   * project, reported by the renderer on every `isOpen` change. Consulted at
   * eviction-capture time to decide whether the cold switch-back should
   * auto-reopen and auto-resume. In-memory only.
   *
   * `isVisible` is the same panel's on-screen state, which is a different
   * question: focus mode parks the panel off-canvas with `isOpen` left true so
   * exiting focus mode can bring it back. Kept as a second map rather than
   * folded into the first because the cold-resume decision genuinely wants the
   * open one — a panel the user parked for a gesture is still a panel they
   * expect to find when they come back. Defaults to `isOpen` so a caller that
   * doesn't distinguish them (and every stored report from before this split)
   * behaves as it always did.
   *
   * Returns whether the VISIBLE answer moved, so the caller can push the
   * tallies that read it instead of waiting out a poll interval.
   */
  reportPanelOpen(projectId: string, isOpen: boolean, isVisible: boolean = isOpen): boolean {
    if (!projectId) return false;
    if (isOpen) {
      this.panelOpenByProjectId.set(projectId, true);
    } else {
      this.panelOpenByProjectId.delete(projectId);
    }

    const was = this.panelVisibleByProjectId.get(projectId) === true;
    if (isVisible) {
      this.panelVisibleByProjectId.set(projectId, true);
    } else {
      this.panelVisibleByProjectId.delete(projectId);
    }
    return was !== isVisible;
  }

  /**
   * Whether this workspace's assistant panel is on screen, as last reported by
   * its renderer.
   *
   * Read by the project tallies to decide whether the assistant has anything to
   * say about a row. A hidden panel keeps its PTY until the idle-hibernate
   * timer fires, and a session nobody can see is not a state anyone can act on
   * — reporting it left projects claiming "Assistant waiting" for a panel the
   * user had deliberately put away.
   *
   * Unreported reads as hidden, which is the conservative answer here: a
   * project whose view has never mounted the panel this session has no
   * assistant on screen either. Every way this can go stale — a view evicted
   * without a parting report, two windows on one project where the last
   * reporter wins — leaves a `true` behind rather than a `false`, so the
   * failure mode is a row that keeps reporting an assistant, which is where
   * this surface stood before the gate existed.
   */
  isPanelVisible(projectId: string): boolean {
    if (!projectId) return false;
    return this.panelVisibleByProjectId.get(projectId) === true;
  }

  validateToken(token: string): HelpAssistantTier | false {
    if (!token) return false;
    const record = this.sessionsByToken.get(token);
    if (!record) return false;
    if (record.revoked) return false;
    return record.tier;
  }

  /**
   * Binds a freshly spawned PTY terminal id to its help-session token. Called
   * from the lifecycle spawn handler after `validateToken` confirms the
   * launch is a help session, so the main process owns the terminalId↔session
   * association without depending on a renderer-issued `help.markTerminal`
   * round-trip. Returns false for unknown or revoked tokens — the spawn
   * handler treats that as a hard failure (the token was revoked between
   * provision and spawn — almost certainly a stale resume against a session
   * that was already displaced).
   *
   * If a different terminal was already bound for the same project, kills it
   * here too. This is the second line of defense behind the displacement in
   * `doProvision`: covers the renderer race where a new spawn arrives before
   * a prior provision's terminal binding was recorded.
   */
  markTerminalForToken(token: string, terminalId: string): boolean {
    if (!token || !terminalId) return false;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return false;

    // The lane comes from the authenticated record, never from the caller — a
    // renderer-supplied slot here could evict a sibling lane's PTY using a
    // bearer that was only ever issued for its own.
    const slotKey = assistantSlotKey(record.projectId, record.slot);
    const existingTerminal = this.activeHelpTerminalBySlotKey.get(slotKey);
    if (existingTerminal && existingTerminal !== terminalId) {
      this.killTerminal(existingTerminal, "help-session-displaced");
      this.removeTerminalFromMaps(existingTerminal);
    }

    this.activeHelpTerminalBySlotKey.set(slotKey, terminalId);
    this.terminalBySessionId.set(record.sessionId, terminalId);
    return true;
  }

  /**
   * Drops a terminal id from the help-session indexes without revoking the
   * session record. Used by the spawn handler's catch block when the PTY
   * spawn never landed — the session is still valid (caller may retry),
   * but this terminalId is dead.
   */
  unbindTerminal(terminalId: string): void {
    if (!terminalId) return;
    this.removeTerminalFromMaps(terminalId);
  }

  /**
   * The lane `terminalId` currently serves, or null when it serves none.
   *
   * Null is the meaningful answer for a displaced backend whose kill has not
   * landed yet: `displacePriorSessions` drops the record synchronously, so a
   * corpse resolves to no lane while its live successor resolves to one. That
   * is what lets project status rank concurrent assistants by attention
   * without a mid-kill corpse outranking them (see `projectAgentCounts`).
   */
  getSlotForTerminal(terminalId: string): number | null {
    if (!terminalId) return null;
    for (const [sessionId, boundId] of this.terminalBySessionId.entries()) {
      if (boundId !== terminalId) continue;
      const record = this.sessionsById.get(sessionId);
      if (record && !record.revoked) return record.slot;
    }
    return null;
  }

  /**
   * Reports whether `terminalId` is currently the active help-session PTY
   * for any lane. The PtyEventRouter's `terminal-pid` callback uses this
   * to filter help-session terminals into the Windows Job Object so the OS
   * reaps the agent tree on a hard Daintree crash (#7526). Returns false
   * once the binding is dropped (revoke / displace / unbind) — a late PID
   * arrival for a torn-down session is treated as a non-help terminal.
   */
  isHelpTerminal(terminalId: string): boolean {
    if (!terminalId) return false;
    for (const boundId of this.activeHelpTerminalBySlotKey.values()) {
      if (boundId === terminalId) return true;
    }
    return false;
  }

  /**
   * Every assistant backend bound to `projectId` — each one's PTY, the
   * WebContents the session pinned at provision time, and its lane — in slot
   * order. Empty when the project has no unrevoked help session with a spawned
   * terminal.
   *
   * Returns all lanes rather than a single winner (#12108) because callers use
   * this as a floor: with concurrent sessions a lane whose PTY has exited must
   * not mask a live sibling, or reclaiming the project would kill the sibling
   * — the #11807 regression in a new shape.
   *
   * ProjectViewManager's eviction policy reads this synchronously to keep the
   * view hosting a running assistant out of the routine LRU candidate pool
   * (#11157): destroying that view fires `onViewEvicted` →
   * `revokeByWebContentsId` → `gracefulKill`, tearing down the whole PTY
   * process tree, so every sub-agent and background shell the assistant spawned
   * dies with it. A grid terminal has no such coupling (its PTY lives in the
   * pty-host and reconnects on switch-back), which is why the floor is scoped
   * to help sessions rather than to `hasActiveAgent()` at large.
   *
   * `webContentsId` is the same pin `revokeByWebContentsId` matches on, so the
   * caller can protect exactly the view whose eviction would do the killing —
   * a second window's cached view of the same project kills nothing and stays
   * an ordinary LRU candidate.
   *
   * NOT a liveness signal on its own: the binding is dropped on revoke,
   * displacement, and unbind, but nothing drops it when the PTY exits under its
   * own steam (the orphan sweep deliberately skips bound sessions). Callers
   * must cross-check `terminalId` against a registry that tracks PTY exits, or
   * an assistant the user quit would pin its view forever.
   */
  getAssistantBackends(
    projectId: string
  ): Array<{ terminalId: string; webContentsId: number; slot: number }> {
    if (!projectId) return [];
    const backends: Array<{ terminalId: string; webContentsId: number; slot: number }> = [];
    for (const slot of ASSISTANT_SLOTS) {
      const terminalId = this.activeHelpTerminalBySlotKey.get(assistantSlotKey(projectId, slot));
      if (!terminalId) continue;
      for (const record of this.sessionsById.values()) {
        if (record.revoked) continue;
        // Match on the project and lane too, not just the terminal id: nothing
        // enforces terminal-id uniqueness across projects, and picking up
        // another project's record would return the wrong pin — which reads as
        // "this view isn't the pinned one" and hands the running assistant
        // back to the LRU.
        if (record.projectId !== projectId || record.slot !== slot) continue;
        if (this.terminalBySessionId.get(record.sessionId) !== terminalId) continue;
        backends.push({ terminalId, webContentsId: record.projectViewWebContentsId, slot });
        break;
      }
    }
    return backends;
  }

  /**
   * Looks up the renderer WebContents id pinned to a help-session bearer at
   * provision time. The MCP server uses this at handshake to pin each
   * transport session to the window that minted it, so a tool call from the
   * assistant in window A can never be routed to window B's renderer (#7002).
   * Returns null for unknown or revoked tokens.
   */
  getWebContentsIdForToken(token: string): number | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    return record.projectViewWebContentsId;
  }

  /**
   * Looks up the renderer `ActionContext` snapshot bound to a help-session
   * bearer at provision time. The MCP server uses this at handshake to pin
   * every tool dispatch to the worktree/terminal the user had focused when
   * the assistant launched, so a focus shift during the model's turn can't
   * silently retarget the action (#8317). Returns null for unknown, revoked,
   * or context-less tokens — the dispatch then falls back to live context,
   * matching pre-#8317 behaviour.
   */
  getActionContextForToken(token: string): ActionContext | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    return record.actionContext ?? null;
  }

  /**
   * Looks up the public help-session id minted at provision for a bearer
   * token. The MCP server resolves this at handshake to join its own
   * per-connection transport session id back to the help session the
   * renderer knows about (`helpPanelStore.sessionId`), so audit records and
   * turn-id lookups correlate with what the assistant panel displays.
   * Returns null for unknown or revoked tokens.
   */
  getSessionIdForToken(token: string): string | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    return record.sessionId;
  }

  /**
   * Renderer-safe sibling of `getActionContextForToken`, keyed on the public
   * `sessionId` (persisted in `helpPanelStore`) instead of the bearer token.
   * The HelpPanel footer uses this to surface the pinned worktree/terminal
   * binding to the user (#8772) without the token ever crossing the IPC
   * bridge. Returns null for unknown, revoked, or context-less sessions.
   */
  getActionContextForSessionId(sessionId: string): ActionContext | null {
    if (!sessionId) return null;
    const record = this.sessionsById.get(sessionId);
    if (!record || record.revoked) return null;
    return record.actionContext ?? null;
  }

  /**
   * Session-id keyed sibling of `getWebContentsIdForToken`. Lets the
   * sessionId-facing IPC handlers (#8772) reject reads from a window other
   * than the one that minted the session, mirroring the per-window pin from
   * #7002 without exposing the bearer token. Returns null for unknown or
   * revoked sessions.
   */
  getWebContentsIdForSessionId(sessionId: string): number | null {
    if (!sessionId) return null;
    const record = this.sessionsById.get(sessionId);
    if (!record || record.revoked) return null;
    return record.projectViewWebContentsId;
  }

  /**
   * Inverse of `terminalBySessionId` for the assistant-turn audit. Returns
   * the help-session id currently bound to a given terminal id, or null
   * when the terminal is not (or no longer) a help-session terminal. Linear
   * scan is intentional: the map is bounded by simultaneously active help
   * sessions per project and stays small in practice.
   */
  getSessionIdForTerminal(terminalId: string): string | null {
    if (!terminalId) return null;
    for (const [sessionId, tid] of this.terminalBySessionId.entries()) {
      if (tid === terminalId) return sessionId;
    }
    return null;
  }

  /**
   * Provisions the per-project session directory for the Daintree Assistant
   * under userData/help-sessions/<projectPathHash>/. The dir is reused across
   * launches so Claude Code's per-folder workspace-trust prompt only fires
   * once per project; the .mcp.json bearer is rotated on every provision.
   *
   * One directory serves every lane of the project. On every call:
   *   1. Copy the bundled help/ template into the dir (overwrites — picks up
   *      bundled-asset updates without losing the trust acceptance).
   *   2. Write this lane's MCP wiring: for Claude, a per-lane `--mcp-config`
   *      file under `.lanes/` carrying the fresh literal bearer, with the
   *      shared `.mcp.json` left empty; for Copilot, the shared `.mcp.json`
   *      with an env placeholder; nothing on disk for Codex.
   *   3. Overlay .claude/settings.json with current `helpAssistant` settings.
   *   4. Stamp meta.json with the project identity for GC.
   */
  async provisionSession(input: ProvisionInput): Promise<ProvisionResult | null> {
    if (this.disposed) return null;
    this.validateProvisionInput(input);

    const helpFolder = getHelpFolderPath();
    if (!helpFolder) {
      console.warn("[HelpSessionService] Bundled help folder unavailable — cannot provision");
      return null;
    }

    // Lock on the LANE ITSELF — `(projectId, slot)` — because that is the
    // identity the single-backend invariant is stated in. A path-derived key
    // would not serialize two callers that spell the same project differently
    // (`/work/p` vs `/work/p/`): they would hash apart, both run
    // `displacePriorSessions` before either registered its record, and both
    // end up live in one lane. Different lanes and different projects still
    // provision in parallel here; the shared session DIRECTORY they write into
    // is serialized separately, inside `doProvision`.
    const pathHash = projectPathHash(input.projectPath);
    const lockKey = assistantSlotKey(input.projectId, input.slot ?? 0);
    const previous = this.provisionLocks.get(lockKey);
    let resolveLock!: () => void;
    const next = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    // Keep the CHAINED promise, which is what actually lands in the map — the
    // cleanup below compares against it to decide whether this call is still
    // the tail of the queue. Comparing against `next` never matched, so the
    // entry was never dropped and the map grew for the life of the process.
    const tail = (previous ?? Promise.resolve()).then(() => next);
    this.provisionLocks.set(lockKey, tail);
    if (previous) await previous;

    try {
      return await this.doProvision(input, helpFolder, pathHash);
    } finally {
      resolveLock();
      // Drop the lock entry once it resolves so the map doesn't grow without
      // bound. Anyone awaiting `previous` already has the resolved promise.
      if (this.provisionLocks.get(lockKey) === tail) {
        this.provisionLocks.delete(lockKey);
      }
    }
  }

  private async doProvision(
    input: ProvisionInput,
    helpFolder: string,
    pathHash: string
  ): Promise<ProvisionResult | null> {
    const settings = this.readSettings();
    // Every help agent — the Daintree Assistant included — provisions at the
    // tier the user configured. Agent identity never widens the MCP surface,
    // which restores the #10640/#10647 safety model: `action` is the default
    // floor, git and forge writes sit above it and need a human-approved scoped
    // grant, and `workbench` / `system` stay explicit user choices. An identity
    // override here would make the Settings tier selector lie about the surface
    // it hands out (#11907). What each tier permits is locked in
    // `mcp-server/__tests__/tierAuth.test.ts`.
    const tier: HelpAssistantTier = settings.tier;
    const slot = input.slot ?? 0;
    const sessionId = randomUUID();
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const sessionsRoot = this.getSessionsRoot();
    // One directory per PROJECT, shared by every lane. Claude's workspace-trust
    // and `.mcp.json` approval prompts are both per folder, so this is what
    // makes them fire once per project rather than once per lane. Anything a
    // lane must not share — its MCP bearer — lives in a per-lane file below.
    const sessionPath = path.join(sessionsRoot, assistantSessionDirName(pathHash));

    if (settings.daintreeControl) {
      try {
        await this.ensureMcpServerReady();
      } catch (err) {
        // Surface as a typed error the renderer can display verbatim. The
        // alternative (silently writing a `.mcp.json` without the daintree
        // entry and launching anyway) is exactly the silent-degrade path
        // the user observed and asked us to fix.
        const reason = formatErrorMessage(err, "in-process MCP server isn't ready");
        await this.recordMcpNotReady(sessionId, reason);
        throw new HelpSessionError(
          "MCP_SERVER_NOT_STARTED",
          `Daintree Assistant needs the in-process MCP server, but it isn't ready: ${reason}`
        );
      }
    }

    // Single-backend invariant (#7509): displace any prior unrevoked record
    // for this LANE BEFORE writing a fresh `.mcp.json`. The bearer is
    // marked revoked first so any in-flight MCP call from the orphan 401s
    // before the kill IPC reaches the PTY host. Runs inside `provisionLocks`
    // (per lane directory), so concurrent provisions for the same lane see
    // this as an atomic step. The renderer still calls `revokeHelpSession`
    // from its cooperative cleanup paths — this enforcement is defense-in-depth
    // for when those paths drop the kill or never fire (crash, project
    // switch, hibernate race).
    this.displacePriorSessions(input.projectId, slot);

    // One agent per project's lanes. The shared directory holds files that are
    // agent-shaped as well as lane-shaped: the user-content mirror writes each
    // agent's skills and removes the other's, Copilot needs the shared
    // `.mcp.json` that a Claude provision empties, and the settings overlay is
    // Claude's. Serializing the writes keeps them whole; it does not make two
    // agents' versions of them coexist. The renderer already keeps lanes on one
    // preferred agent, so this only ever fires for an explicit `help.launch` of
    // a different agent while a sibling is live, and it fails closed with a
    // reason rather than letting that lane quietly clobber its sibling's setup.
    const liveSibling = [...this.sessionsByToken.values()].find(
      (record) =>
        !record.revoked &&
        record.projectId === input.projectId &&
        record.slot !== slot &&
        record.agentId !== input.agentId
    );
    if (liveSibling) {
      throw new HelpSessionError(
        "MIXED_AGENT_LANES",
        `Another session in this project is running ${liveSibling.agentId}; sessions of one project share a folder and have to use the same agent. Stop it first, or open the new session with ${liveSibling.agentId}.`
      );
    }

    // Every lane of a project provisions into ONE directory, so the file work
    // below is serialized per directory as well as per lane. The lane lock
    // above guards the single-backend invariant; this one guards the template
    // copy and its hash stamp, the user-content mirror and its manifest, the
    // markdown scratch addendum and the shared `.mcp.json` — all of which two
    // lanes provisioning at once would otherwise write over each other.
    const { scratchPath, port, laneMcpConfigPath } = await this.withDirectoryLock(
      pathHash,
      async () => {
        await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
        await fs.chmod(sessionsRoot, 0o700).catch(() => {});
        // Hash-gate the template overwrite (#7525). `fs.cp` is non-atomic — a
        // crash mid-copy would leave a torn session dir whose template files
        // are a mix of old and new. Most launches see an unchanged template
        // (same app version since last open), so we skip the copy entirely
        // when the on-disk stamp matches the bundled hash. The stamp is only
        // written AFTER `fs.cp` resolves, so a failed copy never marks itself
        // as valid: next launch sees the mismatch and re-runs the copy.
        //
        // The `.mcp.json`, `.claude/settings.json`, and `meta.json` writes
        // below stay unconditional — those carry per-session secrets (rotated
        // bearer, current user settings) and are not template content.
        const sourceHash = await computeTemplateHash(helpFolder);
        const existingHash = await readTemplateHashStamp(sessionPath);
        if (existingHash !== sourceHash) {
          // `force: true` is the default — overwrites existing files in the dir
          // with the bundled template, picking up any updates to CLAUDE.md /
          // settings baseline / etc. without losing Claude Code's per-folder trust
          // acceptance (which lives in ~/.claude.json, not here).
          await fs.cp(helpFolder, sessionPath, { recursive: true });
          await resilientAtomicWriteFile(
            path.join(sessionPath, TEMPLATE_HASH_FILE),
            sourceHash + "\n",
            "utf-8",
            { mode: 0o600 }
          );
        }
        await fs.chmod(sessionPath, 0o700).catch(() => {});

        // Mirror user-authored commands/skills from ~/.daintree/assistant and
        // <project>/.daintree/assistant into the session dir so the launched CLI
        // discovers them through its native cwd-scoped mechanisms. Runs after the
        // template copy and unconditionally — the template hash gate doesn't
        // cover user content, which changes independently of app version.
        //
        // Failure policy: invalid or unwritable NEW content is safely omitted (the
        // assistant just launches without it), but content that would run STALE —
        // an unreadable source (desired state unprovable) or a managed skill that
        // should be gone yet is still on disk — fails the provision closed. A
        // session quietly running deleted or superseded skill instructions is
        // worse than a retryable launch error.
        let syncResult;
        try {
          syncResult = await syncAssistantContent({
            sessionPath,
            projectPath: input.projectPath,
            agentId: input.agentId,
          });
        } catch (err) {
          const reason = formatErrorMessage(err, "couldn't read the assistant content folders");
          throw new HelpSessionError(
            "USER_CONTENT_SYNC_FAILED",
            `Couldn't refresh the project's assistant commands and skills: ${reason}`
          );
        }
        if (syncResult) {
          if (syncResult.omittedSkills.length > 0 || syncResult.failedCopies.length > 0) {
            console.warn(
              "[HelpSessionService] Assistant content partially mirrored; launching without:",
              {
                sessionPath,
                omittedSkills: syncResult.omittedSkills,
                failedCopies: syncResult.failedCopies,
              }
            );
          }
          if (syncResult.staleFailures.length > 0) {
            // Name the session dir: a stale file that survives removal (symlinked
            // chain, or a directory where a managed file belongs) fails every
            // retry identically, so clearing that path by hand is the only fix.
            console.warn(
              "[HelpSessionService] Assistant content sync left stale managed files; clear this session directory to recover:",
              { sessionPath, staleFailures: syncResult.staleFailures }
            );
            throw new HelpSessionError(
              "USER_CONTENT_SYNC_FAILED",
              `Couldn't refresh the project's assistant commands and skills — outdated copies still present in the session directory ${sessionPath}: ${syncResult.staleFailures.join(", ")}`
            );
          }
        }

        // Per-session scratch dir under `userData/assistant-scratch/<instanceId>/`.
        // Cleared on every app start by `AssistantScratchService`. Created
        // unconditionally outside the template hash gate so the path is always
        // valid for this provision — agents won't see a missing dir behind the
        // `DAINTREE_ASSISTANT_SCRATCH_DIR` env var. Failure to create propagates
        // (rather than being swallowed) because launching with a stale or missing
        // scratch path is worse than a clean provision failure.
        const scratchPath = getScratchDirForSession(sessionId);
        await fs.mkdir(scratchPath, { recursive: true, mode: 0o700 });
        await fs.chmod(scratchPath, 0o700).catch(() => {});

        // Write the scratch-path addendum to each per-agent markdown file in the
        // session dir. Unconditional — must run even when the template hash gate
        // above skips `fs.cp`, otherwise a stale path from a prior session would
        // persist (`scratchPath` changes every provision because `sessionId` does).
        // Uses managed markers so re-provision replaces the block in place instead
        // of accumulating duplicate stanzas.
        await this.writeScratchAddendum(sessionPath, scratchPath);

        const port = await this.getMcpPort(settings.daintreeControl);
        let laneMcpConfigPath: string | undefined;
        if (input.agentId === "claude") {
          laneMcpConfigPath = await this.writeClaudeMcpConfig(
            sessionPath,
            slot,
            sessionId,
            settings,
            port,
            token
          );
          await this.writeClaudeSettings(sessionPath, helpFolder, settings);
        } else if (input.agentId === "copilot") {
          await this.writeCopilotMcpConfig(sessionPath, settings, port);
        } else {
          // Codex and any other agent skip `writeMcpConfig`, so when the
          // template hash gate (#7525) also skips `fs.cp`, a `.mcp.json` from a
          // prior Claude provision for this same project keeps its stale
          // `daintree` Bearer in cwd. The bearer is already revoked in-memory
          // (single-backend invariant), but before the gate, `fs.cp` would
          // have restored the bundled `.mcp.json` and wiped the entry. Strip
          // it now to preserve that hygiene — no-op when the entry is absent
          // or its bearer is still live.
          await this.stripStaleDaintreeMcpEntry(sessionPath);
        }
        return { scratchPath, port, laneMcpConfigPath };
      }
    );
    // Codex doesn't read project-scoped `.codex/config.toml` from cwd —
    // its only mechanism for overriding the global config is the `-c key=value`
    // CLI flag (verified against codex-cli 0.129.0). MCP servers are appended
    // to the spawn command in `lifecycle.ts` via the `getCodexLaunchArgs`
    // accessor below; nothing is written to disk for Codex.
    //
    // Copilot reads `<sessionPath>/.mcp.json` (written above by
    // `writeCopilotMcpConfig`). The `--plan` read-only flag is appended at
    // spawn time via `getCopilotLaunchArgs`.

    const codexLaunchArgs =
      input.agentId === "codex"
        ? this.buildCodexLaunchArgs(settings.daintreeControl, settings.docSearch, port)
        : undefined;
    const copilotLaunchArgs =
      input.agentId === "copilot" ? this.buildCopilotLaunchArgs() : undefined;
    // Claude reads its MCP wiring from the per-lane file rather than the
    // shared cwd `.mcp.json`; the flag is the only way that file reaches it.
    const claudeLaunchArgs = laneMcpConfigPath ? ["--mcp-config", laneMcpConfigPath] : undefined;

    const now = Date.now();
    const record: HelpSessionRecord = {
      sessionId,
      token,
      windowId: input.windowId,
      projectViewWebContentsId: input.projectViewWebContentsId,
      projectId: input.projectId,
      slot,
      projectPath: input.projectPath,
      sessionPath,
      agentId: input.agentId,
      tier,
      bypassPermissions: settings.bypassPermissions,
      debugLogging: settings.debugLogging,
      createdAt: now,
      revoked: false,
      actionContext: input.actionContext,
      codexLaunchArgs,
      copilotLaunchArgs,
      laneMcpConfigPath,
      claudeLaunchArgs,
      scratchPath,
    };

    await this.writeSessionMeta(sessionPath, {
      projectId: input.projectId,
      projectPath: input.projectPath,
      lastUsedAt: now,
    });

    this.sessionsByToken.set(token, record);
    this.sessionsById.set(sessionId, record);

    if (settings.daintreeControl && port) {
      try {
        if (input.agentId === "claude") {
          // Claude Code reads SSE at /sse with a literal bearer baked into
          // its lane's `--mcp-config` file. Both probes warm the same
          // in-memory MCP token map, so neither leaks across agents.
          await probeMcpSseServer(port, token);
        } else {
          // Codex and Copilot both speak Streamable HTTP at /mcp. Codex
          // reads the bearer from `DAINTREE_MCP_TOKEN` PTY env via
          // `bearer_token_env_var`. Copilot reads the bearer from PTY env
          // via `${DAINTREE_MCP_TOKEN}` substitution in its settings file.
          await probeMcpServer(port, token);
        }
      } catch (err) {
        record.revoked = true;
        this.sessionsByToken.delete(token);
        this.sessionsById.delete(sessionId);
        if (input.agentId === "claude" || input.agentId === "copilot") {
          await this.stripStaleDaintreeMcpEntry(sessionPath);
          // The lane file was written moments ago with the bearer the probe just
          // proved dead; a failed provision must not leave it behind.
          await this.removeLaneMcpConfig(laneMcpConfigPath);
        }
        const reason = formatErrorMessage(err, "assistant MCP session isn't ready");
        await this.recordMcpNotReady(sessionId, reason);
        throw new HelpSessionError(
          "MCP_PROBE_FAILED",
          `Daintree Assistant minted an MCP session, but the assistant bearer was not ready: ${reason}`
        );
      }
    }

    const mcpUrl = this.buildMcpUrl(input.agentId, settings.daintreeControl, port);
    return { sessionId, sessionPath, token, tier, mcpUrl, windowId: input.windowId };
  }

  private buildMcpUrl(
    agentId: string,
    daintreeControl: boolean,
    port: number | null
  ): string | null {
    if (!daintreeControl || !port) return null;
    // Claude reads SSE at /sse with a literal bearer; everyone else speaks
    // Streamable HTTP at /mcp with env-var substitution.
    if (agentId === "claude") return `http://127.0.0.1:${port}/sse`;
    return `http://127.0.0.1:${port}/mcp`;
  }

  /**
   * Builds the `-c key=value` CLI args that wire MCP servers into a Codex
   * help-session spawn. The values are TOML-encoded literals (quoted strings),
   * matching Codex's `-c` parser. Returns an empty array when both server
   * toggles are off.
   *
   * Token comes from `DAINTREE_MCP_TOKEN` in PTY env via `bearer_token_env_var`,
   * so no literal token is ever embedded in argv or written to disk.
   */
  private buildCodexLaunchArgs(
    daintreeControl: boolean,
    docSearch: boolean,
    port: number | null
  ): string[] {
    const args: string[] = [];
    if (daintreeControl && port) {
      args.push(
        "-c",
        `mcp_servers.daintree.transport="http"`,
        "-c",
        `mcp_servers.daintree.url="http://127.0.0.1:${port}/mcp"`,
        "-c",
        `mcp_servers.daintree.bearer_token_env_var="DAINTREE_MCP_TOKEN"`
      );
    }
    if (docSearch) {
      args.push(
        "-c",
        `mcp_servers.daintree-docs.transport="http"`,
        "-c",
        `mcp_servers.daintree-docs.url="https://daintree.org/api/mcp"`
      );
    }
    return args;
  }

  /**
   * Returns the cached `-c` flags that wire MCP servers for a Codex help
   * session. lifecycle.ts appends them to the spawn command after the help
   * token validates. Returns null for unknown / revoked tokens or non-Codex
   * sessions, so the spawn handler never injects flags for the wrong agent.
   */
  getCodexLaunchArgs(token: string): string[] | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    if (record.agentId !== "codex") return null;
    return record.codexLaunchArgs ?? [];
  }

  /**
   * Builds the CLI flags that constrain a Copilot help-session spawn to
   * read-only behaviour. Pins `--plan` (read-only mode, available since
   * Copilot CLI v1.0.40 — gated by `assistantMinVersion` in
   * `copilot.ts`). MCP servers are written into `<sessionPath>/.mcp.json`
   * via `writeCopilotMcpConfig` and read from cwd at launch — no flag
   * injection needed for MCP discovery.
   */
  private buildCopilotLaunchArgs(): string[] {
    return ["--plan"];
  }

  /**
   * Returns the cached CLI flags for a Copilot help session. lifecycle.ts
   * appends them to the spawn command after the help token validates.
   * Returns null for unknown / revoked tokens or non-Copilot sessions, so
   * the spawn handler never injects flags for the wrong agent.
   */
  getCopilotLaunchArgs(token: string): string[] | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    if (record.agentId !== "copilot") return null;
    return record.copilotLaunchArgs ?? [];
  }

  /**
   * Invalidates the in-memory bearer for this session. The on-disk dir is
   * intentionally preserved across launches so the user's one-time Claude
   * Code workspace-trust acceptance for this project carries over to the
   * next assistant open — but this lane's `--mcp-config` file is removed and
   * any literal bearer is stripped from the shared `.mcp.json`, so a `claude`
   * started outside the help-panel flow (e.g. a stray terminal `cd`-ed into
   * the session dir) can't keep authenticating against the now-revoked
   * record. The next provision writes a fresh lane file.
   *
   * Pass `{ captureHibernation: true }` for the eviction / window-close
   * paths: instead of a hard kill, the bound PTY is graceful-killed so the
   * agent flushes its resume ID, and a pending-hibernation entry is
   * persisted for the project. The next time the user opens the assistant
   * for that project, the renderer resumes the conversation. User-driven
   * revokes (renderer IPC) leave the option off so "+ New session" /
   * explicit close discards the transcript as the user intended.
   */
  async revokeSession(sessionId: string, opts?: { captureHibernation?: boolean }): Promise<void> {
    const record = this.sessionsById.get(sessionId);
    if (!record || record.revoked) return;

    const terminalId = this.terminalBySessionId.get(sessionId);
    const slotKey = assistantSlotKey(record.projectId, record.slot);

    // Capture FIRST (while the session record is still valid for token
    // lookups by the agent process). gracefulKill resolves with the agent's
    // resume ID once the agent flushes its transcript and exits. If
    // gracefulKill rejects or returns null (PTY already gone, host crashed,
    // agent didn't write a session file), we silently fall through to the
    // existing kill path — eviction completes either way, just without a
    // resume entry. A best-effort capture is strictly an improvement over
    // the previous behaviour of always losing the conversation.
    let capturedAgentSessionId: string | null = null;
    // Whether THIS call claimed the lane's capture below. `revoked` is only set
    // after the gracefulKill await, so a concurrent revoke of the same session —
    // the renderer's no-capture `handleTerminalPanelMissing` path, which now
    // races us whenever the project view outlives the kill (project sleep and
    // close+kill both keep it alive) — passes the guard at the top and reaches
    // the finalize block below. Without this flag it would release OUR ownership
    // and the real resume id would be dropped for the empty-sentinel placeholder,
    // silently demoting the resume to latest-conversation.
    let ownsCapture = false;
    if (opts?.captureHibernation && terminalId && this.ptyClient) {
      // #9639: write a placeholder resume entry SYNCHRONOUSLY (memory-first
      // via `set`) before the gracefulKill round-trip. The eviction path that
      // calls us is fire-and-forget, so a project switch-back can load the new
      // renderer view and call `takePendingHibernation` before gracefulKill
      // resolves. Without the placeholder it gets null and starts a *fresh*
      // assistant session — the visible "restart" this issue is about. The
      // empty-`agentSessionId` sentinel routes the renderer down the
      // resume-latest path instead; once gracefulKill returns we overwrite the
      // placeholder with the agent's real resume ID (below).
      if (this.pendingHibernationStore) {
        this.pendingCapturesBySlotKey.set(slotKey, sessionId);
        ownsCapture = true;
        const panelWasOpen = this.panelOpenByProjectId.get(record.projectId) === true;
        void this.pendingHibernationStore
          .set(slotKey, {
            agentId: record.agentId,
            agentSessionId: "",
            cwd: record.sessionPath,
            capturedAt: Date.now(),
            panelWasOpen,
          })
          .catch((err) => {
            console.warn(
              "[HelpSessionService] Failed to persist pending hibernation placeholder:",
              record.projectId,
              err
            );
          });
      }
      try {
        capturedAgentSessionId = await this.ptyClient.gracefulKill(terminalId);
      } catch (err) {
        console.warn(
          "[HelpSessionService] gracefulKill during capture-revoke failed:",
          terminalId,
          err
        );
      }
    }

    // Race guard: a same-project re-provision can call `displacePriorSessions`
    // during the `gracefulKill` await above, which marks our record revoked
    // and lets a fresh session take over the project's active slot. Detect
    // here BEFORE we re-mark revoked / clear maps — if we lost the race, the
    // post-await cleanup below skips the active-slot manipulation and we
    // skip the pending-hibernation write so the captured (old) resume ID
    // doesn't shadow the just-started fresh launch.
    const displacedDuringCapture = record.revoked;

    record.revoked = true;
    this.sessionsById.delete(sessionId);
    this.sessionsByToken.delete(record.token);

    // Single-backend invariant (#7509): kill the bound PTY now so the orphan
    // can't keep dispatching MCP calls under the just-revoked bearer. Guard
    // against clobbering a sibling session that took over the project's
    // active-terminal slot before this revoke ran. Skip the hard kill if
    // we already gracefulKilled — same lifecycle endpoint, just avoids the
    // duplicate "kill an unknown terminal" warning in the PTY host log.
    if (terminalId) {
      this.terminalBySessionId.delete(sessionId);
      // If displaced, the new provision already cleared the active slot (and
      // may have set it to a new terminal id) — never touch it here.
      if (!displacedDuringCapture && this.activeHelpTerminalBySlotKey.get(slotKey) === terminalId) {
        this.activeHelpTerminalBySlotKey.delete(slotKey);
      }
      if (!capturedAgentSessionId) {
        this.killTerminal(terminalId, "help-session-revoked");
      }
    }

    // Eagerly tear down the live MCP session(s) bound to this bearer (#9151).
    // Without this the MCP session keeps its tier, grants, and renderer pin
    // until the abuse policy trips on accumulated 401s or the 30-minute idle
    // reaper collects it — up to a full 30 minutes of stale state for a
    // session that goes idle right after revoke. Fires unconditionally (the
    // MCP session is live regardless of whether we captured a hibernation
    // resume ID); a no-op when the agent never reached the MCP server.
    try {
      this.onMcpSessionRevokedFn?.(record.token);
    } catch (err) {
      console.warn(
        "[HelpSessionService] MCP session teardown during revoke failed:",
        sessionId,
        err
      );
    }

    // #9639: finalize the placeholder written before gracefulKill. Only act if
    // we still own the capture — a same-lane re-provision that ran
    // `displacePriorSessions` during the await clears our ownership and the
    // placeholder, so the old resume ID can't shadow the fresh session that
    // took the lane. When we still own it: overwrite with the real resume ID
    // if gracefulKill yielded one, otherwise leave the empty-sentinel in place
    // (resume-latest beats a fresh launch). Then release ownership.
    if (
      ownsCapture &&
      this.pendingHibernationStore &&
      this.pendingCapturesBySlotKey.get(slotKey) === sessionId
    ) {
      if (capturedAgentSessionId) {
        const panelWasOpen = this.panelOpenByProjectId.get(record.projectId) === true;
        void this.pendingHibernationStore
          .set(slotKey, {
            agentId: record.agentId,
            agentSessionId: capturedAgentSessionId,
            cwd: record.sessionPath,
            capturedAt: Date.now(),
            panelWasOpen,
          })
          .catch((err) => {
            console.warn(
              "[HelpSessionService] Failed to persist pending hibernation:",
              record.projectId,
              err
            );
          });
      }
      this.pendingCapturesBySlotKey.delete(slotKey);
    }

    // Claude's literal session bearer lives in this lane's own `--mcp-config`
    // file: remove it, so nothing on disk names a route that no longer
    // answers. The shared `.mcp.json` is also stripped for both Claude and
    // Copilot (Copilot references it with `$DAINTREE_MCP_TOKEN` substitution,
    // and a pre-shared-directory install may still have a literal Claude
    // bearer in it) so a stray agent started outside the help-panel flow in
    // that cwd can't keep talking to the revoked route. Codex stores nothing
    // on disk (uses `-c` flags), so no file work is needed.
    if (record.agentId === "claude") {
      await this.removeLaneMcpConfig(record.laneMcpConfigPath);
    }
    if (record.agentId === "claude" || record.agentId === "copilot") {
      await this.stripStaleDaintreeMcpEntry(record.sessionPath);
    }
  }

  /**
   * Non-consuming read of the eviction-captured resume entry for a project.
   * Unlike `takePendingHibernation`, this does NOT clear the entry or touch
   * the in-flight capture owner — it's a pure lookup so the renderer's idle
   * empty state can decide whether to offer a "Resume assistant" affordance
   * before the user commits to a launch. The actual resume still goes through
   * `takePendingHibernation` (atomic take) inside the launch flow.
   */
  peekPendingHibernation(
    projectId: string,
    slot: number
  ): {
    agentId: string;
    agentSessionId: string;
    cwd: string;
    panelWasOpen: boolean;
  } | null {
    if (!this.pendingHibernationStore) return null;
    const entry = this.pendingHibernationStore.get(assistantSlotKey(projectId, slot));
    if (!entry) return null;
    return {
      agentId: entry.agentId,
      agentSessionId: entry.agentSessionId,
      cwd: entry.cwd,
      // In-memory-only flag; disk-loaded prior-session entries lack it →
      // false, so app restart never auto-resumes (#10815).
      panelWasOpen: entry.panelWasOpen === true,
    };
  }

  /**
   * Reads and clears the main-captured pending hibernation entry for a
   * project. Called by the renderer at launch time to seed
   * `helpPanelStore.hibernateSessions[projectId]` from the entry main
   * captured on the prior eviction. The entry is one-shot — once read it's
   * dropped from the persistent store so a future cold launch without
   * intervening capture starts fresh.
   *
   * Returns a `claimId` alongside the entry (#11477): a launch that takes but
   * then aborts quotes it back to `restorePendingHibernation` to put the entry
   * back. `ownerWebContentsId` is the taking view, supplied by the IPC layer
   * from its context — never by the renderer.
   */
  async takePendingHibernation(
    projectId: string,
    slot: number,
    ownerWebContentsId?: number
  ): Promise<{
    agentId: string;
    agentSessionId: string;
    cwd: string;
    claimId: string;
  } | null> {
    if (!this.pendingHibernationStore) return null;
    const slotKey = assistantSlotKey(projectId, slot);
    const entry = this.pendingHibernationStore.get(slotKey);
    if (!entry) return null;
    // #10048: invalidate the in-flight capture owner before the await so the
    // post-gracefulKill finalize block's ownership guard fails and the
    // already-killed agent's (now-stale) resume ID cannot overwrite the
    // placeholder the renderer just claimed. Mirrors displacePriorSessions.
    this.pendingCapturesBySlotKey.delete(slotKey);
    // Stash the exact entry (original `capturedAt` and all) so a taker that
    // aborts can hand it back via `restorePendingHibernation` (#11477).
    // Overwrites any prior stash for this lane: only the most recent take is
    // restorable, and an earlier taker's put-back must not resurrect a
    // superseded entry. Stashes are per lane, so one view holding claims on
    // several lanes keeps them independent — the CAS identity is
    // (slotKey, claimId, ownerWebContentsId), and the same owner appearing in
    // more than one bucket is expected rather than ambiguous.
    const { panelWasOpen: _panelWasOpen, ...restorable } = entry;
    const claimId = randomUUID();
    this.lastTakenBySlotKey.set(slotKey, {
      entry: restorable,
      claimId,
      ownerWebContentsId: ownerWebContentsId ?? null,
    });
    await this.pendingHibernationStore.clear(slotKey);
    return {
      agentId: entry.agentId,
      agentSessionId: entry.agentSessionId,
      cwd: entry.cwd,
      claimId,
    };
  }

  /**
   * Put back an entry a caller took via `takePendingHibernation` but did not
   * end up using (#11477).
   *
   * `takePendingHibernation` is destructive by design — the atomic take is the
   * single-winner gate that stops two windows from displacing each other's
   * backend (#10819). But every abort downstream of a successful take dropped
   * the entry on the floor, so a launch superseded by a StrictMode remount, the
   * stall watchdog, or a plain provisioning failure destroyed the only resume
   * token the user had. The watchdog case is the sharpest: it surfaces a
   * *retryable* launch error while the token that retry needs is already gone.
   *
   * The `claimId` from the matching take is required, so a release acts on the
   * take that produced it rather than on the project at large. On top of that,
   * it refuses whenever anything newer owns the slot:
   *
   * - A present entry means a fresh capture landed after our take. It is newer
   *   and describes a later conversation; overwriting it would resurrect a
   *   superseded one.
   * - An in-flight capture owner means a `revokeSession` is mid-`gracefulKill`
   *   and will write the real resume id when it resolves (#9646). Restoring
   *   under it would be clobbered anyway, or would race the placeholder.
   *
   * The entry itself comes from main's own take-side stash, not from the
   * caller: the renderer only reports that it didn't use what it took. That
   * keeps the original `capturedAt` (so a put-back can't refresh its way past
   * the 14-day staleness cutoff), keeps `panelWasOpen` stripped — the safe
   * default, since a put-back entry should be offered for an explicit resume
   * but never auto-resume on switch-back (#10815) — and leaves no path for a
   * renderer to write an agentId/cwd of its choosing into main's persistent
   * store.
   *
   * Returns whether the entry was actually restored.
   */
  async restorePendingHibernation(
    projectId: string,
    slot: number,
    claimId: string,
    ownerWebContentsId?: number
  ): Promise<boolean> {
    if (!this.pendingHibernationStore) return false;
    const slotKey = assistantSlotKey(projectId, slot);
    const stashed = this.lastTakenBySlotKey.get(slotKey);
    if (!stashed) return false;
    // Compare-and-swap on the specific take. A release quoting a superseded
    // claim (a later take replaced the stash) or arriving from a view other
    // than the one that took it is refused WITHOUT consuming the stash, so the
    // rightful claimant can still put its entry back.
    if (stashed.claimId !== claimId) return false;
    if (
      stashed.ownerWebContentsId !== null &&
      ownerWebContentsId !== undefined &&
      stashed.ownerWebContentsId !== ownerWebContentsId
    ) {
      return false;
    }
    // One-shot from here: the claim is now spent either way, so a duplicate
    // release can't re-resurrect an entry a subsequent take consumed.
    this.lastTakenBySlotKey.delete(slotKey);
    if (this.pendingHibernationStore.get(slotKey)) return false;
    if (this.pendingCapturesBySlotKey.has(slotKey)) return false;
    await this.pendingHibernationStore.set(slotKey, stashed.entry);
    return true;
  }

  /**
   * Which lanes of `projectId` hold an eviction-captured resume entry.
   *
   * A cold renderer knows nothing about lanes 1+ — the ephemeral per-slot
   * state is gone and only the persisted entries survive — so without this the
   * tabs for those lanes would never be recreated and their captured
   * conversations would be unreachable despite still being on disk. Returns
   * lanes in slot order.
   */
  listPendingHibernationSlots(projectId: string): number[] {
    if (!this.pendingHibernationStore || !projectId) return [];
    return ASSISTANT_SLOTS.filter((slot) =>
      Boolean(this.pendingHibernationStore?.get(assistantSlotKey(projectId, slot)))
    );
  }

  /**
   * Revoke every prior session occupying `(projectId, slot)`.
   *
   * Scoped to the lane since #12108. The #7509 property is unchanged and lives
   * in the ORDER below, not in the breadth of the filter: the record leaves
   * `sessionsByToken` before the fire-and-forget PTY kill, so even a dropped
   * kill IPC leaves an orphan whose bearer no longer validates. Narrowing the
   * filter only stops us killing sessions in other lanes, which are live
   * sessions the user asked for rather than orphans.
   *
   * This is why `record.slot` is required rather than optional: a record whose
   * lane were unknown would be displaced by nobody and would protect nobody.
   */
  private displacePriorSessions(projectId: string, slot: number): void {
    const slotKey = assistantSlotKey(projectId, slot);
    const priors = [...this.sessionsById.values()].filter(
      (record) => record.projectId === projectId && record.slot === slot && !record.revoked
    );
    for (const prior of priors) {
      prior.revoked = true;
      this.sessionsByToken.delete(prior.token);
      this.sessionsById.delete(prior.sessionId);
      // #9639: if this displaced session owns an in-flight capture placeholder,
      // drop it (and release ownership) so the old, soon-to-be-stale resume ID
      // can't shadow the fresh session now taking this lane.
      if (this.pendingCapturesBySlotKey.get(slotKey) === prior.sessionId) {
        this.pendingCapturesBySlotKey.delete(slotKey);
        void this.pendingHibernationStore?.clear(slotKey).catch((err) => {
          console.warn(
            "[HelpSessionService] Failed to clear displaced pending hibernation:",
            projectId,
            err
          );
        });
      }
      const terminalId = this.terminalBySessionId.get(prior.sessionId);
      if (terminalId) {
        this.terminalBySessionId.delete(prior.sessionId);
        this.killTerminal(terminalId, "help-session-displaced");
      }
      // Tear down the displaced session's live MCP transport too (#9151).
      // Displacement is just a same-lane re-provision flavour of revoke —
      // without this the old bearer keeps its tier/grants/pin until the
      // 30-minute idle reaper, exactly the stale state this issue closes on
      // the `revokeSession` path.
      try {
        this.onMcpSessionRevokedFn?.(prior.token);
      } catch (err) {
        console.warn(
          "[HelpSessionService] MCP session teardown during displacement failed:",
          prior.sessionId,
          err
        );
      }
    }
    // Also clear any stale active-terminal binding the renderer never
    // confirmed via `markTerminalForToken` — leaving it would leak this
    // lane's binding and cause the next `markTerminalForToken` to kill
    // the wrong PTY.
    this.activeHelpTerminalBySlotKey.delete(slotKey);
  }

  private killTerminal(terminalId: string, reason: string): void {
    if (!this.ptyClient) return;
    try {
      this.ptyClient.kill(terminalId, reason);
    } catch (err) {
      console.warn(
        "[HelpSessionService] Failed to kill displaced help PTY:",
        terminalId,
        reason,
        err
      );
    }
  }

  private removeTerminalFromMaps(terminalId: string): void {
    for (const [pid, tid] of this.activeHelpTerminalBySlotKey.entries()) {
      if (tid === terminalId) this.activeHelpTerminalBySlotKey.delete(pid);
    }
    for (const [sid, tid] of this.terminalBySessionId.entries()) {
      if (tid === terminalId) this.terminalBySessionId.delete(sid);
    }
  }

  async revokeByWebContentsId(webContentsId: number): Promise<void> {
    const targets = [...this.sessionsById.values()].filter(
      (record) => record.projectViewWebContentsId === webContentsId
    );
    // LRU eviction destroys the renderer for a project the user almost
    // certainly intends to return to — capture the agent's resume ID
    // before killing so the next open resumes the conversation.
    await Promise.all(
      targets.map((record) => this.revokeSession(record.sessionId, { captureHibernation: true }))
    );
  }

  async revokeByWindowId(windowId: number): Promise<void> {
    const targets = [...this.sessionsById.values()].filter(
      (record) => record.windowId === windowId
    );
    // Window close = user is done with this window but the project lives on
    // in other windows / future launches. Capture the resume ID so the next
    // open in any window picks the conversation back up.
    await Promise.all(
      targets.map((record) => this.revokeSession(record.sessionId, { captureHibernation: true }))
    );
  }

  /**
   * Three entry points capture-revoke a project's help sessions ahead of a
   * project-wide teardown: the idle-background auto-close sweep (#10830),
   * `project:sleep`, and `project:close` with `killTerminals` (#12181). All
   * three take the same conversation-preserving path as LRU eviction, so the
   * next open resumes where the user left off. The renderer's own hibernate
   * timer can't do this itself, because a parked project view freezes timers
   * (the #10739 class).
   *
   * The sweep never hands us a LIVE assistant: since #11807 it treats one as a
   * hard floor and skips the project entirely, because nothing tells main
   * whether an idle-looking assistant is merely at its prompt or sitting on a
   * scheduled wakeup. Its records are the non-live ones — a terminal that
   * exited under its own steam (nothing drops that binding), or a session
   * provisioned but never bound. Sleep and close are the opposite: the user
   * asked for the teardown, so a live assistant behind a still-live project
   * view is the normal case and the capture path really runs. That is what
   * makes the renderer's own no-capture revoke of the same session racing us
   * reachable, and why `revokeSession` finalizes only under the ownership flag.
   */
  async revokeByProjectId(projectId: string): Promise<void> {
    const targets = [...this.sessionsById.values()].filter(
      (record) => record.projectId === projectId
    );
    await Promise.all(
      targets.map((record) => this.revokeSession(record.sessionId, { captureHibernation: true }))
    );
  }

  async revokeAll(): Promise<void> {
    // App shutdown — no time to await gracefulKill round-trips, so we skip
    // capture. The cooperative renderer-side hibernate timer is the main
    // resume mechanism for clean shutdowns; this is the safety net.
    const targets = [...this.sessionsById.values()];
    await Promise.all(targets.map((record) => this.revokeSession(record.sessionId)));
    // Take-side stashes are launch-scoped and hold a resume id; nothing can
    // release one across a restart, so drop them rather than carry them to
    // shutdown. The persisted entries themselves are untouched (#11477).
    this.lastTakenBySlotKey.clear();
  }

  /**
   * Sweeps legacy per-launch session dirs left over from the old model
   * (UUID-named — no longer match the per-project path-hash naming). The
   * current per-project dirs persist indefinitely so the user's workspace-
   * trust acceptance carries across launches; we'll add a project-deletion
   * hook later when projects can be removed from Daintree.
   *
   * Project-hash dirs are kept, but their `.mcp.json` is checked for a
   * `daintree` entry whose Bearer token isn't in `sessionsByToken`. Tokens
   * never rehydrate across restarts, so any literal token left from a
   * previous boot is dead — strip it before a `claude` started in that
   * cwd (outside the help-panel flow) reads it and 401s.
   */
  async gcStaleSessions(): Promise<void> {
    const sessionsRoot = this.getSessionsRoot();
    let entries: string[];
    try {
      entries = await fs.readdir(sessionsRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn("[HelpSessionService] Failed to read sessions root for GC:", err);
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(sessionsRoot, entry);
        if (this.isProjectHashDirName(entry)) {
          await this.stripStaleDaintreeMcpEntry(entryPath);
          await this.sweepStaleLaneConfigs(entryPath);
          return;
        }
        // Everything else goes: per-launch UUID directories from the oldest
        // model, and the `<hash>-sN` per-lane directories that preceded the
        // shared one. Neither can be resumed from — their agents' resume ids
        // were captured against a cwd nothing launches in any more.
        await this.removeSessionDir(entryPath);
      })
    );
  }

  /**
   * Arm the periodic orphan-bearer sweep (#10698). Wired once at app boot from
   * `globalServicesInit`. Idempotent and a no-op after `dispose`. The timer is
   * `unref`'d so it never keeps the process alive on its own.
   */
  startOrphanSweep(): void {
    if (this.disposed || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        this.sweepOrphanSessions(ORPHAN_SESSION_MAX_AGE_MS);
      } catch (err) {
        console.warn("[HelpSessionService] Orphan-bearer sweep failed:", err);
      }
    }, ORPHAN_SESSION_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * Revoke every unrevoked session record that was minted more than `maxAgeMs`
   * ago but never bound to a PTY terminal — an orphaned provisional bearer
   * whose launch was abandoned without the renderer revoking its token. Bound
   * sessions (present in `terminalBySessionId`) are skipped regardless of age:
   * a healthy long-running assistant must never be swept. Snapshots the target
   * list before mutating so the `revokeSession` map deletes don't disturb the
   * iteration.
   */
  async sweepOrphanSessions(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const orphans = [...this.sessionsById.values()].filter(
      (record) =>
        !record.revoked &&
        !this.terminalBySessionId.has(record.sessionId) &&
        record.createdAt <= cutoff
    );
    await Promise.all(orphans.map((record) => this.revokeSession(record.sessionId)));
  }

  dispose(): void {
    this.disposed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    void this.revokeAll();
  }

  /**
   * Whether `name` is a session directory we own and must keep.
   *
   * Load-bearing: `gcStaleSessions` recursively DELETES every directory this
   * rejects. Only the bare project hash passes — every lane of a project shares
   * it — so both legacy shapes are collected: per-launch UUID directories from
   * the oldest model, and the `<hash>-sN` per-lane directories that preceded the
   * shared one. See `isAssistantSessionDirName` for why neither is worth keeping.
   */
  private isProjectHashDirName(name: string): boolean {
    return isAssistantSessionDirName(name, PROJECT_HASH_LEN);
  }

  /**
   * The MCP server module, imported lazily (it is a cycle at load time) and
   * exactly once. Two lanes provisioning at the same moment used to issue two
   * concurrent `import()`s of it, which is one more than the module system
   * guarantees to resolve identically — under vitest the second escaped the
   * module mock and loaded the real service. One shared promise, one import.
   */
  private mcpServerModule: Promise<typeof import("./McpServerService.js")> | null = null;

  private loadMcpServerModule(): Promise<typeof import("./McpServerService.js")> {
    this.mcpServerModule ??= import("./McpServerService.js");
    return this.mcpServerModule;
  }

  /** Serializes filesystem work on one project's shared session directory. */
  private readonly directoryLocks = new Map<string, Promise<void>>();

  private async withDirectoryLock<T>(pathHash: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.directoryLocks.get(pathHash);
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Same shape as `provisionLocks`: chain, remember the chained promise, and
    // only drop the entry if this call is still the tail.
    const tail = (previous ?? Promise.resolve()).then(() => next);
    this.directoryLocks.set(pathHash, tail);
    if (previous) await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.directoryLocks.get(pathHash) === tail) {
        this.directoryLocks.delete(pathHash);
      }
    }
  }

  private validateProvisionInput(input: ProvisionInput): void {
    if (!input || typeof input !== "object") {
      throw new Error("Invalid provision input");
    }
    if (typeof input.projectId !== "string" || !input.projectId.trim()) {
      throw new Error("projectId is required");
    }
    if (typeof input.projectPath !== "string" || !input.projectPath.trim()) {
      throw new Error("projectPath is required");
    }
    // Absent means slot 0 (pre-slot callers and fixtures). Present but invalid
    // is a caller bug: clamping it would silently displace whichever lane the
    // clamp landed on, which is exactly the cross-lane kill the slot key
    // exists to prevent.
    if (input.slot !== undefined && !isValidAssistantSlot(input.slot)) {
      throw new Error(
        `slot must be an integer in [0, ${ASSISTANT_SLOTS.length}) — got ${String(input.slot)}`
      );
    }
    if (!path.isAbsolute(input.projectPath)) {
      throw new Error("projectPath must be absolute");
    }
    if (!Number.isInteger(input.windowId) || input.windowId < 0) {
      throw new Error("windowId must be a non-negative integer");
    }
    if (!Number.isInteger(input.projectViewWebContentsId) || input.projectViewWebContentsId < 0) {
      throw new Error("projectViewWebContentsId must be a non-negative integer");
    }
    if (typeof input.agentId !== "string" || !input.agentId.trim()) {
      throw new Error("agentId is required");
    }
    // Use the wired list (stable + experimental) so an experimental-tier help
    // session can provision even though the picker (driven by the stable-only
    // list) keeps it hidden until promoted. Deprecated-tier agents (e.g.
    // gemini) are excluded here and cannot provision a help session.
    if (!getAssistantWiredAgentIds().includes(input.agentId)) {
      throw new Error(`agentId "${input.agentId}" is not assistant-supported`);
    }
  }

  private readSettings(): {
    daintreeControl: boolean;
    docSearch: boolean;
    tier: HelpAssistantTier;
    bypassPermissions: boolean;
    debugLogging: boolean;
  } {
    const stored = (store.get("helpAssistant") as Record<string, unknown> | undefined) ?? {};
    // Read-time migration from the legacy `skipPermissions` boolean. This
    // mirrors the IPC handler's `sanitizeStored` exactly — both must stay in
    // lockstep so a session provisioned during the same boot as a renderer
    // settings load reads identical values from the store.
    const legacySkip = typeof stored.skipPermissions === "boolean" ? stored.skipPermissions : null;
    const tier: HelpAssistantTier = isHelpAssistantTier(stored.tier)
      ? stored.tier
      : legacySkip !== null
        ? legacySkip
          ? "system"
          : "action"
        : DEFAULT_TIER;
    const bypassPermissions =
      typeof stored.bypassPermissions === "boolean"
        ? stored.bypassPermissions
        : legacySkip !== null
          ? legacySkip
          : DEFAULT_BYPASS_PERMISSIONS;
    return {
      daintreeControl:
        typeof stored.daintreeControl === "boolean"
          ? stored.daintreeControl
          : DEFAULT_DAINTREE_CONTROL,
      docSearch: typeof stored.docSearch === "boolean" ? stored.docSearch : DEFAULT_DOC_SEARCH,
      tier,
      bypassPermissions,
      debugLogging:
        typeof stored.debugLogging === "boolean" ? stored.debugLogging : DEFAULT_DEBUG_LOGGING,
    };
  }

  /**
   * Returns the per-session env vars for the assistant scratch folder.
   * Injected into the PTY spawn env for every help-session agent — Claude,
   * Codex, and Copilot all read env vars from their PTY parent, so this
   * single getter covers them all. Pairs with the markdown addendum
   * written into the session dir at provision time, which tells the agent
   * to use this dir for any temporary or scratch files. Returns null for
   * unknown / revoked tokens so the spawn handler skips the merge.
   */
  getAssistantScratchEnv(token: string): Record<string, string> | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    return { [ASSISTANT_SCRATCH_ENV_VAR]: record.scratchPath };
  }

  /**
   * Returns the snapshot of the user's CLI bypass preference taken at
   * provision time. `lifecycle.ts` reads this to decide whether to append
   * `--dangerously-skip-permissions` to the assistant spawn command —
   * decoupled from `tier` (which controls MCP capability) so the two
   * controls are truly orthogonal.
   */
  getBypassPermissions(token: string): boolean {
    if (!token) return false;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return false;
    return record.bypassPermissions;
  }

  /**
   * Returns the snapshot of the user's debug-logging preference taken at
   * provision time. `lifecycle.ts` reads this to decide whether to inject
   * `DAINTREE_ASSISTANT_DEBUG_LOG=1` into the assistant spawn env.
   */
  getDebugLogging(token: string): boolean {
    if (!token) return false;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return false;
    return record.debugLogging;
  }

  private getSessionsRoot(): string {
    return path.join(app.getPath("userData"), SESSIONS_DIR_NAME);
  }

  /**
   * Resolves once the in-process MCP server is bound and listening, OR
   * throws if it cannot be made ready. Daintree control on the assistant is
   * meaningless without a live MCP server, so we treat unreachable as a
   * hard launch failure rather than silently degrading the session.
   *
   * Defense-in-depth:
   *
   * - Force-enables the persisted `mcpServer.enabled` flag if it's off. The
   *   shipped defaults can ship `daintreeControl: true` alongside
   *   `mcpServer.enabled: false`, so a fresh install would otherwise hit
   *   this path with the server disabled and `start()` would silently
   *   no-op (`McpServerService.start()` early-returns when `!isEnabled()`).
   *   The IPC handler for `helpAssistant.setSettings` couples the toggle
   *   going forward; this handles boot.
   * - Wires the help-token validator on `McpServerService`. The deferred
   *   `mcp-server` task in `windowServices.ts` also wires this — but the
   *   renderer can call `provisionSession` before that task drains, so we
   *   register here too. The setter is idempotent.
   */
  private async ensureMcpServerReady(): Promise<void> {
    if (!this.mcpRegistry) {
      throw new Error("MCP registry not yet wired (app still initializing)");
    }
    const { mcpServerService } = await this.loadMcpServerModule();
    mcpServerService.setHelpTokenValidator((token) => this.validateToken(token));
    mcpServerService.setHelpSessionWebContentsResolver((token) =>
      this.getWebContentsIdForToken(token)
    );
    mcpServerService.setHelpSessionActionContextResolver((token) =>
      this.getActionContextForToken(token)
    );
    mcpServerService.setHelpSessionIdResolver((token) => this.getSessionIdForToken(token));
    mcpServerService.setSessionIdResolver((terminalId) => this.getSessionIdForTerminal(terminalId));
    // Eager MCP-session teardown on revoke (#9151). Idempotent re-set.
    this.setOnMcpSessionRevoked((token) => mcpServerService.disconnectHelpBearer(token));
    if (!mcpServerService.isEnabled()) {
      // setEnabled() will only call start() internally if it has its own
      // `registry` already set — which it doesn't on cold boot if the
      // deferred `mcp-server` task hasn't drained yet. So we just persist
      // the enabled flag here and rely on the explicit start() below to
      // bind the server with our `mcpRegistry`.
      await mcpServerService.setEnabled(true);
    }
    if (!mcpServerService.isRunning) {
      await mcpServerService.start(this.mcpRegistry);
    }
    if (!mcpServerService.isRunning) {
      const snapshot = mcpServerService.getRuntimeState();
      throw new Error(
        snapshot.lastError ?? "MCP server is not running (state: " + snapshot.state + ")"
      );
    }

    // `isRunning` only proves the OS socket is bound. Issue an active
    // self-probe (real `initialize` round-trip with the bearer) so we
    // don't write `.mcp.json` and launch the assistant against a server
    // that hangs or 500s on the first request.
    //
    // Probe targets `/mcp` (Streamable HTTP) before the help token exists.
    // After the session record is registered, `doProvision()` also probes
    // `/sse` with the freshly minted assistant bearer that Claude will use.
    const port = mcpServerService.currentPort;
    const apiKey = mcpServerService.currentApiKey;
    if (port === null || !apiKey) {
      throw new Error("MCP server is running but port or API key is unavailable");
    }
    await probeMcpServer(port, apiKey);
  }

  /**
   * Best-effort: persist a `mcp-not-ready` turn-outcome record so the audit
   * captures pre-turn provisioning failures alongside FSM-driven outcomes.
   * Swallows errors — the audit write must never mask the original
   * `HelpSessionError` the caller is about to throw.
   */
  private async recordMcpNotReady(sessionId: string | null, detail: string): Promise<void> {
    try {
      const { mcpServerService } = await this.loadMcpServerModule();
      mcpServerService.recordTurnOutcome({
        outcome: "mcp-not-ready",
        sessionId,
        detail,
      });
    } catch (err) {
      console.warn("[HelpSessionService] Failed to record mcp-not-ready outcome:", err);
    }
  }

  private async getMcpPort(daintreeControl: boolean): Promise<number | null> {
    if (!daintreeControl) return null;
    try {
      const { mcpServerService } = await this.loadMcpServerModule();
      return mcpServerService.currentPort;
    } catch {
      return null;
    }
  }

  /**
   * Writes a Claude lane's MCP wiring, and returns the path of the per-lane
   * `--mcp-config` file that carries it.
   *
   * Two files, deliberately. The shared `<sessionPath>/.mcp.json` is written
   * EMPTY: it is one file for every lane of the project, so nothing lane-
   * specific can live in it, and a project-scoped `.mcp.json` with servers in
   * it is also what raises Claude's per-folder approval prompt. Everything —
   * the docs server and the daintree control server with this lane's literal
   * bearer — goes into `<sessionPath>/.lanes/slot-N.mcp.json` instead, handed
   * to the CLI with `--mcp-config`. Servers supplied that way are caller input
   * and raise no approval prompt, and they merge with the (empty) project file.
   */
  private async writeClaudeMcpConfig(
    sessionPath: string,
    slot: number,
    sessionId: string,
    settings: { daintreeControl: boolean; docSearch: boolean },
    port: number | null,
    token: string
  ): Promise<string> {
    const mcpServers: Record<string, unknown> = {};
    if (settings.docSearch) {
      mcpServers["daintree-docs"] = {
        type: "http",
        url: "https://daintree.org/api/mcp",
      };
    }
    if (settings.daintreeControl && port) {
      // Bake the literal token into the file rather than `${DAINTREE_MCP_TOKEN}`
      // substitution. Claude Code's `${VAR}` substitution in `headers` is still
      // broken as of v2.1.83 through v2.1.133 (tested May 2026): the placeholder
      // is not forwarded to the wire (anthropics/claude-code#6204). Worse,
      // `claude mcp add`/`claude mcp remove` rewrite `${VAR}` to its literal env
      // value when they touch `.mcp.json` (#18692, #57131), so env substitution
      // would leak every session bearer to disk the moment a user runs either
      // subcommand. The literal-token path avoids that class of leak entirely.
      // (Separately, #28293 drops headers on SSE-transport POSTs regardless of
      // literal-vs-substituted value — a known limitation neither path fixes.)
      // Same reason as McpPaneConfigService.ts. The session dir is 0o700 and the
      // file is 0o600. Token rotates on every provision; the in-memory map is
      // the auth boundary, so the literal on disk is dead the moment its session
      // is revoked.
      mcpServers["daintree"] = {
        type: "sse",
        url: `http://127.0.0.1:${port}/sse`,
        headers: { Authorization: `Bearer ${token}` },
      };
    }
    const laneDir = path.join(sessionPath, ASSISTANT_LANE_CONFIG_DIR);
    await fs.mkdir(laneDir, { recursive: true, mode: 0o700 });
    await fs.chmod(laneDir, 0o700).catch(() => {});
    const lanePath = path.join(laneDir, assistantLaneMcpConfigName(slot, sessionId));
    await resilientAtomicWriteFile(
      lanePath,
      JSON.stringify({ mcpServers }, null, 2) + "\n",
      "utf-8",
      { mode: 0o600 }
    );
    // The shared project file. The bundled template ships one with the docs
    // server in it; that is what the approval prompt was for, so it is
    // overwritten with nothing rather than left to prompt.
    await resilientAtomicWriteFile(
      path.join(sessionPath, ".mcp.json"),
      JSON.stringify({ mcpServers: {} }, null, 2) + "\n",
      "utf-8",
      { mode: 0o600 }
    );
    return lanePath;
  }

  /**
   * Returns the cached `--mcp-config` flag pair for a Claude help session.
   * lifecycle.ts appends it to the spawn command after the help token
   * validates. Returns null for unknown / revoked tokens or non-Claude
   * sessions, so the spawn handler never injects the flag for the wrong agent.
   */
  getClaudeLaunchArgs(token: string): string[] | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    if (record.agentId !== "claude") return null;
    return record.claudeLaunchArgs ?? [];
  }

  /**
   * Removes the per-lane `--mcp-config` file, if any. Called on revoke — the
   * bearer in it is dead the moment its session is — and from GC for lane
   * files whose bearer is no longer in `sessionsByToken`.
   */
  private async removeLaneMcpConfig(lanePath: string | undefined): Promise<void> {
    if (!lanePath) return;
    try {
      await fs.rm(lanePath, { force: true });
    } catch (err) {
      console.warn("[HelpSessionService] Failed to remove lane MCP config:", lanePath, err);
    }
  }

  /**
   * Sweeps `<sessionPath>/.lanes/` of every file whose session isn't live.
   * Keyed on the session id in the file NAME, so a docs-only file with no
   * bearer in it is judged the same way as one with, and nothing has to parse
   * a credential out of a file to decide its fate. Sessions never rehydrate
   * across restarts, so after a boot every lane file on disk is dead until its
   * lane re-provisions and writes a new one. Anything in the directory that is
   * not a lane file at all is removed too — nothing else is supposed to be there.
   */
  private async sweepStaleLaneConfigs(sessionPath: string): Promise<void> {
    const laneDir = path.join(sessionPath, ASSISTANT_LANE_CONFIG_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(laneDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn("[HelpSessionService] Failed to read lane config dir for GC:", laneDir, err);
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const sessionId = sessionIdFromLaneMcpConfigName(entry);
        const live = sessionId ? this.sessionsById.get(sessionId) : undefined;
        if (live && !live.revoked) return;
        await this.removeLaneMcpConfig(path.join(laneDir, entry));
      })
    );
  }

  /**
   * Writes `<sessionPath>/.mcp.json` for a Copilot help session. Copilot's
   * MCP discovery is CWD-only and the file shape is `{ mcpServers: { name: {
   * type: "http", url, headers } } }`. Auth uses Copilot's native env-var
   * substitution (`$VAR`, single-dollar form) so the literal session token
   * never lands on disk — the bearer is delivered through
   * `DAINTREE_MCP_TOKEN` in PTY spawn env.
   */
  private async writeCopilotMcpConfig(
    sessionPath: string,
    settings: { daintreeControl: boolean; docSearch: boolean },
    port: number | null
  ): Promise<void> {
    const mcpServers: Record<string, unknown> = {};
    if (settings.docSearch) {
      mcpServers["daintree-docs"] = {
        type: "http",
        url: "https://daintree.org/api/mcp",
      };
    }
    if (settings.daintreeControl && port) {
      mcpServers["daintree"] = {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${COPILOT_BEARER_PLACEHOLDER}` },
      };
    }
    const target = path.join(sessionPath, ".mcp.json");
    await resilientAtomicWriteFile(
      target,
      JSON.stringify({ mcpServers }, null, 2) + "\n",
      "utf-8",
      { mode: 0o600 }
    );
  }

  private async writeClaudeSettings(
    sessionPath: string,
    bundledHelpFolder: string,
    settings: { daintreeControl: boolean; bypassPermissions: boolean }
  ): Promise<void> {
    const bundledSettingsPath = path.join(bundledHelpFolder, ".claude", "settings.json");
    const baseline = await this.readBundledSettings(bundledSettingsPath);

    const merged = deepClonePlainJson(baseline);
    if (!merged.permissions) merged.permissions = {};
    if (!Array.isArray(merged.permissions.allow)) merged.permissions.allow = [];
    // A malformed bundled file could pass the object guard in
    // readBundledSettings with a non-array deny (e.g. the bare string
    // "Bash(**)"). Claude Code's handling of a non-array deny is undefined,
    // so normalize it here the same way we normalize allow.
    if (!Array.isArray(merged.permissions.deny)) merged.permissions.deny = [];

    if (settings.daintreeControl && !merged.permissions.allow.includes("mcp__daintree__*")) {
      merged.permissions.allow.push("mcp__daintree__*");
    }

    // Auto-trust the project-scoped MCP servers we wrote into the session-dir
    // .mcp.json. Without this, Claude Code prompts the user to approve each
    // server interactively on first launch, which would block the assistant.
    merged.enableAllProjectMcpServers = true;

    // Always assign defaultMode explicitly so a baseline change (or a future
    // bundled template that ships with `defaultMode` set) can never silently
    // bypass permissions when the user has bypass off.
    if (settings.bypassPermissions) {
      merged.defaultMode = "bypassPermissions";
    } else {
      delete merged.defaultMode;
    }

    const target = path.join(sessionPath, ".claude", "settings.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await resilientAtomicWriteFile(target, JSON.stringify(merged, null, 2) + "\n", "utf-8", {
      mode: 0o600,
    });
  }

  private async readBundledSettings(settingsPath: string): Promise<BundledClaudeSettings> {
    try {
      const raw = await fs.readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as BundledClaudeSettings;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // fall through to baseline
    }
    return {
      permissions: {
        allow: [
          // `Read(...)` covers every file-reading tool (Glob, Grep, LS).
          // Separate `Glob(**)`/`Grep(**)`/`LS(**)` entries are never matched
          // by the file permission checks and make Claude Code print a warning
          // on every session start.
          "Read(**)",
          "WebFetch",
          "mcp__daintree-docs__*",
          "Bash(gh *)",
          "Bash(glab *)",
          "Bash(tea *)",
        ],
        deny: [
          // `Edit(...)` covers every file-editing tool (Write, NotebookEdit,
          // MultiEdit). Separate `Write(**)`/`NotebookEdit(**)` entries are
          // never matched by the file permission checks and make Claude Code
          // print a warning on every session start.
          "Edit(**)",
          "Bash(gh issue create*)",
          "Bash(gh pr create*)",
          "Bash(gh pr merge*)",
          "Bash(gh repo create*)",
          "Bash(gh repo delete*)",
          "Bash(glab issue create*)",
          "Bash(glab mr create*)",
          "Bash(glab mr merge*)",
          "Bash(tea issue create*)",
          "Bash(tea issues create*)",
          "Bash(tea pr create*)",
          "Bash(tea pulls create*)",
          "Bash(tea pulls merge*)",
        ],
      },
    };
  }

  /**
   * Writes the assistant-scratch addendum block into each per-agent markdown
   * file in the session dir (`CLAUDE.md`, `AGENTS.md`). The block is bracketed
   * by `<!-- DAINTREE_ASSISTANT_SCRATCH_START -->` /
   * `<!-- DAINTREE_ASSISTANT_SCRATCH_END -->` markers so re-provision replaces
   * it in place instead of appending duplicates. We write to both
   * unconditionally rather than agent-specific because:
   *
   *   - The session dir is per-project and reused across launches, so the
   *     same dir may have been provisioned for a different agent last time.
   *     A stale addendum in the "wrong" file would point at a now-deleted
   *     scratch dir (the cleanup sweep nukes prior-instance subdirs every
   *     boot).
   *   - The bundled help template has both files in it anyway, so any
   *     agent that happens to read the wrong file gets correct guidance.
   *
   * Copilot doesn't have a dedicated `COPILOT.md` and currently relies on
   * env-only injection — recent Copilot CLI does read `AGENTS.md` from cwd,
   * so the AGENTS.md addendum doubles as Copilot's instruction surface.
   *
   * The file MUST already exist (copied by `fs.cp` from the help template).
   * If the template hash gate skipped the copy but the file is somehow
   * missing (manual deletion), we log and skip rather than fabricating one.
   */
  private async writeScratchAddendum(sessionPath: string, scratchPath: string): Promise<void> {
    const addendum = this.buildScratchAddendum(scratchPath);
    const targets = ["CLAUDE.md", "AGENTS.md"];
    await Promise.all(
      targets.map((name) =>
        this.replaceOrAppendScratchBlock(path.join(sessionPath, name), addendum)
      )
    );
  }

  private buildScratchAddendum(_scratchPath: string): string {
    // No literal path. This block lives in the CLAUDE.md / AGENTS.md that every
    // lane of the project shares, while the scratch folder is per session — so a
    // literal path here is whichever lane provisioned last, and the other lanes
    // would be told to write into a folder that is not theirs. The env var is
    // set per PTY and is always this lane's own.
    return [
      "## Assistant Scratch Folder",
      "",
      `You have a dedicated scratch folder for any temporary or working files you need to create. Its path is in the environment variable \`${ASSISTANT_SCRATCH_ENV_VAR}\`; read that variable rather than assuming a location.`,
      "",
      "Use this folder — not the project workspace, not the system temp dir — for any notes, drafts, intermediate output, or other scratch work. The folder is cleared on every Daintree launch, so don't put anything you want to keep there.",
      "",
    ].join("\n");
  }

  private async replaceOrAppendScratchBlock(filePath: string, addendum: string): Promise<void> {
    const start = "<!-- DAINTREE_ASSISTANT_SCRATCH_START -->";
    const end = "<!-- DAINTREE_ASSISTANT_SCRATCH_END -->";
    const block = `${start}\n${addendum}${end}\n`;

    let existing: string;
    try {
      existing = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn("[HelpSessionService] Scratch addendum target missing; skipping:", filePath);
        return;
      }
      throw err;
    }

    // Replace existing block if present (preserves surrounding content);
    // otherwise append with a leading blank line so the marker isn't glued
    // to the end of the prior section.
    const startIdx = existing.indexOf(start);
    const endIdx = existing.indexOf(end);
    let next: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + end.length).replace(/^\n/, "");
      next = `${before}${block}${after}`;
    } else {
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      next = `${existing}${separator}${block}`;
    }

    if (next === existing) return;
    await resilientAtomicWriteFile(filePath, next, "utf-8", { mode: 0o600 });
  }

  private async writeSessionMeta(sessionPath: string, meta: SessionMeta): Promise<void> {
    const target = path.join(sessionPath, META_FILE_NAME);
    await resilientAtomicWriteFile(target, JSON.stringify(meta, null, 2) + "\n", "utf-8", {
      mode: 0o600,
    });
  }

  private async removeSessionDir(sessionPath: string): Promise<void> {
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
    } catch (err) {
      console.warn("[HelpSessionService] Failed to remove session dir:", sessionPath, err);
    }
  }

  /**
   * Removes the `daintree` MCP entry from `<sessionPath>/.mcp.json` if its
   * Bearer token isn't in `sessionsByToken`. Race-safe against a concurrent
   * provision: a fresh provision writes a *different* token which IS in
   * the map, so the "missing from map" check skips it.
   */
  private async stripStaleDaintreeMcpEntry(sessionPath: string): Promise<void> {
    const target = path.join(sessionPath, ".mcp.json");
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn(
        "[HelpSessionService] Failed to read .mcp.json for stale-token strip:",
        target,
        err
      );
      return;
    }
    let parsed: { mcpServers?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    } catch {
      return;
    }
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object") return;
    const entry = servers["daintree"] as { headers?: { Authorization?: string } } | undefined;
    if (!entry) return;
    const auth = entry.headers?.Authorization ?? "";
    const match = /^Bearer\s+(.+)$/.exec(auth);
    const token = match?.[1]?.trim();
    // Copilot never writes a literal bearer — `writeCopilotMcpConfig` emits the
    // `$DAINTREE_MCP_TOKEN` placeholder, which is substituted from PTY env at
    // spawn. Matching it against the token map always misses, so an unrevoked
    // Copilot session owning this exact directory would have its own live
    // config stripped out from under it.
    // Narrowed to Copilot: a Claude session owning the directory does not make
    // a leftover Copilot entry legitimate, and keeping one would leave Claude
    // with a stale server it cannot authenticate against.
    const ownedByLiveCopilot = [...this.sessionsByToken.values()].some(
      (record) =>
        !record.revoked && record.agentId === "copilot" && record.sessionPath === sessionPath
    );
    if (token === COPILOT_BEARER_PLACEHOLDER && ownedByLiveCopilot) return;

    // Otherwise a token is only live FOR THIS DIRECTORY. Lanes share their
    // project's directory, so a live bearer here belongs to one of this
    // project's lanes; one belonging to another project is misplaced, not live
    // — keeping it would leave a working credential in a directory its session
    // never owned, which is the stray-`claude`-in-cwd hole this strip exists to
    // close. Claude's own bearers no longer land in this file at all (they ride
    // in per-lane `--mcp-config` files), so the only literal ones left to find
    // are from installs that predate that.
    const live = token ? this.sessionsByToken.get(token) : undefined;
    if (live && live.sessionPath === sessionPath) return;

    delete servers["daintree"];
    try {
      await resilientAtomicWriteFile(target, JSON.stringify(parsed, null, 2) + "\n", "utf-8", {
        mode: 0o600,
      });
    } catch (err) {
      console.warn(
        "[HelpSessionService] Failed to strip stale daintree entry from .mcp.json:",
        target,
        err
      );
    }
  }
}

export const helpSessionService = new HelpSessionService();
