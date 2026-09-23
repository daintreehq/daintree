import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from "@shared/types/agentSettings";
import type { CliAvailability, OnboardingState, PrerequisiteSpec } from "@shared/types";
import type { ChecklistItemId, ChecklistState } from "@shared/types/ipc/maps";

/**
 * Bridge answers for the first-run journey harness.
 *
 * Imported FIRST by `preview.tsx`, so `window.electron` exists before any store
 * module evaluates. The onboarding record is mutable and lives here, not in the
 * page: the welcome banner, the wizard's completion and the checklist all write
 * through the real IPC calls, so a spec that clicks "Not now" or finishes the
 * wizard sees the app's own gating decide what comes next.
 *
 * Query parameters (all optional):
 *   ?onboarding=fresh|skipped|complete   the persisted onboarding record
 *   ?checklist=none|opened|launched|dismissed   checklist items already done
 *   ?welcomeCard=pending|dismissed
 *   ?agents=none|ready|pinned   none installed; Claude + Codex ready; ready and pinned
 *   ?git=ok|missing             whether the fatal Git prerequisite passes
 */

const params = new URLSearchParams(window.location.search);
const onboardingMode = params.get("onboarding") ?? "fresh";
const checklistMode = params.get("checklist") ?? "none";
const agentsMode = params.get("agents") ?? "ready";
const gitMode = params.get("git") ?? "ok";

const READY_AGENTS = new Set(["claude", "codex"]);

export const previewAvailability: CliAvailability = Object.fromEntries(
  LAUNCHABLE_AGENT_IDS.map((id) => [
    id,
    agentsMode !== "none" && READY_AGENTS.has(id) ? "ready" : "missing",
  ])
) as CliAvailability;

function checklistItems(): ChecklistState["items"] {
  const opened = checklistMode === "opened" || checklistMode === "launched";
  return {
    openedProject: opened,
    launchedAgent: checklistMode === "launched",
    createdWorktree: false,
    ranSecondParallelAgent: false,
  };
}

const onboarding: OnboardingState = {
  schemaVersion: 2,
  completed: onboardingMode === "complete",
  currentStep: null,
  agentSetupIds: [],
  firstRunToastSeen: onboardingMode !== "fresh",
  newsletterPromptSeen: true,
  waitingNudgeSeen: true,
  // The "new agent" dot is discovery state for later launches; seen here so it
  // is not beside every name in every capture.
  seenAgentIds: LAUNCHABLE_AGENT_IDS.slice(),
  availabilityFirstSeen: {},
  welcomeCardDismissed: params.get("welcomeCard") === "dismissed",
  setupBannerDismissed: onboardingMode !== "fresh",
  checklist: {
    dismissed: checklistMode === "dismissed",
    celebrationShown: false,
    items: checklistItems(),
  },
};

const checklistListeners = new Set<(next: ChecklistState) => void>();
function pushChecklist(): void {
  const snapshot = structuredClone(onboarding.checklist);
  for (const listener of checklistListeners) listener(snapshot);
}

export const previewAgentSettings: AgentSettings = {
  ...DEFAULT_AGENT_SETTINGS,
  // Stamped as a real install stamps it. Unstamped settings read as a legacy
  // store, and the migration clears every pin the wizard writes.
  settingsVersion: 2,
  agents: Object.fromEntries(
    Object.entries(DEFAULT_AGENT_SETTINGS.agents).map(([id, entry]) => [
      id,
      { ...entry, pinned: agentsMode === "pinned" && READY_AGENTS.has(id) ? true : undefined },
    ])
  ),
};

const PREREQUISITES: PrerequisiteSpec[] = [
  {
    tool: "git",
    label: "Git",
    versionArgs: ["--version"],
    severity: "fatal",
    installUrl: "https://git-scm.com/downloads",
    installBlocks: {
      macos: [
        { label: "Homebrew", commands: ["brew install git"] },
        {
          label: "Xcode Command Line Tools",
          commands: ["xcode-select --install"],
          opensExternalInstaller: true,
          notes: ["Opens the macOS installer — finish it there, then re-check"],
        },
      ],
    },
  },
  {
    tool: "node",
    label: "Node.js",
    versionArgs: ["--version"],
    severity: "fatal",
    minVersion: "18.0.0",
    installUrl: "https://nodejs.org",
  },
  { tool: "npm", label: "npm", versionArgs: ["--version"], severity: "warn" },
  { tool: "gh", label: "GitHub CLI", versionArgs: ["--version"], severity: "warn" },
];

const VERSIONS: Record<string, string> = {
  git: "2.47.1",
  node: "22.23.2",
  npm: "10.9.2",
  gh: "2.63.0",
};

/** Resolves on a later tick, as a real IPC round trip does. */
function later<T>(value: T, ms = 30): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function inertMethod(): unknown {
  const settled = Promise.resolve(undefined);
  return Object.assign(() => undefined, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

function withInertFallback<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (obj, key) => (key in obj ? Reflect.get(obj, key) : inertMethod),
  });
}

const isHarness = !Reflect.get(window, "electron");

installPreviewShims({
  onboarding: withInertFallback({
    get: async () => structuredClone(onboarding),
    getChecklist: async () => structuredClone(onboarding.checklist),
    complete: async () => {
      onboarding.completed = true;
    },
    setStep: async () => undefined,
    dismissSetupBanner: async () => {
      onboarding.setupBannerDismissed = true;
      return structuredClone(onboarding);
    },
    dismissWelcomeCard: async () => {
      onboarding.welcomeCardDismissed = true;
      return structuredClone(onboarding);
    },
    dismissChecklist: async () => {
      onboarding.checklist.dismissed = true;
    },
    markChecklistItem: async (item: ChecklistItemId) => {
      if (onboarding.checklist.items[item]) return;
      onboarding.checklist.items[item] = true;
      pushChecklist();
    },
    markAgentsSeen: async () => structuredClone(onboarding),
    recordAgentFirstSeen: async () => structuredClone(onboarding),
    onChecklistPush: (callback: (next: ChecklistState) => void) => {
      checklistListeners.add(callback);
      return () => checklistListeners.delete(callback);
    },
  }),
  system: withInertFallback({
    getCliAvailability: () => later({ ...previewAvailability }),
    refreshCliAvailability: () => later({ ...previewAvailability }),
    getAgentCliDetails: async () => ({}),
    getHealthCheckSpecs: () => later(PREREQUISITES),
    checkTool: (spec: PrerequisiteSpec) => {
      const missing = gitMode === "missing" && spec.tool === "git";
      return later({
        tool: spec.tool,
        label: spec.label,
        available: !missing,
        unavailableReason: missing ? "not-found" : undefined,
        version: missing ? null : (VERSIONS[spec.tool] ?? "1.0.0"),
        severity: spec.severity,
        meetsMinVersion: !missing,
        minVersion: spec.minVersion,
        installUrl: spec.installUrl,
        installBlocks: spec.installBlocks,
      });
    },
    getHomeDir: async () => "/Users/you",
    onAgentInstallProgress: () => () => undefined,
    // Held open: the install step is captured mid-flight, never finished.
    installAgent: () => new Promise(() => undefined),
  }),
  agentSettings: withInertFallback({
    get: async () => structuredClone(previewAgentSettings),
    set: async (id: string, patch: Record<string, unknown>) => {
      previewAgentSettings.agents[id] = { ...previewAgentSettings.agents[id], ...patch };
      return structuredClone(previewAgentSettings);
    },
    setGlobal: async () => structuredClone(previewAgentSettings),
  }),
});

// A harness page must never inherit persisted state: the CLI-availability cache
// and several preference stores persist to localStorage, and one scenario's
// agents would otherwise ride into the next page of the same browser context.
if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
