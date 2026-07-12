/**
 * Terminal lifecycle handlers - spawn, kill, trash, restore.
 */

import crypto from "crypto";
import os from "os";
import { z } from "zod";
import { CHANNELS } from "../../channels.js";
import { waitForBurstRateLimitSlot, consumeRestoreQuota } from "../../utils.js";
import { defineIpcNamespace, op, opValidated } from "../../define.js";
import { projectStore } from "../../../services/ProjectStore.js";
import type * as McpServerServiceModule from "../../../services/McpServerService.js";
import { mcpPaneConfigService } from "../../../services/McpPaneConfigService.js";
import { helpSessionService } from "../../../services/HelpSessionService.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";
import {
  TerminalSpawnOptionsSchema,
  AgentSessionRetentionDaysSchema,
} from "../../../schemas/ipc.js";
import { store } from "../../../store.js";
import type { AgentSessionRetentionDays } from "../../../../shared/types/ipc/agentSessionHistory.js";
import { resolveDaintreeMcpTier } from "../../../../shared/types/project.js";
import { DEFAULT_DANGEROUS_ARGS } from "../../../../shared/types/agentSettings.js";
import {
  getAssistantWiredAgentIds,
  getEffectiveAgentConfig,
} from "../../../../shared/config/agentRegistry.js";
import { getPluginIdForAgent } from "../../../../shared/config/pluginAgentRegistry.js";
import {
  SettingTemplateError,
  substituteSettingsTemplates,
} from "../../../services/settingsTemplateResolver.js";
import type * as PluginServiceModule from "../../../services/PluginService.js";

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
// stack is ~637KB and only needed for Claude launches with a non-"off" MCP
// tier, so keep it out of this module's static import set (it loads eagerly
// at boot).
type McpServerSingleton = typeof McpServerServiceModule.mcpServerService;

let cachedMcpServerService: McpServerSingleton | null = null;
async function getMcpServerService(): Promise<McpServerSingleton> {
  if (!cachedMcpServerService) {
    const mod = await import("../../../services/McpServerService.js");
    cachedMcpServerService = mod.mcpServerService;
  }
  return cachedMcpServerService;
}

// One-time wiring of the assistant-pane pinning resolvers (#10647). Help-session
// resolvers are wired in globalServicesInit / HelpSessionService; the assistant
// pane path has no such owner, so we lazily wire it on first assistant spawn —
// before `registerAssistantPaneBearer` and the CLI's first `/mcp` handshake.
// Idempotent re-set is harmless, but the guard avoids re-binding on every spawn.
let assistantPaneResolversWired = false;
function wireAssistantPaneResolvers(mcpServerService: McpServerSingleton): void {
  if (assistantPaneResolversWired) return;
  mcpServerService.setAssistantPaneWebContentsResolver((token) =>
    mcpPaneConfigService.getWebContentsIdForToken(token)
  );
  mcpServerService.setAssistantPaneActionContextResolver((token) =>
    mcpPaneConfigService.getActionContextForToken(token)
  );
  assistantPaneResolversWired = true;
}

// Same lazy-import discipline as the MCP service above: PluginService pulls in
// the whole plugin host (~thousands of lines), and only plugin-agent launches
// that actually embed a `${settings:*}` template need it — so keep it off the
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
} from "../../../services/pty/agentSessionHistory.js";
import { getAgentSessionRetentionDays } from "../../../services/pty/agentSessionRetention.js";
import { journalAgentSession } from "../../../services/pty/agentSessionJournal.js";
import { getLifecycleLedger } from "../../../services/pty/lifecycleLedger.js";
import type { WorkspaceClient } from "../../../services/WorkspaceClient.js";
import { getDefaultShell } from "../../../services/pty/terminalShell.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { quoteCommandArg } from "../../../../shared/utils/shellEscape.js";
import { MAX_TERMINALS_PER_RECIPE_ADMISSION_BATCH } from "../../../../shared/utils/recipeSanitizer.js";
import { buildCommandLaunchShell } from "./commandLaunch.js";

export function registerTerminalLifecycleHandlers(deps: HandlerDependencies): () => void {
  const { ptyClient } = deps;
  if (!ptyClient) {
    return () => {};
  }

  const handleTerminalSpawn = async (
    ctx: IpcContext,
    validatedOptions: ValidatedTerminalSpawnOptions
  ): Promise<string> => {
    // Capture the sender window id synchronously before any `await` — the
    // window can be destroyed mid-spawn, after which `ctx.senderWindow` would
    // be a stale reference. Only the daintree-assistant env-only path consumes
    // this (as `DAINTREE_WINDOW_ID`); `null` means no window was in scope.
    const windowId = ctx.senderWindow?.id ?? null;

    const bypassedRateLimit = validatedOptions.restore === true && consumeRestoreQuota();
    if (!bypassedRateLimit) {
      // A bounded recipe consumes one admission slot, not one slot per panel.
      // Ordinary spawns keep the six-terminal burst and 1/sec sustained guard.
      await waitForTerminalSpawnAdmission(validatedOptions);
    }

    const cols = Math.max(1, Math.min(500, Math.floor(validatedOptions.cols) || 80));
    const rows = Math.max(1, Math.min(500, Math.floor(validatedOptions.rows) || 30));

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
    const explicitWorkspaceId = validatedOptions.projectId;
    const resolvedProject = explicitWorkspaceId
      ? projectStore.getProjectById(explicitWorkspaceId)
      : projectStore.getCurrentProject();

    // Ownership is the explicit id; project-only enrichment below (settings, shell
    // overrides, project-path cwd fallback) stays gated on a resolved Project.
    const projectId = explicitWorkspaceId ?? resolvedProject?.id;
    const projectPath = resolvedProject?.path;

    // Fetch project-level terminal overrides when there's no agent launch
    // hint. Agent launches intentionally use the default shell configuration
    // (user shell + default args) to keep behaviour predictable — project
    // overrides can shape plain-shell UX without leaking into agent launches.
    let projectShell: string | undefined;
    let projectArgs: string[] | undefined;
    let projectCwd: string | undefined;
    if (resolvedProject && !launchAgentId) {
      const projSettings = await projectStore.getProjectSettings(resolvedProject.id);
      const ts = projSettings.terminalSettings;
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

    // Resolve a shell identity early for quoting decisions only. Every
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
    const quotingShell = validatedOptions.shell || projectShell || getDefaultShell();

    // Help-assistant launches arrive with a pre-provisioned session dir whose
    // .mcp.json is already in cwd, baked with the literal session token, and
    // a .claude/settings.json that sets `enableAllProjectMcpServers: true` so
    // Claude Code auto-trusts the project-scoped servers without prompting.
    // Skip per-pane MCP config injection (the session dir owns it) and let
    // Claude's normal cwd discovery do its thing. The CLI bypass flag is
    // gated on the session's snapshotted `bypassPermissions` (independent
    // of `tier`), so an `action`-tier session can still skip permission
    // prompts and a `system`-tier session can still respect them.
    //
    // The Daintree Assistant is the exception to the session-dir cwd: it is
    // env-only (MCP via DAINTREE_MCP_* env vars, reads no cwd config) so the
    // renderer points it at the project root instead — see the assistant cwd
    // branches in HelpSessionController/`helpActions`. Nothing here depends on
    // the assistant's cwd; we just honor whatever cwd the renderer supplied.
    const helpToken = spawnEnv?.DAINTREE_MCP_TOKEN ?? "";
    const helpTier = helpToken ? helpSessionService.validateToken(helpToken) : false;
    const isAssistantAgent =
      typeof launchAgentId === "string" && getAssistantWiredAgentIds().includes(launchAgentId);
    const isHelpLaunch = helpTier !== false && isAssistantAgent && safeCommand.length > 0;

    // If a help-session token was supplied but is invalid (revoked between
    // provision and spawn — typically because a sibling provision displaced
    // the session under the single-backend invariant), refuse to silently
    // fall back to a normal Claude launch with per-pane MCP injection. The
    // renderer must always provision a fresh session before spawning the
    // assistant; falling through would resurrect the orphan-backend failure
    // mode (#7509) by spawning an unmanaged Claude in the assistant slot.
    if (!isHelpLaunch && helpToken && isAssistantAgent && safeCommand.length > 0) {
      throw new Error(
        "Daintree Assistant session token is invalid or already displaced; refusing to spawn"
      );
    }

    if (isHelpLaunch && launchAgentId) {
      const dangerous = DEFAULT_DANGEROUS_ARGS[launchAgentId];
      const bypassPermissions = helpSessionService.getBypassPermissions(helpToken);
      // The Daintree Assistant is not Claude Code — it has no
      // `--dangerously-skip-permissions` flag (no DEFAULT_DANGEROUS_ARGS entry).
      // For it, the user's "bypass permissions" preference maps to skipping the
      // assistant's OWN per-action confirm sheet, which the CLI reads from this
      // env var at startup. The capability tier remains the only safeguard.
      if (launchAgentId === "daintree-assistant" && bypassPermissions) {
        spawnEnv = { ...(spawnEnv ?? {}), DAINTREE_ASSISTANT_AUTO_APPROVE: "1" };
      }
      // The Daintree Assistant emits a full-fidelity per-session debug trace
      // when this env var is set (off by default). Gated on the user's
      // provision-time preference; only the assistant's own CLI reads it.
      if (launchAgentId === "daintree-assistant" && helpSessionService.getDebugLogging(helpToken)) {
        spawnEnv = { ...(spawnEnv ?? {}), DAINTREE_ASSISTANT_DEBUG_LOG: "1" };
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
      // Copilot help sessions get the `--plan` read-only flag appended at
      // spawn time (the same CLI-flag pinning pattern Codex uses for its
      // `-c` MCP args). MCP wiring lives in `<sessionPath>/.mcp.json` via
      // `writeCopilotMcpConfig` and is auto-discovered from cwd — no flag
      // injection needed for that.
      //
      // A `null` return is the agent-mismatch signal (e.g. a Claude help
      // token reused with `launchAgentId: "copilot"`) — refuse to spawn.
      // Strip any user-supplied `--plan` first so the appended flag is
      // unambiguously authoritative.
      if (launchAgentId === "copilot") {
        const copilotArgs = helpSessionService.getCopilotLaunchArgs(helpToken);
        if (copilotArgs === null) {
          throw new Error(
            "Daintree Assistant help token does not belong to a Copilot session; refusing to spawn"
          );
        }
        safeCommand = safeCommand
          .replace(/(^|\s)--plan(?:=\S*)?(?=\s|$)/g, "$1")
          .replace(/\s{2,}/g, " ")
          .trim();
        if (copilotArgs.length > 0) {
          safeCommand =
            `${safeCommand} ${copilotArgs.map((arg) => quoteCommandArg(arg, quotingShell)).join(" ")}`.trim();
        }
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

      // Bind this terminalId to the help session so HelpSessionService can
      // kill the PTY when the session is displaced or revoked (#7509). Owns
      // the binding from main-process spawn time, so it doesn't depend on
      // the renderer-issued `help.markTerminal` round-trip landing first.
      // A false return means the token was revoked between provision and
      // spawn (e.g. a stale resume against a session a sibling provision
      // already displaced) — refuse to launch as a help session rather
      // than silently degrading to a non-help Claude.
      if (!helpSessionService.markTerminalForToken(helpToken, id)) {
        throw new Error(
          "Daintree Assistant session token is invalid or already displaced; refusing to spawn"
        );
      }
    } else if (launchAgentId === "claude" && safeCommand.length > 0 && resolvedProject) {
      // Daintree MCP injection for normal Claude Code agent launches.
      // Mints a per-pane bearer token, writes a managed --mcp-config JSON under
      // userData, and injects the flag into the command + the token into env.
      // Token is revoked and the file deleted on PTY exit (see registerTerminalEventHandlers).
      try {
        const projSettings = await projectStore.getProjectSettings(resolvedProject.id);
        const tier = resolveDaintreeMcpTier(projSettings);
        if (tier !== "off") {
          const mcpServerService = await getMcpServerService();
          const ready = mcpServerService.isRunning || (await mcpServerService.ensureReady());
          if (!ready) {
            console.warn(
              "[TerminalSpawn] Daintree MCP requested for Claude launch, but the MCP server is not ready; continuing without MCP injection"
            );
          }
          const port = mcpServerService.currentPort;
          if (ready && port) {
            const { configPath, token } = await mcpPaneConfigService.preparePaneConfig({
              paneId: id,
              port,
              tier,
            });
            safeCommand = `${safeCommand} --mcp-config ${quoteCommandArg(configPath, quotingShell)}`;
            spawnEnv = { ...(spawnEnv ?? {}), DAINTREE_MCP_TOKEN: token };
          }
        }
      } catch (mcpErr) {
        console.error(
          "[TerminalSpawn] Failed to prepare Daintree MCP config; continuing without MCP injection:",
          mcpErr
        );
      }
    } else if (
      launchAgentId === "daintree-assistant" &&
      safeCommand.length > 0 &&
      resolvedProject
    ) {
      // Daintree Assistant reads its MCP connection details straight from PTY
      // env (`mcpInjection: "env-only"`) — no .mcp.json, no CLI flags. Mint a
      // per-pane bearer via the same `preparePaneConfig` path Claude uses so
      // the token is registered with the MCP server's bearer validator (an
      // unregistered raw UUID would be rejected on connect) and revoked on PTY
      // exit; we discard the written config file and use only the token.
      // The assistant speaks Streamable HTTP at /mcp (not Claude's /sse).
      // DAINTREE_PROJECT_ID is injected downstream by `injectDaintreeMetadata`
      // in the pty-host, so it is intentionally not set here.
      try {
        const projSettings = await projectStore.getProjectSettings(resolvedProject.id);
        const tier = resolveDaintreeMcpTier(projSettings);
        if (tier !== "off") {
          const mcpServerService = await getMcpServerService();
          const ready = mcpServerService.isRunning || (await mcpServerService.ensureReady());
          if (!ready) {
            console.warn(
              "[TerminalSpawn] Daintree MCP requested for assistant launch, but the MCP server is not ready; continuing without MCP injection"
            );
          }
          const port = mcpServerService.currentPort;
          if (ready && port) {
            const { token } = await mcpPaneConfigService.preparePaneConfig({
              paneId: id,
              port,
              tier,
            });
            // Promote the assistant's pane token to a pinned bearer so its MCP
            // session binds to the launching renderer's WebContents and replays
            // the launch-time ActionContext, instead of falling back to
            // active-window dispatch (#10647). The resolvers must be wired and
            // the bearer registered before this IPC resolves — the PTY starts
            // immediately and the CLI's first /mcp POST can race ahead. When the
            // sender WebContents is unknown we skip registration and degrade to
            // the generic pane-token behaviour rather than pinning to nothing.
            //
            // Cleanup is free: the pinning metadata lives on the token record,
            // so the existing `revokePaneConfig(id)` on PTY exit (events.ts) and
            // spawn failure tears it down. A destroyed renderer is handled by
            // the fail-closed `getPinnedWebContents` → `SessionBindingError`
            // primitive, which is exactly the structured tool error we want —
            // revoking the token here would degrade that into a 401 instead.
            if (Number.isInteger(ctx.webContentsId) && ctx.webContentsId > 0) {
              wireAssistantPaneResolvers(mcpServerService);
              mcpPaneConfigService.registerAssistantPaneBearer(
                token,
                ctx.webContentsId,
                validatedOptions.actionContext
              );
            }
            spawnEnv = {
              ...(spawnEnv ?? {}),
              DAINTREE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
              DAINTREE_MCP_TOKEN: token,
              ...(windowId !== null ? { DAINTREE_WINDOW_ID: String(windowId) } : {}),
            };
          }
        }
      } catch (mcpErr) {
        console.error(
          "[TerminalSpawn] Failed to prepare Daintree Assistant MCP env; continuing without MCP injection:",
          mcpErr
        );
      }
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
    const commandLaunchShell = buildCommandLaunchShell(safeCommand, quotingShell);
    const resolvedArgs = commandLaunchShell ? commandLaunchShell.args : projectArgs;
    const spawnShell = commandLaunchShell
      ? commandLaunchShell.shell
      : validatedOptions.shell || projectShell;

    try {
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
        title,
        titleMode: validatedOptions.titleMode,
        projectId,
        restore: validatedOptions.restore,
        isEphemeral: validatedOptions.isEphemeral,
        agentLaunchFlags: validatedOptions.agentLaunchFlags,
        agentModelId: validatedOptions.agentModelId,
        worktreeId: validatedOptions.worktreeId,
        agentPresetId: validatedOptions.agentPresetId,
        agentPresetColor: validatedOptions.agentPresetColor,
        originalAgentPresetId:
          validatedOptions.originalAgentPresetId ?? validatedOptions.agentPresetId,
      });

      if (safeCommand.length > 0 && !commandLaunchShell) {
        // Execute immediately. node-pty queues the write against the spawned
        // shell, so users do not stare at a blank prompt while we wait for RC
        // files/prompt detection. The shell still remains the parent process;
        // when the command exits, the terminal returns to a normal shell.
        if (ptyClient.hasTerminal(id)) {
          ptyClient.write(id, `${safeCommand}\r`);
        }
      }

      return id;
    } catch (error) {
      // If we minted an MCP pane config above and the PTY spawn never landed,
      // revoke it now so we don't leak per-pane tokens or config files.
      mcpPaneConfigService.revokePaneConfig(id).catch(() => {
        // best-effort cleanup
      });
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
  // Best-effort: a null sessionId (no resumable session — e.g. Cursor or a
  // non-resume-config agent), a non-agent terminal, or a branch-lookup failure
  // all skip silently and never fail the close. Mirrors PtyManager's trash-
  // expiry capture, the fourth close path that already journals.
  const persistCloseRecord = async (
    info: Awaited<ReturnType<typeof ptyClient.getTerminalAsync>>,
    sessionId: string | null,
    generation?: number
  ): Promise<void> => {
    if (!sessionId || !info?.launchAgentId) return;
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
        },
        { terminalId: info.id, generation }
      );
    } catch (err) {
      console.warn("[TerminalLifecycle] Failed to persist agent session on close:", err);
    }
  };

  const handleTerminalKill = async (id: string): Promise<void> => {
    try {
      if (typeof id !== "string") {
        throw new Error("Invalid terminal ID: must be a string");
      }
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
        await persistCloseRecord(info, sessionId, generation);
      } else {
        ptyClient.kill(id);
      }
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to kill terminal");
      throw new Error(`Failed to kill terminal: ${errorMessage}`);
    }
  };

  const handleTerminalGracefulKill = async (id: string): Promise<string | null> => {
    if (typeof id !== "string") {
      throw new Error("Invalid terminal ID: must be a string");
    }
    const info = await ptyClient.getTerminalAsync(id).catch(() => null);
    const generation = getLifecycleLedger().currentGeneration(id);
    const sessionId = await ptyClient.gracefulKill(id);
    await persistCloseRecord(info, sessionId, generation);
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

  const handleAgentSessionList = async (payload: { worktreeId?: string }) => {
    const { app } = await import("electron");
    return listAgentSessions(
      payload?.worktreeId,
      app.getPath("userData"),
      getAgentSessionRetentionDays()
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
    },
  });

  return namespace.register();
}
