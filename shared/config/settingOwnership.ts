/**
 * Whose machine each persisted setting belongs to when a window is attached to
 * a remote host, declared once for main and the renderer (#14694).
 *
 * - `host`: everything about the work — agents, accounts, environment, MCP,
 *   plugins, forge, run history, per-project state. A remote window reads and
 *   writes the connected host's value, and its settings page names the host.
 * - `device`: the screen, keyboard and this machine — theme, keybindings,
 *   terminal appearance, window geometry, GPU, voice, privacy, updates, crash
 *   recovery and the host list itself. Always this machine's.
 *
 * Main derives its ownership tables from this (`electron/storeOwnership.ts`)
 * and holds them total over the store schemas, so a store key or field that
 * doesn't declare an owner fails typecheck. Nothing is synced between hosts.
 */
export type SettingOwner = "host" | "device";

/**
 * How the owner's stored value divides: one answer (`global`), one per project
 * (keyed by project, workspace, worktree or project path), one per paired host
 * kept on this machine (`host`), or a value holding both global and
 * per-project answers. It describes the stored shape; it routes nothing and
 * makes nothing editable.
 */
export type SettingScope = "global" | "project" | "host" | "global-or-project";

export interface SettingDeclaration {
  readonly owner: SettingOwner;
  readonly scope: SettingScope;
}

/** A key whose fields have their own owners. */
interface SplitSetting {
  readonly fields: Readonly<Record<string, SettingDeclaration>>;
}

export type SettingEntry = SettingDeclaration | SplitSetting;

/** One file of settings: electron-store's, by its `name`. */
interface SettingStore {
  readonly kind: "electron-store";
  readonly entries: Readonly<Record<string, SettingEntry>>;
}

const host = { owner: "host", scope: "global" } as const;
const hostPerProject = { owner: "host", scope: "project" } as const;
const hostGlobalOrProject = { owner: "host", scope: "global-or-project" } as const;
const device = { owner: "device", scope: "global" } as const;
const devicePerHost = { owner: "device", scope: "host" } as const;
const deviceGlobalOrProject = { owner: "device", scope: "global-or-project" } as const;

export const SETTING_CATALOG = {
  // electron-store's default file, config.json.
  config: {
    kind: "electron-store",
    entries: {
      // Store-file bookkeeping; each machine's own and never crosses a link.
      _schemaVersion: device,
      windowState: device,
      // Behaviour runs where the terminals run; appearance is how this screen draws them.
      terminalConfig: {
        fields: {
          scrollbackLines: host,
          performanceMode: host,
          hybridInputEnabled: host,
          hybridInputAutoFocus: host,
          resourceMonitoringEnabled: host,
          memoryLeakDetectionEnabled: host,
          memoryLeakAutoRestartThresholdMb: host,
          screenReaderMode: device,
          cachedProjectViews: device,
          fontSize: device,
          fontFamily: device,
          colorSchemeId: device,
          customSchemes: device,
          recentSchemeIds: device,
        },
      },
      sessionRestore: host,
      windowOpening: device,
      // Each machine holds its own power assertion for its own agents; a remote
      // window's keep-awake split answers from this machine, so it edits this one.
      keepAwake: device,
      idleTerminalNotify: host,
      idleTerminalDismissals: hostPerProject,
      idleTerminalNotifiedAt: hostPerProject,
      parkedRuns: host,
      snoozedRuns: host,
      idleBackgroundAutoClose: host,
      pluginBackgroundUpdateCheck: host,
      // Panel layout and the terminal list move with the host; zoom, sidebar and
      // panel sizes, and palette habits stay with the client. This is the
      // app-wide copy: a project's own layout is kept in its workspace state.
      appState: {
        fields: {
          activeWorktreeId: host,
          terminals: host,
          recipes: host,
          panelGridConfig: host,
          mruList: host,
          focusMode: host,
          fleetScopeMode: host,
          sidebarWidth: device,
          focusPanelState: device,
          diagnosticsHeight: device,
          dockedPopoverHeight: device,
          hasSeenWelcome: device,
          developerMode: device,
          actionMruList: device,
          actionPinnedIds: device,
          actionHiddenIds: device,
        },
      },
      legacyWorkspaceStateOwnerId: host,
      hostEndRestoreHolds: host,
      userConfig: host,
      worktreeConfig: host,
      agentSettings: hostGlobalOrProject,
      // The host decides when its agents notify, so the policy (what notifies,
      // escalation, quiet hours) is the host's. How a notification reaches this
      // person (sounds, the flash, how the bell groups them) is this screen's.
      notificationSettings: {
        fields: {
          enabled: host,
          completedEnabled: host,
          waitingEnabled: host,
          waitingEscalationEnabled: host,
          waitingEscalationDelayMs: host,
          workingPulseEnabled: host,
          quietHoursEnabled: host,
          quietHoursStartMin: host,
          quietHoursEndMin: host,
          quietHoursWeekdays: host,
          soundEnabled: device,
          completedSoundFile: device,
          waitingSoundFile: device,
          escalationSoundFile: device,
          workingPulseSoundFile: device,
          uiFeedbackSoundEnabled: device,
          flashEnabled: device,
          groupByContext: device,
        },
      },
      userAgentRegistry: host,
      agentUpdateSettings: host,
      keybindingOverrides: device,
      projectEnv: hostPerProject,
      globalEnvironmentVariables: host,
      appAgentConfig: host,
      windowStates: deviceGlobalOrProject,
      worktreeIssueMap: hostPerProject,
      wslGitByWorktree: hostPerProject,
      rosettaWarningDismissed: device,
      // Canopy reads the agents of the machine it runs on, which is the host, with
      // a model downloaded there.
      canopyMode: host,
      appTheme: deviceGlobalOrProject,
      privacy: device,
      agentSessionHistory: host,
      voiceInput: device,
      mcpServer: host,
      helpAssistant: host,
      pendingErrors: device,
      errorFingerprints: device,
      gpu: device,
      crashRecovery: device,
      onboarding: device,
      orchestrationMilestones: device,
      shortcutHintCounts: device,
      shortcutHintHoveredKeys: device,
      forgeEnableDismissedPaths: hostPerProject,
      updateChannel: device,
      dismissedUpdateVersion: device,
      dismissedUpdateAt: device,
      versionFirstRun: device,
      lastUpdateCheck: device,
      pendingUpdateVersion: device,
      pendingUpdateInstallStage: device,
      storeUpdateNotificationsEnabled: device,
      lastNotifiedStoreVersion: device,
      storeNotifierEtag: device,
      logLevelOverrides: device,
      plugins: host,
      forgeDefaultProviderId: host,
      forgeCredentials: host,
      forgeAudit: host,
      runHistory: host,
      pluginMcpAudit: host,
      pluginMcpConsent: host,
      pluginMcpConfig: host,
      pluginCapabilityConsent: hostGlobalOrProject,
      projectPluginTrust: hostPerProject,
      projectPluginVisibility: hostGlobalOrProject,
      pluginProjectInstances: hostPerProject,
      projectSurfaceChoices: hostPerProject,
      projectFileEditorChoices: hostPerProject,
      projectLayoutSeeds: hostPerProject,
      projectApplicationWelcomes: hostPerProject,
      projectHiddenLaunchGroups: hostPerProject,
      projectPluginSetupSkips: hostPerProject,
      projectPluginAccountBindings: hostPerProject,
      pluginNotificationSilences: hostGlobalOrProject,
      hiddenSearchProviders: hostGlobalOrProject,
      pluginContextProvidersOff: hostGlobalOrProject,
      pluginWorktreeDeleteNoteMutes: hostGlobalOrProject,
      projectPresentation: hostPerProject,
      worktreeCustomTitles: hostPerProject,
      projectAgentMcpEnablement: hostPerProject,
      projectAgentMcpAccess: hostPerProject,
      pluginAgentMcpAccess: host,
      projectAssistantAgentMcpAccess: hostPerProject,
      workspaceKeepResident: hostPerProject,
      // Dev servers run on the host, so a user Stop is recorded where the panel's server lives.
      devPreviewUserStopped: hostPerProject,
      remoteHosts: device,
      hostMode: device,
      // This machine's own listener and the devices paired to it.
      deviceAnswer: device,
      remoteHostsPreferences: device,
      // What this machine lets a host's plugins do with its clipboard.
      remoteHostPluginClipboardGrants: devicePerHost,
      // Which host plugins may run their view code on this machine, and what code.
      remoteHostPluginViewConsent: devicePerHost,
    },
  },
  "window-states": {
    kind: "electron-store",
    entries: {
      windowStates: deviceGlobalOrProject,
    },
  },
  "audit-logs": {
    kind: "electron-store",
    entries: {
      mcpAuditLog: host,
      mcpTurnOutcomeLog: host,
      pluginAuditLog: host,
      forgeAuditLog: host,
      runHistoryRecords: host,
      pluginMcpAuditLog: host,
    },
  },
} as const satisfies Readonly<Record<string, SettingStore>>;

type ConfigEntries = typeof SETTING_CATALOG.config.entries;

/**
 * A setting in the main settings file: its store key, or `key.field` for a
 * key whose fields have their own owners (which has no owner of its own).
 */
export type SettingPath = {
  [K in keyof ConfigEntries & string]: ConfigEntries[K] extends { readonly fields: infer F }
    ? `${K}.${keyof F & string}`
    : K;
}[keyof ConfigEntries & string];

function own<T>(record: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function lookUp(path: string): SettingDeclaration | undefined {
  const [key, field, ...rest] = path.split(".");
  const entry = own<SettingEntry>(SETTING_CATALOG.config.entries, key);
  if (!entry || rest.length > 0) return undefined;
  if ("fields" in entry) return own(entry.fields, field);
  return field === undefined ? entry : undefined;
}

export function settingDeclaration(path: SettingPath): SettingDeclaration {
  const declaration = lookUp(path);
  if (!declaration) throw new Error(`No setting is declared at "${path}"`);
  return declaration;
}

export function settingOwner(path: SettingPath): SettingOwner {
  return settingDeclaration(path).owner;
}
