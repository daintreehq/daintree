import type { StoreSchema } from "../../../electron/store";

/**
 * The store as it looked at schema version 0.
 *
 * Annotating the fixture as `StoreSchema` would assert the migrations had
 * already run: v0 terminals carry no `location` (002 adds it), notification
 * sound config is still one `soundFile` (008 splits it into three) and agent
 * entries still hold `selected`/`enabled` (012/013 rewrite them). Only those
 * three slices are relaxed — every other field is still held to the product
 * type, so drift outside the migrated surface stays a type error.
 */
type LegacyStoreV0 = Omit<StoreSchema, "appState" | "notificationSettings" | "agentSettings"> & {
  appState: Omit<StoreSchema["appState"], "terminals"> & {
    terminals: Array<Omit<StoreSchema["appState"]["terminals"][number], "location">>;
  };
  notificationSettings: Omit<
    StoreSchema["notificationSettings"],
    | "completedSoundFile"
    | "waitingSoundFile"
    | "escalationSoundFile"
    | "workingPulseEnabled"
    | "workingPulseSoundFile"
    | "uiFeedbackSoundEnabled"
    | "quietHoursEnabled"
    | "quietHoursStartMin"
    | "quietHoursEndMin"
    | "quietHoursWeekdays"
  > & { soundFile: string };
  agentSettings: Omit<StoreSchema["agentSettings"], "agents"> & {
    agents: Record<string, Record<string, unknown>>;
  };
};

/**
 * Generates a heavy v0 store fixture so that MigrationRunner will apply all 16
 * migrations (v2–v17). The fixture exercises the O(N) paths in migrations 002
 * (terminals), 003 (recipes), 012 (agents), and 013 (agents).
 */
export function createHeavyMigrationFixture(): LegacyStoreV0 {
  const terminalCount = 10_000;
  const recipeCount = 500;
  const agentCount = 200;
  const worktreeCount = 100;
  const pendingErrorCount = 100;
  const envVarCount = 100;

  const terminals: LegacyStoreV0["appState"]["terminals"] = Array.from(
    { length: terminalCount },
    (_, i) => ({
      id: `term-${i}`,
      title: `Terminal ${i}`,
      cwd: `/repo/worktrees/wt-${i % worktreeCount}/src`,
      worktreeId: `wt-${i % worktreeCount}`,
      // v0 schema — no `location` field (migration 002 adds it)
    })
  );

  const recipes: StoreSchema["appState"]["recipes"] = Array.from(
    { length: recipeCount },
    (_, i) => ({
      id: `recipe-${i}`,
      name: `Recipe ${i}`,
      worktreeId: i % 2 === 0 ? `wt-${i % worktreeCount}` : undefined,
      terminals: Array.from({ length: 3 }, (_, j) => ({
        type: "terminal" as const,
        title: `Tab ${j}`,
        command: `echo ${i}-${j}`,
      })),
      createdAt: Date.now() - i * 1000,
      showInEmptyState: i < 10,
      lastUsedAt: i % 5 === 0 ? Date.now() - i * 5000 : undefined,
    })
  );

  const agents: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < agentCount; i++) {
    // Half the agents have legacy `selected`/`enabled` (migration 012 target),
    // and half have bare `{ pinned: true }` (migration 013 phantom targets).
    if (i % 2 === 0) {
      agents[`agent-${i}`] = {
        selected: i % 3 !== 0,
        enabled: true,
        customFlag: `value-${i}`,
      };
    } else {
      agents[`agent-${i}`] = { pinned: true };
    }
  }

  const worktreeIssueMap: StoreSchema["worktreeIssueMap"] = {};
  for (let i = 0; i < worktreeCount; i++) {
    worktreeIssueMap[`wt-${i}`] = {
      issueNumber: 1000 + i,
      issueTitle: `Perf fixture issue ${1000 + i} in org/repo`,
    };
  }

  const globalEnvironmentVariables: Record<string, string> = {};
  for (let i = 0; i < envVarCount; i++) {
    globalEnvironmentVariables[`PERF_VAR_${i}`] = `value-${i}`;
  }

  const pendingErrors: StoreSchema["pendingErrors"] = Array.from(
    { length: pendingErrorCount },
    (_, i) => ({
      id: `perf-error-${i}`,
      message: `Error ${i}: something went wrong in module-${i % 20}`,
      details: `at module${i % 20} (line ${i}): error in perf fixture`,
      timestamp: Date.now() - i * 60000,
      type: i % 5 === 0 ? ("filesystem" as const) : ("process" as const),
      retryability: i % 5 === 0 ? ("none" as const) : ("auto" as const),
      dismissed: false,
      source: `module-${i % 20}`,
      correlationId: `ERR_${i}`,
    })
  );

  return {
    _schemaVersion: 0,
    windowState: { width: 1200, height: 800, isMaximized: false },
    terminalConfig: {
      scrollbackLines: 2500,
      performanceMode: false,
    },
    hibernation: { enabled: false, inactiveThresholdHours: 24 },
    idleTerminalNotify: { enabled: true, thresholdMinutes: 60 },
    idleTerminalDismissals: {},
    idleTerminalNotifiedAt: {},
    parkedRuns: {},
    snoozedRuns: {},
    idleBackgroundAutoClose: { enabled: false, thresholdMinutes: 15 },
    pluginBackgroundUpdateCheck: { enabled: false, lastCheckedAt: null },
    appState: {
      activeWorktreeId: "wt-0",
      sidebarWidth: 350,
      focusMode: false,
      terminals,
      recipes,
      hasSeenWelcome: true,
      panelGridConfig: { strategy: "automatic" as const, value: 3 },
    },
    userConfig: {},
    worktreeConfig: {
      pathPattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
    },
    agentSettings: {
      agents,
    },
    notificationSettings: {
      enabled: true,
      completedEnabled: false,
      waitingEnabled: false,
      soundEnabled: true,
      soundFile: "ping.wav",
      waitingEscalationEnabled: true,
      waitingEscalationDelayMs: 180_000,
    },
    userAgentRegistry: {},
    agentUpdateSettings: {
      autoCheck: true,
      checkFrequencyHours: 24,
      lastAutoCheck: null,
    },
    keybindingOverrides: { overrides: {} },
    projectEnv: {},
    globalEnvironmentVariables,
    appAgentConfig: {} as StoreSchema["appAgentConfig"],
    windowStates: {},
    worktreeIssueMap,
    wslGitByWorktree: {},
    rosettaWarningDismissed: false,
    appTheme: { colorSchemeId: "daintree" },
    privacy: {
      telemetryLevel: "off",
      hasSeenPrompt: false,
      logRetentionDays: 30,
    },
    agentSessionHistory: { retentionDays: 30 },
    voiceInput: {
      enabled: true,
      openaiApiKey: "",
      deepgramApiKey: "",
      language: "en",
      customDictionary: [],
      transcriptionProvider: "deepgram",
      transcriptionModel: "nova-3",
      correctionEnabled: false,
      correctionModel: "gpt-5-nano",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: false,
      deviceId: "",
      organizationId: "",
      projectId: "",
      recordingMode: "push-to-talk",
      suggestedDictionary: [],
      learnFromCorrections: false,
    },
    mcpServer: {
      enabled: false,
      port: 45454,
      apiKey: "",
      auditEnabled: false,
      auditMaxRecords: 500,
      abusePolicyEnabled: false,
      abusePolicyMaxDenials: 5,
      abusePolicyWindowMs: 60_000,
    },
    helpAssistant: {
      docSearch: true,
      daintreeControl: false,
      tier: "workbench",
      bypassPermissions: false,
      auditRetention: 30,
    },
    pendingErrors,
    errorFingerprints: {},
    gpu: { hardwareAccelerationDisabled: false },
    crashRecovery: { autoRestoreOnCrash: false },
    onboarding: {
      schemaVersion: 0,
      completed: true,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      seenAgentIds: [],
      availabilityFirstSeen: {},
      welcomeCardDismissed: false,
      setupBannerDismissed: false,
      checklist: {
        dismissed: false,
        celebrationShown: false,
        items: {
          openedProject: true,
          launchedAgent: false,
          createdWorktree: false,
          ranSecondParallelAgent: false,
        },
      },
    },
    orchestrationMilestones: {},
    shortcutHintCounts: {},
    updateChannel: "stable",
    logLevelOverrides: {},
    plugins: { disabled: [], auditEnabled: true, auditMaxRecords: 500, installed: {} },
    forgeAudit: { auditEnabled: true, auditMaxRecords: 500 },
    runHistory: {},
    pluginMcpAudit: { auditEnabled: true, auditMaxRecords: 500 },
    pluginMcpConsent: {},
    pluginMcpConfig: { maxToolsPerSession: 64 },
    pluginCapabilityConsent: {},
  };
}

/**
 * Returns the serialized byte size of the heavy fixture.
 * Used as a sanity check — if the fixture shrinks below this threshold,
 * it likely no longer exercises the O(N) migration paths.
 */
export function getHeavyFixtureMinBytes(): number {
  return 1_000_000;
}
