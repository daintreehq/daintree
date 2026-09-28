// Imported FIRST by buttonStatesPreview.tsx, so the Trusted Types policies, the
// bridge shim and the frozen clock are all in place before any module that
// reaches for them at evaluation time. ES module imports are hoisted but
// evaluated in source order.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { PrerequisiteSpec } from "@shared/types";

/**
 * Wall clock pinned so relative times ("3m ago", "Last used 2h ago") are the same
 * in every capture — a before/after pair must differ in the design, not the clock.
 */
export const FROZEN_NOW = 1_764_000_000_000;
Date.now = () => FROZEN_NOW;

/**
 * The one switch a busy capture flips. Every shimmed write below answers
 * normally until the spec sets `window.__buttonStatesHold = true`; after that it
 * returns a promise that never settles, so the control that started it stays in
 * its in-flight state for as long as the page is open. Reads that seed the
 * surface on mount are never held, so the rest state is always reached first.
 */
declare global {
  interface Window {
    __buttonStatesHold?: boolean;
  }
}

export function held<T>(value: T): Promise<T> {
  if (window.__buttonStatesHold) return new Promise<T>(() => undefined);
  return Promise.resolve(value);
}

const isHarness = !Reflect.get(window, "electron");

/** Unlisted names on a namespace fall back to an inert async no-op. */
const withFallback = <T extends object>(target: T) =>
  new Proxy(target, {
    get: (t, key) => Reflect.get(t, key) ?? (() => Promise.resolve(undefined)),
  });

const HEALTH_SPECS: PrerequisiteSpec[] = [
  {
    tool: "git",
    label: "Git",
    versionArgs: ["--version"],
    severity: "fatal",
    minVersion: "2.30.0",
    installUrl: "https://git-scm.com/downloads",
  },
  {
    tool: "node",
    label: "Node.js",
    versionArgs: ["--version"],
    severity: "warn",
    minVersion: "18.0.0",
    installUrl: "https://nodejs.org",
  },
  {
    tool: "gh",
    label: "GitHub CLI",
    versionArgs: ["--version"],
    severity: "silent",
    installUrl: "https://cli.github.com",
  },
];

/**
 * What the CLI availability probe answers. A fixture that stages agents sets it in
 * its seed; the setup wizard polls it, so an inert `undefined` would crash it.
 */
let cliAvailability: Record<string, string> = {};
export function setPreviewCliAvailability(next: Record<string, string>): void {
  cliAvailability = next;
}

const params = new URLSearchParams(window.location.search);
/** `?git=missing` makes the setup requirement check fail on its one fatal tool. */
const gitMissing = params.get("git") === "missing";

const noUnsubscribe = () => () => undefined;

installPreviewShims({
  system: withFallback({
    healthCheck: () =>
      held({
        prerequisites: [
          { tool: "git", available: true, version: "2.47.1" },
          { tool: "node", available: true, version: "22.23.2" },
          { tool: "npm", available: true, version: "10.9.2" },
          { tool: "gh", available: false, version: null },
        ],
      }),
    startRendererCpuProfile: () =>
      Promise.resolve({ status: "started", expiresAt: FROZEN_NOW + 15_000 }),
    stopRendererCpuProfile: () => held({ status: "saved" }),
    openInEditor: () => held(undefined),
    getHealthCheckSpecs: () => Promise.resolve(HEALTH_SPECS),
    checkTool: (spec: PrerequisiteSpec) => {
      const missing = gitMissing && spec.tool === "git";
      return held({
        tool: spec.tool,
        label: spec.label,
        available: !missing,
        version: missing ? null : spec.tool === "git" ? "2.47.1" : "22.23.2",
        severity: spec.severity,
        meetsMinVersion: !missing,
        minVersion: spec.minVersion,
        installUrl: spec.installUrl,
        installBlocks: spec.installBlocks,
      });
    },
    getCliAvailability: () => Promise.resolve(cliAvailability),
    refreshCliAvailability: () => held(cliAvailability),
    getAgentCliDetails: () => Promise.resolve({}),
    installAgent: () => held({ success: true }),
    openExternal: () => Promise.resolve(undefined),
  }),
  // The wizard's Continue pins the chosen agents and adopts whatever main echoes
  // back; an inert `undefined` there would stop it on the first step.
  agentSettings: withFallback({
    get: () => Promise.resolve({ agents: {} }),
    set: (agentId: string, updates: Record<string, unknown>) =>
      Promise.resolve({ agents: { [agentId]: updates } }),
  }),
  logs: withFallback({
    getLevelOverrides: () => Promise.resolve({}),
  }),
  gpu: withFallback({
    getStatus: () =>
      Promise.resolve({ hardwareAccelerationDisabled: false, angleFallbackActive: false }),
  }),
  editor: withFallback({
    getConfig: () =>
      Promise.resolve({
        preferredEditor: { id: "vscode" },
        discoveredEditors: [
          { id: "vscode", name: "Visual Studio Code", available: true },
          { id: "cursor", name: "Cursor", available: true },
          { id: "zed", name: "Zed", available: false },
        ],
      }),
    discover: () => Promise.resolve([]),
    setConfig: () => held(undefined),
  }),
  globalEnv: withFallback({
    get: () =>
      Promise.resolve({
        PATH_EXTRA: "/opt/homebrew/bin",
        NODE_OPTIONS: "--max-old-space-size=8192",
      }),
    set: () => held(undefined),
  }),
  project: withFallback({
    getSettings: () => Promise.resolve({ runCommands: [] }),
    saveSettings: () => held(undefined),
    getAll: () => Promise.resolve([]),
    onSwitch: noUnsubscribe,
  }),
  privacy: withFallback({
    getSettings: () =>
      Promise.resolve({
        telemetryLevel: "errors",
        logRetentionDays: 30,
        dataFolderPath: "/Users/greg/Library/Application Support/Daintree",
      }),
    clearCache: () => held({ failed: 0 }),
  }),
  agentSessionHistory: withFallback({
    getRetentionDays: () => Promise.resolve(30),
    list: () => Promise.resolve([]),
  }),
  mcpServer: withFallback({
    getStatus: () =>
      Promise.resolve({
        enabled: true,
        port: 45454,
        configuredPort: 45454,
        apiKey: "dt_preview_key",
      }),
    getRuntimeState: () =>
      Promise.resolve({ enabled: true, state: "ready", port: 45454, lastError: null }),
    onRuntimeStateChanged: noUnsubscribe,
    getAuditConfig: () => Promise.resolve({ enabled: true, maxRecords: 500 }),
    getLogRecords: () => Promise.resolve([]),
    getTurnOutcomeRecords: () => Promise.resolve([]),
    getAuditStats: () => Promise.resolve(null),
    listActiveBearers: () =>
      Promise.resolve([
        {
          tokenHash: "hash-claude",
          token4LastChars: "9f2c",
          userAgent: "claude-code/2.1.4",
          lastActiveAt: FROZEN_NOW - 120_000,
          requestsSinceLaunch: 42,
        },
        {
          tokenHash: "hash-cursor",
          token4LastChars: "71ab",
          userAgent: "Cursor/1.6.2",
          lastActiveAt: FROZEN_NOW - 900_000,
          requestsSinceLaunch: 1,
        },
      ]),
    listHelpSessionBearers: () => Promise.resolve([]),
    listActiveClients: () => Promise.resolve([]),
    disconnectBearer: () => held(undefined),
  }),
  helpAssistant: withFallback({
    getSettings: () => Promise.resolve({ daintreeControl: false }),
  }),
  git: withFallback({
    listCommits: () => Promise.resolve({ items: [], hasMore: false, total: 0 }),
    scanConflictMarkers: (_cwd: string, paths: string[]) =>
      paths.length === 1
        ? held(paths.map((path) => ({ path, hunkCount: 2, firstMarkerLine: 12 })))
        : Promise.resolve(
            paths.map((path, i) => ({ path, hunkCount: i + 1, firstMarkerLine: 12 }))
          ),
  }),
  onboarding: withFallback({
    get: () =>
      Promise.resolve({
        seenAgentIds: [],
        availabilityFirstSeen: {},
        welcomeCardDismissed: true,
        setupBannerDismissed: true,
      }),
  }),
});

// A harness page must never inherit persisted state from the last page the
// browser context loaded — several stores persist to localStorage.
if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
