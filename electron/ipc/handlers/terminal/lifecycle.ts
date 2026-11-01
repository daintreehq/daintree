/**
 * Terminal lifecycle handlers - spawn, kill, trash, restore.
 */

import crypto from "crypto";
import { HELP_MCP_TOOL_TIMEOUT_MS } from "../../../../shared/types/replyWait.js";
import os from "os";
import { z } from "zod";
import { CHANNELS } from "../../channels.js";
import { waitForBurstRateLimitSlot, consumeRestoreQuota } from "../../utils.js";
import { defineIpcNamespace, op, opValidated } from "../../define.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { noteTerminalLaunch } from "../../../services/pty/agentSessionCapturePersistence.js";
import type * as McpServerServiceModule from "../../../services/McpServerService.js";
import {
  mcpPaneConfigService,
  type PanePluginServer,
} from "../../../services/McpPaneConfigService.js";
import { helpSessionService } from "../../../services/HelpSessionService.js";
import { isAssistantTerminalRecord } from "../../../services/assistantTerminal.js";
import {
  findUntouchedClaudeSession,
  rememberClaudePaneStore,
  resolvePaneClaudeProjectsRoot,
} from "../../../services/claude/ClaudeSessionStore.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import { getProjectIdFromSenderUrl } from "../../senderIdentity.js";
import {
  TerminalSpawnOptionsSchema,
  AgentSessionRetentionDaysSchema,
  PrepareBookmarkPayloadSchema,
  BookmarkMutatePayloadSchema,
  BookmarkDeletePayloadSchema,
  ListBookmarksPayloadSchema,
} from "../../../schemas/ipc.js";
import { store } from "../../../store.js";
import { AppError } from "../../../utils/errorTypes.js";
import { armSpawnConfirmation, settleSpawnConfirmation } from "./spawnConfirmation.js";
import type {
  AgentSessionBookmarkMetadata,
  AgentSessionRecord,
  AgentSessionRetentionDays,
} from "../../../../shared/types/ipc/agentSessionHistory.js";
import type { HostMemoryPauseSnapshot } from "../../../../shared/types/pty-host.js";
import { resolveDaintreeMcpTier, type ProjectSettings } from "../../../../shared/types/project.js";
import {
  normalizeTerminalGridDimension,
  type TerminalKillOptions,
} from "../../../../shared/types/terminal.js";
import {
  DEFAULT_DANGEROUS_ARGS,
  relaunchResumeAsAssignedSession,
  supportsExactSessionCapture,
  supportsSessionIdAssignment,
} from "../../../../shared/types/agentSettings.js";
import {
  declaresActiveAssistantTier,
  getAssistantWiredAgentIds,
  getEffectiveAgentConfig,
} from "../../../../shared/config/agentRegistry.js";
import { getPluginIdForAgent } from "../../../../shared/config/pluginAgentRegistry.js";
import {
  SettingTemplateError,
  substituteSettingsTemplates,
} from "../../../services/settingsTemplateResolver.js";
import type * as PluginServiceModule from "../../../services/PluginService.js";
import {
  isAgentMcpScopeAllowed,
  isAssistantAgentMcpScopeAllowed,
} from "../../../services/pluginAgentMcp/projectEnablement.js";
import {
  classifyRequiredPluginTools,
  resolveLaunchPlugins,
  resolveLaunchPluginsReport,
  type LaunchPlugin,
} from "../../../services/pluginAgentMcp/launchPlugins.js";
import {
  forgetPluginToolsLaunch,
  recordPluginToolsLaunch,
} from "../../../services/pluginAgentMcp/agentLaunchRecords.js";
import type { RequiredPluginToolStatus } from "../../../../shared/types/ipc/pluginAgentMcp.js";
import { pluginManifestIdFromInstanceKey } from "../../../../shared/types/plugin.js";
import { describeMissingPluginTools } from "../../../../shared/utils/requiredPluginTools.js";
import { pluginMcpGrantRegistry } from "../../../services/pluginAgentMcp/grantRegistry.js";

type ValidatedTerminalSpawnOptions = z.output<typeof TerminalSpawnOptionsSchema>;

const TERMINAL_SPAWN_INTERVAL_MS = 1_000;
const TERMINAL_SPAWN_BURST = 6;
const RECIPE_SPAWN_BATCH_TTL_MS = 30_000;

interface RecipeSpawnBatchAdmission {
  expectedSize: number;
  claimed: number;
  gate: Promise<void>;
}

const recipeSpawnBatchAdmissions = new Map<string, RecipeSpawnBatchAdmission>();

function claimRecipeSpawnBatchAdmission(
  options: ValidatedTerminalSpawnOptions
): Promise<void> | null {
  const batchId = options.spawnBatchId;
  const batchSize = options.spawnBatchSize;
  if (!batchId || !batchSize || batchSize > MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH) return null;

  const existing = recipeSpawnBatchAdmissions.get(batchId);
  if (existing) {
    if (existing.expectedSize !== batchSize || existing.claimed >= existing.expectedSize) {
      return null;
    }
    existing.claimed++;
    return existing.gate;
  }

  const gate = waitForBurstRateLimitSlot("terminalRecipeSpawnBatch", TERMINAL_SPAWN_INTERVAL_MS, 1);
  const admission: RecipeSpawnBatchAdmission = {
    expectedSize: batchSize,
    claimed: 1,
    gate,
  };
  recipeSpawnBatchAdmissions.set(batchId, admission);

  const expiry = setTimeout(() => {
    if (recipeSpawnBatchAdmissions.get(batchId) === admission) {
      recipeSpawnBatchAdmissions.delete(batchId);
    }
  }, RECIPE_SPAWN_BATCH_TTL_MS);
  expiry.unref();

  return gate;
}

async function waitForTerminalSpawnAdmission(
  options: ValidatedTerminalSpawnOptions
): Promise<void> {
  const recipeBatchGate = claimRecipeSpawnBatchAdmission(options);
  if (recipeBatchGate) {
    await recipeBatchGate;
    return;
  }
  await waitForBurstRateLimitSlot(
    "terminalSpawn",
    TERMINAL_SPAWN_INTERVAL_MS,
    TERMINAL_SPAWN_BURST
  );
}

// Lazy cached accessor (same pattern as `helpAssistant.ts`) — the MCP server
// stack is ~637KB and only needed for agent launches that are handed Daintree's
// MCP servers (a non-"off" tier, or a plugin with agent tools on), so keep it
// out of this module's static import set (it loads eagerly at boot).
type McpServerSingleton = typeof McpServerServiceModule.mcpServerService;

let cachedMcpServerService: McpServerSingleton | null = null;
async function getMcpServerService(): Promise<McpServerSingleton> {
  if (!cachedMcpServerService) {
    const mod = await import("../../../services/McpServerService.js");
    cachedMcpServerService = mod.mcpServerService;
  }
  return cachedMcpServerService;
}

// Wiring of the pane-token resolvers: an agent pane's launch-workspace binding
// (#12486), and the principal a pane bearer's resource ownership is held under,
// with the revocation that drops it (#12487). Help-session resolvers are wired in globalServicesInit /
// HelpSessionService; pane tokens have no such owner, so every spawn that
// registers one wires them first — before the CLI's first handshake.
// Re-setting is a handful of reference writes, and doing it per registration
// keeps the wiring ahead of each one.
/** So the Assistant's panel shows its plugin tool calls beside its calls to Daintree's own server. */
function wireAssistantPluginActivity(mcpServerService: McpServerSingleton): void {
  mcpServerService.setAssistantPluginLaneResolver((terminalId) =>
    helpSessionService.getAssistantPluginLane(terminalId)
  );
}

function wirePaneTokenResolvers(mcpServerService: McpServerSingleton): void {
  mcpServerService.setPaneWorkspaceBindingResolver((token) =>
    mcpPaneConfigService.getPaneWorkspaceBindingForToken(token)
  );
  mcpServerService.setPaneOwnershipPrincipalResolver((token) =>
    mcpPaneConfigService.getOwnershipPrincipalForToken(token)
  );
  mcpServerService.setPaneTerminalResolver((token) =>
    mcpPaneConfigService.getPaneIdForToken(token)
  );
  mcpPaneConfigService.setOwnershipPrincipalRevokedListener((principal) =>
    mcpServerService.revokePaneBearer(principal)
  );
}

// Same lazy-import discipline as the MCP service above: PluginService pulls in
// the whole plugin host (~thousands of lines), and only plugin-agent launches
// that actually embed a `${settings:*}` template, or agent launches in a
// project with a plugin's agent tools turned on, need it — so keep it off the
// eager spawn path and load on first such launch.
type PluginServiceSingleton = typeof PluginServiceModule.pluginService;
let cachedPluginService: PluginServiceSingleton | null = null;
async function getPluginService(): Promise<PluginServiceSingleton> {
  if (!cachedPluginService) {
    const mod = await import("../../../services/PluginService.js");
    cachedPluginService = mod.pluginService;
  }
  return cachedPluginService;
}
import {
  listAgentSessions,
  clearAgentSessions,
  pruneAgentSessions,
  readSessionHistorySync,
  promoteBookmark,
  renameBookmark,
  deleteBookmark,
  listBookmarks,
} from "../../../services/pty/agentSessionHistory.js";
import { getAgentSessionRetentionDays } from "../../../services/pty/agentSessionRetention.js";
import {
  journalAgentSession,
  journalAgentSessionRecord,
} from "../../../services/pty/agentSessionJournal.js";
import { getLifecycleLedger } from "../../../services/pty/lifecycleLedger.js";
import { attributeClose } from "../../../services/pty/closeAttribution.js";
import type { WorkspaceClient } from "../../../services/WorkspaceClient.js";
import { getDefaultShell, waitForWindowsShell } from "../../../services/pty/terminalShell.js";
import {
  filterEnvironment,
  hasEnvVar,
  mergeEnvVars,
} from "../../../services/pty/EnvironmentFilter.js";
import { refreshWindowsPathForSpawn } from "../../../setup/windowsPath.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { quoteCommandArg, isPowerShellShell } from "../../../../shared/utils/shellEscape.js";
import {
  buildWindowsAgentLaunchScript,
  isWindowsAgentExecutableFor,
  resolveWindowsAgentExecutable,
  type WindowsAgentExecutable,
} from "../../../utils/windowsAgentLaunch.js";
import { windowsSystemTool } from "../../../utils/windowsExecutable.js";
import { MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH } from "../../../../shared/utils/recipeSanitizer.js";
import { buildCommandLaunchShell } from "./commandLaunch.js";
import { scheduledRunForRecord } from "../../../../shared/utils/scheduledRunProvenance.js";
import { admitScheduledSpawn } from "../../../services/scheduledRuns/scheduledRunAdmission.js";
import { isHostThrowawayWorkspaceId } from "../../../../shared/config/hostThrowaway.js";

// Longest a Windows command launch waits for the default shell's PATH search,
// matching the pty host's wait before it reports ready.
const WINDOWS_SHELL_WAIT_MS = 2_000;

function toPanePluginServers(plugins: readonly LaunchPlugin[]): PanePluginServer[] {
  return plugins.map(({ plugin, serverKey, scope }) => ({
    pluginInstanceId: plugin.pluginInstanceId,
    serverKey,
    scope,
  }));
}

/** The plugin MCP servers an agent launch in this project should be handed; see `resolveLaunchPlugins`. */
async function resolvePluginMcpServers(
  projectId: string,
  projectRoot: string,
  consumer?: "assistant"
): Promise<PanePluginServer[]> {
  return toPanePluginServers(
    await resolveLaunchPlugins(projectId, projectRoot, consumer, getPluginService)
  );
}

/** Every required plugin marked with one state, for a launch that never got as far as resolving them. */
function requiredPluginToolsAll(
  required: readonly string[],
  state: RequiredPluginToolStatus["state"]
): RequiredPluginToolStatus[] {
  return [...new Set(required)].map((pluginInstanceId) => ({
    pluginInstanceId,
    pluginDisplayName: pluginManifestIdFromInstanceKey(pluginInstanceId),
    state,
  }));
}

/**
 * Settle the statuses still reading ready once preparation produced nothing:
 * a plugin the live eligibility check no longer passes lost its access or went
 * away mid-launch; any other met a failure preparing the configuration itself.
 */
function failUnpreparedPluginTools(
  statuses: RequiredPluginToolStatus[],
  servers: readonly PanePluginServer[],
  projectId: string
): RequiredPluginToolStatus[] {
  const stillEligible = isPluginMcpServerStillEligible(projectId);
  return statuses.map((status) => {
    if (status.state !== "ready") return status;
    const server = servers.find(
      (candidate) => candidate.pluginInstanceId === status.pluginInstanceId
    );
    return { ...status, state: server && stillEligible(server) ? "config-failed" : "revoked" };
  });
}

/** Downgrade the statuses still reading ready to `state`: the launch failed past the point that confirms them. */
function failReadyPluginTools(
  statuses: RequiredPluginToolStatus[],
  state: RequiredPluginToolStatus["state"]
): RequiredPluginToolStatus[] {
  return statuses.map((status) => (status.state === "ready" ? { ...status, state } : status));
}

/**
 * Layer the launch's MCP env over the spawn env. Windows env keys are
 * case-insensitive, so a differently-cased copy of an injected key (a project's
 * `opencode_config_content`) is dropped first, or the PTY would see both and
 * pick one arbitrarily.
 */
function mergeLaunchEnv(
  base: Record<string, string>,
  injected: Record<string, string>
): Record<string, string> {
  if (process.platform !== "win32") return { ...base, ...injected };
  const upper = new Set(Object.keys(injected).map((key) => key.toUpperCase()));
  const kept = Object.fromEntries(
    Object.entries(base).filter(([key]) => !upper.has(key.toUpperCase()))
  );
  return { ...kept, ...injected };
}

/**
 * The session's `--mcp-config` file and the plugin servers' file as one flag
 * with both values, the form Claude documents for several files. Anything else
 * is appended as it is.
 */
function joinMcpConfigArgs(sessionArgs: string[], pluginArgs: string[]): string[] {
  if (
    sessionArgs.length === 2 &&
    pluginArgs.length === 2 &&
    sessionArgs[0] === "--mcp-config" &&
    pluginArgs[0] === "--mcp-config"
  ) {
    return ["--mcp-config", sessionArgs[1]!, pluginArgs[1]!];
  }
  return [...sessionArgs, ...pluginArgs];
}

// Re-checked synchronously as each grant is minted: the servers above were
// resolved before the launch's awaits, and a plugin unloaded or its access
// reduced in between would otherwise get a grant its revocation sweep has
// already run past. `cachedPluginService` is always set by then — the server
// list could not have been non-empty without loading it.
function isPluginMcpServerStillEligible(
  projectId: string,
  consumer?: "assistant"
): (server: PanePluginServer) => boolean {
  const isAllowed =
    consumer === "assistant" ? isAssistantAgentMcpScopeAllowed : isAgentMcpScopeAllowed;
  return ({ pluginInstanceId, scope }) =>
    cachedPluginService !== null &&
    cachedPluginService.hasPlugin(pluginInstanceId) &&
    isAllowed(projectId, pluginInstanceId, scope);
}

export function registerTerminalLifecycleHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }

  const handleTerminalSpawn = async (
    ctx: IpcContext,
    validatedOptions: ValidatedTerminalSpawnOptions
  ): Promise<string> => {
    const bypassedRateLimit = validatedOptions.restore === true && consumeRestoreQuota();
    if (!bypassedRateLimit) {
      // A bounded recipe consumes one admission slot, not one slot per panel.
      // Ordinary spawns keep the six-terminal burst and 1/sec sustained guard.
      await waitForTerminalSpawnAdmission(validatedOptions);
    }

    const cols = normalizeTerminalGridDimension(Math.floor(validatedOptions.cols) || 80);
    const rows = normalizeTerminalGridDimension(Math.floor(validatedOptions.rows) || 30);

    const kind = "terminal";
    const launchAgentId = validatedOptions.launchAgentId;
    const title = validatedOptions.title;

    const id = validatedOptions.id || crypto.randomUUID();

    // The renderer's explicit id identifies the terminal's owning *workspace*, which
    // is not always a registered project — a scratch id is opaque here and resolves to
    // no Project. Keep it as the ownership stamp anyway: retargeting an unresolvable id
    // to whatever is globally current would hand the terminal to the wrong workspace,
    // and leaving it unset made ownership fall back to PtyClient's global
    // `activeProjectId`, so deleting a scratch never killed its terminals (#11079).
    // Only a caller that sent no id at all falls back to the current project.
    // Blank is absent, not an identity: PtyClient already substitutes its
    // active project for a blank id, so leaving it as `""` here would let a
    // whitespace projectId slip past checks that a missing one is subject to.
    const explicitWorkspaceId = validatedOptions.projectId?.trim() || undefined;
    const resolvedProject = explicitWorkspaceId
      ? projectStore.getProjectById(explicitWorkspaceId)
      : projectStore.getCurrentProject();

    // Ownership is the explicit id; project-only enrichment below (settings, shell
    // overrides, project-path cwd fallback) stays gated on a resolved Project.
    const projectId = explicitWorkspaceId ?? resolvedProject?.id;
    const projectPath = resolvedProject?.path;

    // A request naming BOTH a project and a worktree asserts that the worktree
    // belongs to that project, and main has never checked it (#11653). The
    // claim is not inert: worktreeId is forwarded to the PTY and journaled
    // beside projectId on close (persistCloseRecord / prepare-bookmark), so an
    // unchecked pair puts one project's worktree into another's resumable-
    // session history and lets a worktree-scoped clear reach across the
    // boundary.
    //
    // Verify only the relationship the request itself asserts — never infer a
    // project from cwd. A cwd legitimately sits outside its project (linked
    // worktrees, defaultWorkingDirectory, scratch, the home-dir fallback), so
    // containment is not evidence of anything here.
    //
    // Truthiness, not `!== undefined`: a blank id is already treated as absent
    // when resolving the project above (and again by PtyClient, which swaps in
    // the active project), so it must not be taken as an assertion here either
    // — auditing a claim against the empty string would be auditing nothing.
    // Keyed on the pair actually about to be PERSISTED, not on the pair the
    // caller spelled out. A request carrying only a worktreeId still gets the
    // current project stamped beside it below, and that derived pair is
    // journaled and can go cross-project exactly like an asserted one. Gated on
    // a resolved Project because an explicit id is often a scratch id owning no
    // worktrees (#11079), and a spawn with no project resolved at all stamps no
    // pair to check (#5182).
    // Deliberately NOT short-circuited on the project row's `gitBacked: false`
    // flag, tempting as it is — a folder opened without git owns no worktrees,
    // so the claim looks incoherent on its face. But the row is not the
    // authority on that: the workspace host probes the folder on load and
    // enumerates real worktrees if git appeared since (WorkspaceService's
    // "the folder is the authority"), while the row is only promoted when the
    // project is re-added. An external `git init` therefore leaves a stale
    // `false` beside a host serving genuine ids, and trusting it would drop
    // them. Ask the host, which knows.
    const ownershipClaim =
      resolvedProject && validatedOptions.worktreeId
        ? {
            projectId: resolvedProject.id,
            worktreeId: validatedOptions.worktreeId,
            projectPath: resolvedProject.path,
          }
        : null;

    // Started here, awaited below, so the round trip overlaps the settings read
    // and cwd validation instead of adding to them. Settled to `null`
    // (unknown) at creation so an early failure elsewhere in this handler can
    // never surface as an unhandled rejection on a floating promise.
    const worktreeOwnership: Promise<boolean | null> =
      ownershipClaim && deps.worktreeService
        ? deps.worktreeService
            .isWorktreeOwnedByProject(
              ownershipClaim.worktreeId,
              ownershipClaim.projectPath,
              ownershipClaim.projectId
            )
            .catch(() => null)
        : Promise.resolve(null);

    // Fetch project-level terminal overrides when there's no agent launch
    // hint. Agent launches intentionally use the default shell configuration
    // (user shell + default args) to keep behaviour predictable — project
    // overrides can shape plain-shell UX without leaking into agent launches.
    let projectShell: string | undefined;
    let projectArgs: string[] | undefined;
    let projectCwd: string | undefined;
    if (resolvedProject && !launchAgentId) {
      const projSettings = await projectStore
        .getProjectSettings(resolvedProject.id)
        .catch((error: unknown) => {
          console.warn(
            "[TerminalSpawn] Couldn't read project settings; spawning without project terminal overrides:",
            error
          );
          return null;
        });
      const ts = projSettings?.terminalSettings;
      if (ts) {
        if (!validatedOptions.shell && ts.shell) {
          projectShell = ts.shell;
        }
        if (ts.shellArgs) {
          projectArgs = ts.shellArgs;
        }
        if (!validatedOptions.cwd && ts.defaultWorkingDirectory) {
          projectCwd = ts.defaultWorkingDirectory;
        }
      }
    }

    let cwd = validatedOptions.cwd || projectCwd || projectPath || os.homedir();

    const fs = await import("fs");
    const path = await import("path");

    const getValidatedFallback = async (): Promise<string> => {
      if (projectPath && path.isAbsolute(projectPath)) {
        try {
          await fs.promises.access(projectPath);
          return projectPath;
        } catch {
          // ignore
        }
      }

      return os.homedir();
    };

    try {
      if (!path.isAbsolute(cwd)) {
        console.warn(`Relative cwd provided: ${cwd}, falling back to project root or home`);
        cwd = await getValidatedFallback();
      }

      await fs.promises.access(cwd);
    } catch (_error) {
      console.warn(`Invalid cwd: ${cwd}, falling back to project root or home`);
      cwd = await getValidatedFallback();
    }

    // Resolve the ownership claim. Only a PROVEN disowning drops the id — an
    // unknown verdict (no host, host not ready, timed out, nothing to
    // corroborate against, service absent) forwards it exactly as before, so a
    // cold or busy workspace host degrades to today's behaviour instead of
    // stripping metadata on a guess.
    //
    // Dropping, not rejecting: the terminal still spawns, at the cwd the caller
    // asked for, under the workspace id it claimed. Only the unverifiable
    // worktree stamp goes, which keeps the blast radius of a wrong verdict at
    // "this terminal contributes no resume metadata" rather than "the user
    // can't open a terminal". Nothing above reads worktreeId, so sanitizing it
    // here covers every consumer — the close and bookmark paths read it back
    // off the PTY record and observe the sanitized value for free.
    //
    // Awaited HERE rather than at the spawn call: everything below binds
    // resources to this terminal id (help-session token, MCP pane config), and
    // an await between those bindings and the spawn lets a competing provision
    // revoke them against a PTY that does not exist yet, leaving the spawn to
    // proceed untracked.
    let spawnWorktreeId = validatedOptions.worktreeId;
    if ((await worktreeOwnership) === false) {
      console.warn(
        `[TerminalSpawn] Dropping worktreeId ${spawnWorktreeId} for terminal ${id.slice(0, 8)}: ` +
          `it belongs to another project, not ${ownershipClaim?.projectId}`
      );
      spawnWorktreeId = undefined;
    }

    // Debug: log projectId assignment
    if (process.env.DAINTREE_VERBOSE) {
      console.log(`[TerminalSpawn] Spawning terminal ${id.slice(0, 8)}:`, {
        projectId: projectId?.slice(0, 8) ?? "undefined",
        projectName: resolvedProject?.name ?? "none",
        kind,
        launchAgentId,
      });
    }

    // Warn if spawning without projectId - this will cause stats issues
    if (!projectId) {
      console.warn(
        `[TerminalSpawn] Terminal ${id.slice(0, 8)} spawned without projectId - ` +
          "stats will not track this terminal for any project"
      );
    }

    const trimmedCommand = validatedOptions.command?.trim() || "";
    const hasMultilineCommand =
      trimmedCommand.length > 0 && (trimmedCommand.includes("\n") || trimmedCommand.includes("\r"));

    if (hasMultilineCommand) {
      console.error("Multi-line commands not allowed for security, ignoring");
    }
    let safeCommand = hasMultilineCommand ? "" : trimmedCommand;
    let spawnEnv: Record<string, string> | undefined = validatedOptions.env;

    // Help-assistant launches arrive with a pre-provisioned session dir that
    // every lane of the project shares. Claude's MCP wiring, with its literal
    // per-lane bearer, is a per-lane file handed over with `--mcp-config`
    // below; the shared `.mcp.json` in cwd is empty, and `.claude/settings.json`
    // sets `enableAllProjectMcpServers: true` so nothing there prompts. Skip
    // the per-pane MCP config injection (the help session owns its own) and let
    // Claude's normal cwd discovery do the rest. The CLI bypass flag is
    // gated on the session's snapshotted `bypassPermissions` (independent
    // of `tier`), so a `core` session can still skip permission prompts and a
    // `full` session can still respect them.
    const helpToken = spawnEnv?.DAINTREE_MCP_TOKEN ?? "";
    const helpTier = helpToken ? helpSessionService.validateToken(helpToken) : false;
    const isAssistantAgent =
      typeof launchAgentId === "string" && getAssistantWiredAgentIds().includes(launchAgentId);
    const isHelpLaunch = helpTier !== false && isAssistantAgent && safeCommand.length > 0;
    // The rejection below keys off this rather than `isAssistantAgent`, which
    // now also requires an implemented `mcpInjection` mode: an agent excluded
    // on that new ground would otherwise sail past the throw and fall through
    // to the ordinary launch path with a help bearer still in its env (#12262).
    // Deliberately the pre-#12262 admission set and no wider — a deprecated-tier
    // agent could never provision a help session, so a user who carries their
    // own DAINTREE_MCP_TOKEN in a preset or project env must still be able to
    // launch it, exactly as before.
    const couldProvisionHelpSession =
      typeof launchAgentId === "string" && declaresActiveAssistantTier(launchAgentId);

    // If a help-session token was supplied but is invalid (revoked between
    // provision and spawn — typically because a sibling provision displaced
    // the session under the single-backend invariant), refuse to silently
    // fall back to a normal Claude launch with per-pane MCP injection. The
    // renderer must always provision a fresh session before spawning the
    // assistant; falling through would resurrect the orphan-backend failure
    // mode (#7509) by spawning an unmanaged Claude in the assistant slot.
    if (!isHelpLaunch && helpToken && couldProvisionHelpSession && safeCommand.length > 0) {
      throw new Error(
        "Daintree Assistant session token is invalid or already displaced; refusing to spawn"
      );
    }

    // Re-read the Windows registry PATH so a tool installed since app start is
    // on this terminal's PATH (#11773). Main's PATH is what `PtyClient` stamps
    // onto the spawn message, and that message is the only thing that crosses
    // into the long-lived pty-host, which still holds the env it was forked
    // with. Throttled to one `reg.exe` pair every few seconds, so a recipe
    // opening six panes or a session restore replaying a grid pays it once.
    //
    // Awaited HERE for the same reason the worktree-ownership check above is:
    // everything below binds resources to this terminal id (help-session token,
    // MCP pane config), and an await between those bindings and the spawn lets
    // a competing provision revoke them against a PTY that does not exist yet.
    // Placed after the invalid-token rejection so that path doesn't pay for it.
    //
    // The wait is bounded inside the helper — a wedged `reg.exe` hands this
    // spawn the PATH it already had and finishes in the background — so the
    // await costs a read that lands quickly, never a stalled terminal.
    //
    // Skipped when the caller already supplies a PATH: it wins over anything we
    // resolve (see `withCurrentWindowsPath`), so the registry read would be
    // pure latency. Nothing below adds one — the later `spawnEnv` merges carry
    // scratch dirs, MCP coordinates and assistant flags only.
    //
    // The platform guard is duplicated here even though the helper no-ops off
    // Windows: it keeps macOS and Linux free of an extra microtask on the spawn
    // path, where they already resolve PATH through the startup shell probe.
    if (process.platform === "win32" && !hasEnvVar(spawnEnv ?? {}, "PATH")) {
      // Enrichment, like the MCP env block below: a PATH that couldn't be
      // refreshed means the terminal opens with the one it would have had
      // anyway, never that it fails to open. The helper already degrades
      // internally; this keeps that promise from being the spawn's problem if
      // it ever stops holding.
      await refreshWindowsPathForSpawn().catch((err) => {
        console.warn("[TerminalSpawn] Windows PATH refresh failed; using the current PATH:", err);
      });
    }

    // Resolve a shell identity for quoting decisions only. Every
    // `quoteCommandArg` call below feeds into `safeCommand`, which will
    // eventually run inside this shell (POSIX `sh -lic`, PowerShell
    // `-EncodedCommand`, or `cmd /K`). Each shell parses single/double
    // quotes and backslashes differently, so quoting must match. We fall
    // back to `getDefaultShell()` here so the quoter always sees a concrete
    // shell — even when neither the request nor the project sets one.
    //
    // IMPORTANT: this value is *not* what we pass into `ptyClient.spawn`.
    // For plain terminals the PTY pool only matches when `options.shell` is
    // undefined (see `acquirePtyProcess` in `terminalSpawn.ts`); promoting
    // `getDefaultShell()` into the spawn options would silently disable the
    // pool for every spawn. The spawn-side fallback stays absent below.
    //
    // On Windows the default is found by an asynchronous PATH search, and for
    // a command launch it is also the shell the command runs in. So it is read
    // after the PATH refresh above, and a launch whose shell has no answer for
    // this PATH yet (startup, a PATH that just changed, an answer reached past
    // a PATH entry that did not respond) waits for one briefly rather than
    // opening in the in-box Windows PowerShell. A settled answer costs nothing.
    if (process.platform === "win32" && safeCommand && !validatedOptions.shell && !projectShell) {
      await waitForWindowsShell(WINDOWS_SHELL_WAIT_MS);
    }
    const requestedShell = validatedOptions.shell || projectShell || getDefaultShell();
    // Generated Windows agent commands use PowerShell literals even when the
    // user's plain-terminal shell is cmd.exe or Git Bash.
    const quotingShell =
      process.platform === "win32" && launchAgentId && !isPowerShellShell(requestedShell)
        ? windowsSystemTool("powershell.exe")
        : requestedShell;

    // The agent's executable, resolved now (a PATH search, a shim read, the
    // Node lookup, all asynchronous) and before the resource bindings below,
    // per the rule above; the launch script is built from it synchronously at
    // the spawn. A failure is kept until then, where the spawn's own error
    // handling releases what was bound. The env is built the way the PTY's is
    // (`buildTerminalEnv`), so a pane's `Path` replaces main's `PATH` here
    // exactly as it will there.
    const windowsAgentEnv = (): NodeJS.ProcessEnv =>
      mergeEnvVars(filterEnvironment(process.env), spawnEnv ?? {});
    let windowsAgentExecutable: WindowsAgentExecutable | undefined;
    if (process.platform === "win32" && launchAgentId && safeCommand) {
      windowsAgentExecutable = await resolveWindowsAgentExecutable(safeCommand, {
        env: windowsAgentEnv(),
        cwd,
      });
    }

    // Which Claude store this pane will read, decided from what it launches with
    // (#12371). Remembered for the close that journals it, and needed right here:
    // an untouched Claude pane comes back as `--resume <id>` for an id Claude Code
    // never wrote a conversation for, and the CLI exits on it. Every way a pane
    // resumes (relaunch, restart, sleep/wake, eviction, the resume list) funnels
    // through this spawn, so this is where to look. Awaited above the resource
    // bindings for the same reason as the PATH refresh, and applied below to the
    // finished command the launch carriers are built from. Enrichment too: a
    // lookup that fails leaves the resume exactly as it was.
    const claudePaneStore =
      launchAgentId === "claude"
        ? resolvePaneClaudeProjectsRoot({ shell: quotingShell, env: spawnEnv })
        : undefined;
    if (claudePaneStore !== undefined) rememberClaudePaneStore(id, claudePaneStore);
    const untouchedSessionId = await findUntouchedClaudeSession(safeCommand, launchAgentId, {
      cwd,
      agentSessionId: validatedOptions.agentSessionId,
      projectsRoot: claudePaneStore ?? null,
    }).catch(() => undefined);

    const launchMcp =
      typeof launchAgentId === "string"
        ? getEffectiveAgentConfig(launchAgentId)?.capabilities?.launchMcp
        : undefined;

    // Plugin tools this launch can't do without (#14096). Ordinary launches
    // list none and keep the optional behaviour: anything missing just isn't
    // handed over. A required one that is missing refuses the launch with each
    // plugin's state, unless the user chose to start without them this once.
    const requiredPluginTools =
      !isHelpLaunch && validatedOptions.allowMissingPluginTools !== true
        ? (validatedOptions.requiredPluginTools ?? [])
        : [];
    let requiredPluginToolStatuses: RequiredPluginToolStatus[] = [];
    // Recorded only as the PTY is dispatched, so a launch that fails before
    // then leaves no agent behind to be offered a relaunch.
    let pluginToolsLaunchProjectId: string | null = null;

    if (isHelpLaunch && launchAgentId) {
      const dangerous = DEFAULT_DANGEROUS_ARGS[launchAgentId];
      const bypassPermissions = helpSessionService.getBypassPermissions(helpToken);
      // A `waitForReply` send holds its call until the agent answers, and
      // Claude Code's own MCP call timeout would cut it off first.
      if (launchAgentId === "claude" && spawnEnv?.MCP_TOOL_TIMEOUT === undefined) {
        spawnEnv = { ...(spawnEnv ?? {}), MCP_TOOL_TIMEOUT: String(HELP_MCP_TOOL_TIMEOUT_MS) };
      }
      // Honor the agent's `supports.permissionBypass` declaration: only
      // append the dangerous flag when the agent has opted in. Agents that
      // sit at `permissionBypass: false` stay in their read-only mode even
      // when the user's help-assistant settings carry a stored
      // `bypassPermissions: true`.
      const launchAgentConfig = getEffectiveAgentConfig(launchAgentId);
      const agentAllowsBypass = launchAgentConfig?.supports
        ? launchAgentConfig.supports.permissionBypass === true
        : true;
      if (dangerous) {
        // The session-snapshotted `bypassPermissions` flag is the source of
        // truth for whether the assistant runs in dangerous mode — set per
        // help session at provision time, decoupled from the MCP `tier`.
        // Always strip first (covering bare flag and `--flag=value`
        // lookalikes that could survive a substring-only check). Then append
        // the canonical flag iff bypass is on AND the agent declares it
        // accepts bypass. The strip-first pass means
        // `--dangerously-skip-permissions=false` (or a bypass flag smuggled
        // via customArgs against a read-only help session) never wins over
        // the session's stored preference or the agent's `permissionBypass`
        // opt-out.
        const dangerousEscaped = dangerous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const stripPattern = new RegExp(`(^|\\s)${dangerousEscaped}(?:=\\S*)?(?=\\s|$)`, "g");
        safeCommand = safeCommand
          .replace(stripPattern, "$1")
          .replace(/\s{2,}/g, " ")
          .trim();
        if (bypassPermissions && agentAllowsBypass) {
          safeCommand = safeCommand.length > 0 ? `${safeCommand} ${dangerous}` : dangerous;
        }
      }
      // Codex doesn't read project-scoped `.codex/config.toml` from cwd —
      // its only override mechanism is the `-c key=value` CLI flag. The
      // help-session service computed the exact `-c` args for the toggled
      // MCP servers at provision time; append them here, shell-quoted. No
      // literal token is ever in the args (Codex reads
      // `DAINTREE_MCP_TOKEN` from PTY env via `bearer_token_env_var`).
      //
      // A `null` return is the agent-mismatch signal (e.g. a Claude help
      // token reused with `launchAgentId: "codex"`) — refuse to spawn
      // rather than silently launching Codex without its MCP wiring.
      if (launchAgentId === "codex") {
        const codexArgs = helpSessionService.getCodexLaunchArgs(helpToken);
        if (codexArgs === null) {
          throw new Error(
            "Daintree Assistant help token does not belong to a Codex session; refusing to spawn"
          );
        }
        if (codexArgs.length > 0) {
          safeCommand = `${safeCommand} ${codexArgs.map((arg) => quoteCommandArg(arg, quotingShell)).join(" ")}`;
        }
      }
      // Copilot help sessions read their MCP wiring from
      // `<sessionPath>/.mcp.json` (`writeCopilotMcpConfig`), so any flags
      // here are appended as-is, the same pattern Codex uses for its `-c`
      // MCP args.
      //
      // A `null` return is the agent-mismatch signal (e.g. a Claude help
      // token reused with `launchAgentId: "copilot"`) — refuse to spawn.
      if (launchAgentId === "copilot") {
        const copilotArgs = helpSessionService.getCopilotLaunchArgs(helpToken);
        if (copilotArgs === null) {
          throw new Error(
            "Daintree Assistant help token does not belong to a Copilot session; refusing to spawn"
          );
        }
        if (copilotArgs.length > 0) {
          safeCommand =
            `${safeCommand} ${copilotArgs.map((arg) => quoteCommandArg(arg, quotingShell)).join(" ")}`.trim();
        }
      }

      // Claude help sessions read their MCP wiring from a per-lane file
      // handed over with `--mcp-config`, not from the cwd's `.mcp.json`. Every
      // lane of a project shares one session directory, so the shared file
      // cannot carry a lane's bearer; the per-lane file can, and servers
      // supplied this way raise no per-folder approval prompt. Same `null`
      // contract as Codex and Copilot: a valid help token that does not
      // belong to a Claude session is a cross-agent reuse and refuses to spawn.
      let claudeArgs: string[] = [];
      if (launchAgentId === "claude") {
        const laneArgs = helpSessionService.getClaudeLaunchArgs(helpToken);
        if (laneArgs === null) {
          throw new Error(
            "Daintree Assistant help token does not belong to a Claude session; refusing to spawn"
          );
        }
        claudeArgs = laneArgs;
      }

      // Inject the per-session assistant scratch dir into the PTY spawn env
      // for every help-session agent (Claude, Codex, Copilot).
      // Paired with the markdown addendum written into the session dir at
      // provision time so the agent has both a literal path in its
      // instruction surface and an env var for shell substitution. Merged
      // unconditionally — the path is cleared on every app start and stays
      // valid for the lifetime of this process.
      const scratchEnv = helpSessionService.getAssistantScratchEnv(helpToken);
      if (scratchEnv) {
        spawnEnv = { ...(spawnEnv ?? {}), ...scratchEnv };
      }

      // The plugin servers the user let this project's Assistant use, in the
      // agent's own launch dialect beside the session's servers. Each grant is
      // minted for this launch alone and keyed by its terminal id, so PTY exit
      // and a failed spawn revoke it as they do an agent pane's, and the
      // session's own teardown revokes it too. Any failure here launches the
      // Assistant without them rather than not at all.
      let pluginArgs: string[] = [];
      let pluginsPrepared = false;
      const pluginLaunch =
        launchMcp !== undefined ? helpSessionService.getPluginLaunchContext(helpToken) : null;
      if (launchMcp !== undefined && pluginLaunch !== null) {
        try {
          // A name the Assistant's own servers or the user's assistant folder
          // already use is skipped rather than merged into theirs.
          const servers = (
            await resolvePluginMcpServers(
              pluginLaunch.projectId,
              pluginLaunch.projectPath,
              "assistant"
            )
          ).filter((server) => !pluginLaunch.serverNamesInUse.has(server.serverKey));
          if (servers.length > 0) {
            const mcpServerService = await getMcpServerService();
            wireAssistantPluginActivity(mcpServerService);
            const ready = mcpServerService.isRunning || (await mcpServerService.ensureReady());
            const port = mcpServerService.currentPort;
            if (ready && port) {
              const prepared = await mcpPaneConfigService.preparePaneConfig({
                paneId: id,
                port,
                tier: "off",
                injection: launchMcp,
                inheritedEnv: { ...process.env, ...(spawnEnv ?? {}) },
                cwd,
                plugin: {
                  projectId: pluginLaunch.projectId,
                  servers,
                  launchAgentIdHint: launchAgentId,
                  isEligible: isPluginMcpServerStillEligible(pluginLaunch.projectId, "assistant"),
                  consumer: "assistant",
                },
              });
              if (prepared) {
                pluginsPrepared = true;
                pluginArgs = prepared.args;
                if (Object.keys(prepared.env).length > 0) {
                  spawnEnv = mergeLaunchEnv(spawnEnv ?? {}, prepared.env);
                }
              }
            }
          }
        } catch (pluginErr) {
          if (pluginsPrepared) {
            await mcpPaneConfigService.revokePaneConfig(id).catch(() => {});
          }
          pluginArgs = [];
          console.error(
            "[TerminalSpawn] Failed to hand the Daintree Assistant its plugin tools; launching without them:",
            pluginErr
          );
        }
      }
      const launchArgs = joinMcpConfigArgs(claudeArgs, pluginArgs);
      if (launchArgs.length > 0) {
        safeCommand = `${safeCommand} ${launchArgs.map((arg) => quoteCommandArg(arg, quotingShell)).join(" ")}`;
      }

      // Bind this terminalId to the help session so HelpSessionService can
      // kill the PTY when the session is displaced or revoked (#7509). Owns
      // the binding from main-process spawn time, so it doesn't depend on
      // the renderer-issued `help.markTerminal` round-trip landing first.
      // A false return means the token was revoked between provision and
      // spawn (e.g. a stale resume against a session a sibling provision
      // already displaced) — refuse to launch as a help session rather
      // than silently degrading to a non-help Claude.
      if (!helpSessionService.markTerminalForToken(helpToken, id, launchAgentId)) {
        if (pluginsPrepared) await mcpPaneConfigService.revokePaneConfig(id).catch(() => {});
        throw new Error(
          "Daintree Assistant session token is invalid or already displaced; refusing to spawn"
        );
      }
      // A session whose teardown began while its plugin servers were prepared
      // still binds — its capture needs the PTY — but must not hand them over:
      // that teardown already revoked whatever its old PTY held.
      if (pluginsPrepared && helpSessionService.getPluginLaunchContext(helpToken) === null) {
        pluginMcpGrantRegistry.revokeTerminal(id);
      }
    } else if (launchMcp !== undefined && safeCommand.length > 0 && resolvedProject) {
      // Daintree MCP injection for normal agent launches, in the dialect the
      // agent's registry entry declares (`capabilities.launchMcp`): Claude's
      // managed --mcp-config file, Codex's `-c` overrides, and so on. Mints a
      // per-pane bearer token and hands the agent the servers through args,
      // env and (for formats that need one) a 0600 file under userData. Token
      // is revoked and any file deleted on PTY exit (see registerTerminalEventHandlers).
      //
      // The wiring carries one entry per plugin MCP endpoint the user enabled
      // for this project, each with a grant minted for this launch alone. Those
      // are independent of the Daintree tier: a project with Daintree MCP "off"
      // still gets its plugin endpoints, with no Daintree entry and no pane
      // token. The grants are keyed by this terminal id, so every path that
      // revokes the pane config (PTY exit, sync and async spawn failure, a
      // re-prepare on restart) revokes them too. Every await — settings, the
      // PluginService load, server readiness — happens before
      // `preparePaneConfig` mints anything, per the binding rule above.
      let preparedForThisLaunch = false;
      let launchPluginServers: PanePluginServer[] = [];
      // The sender is the launch view only when it is a view of this pane's
      // workspace. `ctx.projectId` was resolved from the sender before any
      // await, off the cross-window registry, never the global current project.
      // The initial window's view registers after its renderer has loaded, so a
      // launch that early falls back to the workspace its URL was opened with,
      // as project hydration does. Either way this only names a preference:
      // routing still checks the view belongs to the workspace on every call.
      const hasSender = Number.isInteger(ctx.webContentsId) && ctx.webContentsId > 0;
      const senderWorkspaceId = hasSender
        ? (ctx.projectId ?? (ctx.event && getProjectIdFromSenderUrl(ctx.event.sender)))
        : null;
      const launchViewWebContentsId =
        senderWorkspaceId === resolvedProject.id ? ctx.webContentsId : null;
      // A snapshot naming another project would make every dispatch fail
      // BINDING_STALE against the view it routes to, permanently; the pane is
      // better served by that view's live context.
      const launchActionContext =
        validatedOptions.actionContext !== undefined &&
        (validatedOptions.actionContext.projectId === undefined ||
          validatedOptions.actionContext.projectId === resolvedProject.id)
          ? validatedOptions.actionContext
          : undefined;
      try {
        // Unreadable settings leave Daintree's own server off, but the
        // plugin servers this project turned on are still handed over.
        const projSettings: ProjectSettings = await projectStore
          .getProjectSettings(resolvedProject.id)
          .catch((error: unknown) => {
            console.warn(
              "[TerminalSpawn] Couldn't read project settings; launching without Daintree MCP:",
              error
            );
            return { runCommands: [] };
          });
        const tier = resolveDaintreeMcpTier(projSettings);
        // A restart respawns an Assistant's pane under the same id with no help
        // token (`buildRestartEnv`), so it lands here rather than above, with
        // none of the session's own wiring either. Plugin servers reach the
        // Assistant only through its own launch, checked against its session
        // and its answer, so this one gets none.
        const isHelpTerminal = helpSessionService.isHelpTerminal(id);
        const pluginReport = isHelpTerminal
          ? null
          : await resolveLaunchPluginsReport(
              resolvedProject.id,
              resolvedProject.path,
              undefined,
              getPluginService
            );
        const pluginServers = pluginReport ? toPanePluginServers(pluginReport.plugins) : [];
        launchPluginServers = pluginServers;
        if (pluginReport && requiredPluginTools.length > 0) {
          requiredPluginToolStatuses = classifyRequiredPluginTools(
            pluginReport,
            requiredPluginTools
          );
        }
        if (tier !== "off" || pluginServers.length > 0) {
          const mcpServerService = await getMcpServerService();
          let ready: boolean;
          try {
            ready = mcpServerService.isRunning || (await mcpServerService.ensureReady());
          } catch (listenerErr) {
            requiredPluginToolStatuses = failReadyPluginTools(
              requiredPluginToolStatuses,
              "listener-failed"
            );
            throw listenerErr;
          }
          if (!ready) {
            console.warn(
              "[TerminalSpawn] Daintree MCP requested for agent launch, but the MCP server is not ready; continuing without MCP injection"
            );
            requiredPluginToolStatuses = failReadyPluginTools(
              requiredPluginToolStatuses,
              "listener-failed"
            );
          }
          const port = mcpServerService.currentPort;
          if (ready && port) {
            const prepared = await mcpPaneConfigService.preparePaneConfig({
              paneId: id,
              port,
              tier,
              injection: launchMcp,
              inheritedEnv: { ...process.env, ...(spawnEnv ?? {}) },
              cwd,
              ...(pluginServers.length > 0
                ? {
                    plugin: {
                      projectId: resolvedProject.id,
                      servers: pluginServers,
                      launchAgentIdHint: launchAgentId,
                      isEligible: isPluginMcpServerStillEligible(resolvedProject.id),
                    },
                  }
                : {}),
            });
            if (!prepared) {
              requiredPluginToolStatuses = failUnpreparedPluginTools(
                requiredPluginToolStatuses,
                pluginServers,
                resolvedProject.id
              );
            }
            if (prepared) {
              preparedForThisLaunch = true;
              if (prepared.args.length > 0) {
                safeCommand = `${safeCommand} ${prepared.args.map((arg) => quoteCommandArg(arg, quotingShell)).join(" ")}`;
              }
              if (Object.keys(prepared.env).length > 0) {
                spawnEnv = mergeLaunchEnv(spawnEnv ?? {}, prepared.env);
              }
              if (prepared.token !== null) {
                // Bind the bearer to the workspace this pane was launched in, so
                // its MCP session acts there for its whole life instead of on
                // whichever window has focus when a call lands (#12486).
                // Registered before this IPC resolves, because the CLI's first
                // handshake can race ahead of anything later. Revoked with the token on PTY exit.
                wirePaneTokenResolvers(mcpServerService);
                mcpPaneConfigService.registerPaneWorkspaceBinding(prepared.token, {
                  workspaceId: resolvedProject.id,
                  ...(launchViewWebContentsId !== null
                    ? { launchWebContentsId: launchViewWebContentsId }
                    : {}),
                  ...(launchActionContext !== undefined
                    ? { actionContext: launchActionContext }
                    : {}),
                  ...(tier === "full" && projSettings.daintreeMcpSkipConfirmations === true
                    ? { skipConfirmations: true }
                    : {}),
                });
                // Every format's hook for the orchestration bearer, whether or
                // not the agent reads it from here.
                spawnEnv = { ...(spawnEnv ?? {}), DAINTREE_MCP_TOKEN: prepared.token };
              }
            }
          }
        }
      } catch (mcpErr) {
        // `preparePaneConfig` rolls back its own failures. What is left is a
        // config it finished that this launch then failed to hand over: the
        // terminal opens without MCP, so revoke it rather than leave its grants
        // and token live until the PTY exits. Nothing else is touched — a
        // failure before preparation must not reach a previous launch that
        // still holds this id.
        if (preparedForThisLaunch) {
          try {
            await mcpPaneConfigService.revokePaneConfig(id);
          } catch {
            // best-effort cleanup
          }
        }
        console.error(
          "[TerminalSpawn] Failed to prepare Daintree MCP config; continuing without MCP injection:",
          mcpErr
        );
        requiredPluginToolStatuses = failUnpreparedPluginTools(
          requiredPluginToolStatuses,
          launchPluginServers,
          resolvedProject.id
        );
      }
      // A requirement nothing above could classify — resolution itself threw,
      // or a restarted Assistant pane, which is never handed plugin servers —
      // is still a requirement that wasn't met.
      if (requiredPluginTools.length > 0 && requiredPluginToolStatuses.length === 0) {
        requiredPluginToolStatuses = requiredPluginToolsAll(
          requiredPluginTools,
          helpSessionService.isHelpTerminal(id) ? "unavailable" : "config-failed"
        );
      }
      if (requiredPluginToolStatuses.length > 0) {
        // Ready means handed over: a live grant for this launch, not merely
        // eligible when resolution ran. One the eligibility recheck skipped, or
        // revoked since, is missing from the agent's configuration.
        const granted = new Set(
          pluginMcpGrantRegistry.listForTerminal(id).map((grant) => grant.pluginInstanceId)
        );
        requiredPluginToolStatuses = requiredPluginToolStatuses.map((status) =>
          status.state === "ready" && !granted.has(status.pluginInstanceId)
            ? { ...status, state: "revoked" }
            : status
        );
      }
      if (requiredPluginToolStatuses.some((status) => status.state !== "ready")) {
        if (preparedForThisLaunch) {
          await mcpPaneConfigService.revokePaneConfig(id).catch(() => {});
        }
      } else if (!helpSessionService.isHelpTerminal(id)) {
        pluginToolsLaunchProjectId = resolvedProject.id;
      }
    } else if (requiredPluginTools.length > 0) {
      requiredPluginToolStatuses = requiredPluginToolsAll(
        requiredPluginTools,
        launchMcp === undefined ? "unsupported-format" : "unavailable"
      );
    }

    if (requiredPluginToolStatuses.some((status) => status.state !== "ready")) {
      throw new AppError({
        code: "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE",
        message: "Agent launch refused: required plugin tools are not ready",
        userMessage: describeMissingPluginTools(requiredPluginToolStatuses),
        details: { code: "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE", tools: requiredPluginToolStatuses },
      });
    }

    // Expand `${settings:*}` templates a plugin agent embedded in its command
    // or args (e.g. `--token=${settings:apiToken}`). The agent's args were
    // concatenated into `safeCommand` upstream by `generateAgentCommand`, so the
    // literal template is sitting in this string. MCP servers already resolve
    // these at spawn (PluginMcpSupervisor.resolveContribution); the agent path
    // had no equivalent, so the unexpanded token reached the PTY and the agent
    // failed to authenticate (#10619). The cheap `includes` pre-check keeps a
    // plain-shell or built-in-agent spawn off the lazy PluginService load
    // entirely; only a plugin-contributed agent with a template pays for it.
    // An unconfigured setting throws `SettingTemplateError` (surfaced as the
    // spawn IPC's rejection) rather than leaking a literal `${...}` to the wire.
    if (launchAgentId && safeCommand.includes("${settings:")) {
      const pluginId = getPluginIdForAgent(launchAgentId);
      if (pluginId) {
        const pluginService = await getPluginService();
        safeCommand = await substituteSettingsTemplates(safeCommand, async (settingId) => {
          const value = await pluginService.resolveSettingTemplate(pluginId, settingId);
          // `resolveSettingTemplate` returns "" for an unset/missing setting;
          // treat that as unresolved so the command never spawns with a blank
          // secret silently swapped in.
          if (!value) throw new SettingTemplateError(pluginId, settingId);
          return value;
        });
      }
    }

    // Resolve spawn shell and args: project overrides > spawn options >
    // defaults. For command launches, run the command through the shell's
    // startup arguments (POSIX `-lic` trap-wrap, PowerShell `-EncodedCommand`,
    // or cmd `/K`) instead of echoing it into the PTY. Plain terminals
    // intentionally leave `spawnShell` as the original undefined-when-unset
    // value (no `getDefaultShell()` fallback) so the PTY pool can match —
    // see `acquirePtyProcess` in `terminalSpawn.ts`.
    let spawnAgentSessionId = validatedOptions.agentSessionId;
    if (untouchedSessionId) {
      const relaunch = relaunchResumeAsAssignedSession(safeCommand, launchAgentId);
      if (relaunch?.sessionId === untouchedSessionId) {
        safeCommand = relaunch.command;
        // A caller that only had the command still gets the id on the record, so
        // teardown hands it back like any other assigned launch.
        spawnAgentSessionId ??= untouchedSessionId;
        console.info(
          `[TerminalSpawn] Terminal ${id.slice(0, 8)} has no Claude conversation to resume; ` +
            "starting a fresh one under its assigned session id"
        );
      }
    }

    // Resolved again only if what it depends on moved since: a settings
    // template that named the executable itself, or a PATH adopted mid-spawn.
    if (
      windowsAgentExecutable &&
      !isWindowsAgentExecutableFor(windowsAgentExecutable, safeCommand, windowsAgentEnv())
    ) {
      windowsAgentExecutable = await resolveWindowsAgentExecutable(safeCommand, {
        env: windowsAgentEnv(),
        cwd,
      });
    }

    try {
      // Inside the try: a failed resolution throws here, and the catch below is
      // what releases the pane config and help binding made above.
      const startupCommand = windowsAgentExecutable
        ? buildWindowsAgentLaunchScript(safeCommand, windowsAgentExecutable, windowsAgentEnv())
        : safeCommand;
      // A host's throwaway run (#14445) ends with its agent, so its exit is the agent's.
      const commandLaunchShell = buildCommandLaunchShell(
        startupCommand,
        quotingShell,
        isHostThrowawayWorkspaceId(projectId) ? "exit" : "keep-open"
      );
      const resolvedArgs = commandLaunchShell ? commandLaunchShell.args : projectArgs;
      const spawnShell = commandLaunchShell
        ? commandLaunchShell.shell
        : validatedOptions.shell || projectShell;

      // Shells that can't host a startup wrapper (fish, nushell, unrecognized
      // Windows shells) launch bare and get the command typed in after spawn.
      // Cache it on the spawn options so it rides every pendingSpawns replay — a
      // pty-host crash respawn would otherwise bring these terminals back as an
      // empty prompt, losing the (possibly resume) launch entirely (#11339). The
      // pty-host spawn handler injects it, and only after a successful spawn, so a
      // rejected spawn can't type it into a pre-existing live PTY (#11341).
      // Wrapper shells already carry the command in `args`, so they replay
      // faithfully with no postSpawnInput.
      const postSpawnInput =
        safeCommand.length > 0 && !commandLaunchShell ? `${safeCommand}\r` : undefined;

      // A scheduled run's first spawn registers the run in its history from
      // these very values, or refuses (#15978). Last before the spawn, with
      // no await between, so nothing can start a run that wasn't recorded.
      admitScheduledSpawn({
        terminalId: id,
        projectId,
        scheduledRun: validatedOptions.scheduledRun,
        launchAgentId,
        cwd,
        worktreeId: spawnWorktreeId,
        agentLaunchFlags: validatedOptions.agentLaunchFlags,
        agentModelId: validatedOptions.agentModelId,
        agentPresetId: validatedOptions.agentPresetId,
        agentSessionId: spawnAgentSessionId,
      });
      if (pluginToolsLaunchProjectId !== null) {
        recordPluginToolsLaunch(id, pluginToolsLaunchProjectId);
      }
      armSpawnConfirmation(id);
      // Every terminal is an interactive shell. Agent launches inject their
      // command after the shell's first prompt renders — never `exec`'d over
      // the shell, so when the agent exits the shell reclaims the foreground.
      // SIGINT routes to the agent (the foreground process group) via the
      // kernel's TTY line discipline; the shell stays pristine.
      ptyClient.spawn(id, {
        cwd,
        shell: spawnShell,
        args: resolvedArgs,
        cols,
        rows,
        command: safeCommand || undefined,
        env: spawnEnv,
        kind,
        launchAgentId,
        pluginPanelKindId: validatedOptions.pluginPanelKindId,
        title,
        titleMode: validatedOptions.titleMode,
        projectId,
        restore: validatedOptions.restore,
        isEphemeral: validatedOptions.isEphemeral,
        // Seal the assistant's identity onto the record itself, for the
        // generic terminal paths to read back through
        // `isAssistantTerminalRecord`. Derived in main, never from a
        // renderer-supplied field: a pane that could assert this would opt
        // itself out of the session journal.
        //
        // The live binding is the second source because a restart respawns the
        // same panel id with a rebuilt env that carries no help token
        // (`buildRestartEnv`), so `isHelpLaunch` is false there — and nothing
        // unbinds the session on a restart's kill. Without it, Restart All
        // Terminals would quietly strip the assistant's identity.
        isAssistantTerminal: isHelpLaunch || helpSessionService.isHelpTerminal(id),
        agentLaunchFlags: validatedOptions.agentLaunchFlags,
        agentModelId: validatedOptions.agentModelId,
        scheduledRun: validatedOptions.scheduledRun,
        agentSessionId: spawnAgentSessionId,
        worktreeId: spawnWorktreeId,
        agentPresetId: validatedOptions.agentPresetId,
        agentPresetColor: validatedOptions.agentPresetColor,
        originalAgentPresetId:
          validatedOptions.originalAgentPresetId ?? validatedOptions.agentPresetId,
        handbackCode: validatedOptions.handbackCode,
        hasFirstPrompt: validatedOptions.hasFirstPrompt,
        // Executed immediately by PtyClient after the spawn message (FIFO on the
        // same channel), so users don't stare at a blank prompt; the shell stays
        // the parent process and reclaims the foreground when the command exits.
        postSpawnInput,
      });
      // What this launch resumes, if anything, decides whether the session a
      // natural exit left on the pane survives it — once the host confirms the
      // spawn (#12433).
      noteTerminalLaunch(id, { command: safeCommand, agentSessionId: spawnAgentSessionId });
      // The assistant lane's durable resume pointer, written the moment its
      // conversation exists so a quit or a main-process crash can't lose it
      // (#13205). Memory-first, so it is current before any later capture.
      // The PTY is already up, so a failure here must not fail the spawn.
      if (isHelpLaunch) {
        try {
          helpSessionService
            .recordLaneLaunchForToken(helpToken, spawnAgentSessionId)
            .catch((err) => {
              console.warn("[TerminalSpawn] Failed to record assistant lane pointer:", err);
            });
        } catch (err) {
          console.warn("[TerminalSpawn] Failed to record assistant lane pointer:", err);
        }
      }

      return id;
    } catch (error) {
      settleSpawnConfirmation(id);
      // If we minted an MCP pane config above and the PTY spawn never landed,
      // revoke it now so we don't leak per-pane tokens or config files.
      mcpPaneConfigService.revokePaneConfig(id).catch(() => {
        // best-effort cleanup
      });
      forgetPluginToolsLaunch(id);
      // If we bound this terminalId to a help session above, unbind now so a
      // future provision doesn't try to kill a PTY that never spawned.
      if (isHelpLaunch) {
        helpSessionService.unbindTerminal(id);
      }
      const errorMessage = formatErrorMessage(error, "Failed to spawn terminal");
      throw new Error(`Failed to spawn terminal: ${errorMessage}`);
    }
  };

  // Resolve the worktree's branch in the main process (where the pty-host's
  // direct-git path is unavailable). Best-effort and time-boxed: a stalled
  // workspace-host must not hold up a terminal close, so cap the lookup at
  // 200ms and treat any miss/timeout/detached-HEAD as "no branch".
  const resolveBranchForMain = async (
    worktreeId: string | undefined,
    svc: WorkspaceClient | undefined
  ): Promise<string | undefined> => {
    if (!worktreeId || !svc) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        svc.getMonitorAsync(worktreeId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 200);
        }),
      ]);
      const branch = snapshot?.branch;
      return branch && branch !== "HEAD" ? branch : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // Journal a resume record for an agent terminal close (kill / gracefulKill).
  // Best-effort: a null sessionId (no captured session id — e.g. Cursor or a
  // non-resume-config agent), a non-agent terminal, or a branch-lookup failure
  // all skip silently and never fail the close. Mirrors PtyManager's trash-
  // expiry capture, the fourth close path that already journals.
  const persistCloseRecord = async (
    info: Awaited<ReturnType<typeof ptyClient.getTerminalAsync>>,
    sessionId: string | null,
    generation: number | undefined,
    cause: "kill" | "restart"
  ): Promise<void> => {
    if (!sessionId || !info?.launchAgentId) return;
    // The Daintree Assistant's overlay terminal must never surface in the
    // resume picker as an ordinary agent pane (#12183). Both callers snapshot
    // `info` before the kill, so the record still carries the stamp here.
    if (isAssistantTerminalRecord(info)) return;
    try {
      const branch = await resolveBranchForMain(info.worktreeId, deps.worktreeService);
      // journalAgentSession is the exactly-once funnel: it gates on the
      // lifecycle ledger's (terminalId, generation) key — dropping a record a
      // concurrent close path already journaled — persists with the real
      // retention setting, and emits agent-session:recorded after the write.
      await journalAgentSession(
        {
          sessionId,
          agentId: info.launchAgentId,
          worktreeId: info.worktreeId ?? null,
          // Prefer the agent's observed task title over the identity title,
          // matching the trash-expiry path — otherwise kill-path records all
          // read "Resume Claude" while trash-path records carry the task.
          // A user-locked title is the exception: the resume row should read
          // the same as the live tab did, and a lock freezes the tab.
          title:
            (info.titleMode === "user" ? info.title : (info.lastObservedTitle ?? info.title)) ??
            null,
          projectId: info.projectId ?? null,
          agentLaunchFlags: info.agentLaunchFlags,
          agentModelId: info.agentModelId,
          cwd: info.cwd ?? undefined,
          branch,
          ...scheduledRunForRecord(info),
          // A pane in the trash was the user's close, whatever ended it here.
          ...attributeClose(info, cause),
        },
        { terminalId: info.id, generation }
      );
    } catch (err) {
      console.warn("[TerminalLifecycle] Failed to persist agent session on close:", err);
    }
  };

  const handleTerminalKill = async (id: string, options?: TerminalKillOptions): Promise<void> => {
    try {
      if (typeof id !== "string") {
        throw new Error("Invalid terminal ID: must be a string");
      }
      if (options?.forRestart === true) ptyClient.suppressExitForRestart(id);
      // Before any await: a restart's respawn arms a fresh window for this id,
      // and it must not be the one this kill clears.
      settleSpawnConfirmation(id);
      // Capture a resume record before tearing down an agent terminal. The info
      // snapshot must precede the kill (it's gone afterward), and gracefulKill —
      // not a bare kill — is what extracts the session id, so route agent
      // terminals through it. Plain terminals keep the original hard kill.
      const info = await ptyClient.getTerminalAsync(id).catch(() => null);
      if (info?.launchAgentId) {
        // Freeze the generation BEFORE the kill: a restart can respawn this id
        // while gracefulKill is in flight, and the record must stay attributed
        // to the incarnation that produced it, not the successor.
        const generation = getLifecycleLedger().currentGeneration(id);
        const sessionId = await ptyClient.gracefulKill(id);
        await persistCloseRecord(
          info,
          sessionId,
          generation,
          options?.forRestart === true ? "restart" : "kill"
        );
      } else {
        ptyClient.kill(id);
      }
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to kill terminal");
      throw new Error(`Failed to kill terminal: ${errorMessage}`);
    }
  };

  const handleTerminalGracefulKill = async (
    id: string,
    options?: TerminalKillOptions
  ): Promise<string | null> => {
    if (typeof id !== "string") {
      throw new Error("Invalid terminal ID: must be a string");
    }
    if (options?.forRestart === true) ptyClient.suppressExitForRestart(id);
    const info = await ptyClient.getTerminalAsync(id).catch(() => null);
    const generation = getLifecycleLedger().currentGeneration(id);
    const sessionId = await ptyClient.gracefulKill(id);
    await persistCloseRecord(
      info,
      sessionId,
      generation,
      options?.forRestart === true ? "restart" : "kill"
    );
    return sessionId;
  };

  const handleTerminalTrash = async (id: string): Promise<void> => {
    try {
      if (typeof id !== "string") {
        throw new Error("Invalid terminal ID: must be a string");
      }
      ptyClient.trash(id);
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to trash terminal");
      throw new Error(`Failed to trash terminal: ${errorMessage}`);
    }
  };

  const handleTerminalRestore = async (id: string): Promise<boolean> => {
    try {
      if (typeof id !== "string") {
        throw new Error("Invalid terminal ID: must be a string");
      }
      return ptyClient.restore(id);
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to restore terminal");
      throw new Error(`Failed to restore terminal: ${errorMessage}`);
    }
  };

  const handleTerminalRestartService = async (): Promise<void> => {
    ptyClient.manualRestart();
  };

  // Main's cached reading — never a host round-trip, which a host under memory
  // pressure is the worst placed to answer.
  const handleTerminalGetHostMemoryPause = async (): Promise<HostMemoryPauseSnapshot> =>
    ptyClient.getHostMemoryPause();

  const handleAgentSessionList = async (payload: { worktreeId?: string; projectId?: string }) => {
    const { app } = await import("electron");
    return listAgentSessions(
      payload?.worktreeId,
      app.getPath("userData"),
      getAgentSessionRetentionDays(),
      payload?.projectId
    );
  };

  const handleAgentSessionClear = async (payload: { worktreeId?: string }): Promise<void> => {
    const { app } = await import("electron");
    await clearAgentSessions(payload?.worktreeId, app.getPath("userData"));
  };

  const handleAgentSessionGetRetention = async (): Promise<AgentSessionRetentionDays> =>
    getAgentSessionRetentionDays();

  const handleAgentSessionSetRetention = async (days: AgentSessionRetentionDays): Promise<void> => {
    // Dot-path write — never spread-write the slice, which would bake current
    // defaults to disk and freeze future default changes for existing users (#6106).
    store.set("agentSessionHistory.retentionDays", days);
    // Apply the (possibly tighter) window immediately rather than lazily on the
    // next persist/list — mirrors helpAssistant's prune-on-write. Fire-and-forget:
    // the write is best-effort and must not block the settings-save round-trip.
    const { app } = await import("electron");
    void pruneAgentSessions(days, app.getPath("userData")).catch((err) => {
      console.warn(
        "[TerminalLifecycle] Failed to prune agent sessions after retention change:",
        err
      );
    });
  };

  // Bookmark a live agent pane's conversation and capture its native session
  // durably BEFORE the renderer removes the pane (#11288). Prepare-before-remove:
  // if any step here throws, the renderer keeps the pane. Main is authoritative
  // for the lifecycle generation — a same-id restart during capture is rejected
  // with STALE_GENERATION rather than journaling or closing the successor.
  const handleAgentSessionPrepareBookmark = async (
    payload: z.output<typeof PrepareBookmarkPayloadSchema>
  ): Promise<{ record: AgentSessionRecord }> => {
    const { terminalId, label, metadata } = payload;

    const info = await ptyClient.getTerminalAsync(terminalId).catch(() => null);
    if (!info?.launchAgentId) {
      throw new AppError({
        code: "NOT_BOOKMARKABLE",
        message: `Terminal ${terminalId} is not a live agent pane`,
      });
    }
    // Only agents whose session id can actually be OBSERVED can be bookmarked —
    // a rolling-history / resume-latest agent has no specific conversation to
    // pin. Gated on the capture path rather than on `resume.kind` alone: an
    // agent can resume by exact id yet have no way to learn one (#11851), and
    // the capture below is a KILL, so passing that pane through here would tear
    // down the user's live agent and only then report that nothing was saved.
    if (!supportsExactSessionCapture(info.launchAgentId)) {
      throw new AppError({
        code: "NOT_BOOKMARKABLE",
        message: `Agent ${info.launchAgentId} has no exact-session resume to bookmark`,
      });
    }
    // Bookmarks are only reachable through the project-scoped list, so pinning a
    // record with no owning project would strand it: exempt from age pruning and
    // the per-worktree cap, yet never listable and so never deletable. Refuse
    // before the capture kill rather than orphan it. A missing projectId is the
    // degenerate spawn path that already warns "spawned without projectId".
    if (!info.projectId) {
      throw new AppError({
        code: "NOT_BOOKMARKABLE",
        message: `Terminal ${terminalId} has no owning project to scope a bookmark to`,
      });
    }
    // The capture types nothing into an approval prompt (#13842), so an id the
    // agent would only print on quit can't be had there: the kill would discard
    // the decision it is waiting on and save nothing. An id assigned at launch
    // needs no typing, but only while the launched agent is still the live one —
    // the same test the capture applies before trusting it.
    const liveAgentId = info.detectedAgentId ?? info.launchAgentId;
    const hasAssignedId =
      !!info.agentSessionId &&
      liveAgentId === info.launchAgentId &&
      supportsSessionIdAssignment(liveAgentId);
    if (info.agentState === "waiting" && info.waitingReason === "approval" && !hasAssignedId) {
      throw new AppError({
        code: "NOT_BOOKMARKABLE",
        message: `Terminal ${terminalId} is waiting on an approval; answer it before bookmarking`,
      });
    }

    // Freeze the incarnation before capture (mirrors the kill path) so the
    // record stays attributed to the conversation that produced it. `?? null` is
    // the frozen-but-unknown sentinel (#11340): when the ledger has evicted the
    // entry we must NOT fall back to the current generation, which could belong
    // to a same-id successor and consume its journal reservation.
    const ledger = getLifecycleLedger();
    const generation = ledger.currentGeneration(terminalId) ?? null;

    let sessionId: string | null;
    try {
      sessionId = await ptyClient.gracefulKill(terminalId);
    } catch (err) {
      throw new AppError({
        code: "SESSION_CAPTURE_FAILED",
        message: `Failed to capture the agent session for ${terminalId}`,
        cause: err instanceof Error ? err : undefined,
      });
    }
    if (!sessionId) {
      throw new AppError({
        code: "SESSION_CAPTURE_FAILED",
        message: `No resumable session id was captured for ${terminalId}`,
      });
    }

    // A successor took the terminal id while we captured — the pane the renderer
    // would remove is no longer this conversation. Abort before any journal write.
    // Only checkable when we froze a concrete generation; a `null` (evicted)
    // freeze can't be compared, so it fails open like the journal path.
    if (typeof generation === "number" && !ledger.isCurrent(terminalId, generation)) {
      throw new AppError({
        code: "STALE_GENERATION",
        message: `Terminal ${terminalId} was restarted during bookmark capture`,
      });
    }

    const branch = await resolveBranchForMain(info.worktreeId, deps.worktreeService);
    const bookmark: AgentSessionBookmarkMetadata = {
      bookmarkedAt: Date.now(),
      label,
      ...metadata,
    };

    let record: AgentSessionRecord | null;
    try {
      record = await journalAgentSessionRecord(
        {
          sessionId,
          agentId: info.launchAgentId,
          worktreeId: info.worktreeId ?? null,
          // Match the kill path: prefer the observed task title unless the user
          // locked the tab title, which the resume row should mirror.
          title:
            (info.titleMode === "user" ? info.title : (info.lastObservedTitle ?? info.title)) ??
            null,
          projectId: info.projectId ?? null,
          agentLaunchFlags: info.agentLaunchFlags,
          agentModelId: info.agentModelId,
          cwd: info.cwd ?? undefined,
          branch,
          bookmark,
          ...scheduledRunForRecord(info),
          ...attributeClose(info, "bookmark"),
        },
        { terminalId, generation }
      );
    } catch (err) {
      throw new AppError({
        code: "PERSIST_FAILED",
        message: `Failed to persist the bookmark for ${terminalId}`,
        cause: err instanceof Error ? err : undefined,
      });
    }

    // journalAgentSessionRecord returns null when this generation was already
    // journaled by a concurrent close path — the captured sessionId may differ
    // from the one that actually landed, so promoting by our sessionId could pin
    // the wrong record or drop the prepared metadata. Fail closed instead: the
    // pane stays as an exited/restartable panel and the user can retry or use
    // Add bookmark from history on the resulting record.
    if (!record) {
      throw new AppError({
        code: "PERSIST_FAILED",
        message: `Bookmark for ${terminalId} raced a concurrent session capture; retry`,
      });
    }

    // A successor may have taken the terminal id while we resolved the branch and
    // wrote the record. The bookmark is durable for the correct (old) session, but
    // the pane now shows the successor — reject so the renderer keeps it open
    // rather than removing (and orphaning) the successor's backend.
    if (typeof generation === "number" && !ledger.isCurrent(terminalId, generation)) {
      throw new AppError({
        code: "STALE_GENERATION",
        message: `Terminal ${terminalId} was restarted during bookmark capture`,
      });
    }

    return { record };
  };

  // A thrown mutator (unreadable journal, atomic-write failure) must surface the
  // stable PERSIST_FAILED code, not a raw errno — SESSION_NOT_FOUND is reserved
  // for a successful read that finds no target (the null return).
  const asBookmarkPersistError = (err: unknown, sessionId: string): AppError =>
    new AppError({
      code: "PERSIST_FAILED",
      message: `Failed to persist bookmark change for session ${sessionId}`,
      cause: err instanceof Error ? err : undefined,
    });

  const handleAgentSessionPromoteBookmark = async (
    payload: z.output<typeof BookmarkMutatePayloadSchema>
  ): Promise<AgentSessionRecord> => {
    const { app } = await import("electron");
    const userData = app.getPath("userData");
    // Same scoping guard as the capture path: a record with no owning project can
    // never appear in the project-scoped bookmark list, so promoting it would
    // create a pin the user can't see or delete. A record's projectId is fixed at
    // journal time, so reading it before the write is sufficient; a record that
    // disappears in between still falls through to promoteBookmark's null →
    // SESSION_NOT_FOUND.
    const target = readSessionHistorySync(userData).find((r) => r.sessionId === payload.sessionId);
    if (target && !target.projectId) {
      throw new AppError({
        code: "NOT_BOOKMARKABLE",
        message: `Session ${payload.sessionId} has no owning project to scope a bookmark to`,
      });
    }
    let record: AgentSessionRecord | null;
    try {
      record = await promoteBookmark(payload.sessionId, payload.label, userData);
    } catch (err) {
      throw asBookmarkPersistError(err, payload.sessionId);
    }
    if (!record) {
      throw new AppError({
        code: "SESSION_NOT_FOUND",
        message: `No resumable session ${payload.sessionId} to bookmark`,
      });
    }
    return record;
  };

  const handleAgentSessionRenameBookmark = async (
    payload: z.output<typeof BookmarkMutatePayloadSchema>
  ): Promise<AgentSessionRecord> => {
    const { app } = await import("electron");
    let record: AgentSessionRecord | null;
    try {
      record = await renameBookmark(payload.sessionId, payload.label, app.getPath("userData"));
    } catch (err) {
      throw asBookmarkPersistError(err, payload.sessionId);
    }
    if (!record) {
      throw new AppError({
        code: "SESSION_NOT_FOUND",
        message: `No bookmark ${payload.sessionId} to rename`,
      });
    }
    return record;
  };

  const handleAgentSessionDeleteBookmark = async (
    payload: z.output<typeof BookmarkDeletePayloadSchema>
  ): Promise<void> => {
    const { app } = await import("electron");
    let removed: boolean;
    try {
      removed = await deleteBookmark(
        payload.sessionId,
        app.getPath("userData"),
        getAgentSessionRetentionDays()
      );
    } catch (err) {
      throw asBookmarkPersistError(err, payload.sessionId);
    }
    if (!removed) {
      throw new AppError({
        code: "SESSION_NOT_FOUND",
        message: `No bookmark ${payload.sessionId} to delete`,
      });
    }
  };

  const handleAgentSessionListBookmarks = async (
    payload: z.output<typeof ListBookmarksPayloadSchema>
  ): Promise<AgentSessionRecord[]> => {
    const { app } = await import("electron");
    return listBookmarks(payload?.projectId, app.getPath("userData"));
  };

  const namespace = defineIpcNamespace({
    name: "terminalLifecycle",
    ops: {
      spawn: opValidated(CHANNELS.TERMINAL_SPAWN, TerminalSpawnOptionsSchema, handleTerminalSpawn, {
        withContext: true,
      }),
      kill: op(CHANNELS.TERMINAL_KILL, handleTerminalKill),
      gracefulKill: op(CHANNELS.TERMINAL_GRACEFUL_KILL, handleTerminalGracefulKill),
      trash: op(CHANNELS.TERMINAL_TRASH, handleTerminalTrash),
      restore: op(CHANNELS.TERMINAL_RESTORE, handleTerminalRestore),
      restartService: op(CHANNELS.TERMINAL_RESTART_SERVICE, handleTerminalRestartService),
      getHostMemoryPause: op(
        CHANNELS.TERMINAL_GET_HOST_MEMORY_PAUSE,
        handleTerminalGetHostMemoryPause
      ),
      agentSessionList: op(CHANNELS.AGENT_SESSION_LIST, handleAgentSessionList),
      agentSessionClear: op(CHANNELS.AGENT_SESSION_CLEAR, handleAgentSessionClear),
      agentSessionGetRetention: op(
        CHANNELS.AGENT_SESSION_GET_RETENTION,
        handleAgentSessionGetRetention
      ),
      agentSessionSetRetention: opValidated(
        CHANNELS.AGENT_SESSION_SET_RETENTION,
        AgentSessionRetentionDaysSchema,
        handleAgentSessionSetRetention
      ),
      agentSessionPrepareBookmark: opValidated(
        CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK,
        PrepareBookmarkPayloadSchema,
        handleAgentSessionPrepareBookmark
      ),
      agentSessionPromoteBookmark: opValidated(
        CHANNELS.AGENT_SESSION_PROMOTE_BOOKMARK,
        BookmarkMutatePayloadSchema,
        handleAgentSessionPromoteBookmark
      ),
      agentSessionRenameBookmark: opValidated(
        CHANNELS.AGENT_SESSION_RENAME_BOOKMARK,
        BookmarkMutatePayloadSchema,
        handleAgentSessionRenameBookmark
      ),
      agentSessionDeleteBookmark: opValidated(
        CHANNELS.AGENT_SESSION_DELETE_BOOKMARK,
        BookmarkDeletePayloadSchema,
        handleAgentSessionDeleteBookmark
      ),
      agentSessionListBookmarks: opValidated(
        CHANNELS.AGENT_SESSION_LIST_BOOKMARKS,
        ListBookmarksPayloadSchema,
        handleAgentSessionListBookmarks
      ),
    },
  });

  return namespace.register();
}
