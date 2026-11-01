/**
 * Whose machine each persisted setting belongs to when a window is attached to
 * a remote host, declared once for main and the renderer (#14694).
 *
 * - `host`: everything about the work — agents, accounts, environment, MCP,
 *   plugins, forge, run history, per-project state. A remote window reads and
 *   writes the connected host's value, and its settings page names the host.
 * - `device`: the screen, keyboard and this machine — theme, keybindings,
 *   terminal appearance, input and scrollback, notifications, window geometry,
 *   GPU, voice, privacy, updates, crash recovery and the host list itself.
 *   Always this machine's.
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

/**
 * One place settings are kept: an electron-store file by its `name`, or the
 * renderer's web storage by key. A renderer key ending in `*` declares every
 * key that starts with what precedes it.
 */
interface SettingStore {
  readonly kind: "electron-store" | "localStorage" | "sessionStorage";
  readonly entries: Readonly<Record<string, SettingEntry>>;
}

const host = { owner: "host", scope: "global" } as const;
const hostPerProject = { owner: "host", scope: "project" } as const;
const hostGlobalOrProject = { owner: "host", scope: "global-or-project" } as const;
const device = { owner: "device", scope: "global" } as const;
const devicePerHost = { owner: "device", scope: "host" } as const;
const devicePerProject = { owner: "device", scope: "project" } as const;
const deviceGlobalOrProject = { owner: "device", scope: "global-or-project" } as const;

export const SETTING_CATALOG = {
  // electron-store's default file, config.json.
  config: {
    kind: "electron-store",
    entries: {
      // Store-file bookkeeping; each machine's own and never crosses a link.
      _schemaVersion: device,
      windowState: device,
      // Resource watching runs where the terminals run; how this screen draws and
      // types into them is this machine's. Scrollback here is how much history
      // this screen's xterm keeps; the host's pty-host sizes and trims its own
      // buffers from its own copy.
      terminalConfig: {
        fields: {
          scrollbackLines: device,
          performanceMode: device,
          hybridInputEnabled: device,
          hybridInputAutoFocus: device,
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
      // The terminal list moves with the host; the grid layout, zoom, sidebar and
      // panel sizes, and palette habits stay with the client. This is the
      // app-wide copy: a project's own layout is kept in its workspace state.
      appState: {
        fields: {
          activeWorktreeId: host,
          terminals: host,
          recipes: host,
          panelGridConfig: device,
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
      // The toolbar is this screen's, so which agents it pins is too (#14702).
      agentToolbarPins: device,
      // Which events alert, when they escalate, quiet hours, and how they reach this
      // person are about whoever is at this screen, not the host doing the work. The
      // host still detects the events; a Shell's own choices decide which of them
      // alert it (#14701), and a host's windows use the host's.
      notificationSettings: device,
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
      // Decisions: the switch and the relay are the owner's, so a remote window
      // edits this machine's, and a Host never holds its own (#15996). Each field
      // declares its owner so a field added later has to choose one.
      decisions: {
        fields: {
          enabled: device,
          relayOrigin: device,
          installationId: device,
          deviceId: device,
          hostId: device,
          proxyAllowlisted: device,
        },
      },
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
  // The renderer's own storage. Every project view shares the `persist:daintree`
  // partition on this machine, so a remote window reads this Mac's value
  // whichever host it is attached to: all of it is the device's, and the scope
  // says how the value divides (#14695).
  "renderer-local-storage": {
    kind: "localStorage",
    entries: {
      "daintree-panel-limits": device,
      "daintree-two-pane-split": deviceGlobalOrProject,
      "daintree-preferences": device,
      "daintree-toolbar-preferences": device,
      "portal-storage": device,
      "daintree-sidebar-view:*": devicePerHost,
      "daintree-worktree-filters*": deviceGlobalOrProject,
      "daintree-command-history": devicePerProject,
      "daintree-url-history": devicePerProject,
      "daintree-terminal-search-history": device,
      "daintree-diff-notes": devicePerProject,
      "daintree-project-home": devicePerProject,
      "daintree-application-navigation": devicePerProject,
      "daintree-notification-history": device,
      "daintree-voice-recording": device,
      "daintree-voice-correction-pace": device,
      "daintree-voice-cleanup-pace:*": device,
      "daintree-forge-token-callout": device,
      "daintree-plugin-terminal-links": device,
      "help-panel-storage": device,
      "project-storage": device,
      "daintree-canopy-scope": device,
      "daintree-canopy-all-hosts": device,
      "daintree-canopy-order": device,
      "daintree-canopy-acknowledged": device,
      "daintree-canopy-role": device,
      "daintree-canopy-assistant-handbacks": device,
      "daintree-canopy-reading-offer-dismissed": device,
      "daintree-canopy-list-width": device,
      "daintree:cliAvailability:v3": device,
      "daintree:fleet-selection-hint-dismissed": device,
      "daintree:host-build-noticed:*": devicePerHost,
      "daintree:plugin-view-state:*": deviceGlobalOrProject,
      "daintree:repo-stats:origin:*": device,
      "daintree_cmd_history_*": devicePerProject,
      "daintree_quickrun_autorestart_*": devicePerProject,
      "daintree_quickrun_expanded_*": devicePerProject,
      daintree_project_hosts_expanded: device,
      daintree_project_hosts_all_shown: device,
      daintree_project_hosts_handoff: device,
      // Keys earlier builds wrote that the app still reads once or cleans up.
      "daintree-agent-preferences": device,
      "project-groups-storage": device,
    },
  },
  // Lives as long as the view does; one project's one-shot claim on open.
  "renderer-session-storage": {
    kind: "sessionStorage",
    entries: {
      "daintree:host-open-claim:*": devicePerProject,
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

const RENDERER_STORAGE = [
  SETTING_CATALOG["renderer-local-storage"].entries,
  SETTING_CATALOG["renderer-session-storage"].entries,
] as const;

const BACKUP_KEY_SUFFIX = ".__bak";

/**
 * The declaration covering a renderer storage key, exact or by `*` prefix. A
 * persisted store's last-good backup (`<key>.__bak`) belongs to its owner.
 */
export function rendererStorageDeclaration(key: string): SettingDeclaration | undefined {
  if (key.endsWith(BACKUP_KEY_SUFFIX)) {
    return rendererStorageDeclaration(key.slice(0, -BACKUP_KEY_SUFFIX.length));
  }
  for (const entries of RENDERER_STORAGE) {
    const exact = own<SettingEntry>(entries, key);
    if (exact && !("fields" in exact)) return exact;
    for (const [declared, entry] of Object.entries(entries)) {
      if (declared.endsWith("*") && key.startsWith(declared.slice(0, -1)) && !("fields" in entry)) {
        return entry;
      }
    }
  }
  return undefined;
}

export function rendererStorageOwner(key: string): SettingOwner {
  const declaration = rendererStorageDeclaration(key);
  if (!declaration) throw new Error(`No renderer storage key is declared for "${key}"`);
  return declaration.owner;
}
