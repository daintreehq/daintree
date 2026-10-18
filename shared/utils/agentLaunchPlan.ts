import {
  getAgentDisplayTitle,
  type AgentConfig,
  type AgentPreset,
} from "../config/agentRegistry.js";
import {
  buildAgentLaunchFlags,
  generateAgentCommand,
  mintAssignedSessionId,
  resolveEffectivePresetId,
  type AgentSettings,
} from "../types/agentSettings.js";
import type { AgentCliDetail } from "../types/ipc/system.js";
import { appendCallerLaunchFlagsToCommand } from "./callerLaunchFlags.js";
import { applyPresetBehaviorOverrides, getMergedPreset, sanitizeAgentEnv } from "./agentPresets.js";
import { sanitizeTerminalName } from "./agentLaunchValidation.js";
import { isAbsolute, isPathInside, pathComparisonKey } from "./path.js";

/** What a caller asked of one launch, as the launcher's options carry it. */
export interface AgentLaunchPlanOptions {
  /** `null` launches the bare agent; omitted, the saved preset for the worktree applies. */
  presetId?: string | null;
  /** Layered over the agent's global env and the preset's env. */
  env?: Record<string, string>;
  prompt?: string;
  interactive?: boolean;
  modelId?: string;
  systemPromptArgs?: string[];
  agentLaunchFlags?: string[];
  name?: string;
}

export interface AgentLaunchPlanInput {
  agentId: string;
  /** The effective registry entry; absent for a plain-terminal launch. */
  agentConfig: AgentConfig | undefined;
  isAgent: boolean;
  /** The worktree the launch files under, which scopes a saved preset. */
  worktreeId: string | null | undefined;
  settings: AgentSettings | null | undefined;
  ccrPresets: AgentPreset[] | undefined;
  projectPresets: AgentPreset[] | undefined;
  options: AgentLaunchPlanOptions | undefined;
  /** The shell of the host the command runs on. */
  shellDialect: "posix" | "windows" | undefined;
  resolveBaseCommand: (registryCommand: string, detail: AgentCliDetail | undefined) => string;
  getCliDetail: (agentId: string) => Promise<AgentCliDetail | undefined>;
  /** The directory Gemini is pointed at for clipboard images, when it can be found. */
  getClipboardDirectory: () => Promise<string | undefined>;
  /**
   * Told, as soon as it is known and before anything is awaited, which saved
   * preset slot named a preset that no longer exists, so the caller can clear
   * it and the next launch resolves directly against the fallback.
   */
  onStalePreset?: (scope: "worktree" | "agent") => void;
}

export interface AgentLaunchPlan {
  command: string | undefined;
  /** The settings-derived flags plus the caller's, persisted for resume. */
  launchFlags: string[] | undefined;
  /** The caller's own flags, recorded apart so a rebuild re-appends exactly these. */
  callerLaunchFlags: string[] | undefined;
  assignedSessionId: string | undefined;
  env: Record<string, string> | undefined;
  preset: AgentPreset | undefined;
  /** The availability detail the command was resolved from, reused by the launch gate. */
  cliDetail: AgentCliDetail | undefined;
  title: string;
  /** "custom" when the title is the caller's name or a preset's, so detection keeps it. */
  titleMode: "custom" | undefined;
}

/**
 * Work out what one launch runs: the preset it resolves to, the command, the
 * flags persisted for resume, the environment and the title (#13495).
 *
 * Shared by the renderer's launcher and the host's viewless launch so a
 * launch means the same thing whichever side starts it. Every input that
 * differs between the two — where settings and presets are read from, how the
 * CLI is probed, which shell the host runs — is a parameter.
 */
export async function buildAgentLaunchPlan(input: AgentLaunchPlanInput): Promise<AgentLaunchPlan> {
  const { agentId, agentConfig, isAgent, worktreeId, options } = input;

  let command: string | undefined;
  let launchFlags: string[] | undefined;
  let callerLaunchFlags: string[] | undefined;
  // Session id chosen up front for CLIs that accept one (#11782). Minted per
  // launch and never reused: re-offering an id the CLI already knows is
  // rejected outright, so each fresh conversation needs its own.
  let assignedSessionId: string | undefined;
  let env: Record<string, string> | undefined;
  let preset: AgentPreset | undefined;
  let cliDetail: AgentCliDetail | undefined;

  if (agentConfig) {
    const entry = input.settings?.agents?.[agentId] ?? {};
    // null = explicitly default — skip preset lookup entirely
    // undefined = use saved preset for this worktree (or agent-level
    //   default, or nothing). Worktree-scoped override wins over the
    //   agent-level `presetId` so switching worktrees doesn't silently
    //   surface another worktree's pick.
    const explicitDefault = options?.presetId === null;
    const savedPresetId = resolveEffectivePresetId(entry, worktreeId);
    const resolvedPresetId = explicitDefault ? undefined : (options?.presetId ?? savedPresetId);
    const primaryPreset =
      isAgent && !explicitDefault
        ? getMergedPreset(
            agentId,
            resolvedPresetId,
            entry.customPresets,
            input.ccrPresets,
            input.projectPresets
          )
        : undefined;
    preset = primaryPreset;

    // Fallback for this launch: if the worktree-scoped pick is stale but the
    // agent-level default is still valid, use the agent default now. Without
    // this, a deleted scoped preset would launch preset-free even when a valid
    // global fallback exists. The stale scoped slot is still reported below so
    // the next launch resolves directly against global.
    const scopedId =
      worktreeId && entry.worktreePresets ? entry.worktreePresets[worktreeId] : undefined;
    if (
      !primaryPreset &&
      isAgent &&
      !explicitDefault &&
      options?.presetId === undefined &&
      scopedId &&
      scopedId === resolvedPresetId &&
      entry.presetId &&
      entry.presetId !== scopedId
    ) {
      preset = getMergedPreset(
        agentId,
        entry.presetId,
        entry.customPresets,
        input.ccrPresets,
        input.projectPresets
      );
    }

    // Stale presetId cleanup: clear whichever scope held the vanished ID. The
    // worktree slot wins at resolution time, so only fall through to clearing
    // the agent-level default when that's what the launch used.
    if (resolvedPresetId && !primaryPreset) {
      if (scopedId && scopedId === resolvedPresetId && worktreeId) {
        input.onStalePreset?.("worktree");
      } else if (entry.presetId && entry.presetId === resolvedPresetId) {
        input.onStalePreset?.("agent");
      }
    }

    // Merge: global env (base) overridden by preset env (preset wins on
    // conflicts). Caller-supplied env layers on top of both — used for
    // session-bound secrets like DAINTREE_MCP_TOKEN.
    const sanitizedGlobal = sanitizeAgentEnv(entry.globalEnv as Record<string, unknown>);
    const sanitizedPreset = preset?.env;
    const callerEnv = options?.env;
    if (sanitizedGlobal || sanitizedPreset || callerEnv) {
      env = { ...sanitizedGlobal, ...sanitizedPreset, ...callerEnv };
    }

    // Per-preset behavioral overrides (incl. tri-state bypass mode) on top of
    // agent-level settings via the shared resolver.
    const effectiveEntry = applyPresetBehaviorOverrides(entry, preset);

    let clipboardDirectory: string | undefined;
    if (agentId === "gemini" && effectiveEntry.shareClipboardDirectory !== false) {
      try {
        clipboardDirectory = await input.getClipboardDirectory();
      } catch {
        // Non-critical: Gemini will work without clipboard access
      }
    }

    cliDetail = await input.getCliDetail(agentId);
    const baseCommand = input.resolveBaseCommand(agentConfig.command, cliDetail);
    const globalSkipPermissions = input.settings?.globalSkipPermissions ?? false;
    const globalUseAltScreen = input.settings?.globalUseAltScreen ?? false;
    assignedSessionId = isAgent ? mintAssignedSessionId(agentId) : undefined;
    command = generateAgentCommand(baseCommand, effectiveEntry, agentId, {
      initialPrompt: options?.prompt,
      interactive: options?.interactive ?? true,
      clipboardDirectory,
      modelId: options?.modelId,
      systemPromptArgs: options?.systemPromptArgs,
      presetArgs: preset?.args?.join(" "),
      globalSkipPermissions,
      globalUseAltScreen,
      sessionId: assignedSessionId,
    });

    // Process-level flags, persisted for session resume.
    if (isAgent) {
      launchFlags = buildAgentLaunchFlags(effectiveEntry, agentId, {
        modelId: options?.modelId,
        systemPromptArgs: options?.systemPromptArgs,
        presetArgs: preset?.args,
        globalSkipPermissions,
        globalUseAltScreen,
      });
    }

    // Caller-supplied flags go last so they override earlier values (argv
    // parsers typically take the last occurrence, e.g. `--model sonnet` after a
    // preset's `--model`). Mirrored into both the spawn command and the
    // persisted flags so resume reproduces the same configuration, and recorded
    // separately too (#13046): recovery paths that rebuild or reconcile the
    // settings-derived flags re-append exactly these.
    const extraFlags = options?.agentLaunchFlags?.filter(Boolean);
    if (extraFlags?.length) {
      command = appendCallerLaunchFlagsToCommand(command, extraFlags, input.shellDialect);
      if (isAgent) {
        launchFlags = [...(launchFlags ?? []), ...extraFlags];
        callerLaunchFlags = extraFlags;
      }
    }
  }

  const baseTitle =
    options?.modelId && isAgent
      ? getAgentDisplayTitle(agentId, options.modelId)
      : (agentConfig?.name ?? "Terminal");

  // Preset title: an explicit `displayTitle` wins verbatim; otherwise compose
  // the agent name with the preset in brackets ("Claude [Z.ai]") so the active
  // preset is visible next to the agent name.
  let presetTitle = baseTitle;
  let hasPresetTitle = false;
  if (isAgent && preset) {
    const presetName = preset.name?.trim();
    if (presetName) {
      hasPresetTitle = true;
      presetTitle = preset.displayTitle?.trim()
        ? preset.displayTitle
        : `${baseTitle} [${presetName}]`;
    }
  }
  // A caller-supplied name overrides the computed title. Empty after
  // sanitizing is treated as no name.
  const trimmedName = options?.name ? sanitizeTerminalName(options.name) : undefined;

  return {
    command,
    launchFlags,
    callerLaunchFlags,
    assignedSessionId,
    env,
    preset,
    cliDetail,
    title: trimmedName || presetTitle,
    // Any non-default title is pinned so the agent-detected title sync can't
    // clobber it with the bare agent name.
    titleMode: trimmedName || hasPresetTitle ? "custom" : undefined,
  };
}

/**
 * Where a launch landed. Resolved before the panel is created, so it
 * accompanies every non-null launch result — a caller driving several launches
 * at once can map a terminal back to its worktree without re-resolving the
 * target itself and reconciling afterwards (#11547).
 */
export interface LaunchAgentIdentity {
  /** Resolved target worktree, or null when the launch is outside one. */
  worktreeId: string | null;
  /** Absolute path of the resolved worktree; null when there is none. */
  worktreePath: string | null;
  /** Branch of the resolved worktree; null when detached or absent. */
  branch: string | null;
  /** Directory the panel was created with; null when none resolved. */
  cwd: string | null;
  /**
   * Whether `cwd` sits outside `worktreePath` — the pane is filed under a
   * worktree its process does not run in (#13130). Null when either path is
   * unknown or `cwd` is relative (main resolves that against a base the
   * renderer never sees). Lexical, like `isPathInside`.
   */
  cwdOutsideWorktree: boolean | null;
}

/**
 * Build the identity reported alongside a launch. Extracted as a pure helper so
 * the four return points in `launchAgent` share one construction and it stays
 * testable without mounting the hook — same reason `resolveLaunchWorktree` and
 * `resolveAgentLaunchKind` are separate.
 *
 * `cwd` is normalized from `""` to null: `resolveWorkspaceCwd` returns an empty
 * string when nothing at all resolves, and main reads a falsy cwd as "use the
 * home dir". Reporting `""` would name a directory the process never runs in.
 *
 * `worktreeId` is reported even when `targetWorktree` is null (the map has not
 * initialized yet, so the id could not be looked up) because that is the id the
 * panel is actually created with — the path and branch stay null since neither
 * is known.
 *
 * `cwd` never selects the worktree, so an explicit cwd in another repo still
 * files under the active one. `cwdOutsideWorktree` reports that disagreement
 * instead of leaving the caller to compare paths itself (#13130).
 */
export function buildLaunchIdentity(
  targetWorktreeId: string | null | undefined,
  targetWorktree: { path?: string; branch?: string } | null,
  cwd: string,
  options: { caseInsensitive: boolean }
): LaunchAgentIdentity {
  const worktreePath = targetWorktree?.path || null;
  const reportedCwd = cwd || null;
  return {
    worktreeId: targetWorktreeId || null,
    worktreePath,
    branch: targetWorktree?.branch ?? null,
    cwd: reportedCwd,
    cwdOutsideWorktree:
      worktreePath && reportedCwd && isAbsolute(reportedCwd)
        ? !isPathInside(
            pathComparisonKey(reportedCwd, options),
            pathComparisonKey(worktreePath, options)
          )
        : null,
  };
}
