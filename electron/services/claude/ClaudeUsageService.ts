/**
 * The Claude Code usage messages this machine's panes showed (#15727), grouped
 * by the login each pane ran on, for Settings (#16370). Every figure is what a
 * pane printed: no credential, usage endpoint or CLI is read, and nothing is
 * typed into a pane. Folders stay in main; the renderer gets opaque keys and
 * the names the user gave their accounts.
 */

import { createHash } from "node:crypto";
import { CLAUDE_USAGE_WINDOWS } from "../../../shared/types/ipc/agentQuota.js";
import type {
  ClaudeUsageAccount,
  ClaudeUsageAccountKind,
  ClaudeUsageReading,
  ClaudeUsageWindow,
} from "../../../shared/types/ipc/agentQuota.js";
import type { AgentSettingsEntry } from "../../../shared/types/agentSettings.js";
import { sanitizeAgentAccounts } from "../../../shared/utils/agentAccounts.js";
import { sanitizeAgentEnv } from "../../../shared/utils/agentPresets.js";
import {
  composeTitledPanel,
  type TitledPanel,
} from "../../../shared/utils/terminalTitleDisplay.js";
import {
  getShellEnvironmentObservation,
  type ShellEnvironmentObservation,
} from "../../setup/shellEnvironmentObservation.js";
import { hasEnvVar } from "../pty/EnvironmentFilter.js";
import { resolveLaunchClaudeConfigDir } from "./claudeConfigDir.js";
import {
  canonicalClaudeConfigDir,
  readClaudeUsageRecords,
  type ClaudeUsageRecord,
} from "./ClaudeUsageObservations.js";

type EnvLike = Readonly<Record<string, string | undefined>>;

const CONFIG_DIR_VAR = "CLAUDE_CONFIG_DIR";

/** What one usage read needs from outside the store, injectable for tests. */
export interface ClaudeUsageDeps {
  readSettings: () => Promise<ClaudeUsageSettings>;
  /** The pane as its header names it, or null when its host doesn't answer for it. */
  describePane: (
    terminalId: string
  ) => Promise<{ title: string | null; projectName: string | null } | null>;
  /** The key the store files a folder under, for comparing saved folders with it. */
  canonicalKey: (dir: string) => Promise<string>;
  /** Main's own environment, the layer under every launch's. */
  processEnv: EnvLike;
  /** What the user's login shell exported, when the startup probe saw it. */
  readShellObservation: () => ShellEnvironmentObservation | undefined;
}

export interface ClaudeUsageSettings {
  claude: AgentSettingsEntry | undefined;
  /** Daintree's global environment variables, applied to every launch. */
  globalEnv: Record<string, string> | undefined;
}

/**
 * The folder a Claude launch with no account lands on: the topmost layer
 * under the launch that sets `CLAUDE_CONFIG_DIR` (Claude's own env in its
 * settings, then Daintree's global env, then main's), read by the same rules
 * a pane's own env is. A project's or preset's env can still move a pane
 * elsewhere; its readings then sit under the folder it named.
 */
export function defaultClaudeConfigDir(
  settings: ClaudeUsageSettings,
  processEnv: EnvLike
): string | undefined {
  const agentEnv = sanitizeAgentEnv(settings.claude?.globalEnv as Record<string, unknown>) ?? {};
  const layers: EnvLike[] = [agentEnv, settings.globalEnv ?? {}, processEnv];
  const named = layers.find((layer) => hasEnvVar(layer, CONFIG_DIR_VAR));
  return resolveLaunchClaudeConfigDir(named ?? {});
}

/**
 * The folder the user's login shell exports, when the startup probe saw it
 * export one. A pane's shell runs that profile after Daintree hands it its
 * env, so the export can replace whatever folder the pane was launched with,
 * and main never sees which it did. `null` when it exports one that can't be
 * resolved; `undefined` when it exports none, or no probe has answered.
 */
function shellProfileConfigDir(
  observation: ShellEnvironmentObservation | undefined
): string | null | undefined {
  const exported = observation?.env[CONFIG_DIR_VAR];
  if (exported === undefined) return undefined;
  return resolveLaunchClaudeConfigDir({ [CONFIG_DIR_VAR]: exported }) ?? null;
}

function accountKey(identity: string | null): string {
  return createHash("sha256")
    .update(identity === null ? "unknown\0" : `folder\0${identity}`)
    .digest("hex")
    .slice(0, 16);
}

const WINDOW_ORDER = new Map<ClaudeUsageWindow, number>(
  CLAUDE_USAGE_WINDOWS.map((window, index) => [window, index])
);

const KIND_ORDER: Record<ClaudeUsageAccountKind, number> = {
  default: 0,
  account: 1,
  other: 2,
  unknown: 3,
};

interface Group {
  identity: string | null;
  kind: ClaudeUsageAccountKind;
  accountNames: string[];
  /** The first saved account's position, so accounts keep their order. */
  order: number;
  byWindow: Map<ClaudeUsageWindow, ClaudeUsageRecord>;
}

/**
 * The latest reading per limit for each login that has one. A pane whose
 * folder couldn't be resolved, or whose shell profile may have replaced it,
 * is never put under any login's, the default's included.
 */
export async function readClaudeUsageAccounts(
  deps: ClaudeUsageDeps = defaultDeps()
): Promise<ClaudeUsageAccount[]> {
  const records = readClaudeUsageRecords();
  if (records.length === 0) return [];

  const settings = await deps
    .readSettings()
    .catch((): ClaudeUsageSettings => ({ claude: undefined, globalEnv: undefined }));
  const observation = deps.readShellObservation();
  const profileDir = shellProfileConfigDir(observation);
  const profileIdentity = profileDir ? await deps.canonicalKey(profileDir) : profileDir;
  // A profile that exports a folder is where a launch with no account of its
  // own ends up, whatever Daintree's layers name.
  const defaultDir =
    profileDir === undefined ? defaultClaudeConfigDir(settings, deps.processEnv) : profileDir;
  const defaultIdentity = defaultDir ? await deps.canonicalKey(defaultDir) : undefined;
  const accounts = sanitizeAgentAccounts(settings.claude?.accounts);
  const accountIdentities = await Promise.all(
    accounts.map((account) => deps.canonicalKey(account.configDir))
  );

  const groups = new Map<string | null, Group>();
  for (const record of records) {
    // In the shell the probe ran, only a pane already on the profile's folder
    // is certain to still be on it. A pane in another shell never ran that
    // profile, so its launch folder stands, as it does with no probe at all.
    const ranProfile = record.shell === null || record.shell === observation?.shell;
    const identity =
      profileIdentity !== undefined && ranProfile && record.configDir !== profileIdentity
        ? null
        : record.configDir;
    let group = groups.get(identity);
    if (group === undefined) {
      const named =
        identity === null
          ? []
          : accounts.filter((_, index) => accountIdentities[index] === identity);
      const firstIndex = identity === null ? -1 : accountIdentities.indexOf(identity);
      const kind: ClaudeUsageAccountKind =
        identity === null
          ? "unknown"
          : identity === defaultIdentity
            ? "default"
            : named.length > 0
              ? "account"
              : "other";
      group = {
        identity,
        kind,
        accountNames: named.map((account) => account.name),
        order: firstIndex < 0 ? Number.MAX_SAFE_INTEGER : firstIndex,
        byWindow: new Map(),
      };
      groups.set(identity, group);
    }
    const current = group.byWindow.get(record.window);
    if (current === undefined || record.observedAt > current.observedAt) {
      group.byWindow.set(record.window, record);
    }
  }

  const ordered = [...groups.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order - b.order
  );
  const paneIds = new Set(
    ordered.flatMap((group) => [...group.byWindow.values()].map((record) => record.terminalId))
  );
  const panes = new Map(
    await Promise.all(
      [...paneIds].map(
        async (terminalId) =>
          [terminalId, await deps.describePane(terminalId).catch(() => null)] as const
      )
    )
  );

  return ordered.map((group) => ({
    key: accountKey(group.identity),
    kind: group.kind,
    accountNames: group.accountNames,
    readings: [...group.byWindow.values()]
      .sort((a, b) => WINDOW_ORDER.get(a.window)! - WINDOW_ORDER.get(b.window)!)
      .map((record): ClaudeUsageReading => {
        const pane = panes.get(record.terminalId) ?? null;
        return {
          window: record.window,
          statement: record.statement,
          usedPercent: record.usedPercent,
          resetsAt: record.resetsAt,
          observedAt: record.observedAt,
          terminalId: record.terminalId,
          paneTitle: pane?.title ?? null,
          projectName: pane?.projectName ?? null,
        };
      }),
  }));
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The title the pane's header shows: a user's title, then the agent's task. */
export function paneDisplayTitle(info: Partial<TitledPanel>): string | null {
  return nonEmpty(
    composeTitledPanel(
      {
        title: info.title ?? "",
        titleMode: info.titleMode,
        lastObservedTitle: info.lastObservedTitle,
        detectedAgentId: info.detectedAgentId,
        agentState: info.agentState,
        cwd: info.cwd,
      },
      "full"
    )
  );
}

function defaultDeps(): ClaudeUsageDeps {
  return {
    readSettings: async () => {
      // Lazy, like the handler's own import of this module.
      const { store } = await import("../../store.js");
      return {
        claude: store.get("agentSettings")?.agents?.claude,
        globalEnv: store.get("globalEnvironmentVariables"),
      };
    },
    describePane: async (terminalId) => {
      const { getPtyClient } = await import("../../window/serviceRefs.js");
      const info = await getPtyClient()?.getTerminalAsync(terminalId);
      if (!info) return null;
      let projectName: string | null = null;
      if (info.projectId) {
        const { projectStore } = await import("../ProjectStore.js");
        projectName = nonEmpty(projectStore.getProjectById(info.projectId)?.name);
      }
      return { title: paneDisplayTitle(info), projectName };
    },
    canonicalKey: canonicalClaudeConfigDir,
    processEnv: process.env,
    readShellObservation: getShellEnvironmentObservation,
  };
}
