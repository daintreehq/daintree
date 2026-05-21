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
import type { PendingHelpHibernationStore } from "./PendingHelpHibernationStore.js";

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
// Stamp file written into the per-project session dir after a successful
// `fs.cp` of the bundled help template. Lives inside the session dir (not
// inside `helpFolder`), so it's never part of the source being hashed and
// gets reaped along with the dir. Filename starts with `.` so it's hidden
// from casual `ls` and unlikely to collide with anything the help template
// might grow to ship.
const TEMPLATE_HASH_FILE = ".template-hash";

const DEFAULT_TIER: HelpAssistantTier = "action";
const DEFAULT_DAINTREE_CONTROL = true;
const DEFAULT_DOC_SEARCH = true;
const DEFAULT_BYPASS_PERMISSIONS = false;

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
  /** Computed at provision for gemini sessions; consumed by lifecycle.ts. */
  geminiLaunchArgs?: string[];
  /** Computed at provision for copilot sessions; consumed by lifecycle.ts. */
  copilotLaunchArgs?: string[];
  /**
   * Per-session scratch directory under
   * `userData/assistant-scratch/<instanceId>/<sessionId>/`. Cleared on every
   * app start; injected into the PTY spawn env as `DAINTREE_ASSISTANT_SCRATCH_DIR`
   * and mentioned in the per-agent CLAUDE.md / AGENTS.md / GEMINI.md addendum.
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

interface BundledGeminiSettings {
  toolsAllowlist?: string[];
  mcpServers?: Record<string, unknown>;
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
 * code so the renderer can match-and-display without parsing prose. Today
 * the only non-validation code is `MCP_NOT_READY` — used when Daintree
 * control is enabled but the in-process MCP server cannot be made ready,
 * which would otherwise launch the assistant with a broken MCP wiring.
 */
export class HelpSessionError extends Error {
  readonly code: "MCP_NOT_READY";
  constructor(code: "MCP_NOT_READY", message: string) {
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
  // Single-backend invariant (#7509): at most one assistant PTY per project
  // at any given time. The renderer's cooperative cleanup paths (removePanel,
  // gracefulKill on hibernate, visibilitychange tearDown) are fire-and-forget
  // and can drop the kill IPC, leaving an orphan PTY that keeps dispatching
  // MCP tool calls under a still-valid bearer. These maps let the main process
  // displace prior backends regardless of what the renderer did.
  private readonly activeHelpTerminalByProjectId = new Map<string, string>();
  private readonly terminalBySessionId = new Map<string, string>();
  private mcpRegistry: WindowRegistry | null = null;
  private ptyClient: PtyKillClient | null = null;
  private pendingHibernationStore: PendingHelpHibernationStore | null = null;
  private disposed = false;

  setMcpRegistry(registry: WindowRegistry): void {
    this.mcpRegistry = registry;
  }

  setPtyClient(client: PtyKillClient | null): void {
    this.ptyClient = client;
  }

  setPendingHibernationStore(store: PendingHelpHibernationStore | null): void {
    this.pendingHibernationStore = store;
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

    const existingTerminal = this.activeHelpTerminalByProjectId.get(record.projectId);
    if (existingTerminal && existingTerminal !== terminalId) {
      this.killTerminal(existingTerminal, "help-session-displaced");
      this.removeTerminalFromMaps(existingTerminal);
    }

    this.activeHelpTerminalByProjectId.set(record.projectId, terminalId);
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
   * Reports whether `terminalId` is currently the active help-session PTY
   * for any project. The PtyEventRouter's `terminal-pid` callback uses this
   * to filter help-session terminals into the Windows Job Object so the OS
   * reaps the agent tree on a hard Daintree crash (#7526). Returns false
   * once the binding is dropped (revoke / displace / unbind) — a late PID
   * arrival for a torn-down session is treated as a non-help terminal.
   */
  isHelpTerminal(terminalId: string): boolean {
    if (!terminalId) return false;
    for (const boundId of this.activeHelpTerminalByProjectId.values()) {
      if (boundId === terminalId) return true;
    }
    return false;
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
   * On every call:
   *   1. Copy the bundled help/ template into the dir (overwrites — picks up
   *      bundled-asset updates without losing the trust acceptance).
   *   2. Overwrite .mcp.json with a fresh literal-token Authorization header.
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

    const pathHash = projectPathHash(input.projectPath);
    const previous = this.provisionLocks.get(pathHash);
    let resolveLock!: () => void;
    const next = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.provisionLocks.set(
      pathHash,
      (previous ?? Promise.resolve()).then(() => next)
    );
    if (previous) await previous;

    try {
      return await this.doProvision(input, helpFolder, pathHash);
    } finally {
      resolveLock();
      // Drop the lock entry once it resolves so the map doesn't grow without
      // bound. Anyone awaiting `previous` already has the resolved promise.
      if (this.provisionLocks.get(pathHash) === next) {
        this.provisionLocks.delete(pathHash);
      }
    }
  }

  private async doProvision(
    input: ProvisionInput,
    helpFolder: string,
    pathHash: string
  ): Promise<ProvisionResult | null> {
    const settings = this.readSettings();
    const tier = settings.tier;
    const sessionId = randomUUID();
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const sessionsRoot = this.getSessionsRoot();
    const sessionPath = path.join(sessionsRoot, pathHash);

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
          "MCP_NOT_READY",
          `Daintree Assistant needs the in-process MCP server, but it isn't ready: ${reason}`
        );
      }
    }

    // Single-backend invariant (#7509): displace any prior unrevoked record
    // for this project BEFORE writing a fresh `.mcp.json`. The bearer is
    // marked revoked first so any in-flight MCP call from the orphan 401s
    // before the kill IPC reaches the PTY host. Runs inside `provisionLocks`
    // (per pathHash), so concurrent provisions for the same project see this
    // as an atomic step. The renderer still calls `revokeHelpSession` from
    // its cooperative cleanup paths — this enforcement is defense-in-depth
    // for when those paths drop the kill or never fire (crash, project
    // switch, hibernate race).
    this.displacePriorSessions(input.projectId);

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
    if (input.agentId === "claude") {
      await this.writeMcpConfig(sessionPath, settings, port, token);
      await this.writeClaudeSettings(sessionPath, helpFolder, settings);
    } else if (input.agentId === "copilot") {
      await this.writeCopilotMcpConfig(sessionPath, settings, port);
    } else if (input.agentId === "gemini") {
      await this.writeGeminiSettings(sessionPath, helpFolder, settings, port);
      // The bundled `.mcp.json` still gets copied into the session via
      // `fs.cp`; ensure no Claude-shaped daintree entry (with a literal
      // dead bearer) survives from a prior provision under this same
      // sessionPath.
      await this.stripStaleDaintreeMcpEntry(sessionPath);
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
    // Codex doesn't read project-scoped `.codex/config.toml` from cwd —
    // its only mechanism for overriding the global config is the `-c key=value`
    // CLI flag (verified against codex-cli 0.129.0). MCP servers are appended
    // to the spawn command in `lifecycle.ts` via the `getCodexLaunchArgs`
    // accessor below; nothing is written to disk for Codex.
    //
    // Gemini reads `<sessionPath>/.gemini/settings.json` (written above by
    // `writeGeminiSettings`). The workspace-level settings file takes
    // precedence over `~/.gemini/settings.json` for same-name MCP entries
    // (Gemini's merge order: workspace > user), which gives us the
    // isolation we need without redirecting `os.homedir()` — see
    // `getGeminiSpawnEnv` for why `GEMINI_CLI_HOME` is intentionally not
    // injected. The `--approval-mode=plan` flag is appended at spawn time
    // via `getGeminiLaunchArgs` because it is a CLI flag, not a settings
    // key.
    //
    // Copilot reads `<sessionPath>/.mcp.json` (written above by
    // `writeCopilotMcpConfig`). The `--plan` read-only flag is appended at
    // spawn time via `getCopilotLaunchArgs`.

    const codexLaunchArgs =
      input.agentId === "codex"
        ? this.buildCodexLaunchArgs(settings.daintreeControl, settings.docSearch, port)
        : undefined;
    const geminiLaunchArgs = input.agentId === "gemini" ? this.buildGeminiLaunchArgs() : undefined;
    const copilotLaunchArgs =
      input.agentId === "copilot" ? this.buildCopilotLaunchArgs() : undefined;

    const now = Date.now();
    const record: HelpSessionRecord = {
      sessionId,
      token,
      windowId: input.windowId,
      projectViewWebContentsId: input.projectViewWebContentsId,
      projectId: input.projectId,
      projectPath: input.projectPath,
      sessionPath,
      agentId: input.agentId,
      tier,
      bypassPermissions: settings.bypassPermissions,
      createdAt: now,
      revoked: false,
      actionContext: input.actionContext,
      codexLaunchArgs,
      geminiLaunchArgs,
      copilotLaunchArgs,
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
          // `.mcp.json`. Both probes warm the same in-memory MCP token
          // map, so neither leaks across agents.
          await probeMcpSseServer(port, token);
        } else {
          // Codex, Gemini, and Copilot all speak Streamable HTTP at /mcp.
          // Codex reads the bearer from `DAINTREE_MCP_TOKEN` PTY env via
          // `bearer_token_env_var`. Gemini and Copilot read the bearer
          // from PTY env via `${DAINTREE_MCP_TOKEN}` / `$DAINTREE_MCP_TOKEN`
          // substitution in their respective settings files.
          await probeMcpServer(port, token);
        }
      } catch (err) {
        record.revoked = true;
        this.sessionsByToken.delete(token);
        this.sessionsById.delete(sessionId);
        if (input.agentId === "claude" || input.agentId === "copilot") {
          await this.stripStaleDaintreeMcpEntry(sessionPath);
        }
        if (input.agentId === "gemini") {
          await this.stripStaleGeminiDaintreeEntry(sessionPath);
        }
        const reason = formatErrorMessage(err, "assistant MCP session isn't ready");
        await this.recordMcpNotReady(sessionId, reason);
        throw new HelpSessionError(
          "MCP_NOT_READY",
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
   * Builds the CLI flags that constrain a Gemini help-session spawn to
   * read-only behaviour. Phase 1 always pins `--approval-mode=plan` (strict
   * read-only — Gemini can only run context-gathering tools like `read_file`
   * and `glob`). The bundled `.gemini/settings.json` in the session cwd
   * carries the docs MCP entry and tool allowlist; nothing else needs to be
   * injected at spawn time.
   *
   * Verified flag spelling per Gemini CLI 0.x: `--approval-mode=plan` is the
   * canonical form and accepts the values `default`, `auto_edit`, `plan`,
   * and `yolo`.
   */
  private buildGeminiLaunchArgs(): string[] {
    return ["--approval-mode=plan"];
  }

  /**
   * Returns the cached CLI flags for a Gemini help session. lifecycle.ts
   * appends them to the spawn command after the help token validates.
   * Returns null for unknown / revoked tokens or non-Gemini sessions, so the
   * spawn handler never injects flags for the wrong agent.
   */
  getGeminiLaunchArgs(token: string): string[] | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    if (record.agentId !== "gemini") return null;
    return record.geminiLaunchArgs ?? [];
  }

  /**
   * Returns the per-session env vars that must be injected into the PTY
   * spawn for a Gemini help session. Today this is just a placeholder for
   * the per-session env contract; the daintree MCP entry travels with the
   * workspace-level `<sessionPath>/.gemini/settings.json` written at
   * provision time, which Gemini's merge precedence (workspace > user)
   * lets shadow same-name user-level entries without redirecting
   * `os.homedir()`. We intentionally do NOT set `GEMINI_CLI_HOME` here —
   * the CLI uses `os.homedir()` for OAuth credential lookup at
   * `~/.gemini/oauth_creds.json`, and redirecting it would break auth for
   * any user who hasn't set `GEMINI_API_KEY`. Returns null for unknown /
   * revoked tokens or non-Gemini sessions.
   */
  getGeminiSpawnEnv(token: string): Record<string, string> | null {
    if (!token) return null;
    const record = this.sessionsByToken.get(token);
    if (!record || record.revoked) return null;
    if (record.agentId !== "gemini") return null;
    return {};
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
   * next assistant open — but the literal bearer is stripped from
   * `.mcp.json` so a `claude` started outside the help-panel flow (e.g. a
   * stray terminal `cd`-ed into the session dir) can't keep authenticating
   * against the now-revoked record. The next provision rewrites a fresh
   * entry into the same file.
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

    // Capture FIRST (while the session record is still valid for token
    // lookups by the agent process). gracefulKill resolves with the agent's
    // resume ID once the agent flushes its transcript and exits. If
    // gracefulKill rejects or returns null (PTY already gone, host crashed,
    // agent didn't write a session file), we silently fall through to the
    // existing kill path — eviction completes either way, just without a
    // resume entry. A best-effort capture is strictly an improvement over
    // the previous behaviour of always losing the conversation.
    let capturedAgentSessionId: string | null = null;
    if (opts?.captureHibernation && terminalId && this.ptyClient) {
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
      if (
        !displacedDuringCapture &&
        this.activeHelpTerminalByProjectId.get(record.projectId) === terminalId
      ) {
        this.activeHelpTerminalByProjectId.delete(record.projectId);
      }
      if (!capturedAgentSessionId) {
        this.killTerminal(terminalId, "help-session-revoked");
      }
    }

    if (capturedAgentSessionId && this.pendingHibernationStore && !displacedDuringCapture) {
      void this.pendingHibernationStore
        .set(record.projectId, {
          agentId: record.agentId,
          agentSessionId: capturedAgentSessionId,
          cwd: record.sessionPath,
          capturedAt: Date.now(),
        })
        .catch((err) => {
          console.warn(
            "[HelpSessionService] Failed to persist pending hibernation:",
            record.projectId,
            err
          );
        });
    }

    // Claude bakes a literal session bearer into `.mcp.json`; Copilot
    // references the same file with `$DAINTREE_MCP_TOKEN` substitution.
    // Both need the daintree entry stripped on revoke so a stray agent
    // started outside the help-panel flow in that cwd can't keep talking
    // to the now-revoked MCP route. Gemini writes its entry into
    // `.gemini/settings.json` instead — strip that. Codex stores nothing
    // on disk (uses `-c` flags), so no file-strip is needed.
    if (record.agentId === "claude" || record.agentId === "copilot") {
      await this.stripStaleDaintreeMcpEntry(record.sessionPath);
    } else if (record.agentId === "gemini") {
      await this.stripStaleGeminiDaintreeEntry(record.sessionPath);
    }
  }

  /**
   * Reads and clears the main-captured pending hibernation entry for a
   * project. Called by the renderer at launch time to seed
   * `helpPanelStore.hibernateSessions[projectId]` from the entry main
   * captured on the prior eviction. The entry is one-shot — once read it's
   * dropped from the persistent store so a future cold launch without
   * intervening capture starts fresh.
   */
  async takePendingHibernation(projectId: string): Promise<{
    agentId: string;
    agentSessionId: string;
    cwd: string;
  } | null> {
    if (!this.pendingHibernationStore) return null;
    const entry = this.pendingHibernationStore.get(projectId);
    if (!entry) return null;
    await this.pendingHibernationStore.clear(projectId);
    return {
      agentId: entry.agentId,
      agentSessionId: entry.agentSessionId,
      cwd: entry.cwd,
    };
  }

  private displacePriorSessions(projectId: string): void {
    const priors = [...this.sessionsById.values()].filter(
      (record) => record.projectId === projectId && !record.revoked
    );
    for (const prior of priors) {
      prior.revoked = true;
      this.sessionsByToken.delete(prior.token);
      this.sessionsById.delete(prior.sessionId);
      const terminalId = this.terminalBySessionId.get(prior.sessionId);
      if (terminalId) {
        this.terminalBySessionId.delete(prior.sessionId);
        this.killTerminal(terminalId, "help-session-displaced");
      }
    }
    // Also clear any stale active-terminal binding the renderer never
    // confirmed via `markTerminalForToken` — leaving it would leak the
    // project's slot and cause the next `markTerminalForToken` to kill
    // the wrong PTY.
    this.activeHelpTerminalByProjectId.delete(projectId);
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
    for (const [pid, tid] of this.activeHelpTerminalByProjectId.entries()) {
      if (tid === terminalId) this.activeHelpTerminalByProjectId.delete(pid);
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

  async revokeAll(): Promise<void> {
    // App shutdown — no time to await gracefulKill round-trips, so we skip
    // capture. The cooperative renderer-side hibernate timer is the main
    // resume mechanism for clean shutdowns; this is the safety net.
    const targets = [...this.sessionsById.values()];
    await Promise.all(targets.map((record) => this.revokeSession(record.sessionId)));
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
          await this.stripStaleGeminiDaintreeEntry(entryPath);
          return;
        }
        await this.removeSessionDir(entryPath);
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    void this.revokeAll();
  }

  private isProjectHashDirName(name: string): boolean {
    return name.length === PROJECT_HASH_LEN && /^[0-9a-f]+$/.test(name);
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
    // Use the wired list (stable + experimental) so a Gemini help session
    // can provision even though the picker (driven by the stable-only list)
    // keeps it hidden until promoted.
    if (!getAssistantWiredAgentIds().includes(input.agentId)) {
      throw new Error(`agentId "${input.agentId}" is not assistant-supported`);
    }
  }

  private readSettings(): {
    daintreeControl: boolean;
    docSearch: boolean;
    tier: HelpAssistantTier;
    bypassPermissions: boolean;
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
    };
  }

  /**
   * Returns the per-session env vars for the assistant scratch folder.
   * Injected into the PTY spawn env for every help-session agent — Claude,
   * Codex, Gemini, and Copilot all read env vars from their PTY parent, so
   * this single getter covers all four. Pairs with the markdown addendum
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
    const { mcpServerService } = await import("./McpServerService.js");
    mcpServerService.setHelpTokenValidator((token) => this.validateToken(token));
    mcpServerService.setHelpSessionWebContentsResolver((token) =>
      this.getWebContentsIdForToken(token)
    );
    mcpServerService.setHelpSessionActionContextResolver((token) =>
      this.getActionContextForToken(token)
    );
    mcpServerService.setSessionIdResolver((terminalId) => this.getSessionIdForTerminal(terminalId));
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
      const { mcpServerService } = await import("./McpServerService.js");
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
      const { mcpServerService } = await import("./McpServerService.js");
      return mcpServerService.currentPort;
    } catch {
      return null;
    }
  }

  private async writeMcpConfig(
    sessionPath: string,
    settings: { daintreeControl: boolean; docSearch: boolean },
    port: number | null,
    token: string
  ): Promise<void> {
    const mcpServers: Record<string, unknown> = {};
    if (settings.docSearch) {
      mcpServers["daintree-docs"] = {
        type: "http",
        url: "https://daintree.org/api/mcp",
      };
    }
    if (settings.daintreeControl && port) {
      // Bake the literal token into the file rather than `${DAINTREE_MCP_TOKEN}`
      // substitution. Claude Code's env substitution in `headers` is broken
      // (sends the literal placeholder, gets 401). Same reason as
      // McpPaneConfigService.ts. The session dir is 0o700 and the file is
      // 0o600. Token rotates on every provision; the in-memory map is the
      // auth boundary, so the literal on disk is dead the moment its session
      // is revoked.
      mcpServers["daintree"] = {
        type: "sse",
        url: `http://127.0.0.1:${port}/sse`,
        headers: { Authorization: `Bearer ${token}` },
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
        headers: { Authorization: "Bearer $DAINTREE_MCP_TOKEN" },
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

  /**
   * Writes `<sessionPath>/.gemini/settings.json` for a Gemini help session.
   * Reads the bundled settings as a baseline (tool allowlist + the
   * `daintree-docs` MCP entry) and overlays the local `daintree` MCP entry
   * when daintreeControl is on. Uses `httpUrl` to select Streamable HTTP
   * transport (Gemini's `url` key is reserved for SSE) and Gemini's native
   * `${VAR}` env-var substitution for the bearer so no literal token lands
   * on disk.
   *
   * The session-dir settings file is workspace-scoped (Gemini reads it
   * because `cwd === sessionPath`). Workspace settings take precedence over
   * `~/.gemini/settings.json` for same-name MCP entries, so our daintree
   * entry shadows any user-level `daintree` server. We do NOT redirect
   * `os.homedir()` — see `getGeminiSpawnEnv` for the rationale.
   */
  private async writeGeminiSettings(
    sessionPath: string,
    bundledHelpFolder: string,
    settings: { daintreeControl: boolean; docSearch: boolean },
    port: number | null
  ): Promise<void> {
    const bundledSettingsPath = path.join(bundledHelpFolder, ".gemini", "settings.json");
    const baseline = await this.readBundledGeminiSettings(bundledSettingsPath);

    const merged = deepClonePlainJson(baseline);
    if (!merged.mcpServers || typeof merged.mcpServers !== "object") {
      merged.mcpServers = {};
    }
    const mcpServers = merged.mcpServers as Record<string, unknown>;

    if (!settings.docSearch) {
      delete mcpServers["daintree-docs"];
    }

    if (settings.daintreeControl && port) {
      mcpServers["daintree"] = {
        httpUrl: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: "Bearer ${DAINTREE_MCP_TOKEN}" },
        trust: true,
      };
    } else {
      delete mcpServers["daintree"];
    }

    const target = path.join(sessionPath, ".gemini", "settings.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await resilientAtomicWriteFile(target, JSON.stringify(merged, null, 2) + "\n", "utf-8", {
      mode: 0o600,
    });
  }

  private async readBundledGeminiSettings(settingsPath: string): Promise<BundledGeminiSettings> {
    try {
      const raw = await fs.readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as BundledGeminiSettings;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // fall through to baseline
    }
    return {
      toolsAllowlist: ["read_file", "list_directory", "search_files", "web_search", "shell"],
      mcpServers: {
        "daintree-docs": { httpUrl: "https://daintree.org/api/mcp", trust: true },
      },
    };
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
          "Read(**)",
          "Glob(**)",
          "Grep(**)",
          "LS(**)",
          "WebFetch",
          "mcp__daintree-docs__*",
          "Bash(gh *)",
          "Bash(glab *)",
          "Bash(tea *)",
        ],
        deny: [
          "Write(**)",
          "Edit(**)",
          "MultiEdit(**)",
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
   * file in the session dir (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`). The
   * block is bracketed by `<!-- DAINTREE_ASSISTANT_SCRATCH_START -->` /
   * `<!-- DAINTREE_ASSISTANT_SCRATCH_END -->` markers so re-provision replaces
   * it in place instead of appending duplicates. We write to all three
   * unconditionally rather than agent-specific because:
   *
   *   - The session dir is per-project and reused across launches, so the
   *     same dir may have been provisioned for a different agent last time.
   *     A stale addendum in the "wrong" file would point at a now-deleted
   *     scratch dir (the cleanup sweep nukes prior-instance subdirs every
   *     boot).
   *   - The bundled help template has all three files in it anyway, so any
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
    const targets = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];
    await Promise.all(
      targets.map((name) =>
        this.replaceOrAppendScratchBlock(path.join(sessionPath, name), addendum)
      )
    );
  }

  private buildScratchAddendum(scratchPath: string): string {
    return [
      "## Assistant Scratch Folder",
      "",
      `You have a dedicated scratch folder for any temporary or working files you need to create: \`${scratchPath}\`.`,
      "",
      `The same path is available in the environment variable \`${ASSISTANT_SCRATCH_ENV_VAR}\` for use in shell commands.`,
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
    if (token && this.sessionsByToken.has(token)) return;

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

  /**
   * Removes the `daintree` MCP entry from `<sessionPath>/.gemini/settings.json`.
   * Gemini's bearer is delivered via `${DAINTREE_MCP_TOKEN}` substitution
   * (not a literal in the file), so a stray `gemini` in this cwd would fail
   * authentication anyway — but stripping the entry is hygiene so the CLI
   * doesn't surface a configured-but-broken server. The `daintree-docs`
   * entry is preserved (session-independent). No-op on ENOENT.
   */
  private async stripStaleGeminiDaintreeEntry(sessionPath: string): Promise<void> {
    const target = path.join(sessionPath, ".gemini", "settings.json");
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn(
        "[HelpSessionService] Failed to read .gemini/settings.json for stale-entry strip:",
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
    if (!("daintree" in servers)) return;

    delete servers["daintree"];
    try {
      await resilientAtomicWriteFile(target, JSON.stringify(parsed, null, 2) + "\n", "utf-8", {
        mode: 0o600,
      });
    } catch (err) {
      console.warn(
        "[HelpSessionService] Failed to strip stale daintree entry from .gemini/settings.json:",
        target,
        err
      );
    }
  }
}

export const helpSessionService = new HelpSessionService();
