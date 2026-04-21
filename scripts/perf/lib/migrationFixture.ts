import type { StoreSchema } from "../../../electron/store";

/**
 * Generates a heavy StoreSchema fixture at schema version 0 so that
 * MigrationRunner will apply all 16 migrations (v2–v17). The fixture
 * exercises the O(N) paths in migrations 002 (terminals), 003 (recipes),
 * 012 (agents), and 013 (agents).
 */
export function createHeavyMigrationFixture(): StoreSchema {
  const terminalCount = 10_000;
  const recipeCount = 500;
  const agentCount = 200;
  const worktreeCount = 100;
  const pendingErrorCount = 100;
  const envVarCount = 100;

  const terminals: StoreSchema["appState"]["terminals"] = Array.from(
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

  const worktreeIssueMap: Record<string, { issueNumber: number; url: string }> = {};
  for (let i = 0; i < worktreeCount; i++) {
    worktreeIssueMap[`wt-${i}`] = {
      issueNumber: 1000 + i,
      url: `https://github.com/org/repo/issues/${1000 + i}`,
    };
  }

  const globalEnvironmentVariables: Record<string, string> = {};
  for (let i = 0; i < envVarCount; i++) {
    globalEnvironmentVariables[`PERF_VAR_${i}`] = `value-${i}`;
  }

  const pendingErrors: StoreSchema["pendingErrors"] = Array.from(
    { length: pendingErrorCount },
    (_, i) => ({
      message: `Error ${i}: something went wrong in module-${i % 20}`,
      stack: `at module${i % 20} (line ${i}): error in perf fixture`,
      timestamp: Date.now() - i * 60000,
      severity: i % 5 === 0 ? ("fatal" as const) : ("error" as const),
      source: `module-${i % 20}`,
      code: `ERR_${i}`,
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
    } as StoreSchema["agentSettings"],
    notificationSettings: {
      enabled: true,
      completedEnabled: false,
      waitingEnabled: false,
      soundEnabled: true,
      soundFile: "ping.wav",
      waitingEscalationEnabled: true,
      waitingEscalationDelayMs: 180_000,
    } as StoreSchema["notificationSettings"],
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
    worktreeIssueMap: worktreeIssueMap as StoreSchema["worktreeIssueMap"],
    appTheme: { colorSchemeId: "daintree" },
    privacy: {
      telemetryLevel: "off",
      hasSeenPrompt: false,
      logRetentionDays: 30,
    },
    voiceInput: {
      enabled: true,
      apiKey: "",
      language: "en",
      customDictionary: [],
      transcriptionModel: "nova-3",
      correctionEnabled: false,
      correctionModel: "gpt-5-nano",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
    },
    mcpServer: { enabled: false, port: 45454, apiKey: "" },
    pendingErrors,
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
      welcomeCardDismissed: false,
      setupBannerDismissed: false,
    } as StoreSchema["onboarding"],
    activationFunnel: {},
    orchestrationMilestones: {},
    shortcutHintCounts: {},
    updateChannel: "stable",
    logLevelOverrides: {},
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
