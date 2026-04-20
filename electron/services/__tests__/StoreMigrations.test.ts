import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The migrations barrel transitively imports modules that touch `electron.app`
// at module load (ProjectStore in migration003). Mock it before the barrel
// import so the drift-guard test can read the full migrations list.
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
    on: vi.fn(),
    getName: vi.fn(() => "daintree-test"),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
}));

// Mock ProjectStore for migration 003. Must be hoisted before barrel import.
const { mockProjectStore } = vi.hoisted(() => ({
  mockProjectStore: {
    getCurrentProjectId: vi.fn<() => string | null>(() => null),
    getProjectById: vi.fn<() => Record<string, unknown> | null>(() => null),
    getRecipes: vi.fn<() => Promise<unknown[]>>(async () => []),
    saveRecipes: vi.fn<() => Promise<void>>(async () => {}),
  },
}));
vi.mock("../ProjectStore.js", () => ({
  projectStore: mockProjectStore,
}));

import type { Migration } from "../StoreMigrations.js";
import { LATEST_SCHEMA_VERSION, MigrationRunner } from "../StoreMigrations.js";
import { migrations } from "../migrations/index.js";
import { migration004 } from "../migrations/004-upgrade-correction-model.js";
import { migration006 } from "../migrations/006-rename-theme-canopy-to-daintree.js";
import { migration007 } from "../migrations/007-reduce-default-terminal-scrollback.js";
import { migration008 } from "../migrations/008-split-notification-sounds.js";
import { migration011 } from "../migrations/011-minimal-soundscape-defaults.js";
import { migration019 } from "../migrations/019-remove-fleet-deck-open.js";

type MockStoreData = Record<string, unknown>;

type MockStore = {
  path: string;
  data: MockStoreData;
  get: (key: string, defaultValue?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
};

function createMockStore(storePath: string, initialData: MockStoreData = {}): MockStore {
  const data: MockStoreData = { ...initialData };
  return {
    path: storePath,
    data,
    get: (key, defaultValue) => (key in data ? data[key] : defaultValue),
    set: (key, value) => {
      if (value === undefined) {
        throw new Error(
          `electron-store v11 does not allow store.set("${key}", undefined) — use delete() instead`
        );
      }
      data[key] = value;
    },
    delete: (key) => {
      delete data[key];
    },
  };
}

describe("MigrationRunner", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-02-10T10:00:00.000Z"));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-migrations-"));
    storePath = path.join(tempDir, "config.json");
    fs.writeFileSync(storePath, JSON.stringify({ ok: true }), "utf8");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns valid current schema version", () => {
    const store = createMockStore(storePath, { _schemaVersion: 3 });
    const runner = new MigrationRunner(store as never);

    expect(runner.getCurrentVersion()).toBe(3);
  });

  it("resets invalid schema version values to zero", () => {
    const store = createMockStore(storePath, { _schemaVersion: "3" });
    const runner = new MigrationRunner(store as never);

    expect(runner.getCurrentVersion()).toBe(0);
    expect(store.data._schemaVersion).toBe(0);
  });

  it("runs only pending migrations in ascending version order", async () => {
    const applied: number[] = [];
    const store = createMockStore(storePath, { _schemaVersion: 1 });
    const runner = new MigrationRunner(store as never);

    const migrations: Migration[] = [
      {
        version: 3,
        description: "third",
        up: async () => {
          applied.push(3);
        },
      },
      {
        version: 2,
        description: "second",
        up: () => {
          applied.push(2);
        },
      },
      {
        version: 1,
        description: "first",
        up: () => {
          applied.push(1);
        },
      },
    ];

    await runner.runMigrations(migrations);

    expect(applied).toEqual([2, 3]);
    expect(store.data._schemaVersion).toBe(3);
  });

  it("throws when store schema version is newer than supported migrations", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 5 });
    const runner = new MigrationRunner(store as never);

    await expect(
      runner.runMigrations([
        {
          version: 2,
          description: "v2",
          up: () => {},
        },
      ])
    ).rejects.toThrow("Store schema version (5) is newer than application supports (2)");
  });

  it("wraps migration errors with version context", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 0 });
    const runner = new MigrationRunner(store as never);

    await expect(
      runner.runMigrations([
        {
          version: 1,
          description: "broken migration",
          up: () => {
            throw new Error("disk full");
          },
        },
      ])
    ).rejects.toThrow("Migration v1 failed: disk full");
  });

  it("creates a backup file before applying pending migrations", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 0 });
    const runner = new MigrationRunner(store as never);

    await runner.runMigrations([
      {
        version: 1,
        description: "noop",
        up: () => {},
      },
    ]);

    const files = fs.readdirSync(tempDir);
    const backupFiles = files.filter((file) => file.startsWith("config.json.backup-"));
    expect(backupFiles).toHaveLength(1);
  });

  describe("migration 004 — upgrade correction model", () => {
    it("upgrades gpt-5-nano to gpt-5-mini and preserves sibling fields", () => {
      const store = createMockStore(storePath, {
        voiceInput: { correctionModel: "gpt-5-nano", enabled: true, language: "en" },
      });
      migration004.up(store as never);
      const voiceInput = store.data.voiceInput as Record<string, unknown>;
      expect(voiceInput.correctionModel).toBe("gpt-5-mini");
      expect(voiceInput.enabled).toBe(true);
      expect(voiceInput.language).toBe("en");
    });

    it("upgrades missing correctionModel to gpt-5-mini", () => {
      const store = createMockStore(storePath, {
        voiceInput: { enabled: true },
      });
      migration004.up(store as never);
      const voiceInput = store.data.voiceInput as { correctionModel: string };
      expect(voiceInput.correctionModel).toBe("gpt-5-mini");
    });

    it("leaves gpt-5-mini unchanged", () => {
      const store = createMockStore(storePath, {
        voiceInput: { correctionModel: "gpt-5-mini", enabled: true },
      });
      migration004.up(store as never);
      const voiceInput = store.data.voiceInput as { correctionModel: string };
      expect(voiceInput.correctionModel).toBe("gpt-5-mini");
    });

    it("skips when no voiceInput settings exist", () => {
      const store = createMockStore(storePath, {});
      migration004.up(store as never);
      expect(store.data.voiceInput).toBeUndefined();
    });
  });

  describe("migration 006 — rename theme canopy to daintree", () => {
    it('renames colorSchemeId "canopy" to "daintree" and preserves sibling fields', () => {
      const store = createMockStore(storePath, {
        appTheme: { colorSchemeId: "canopy", colorVisionMode: "default", customSchemes: "[]" },
      });
      migration006.up(store as never);
      const appTheme = store.data.appTheme as Record<string, unknown>;
      expect(appTheme.colorSchemeId).toBe("daintree");
      expect(appTheme.colorVisionMode).toBe("default");
      expect(appTheme.customSchemes).toBe("[]");
    });

    it('renames colorSchemeId "canopy-slate" to "daintree"', () => {
      const store = createMockStore(storePath, {
        appTheme: { colorSchemeId: "canopy-slate" },
      });
      migration006.up(store as never);
      const appTheme = store.data.appTheme as Record<string, unknown>;
      expect(appTheme.colorSchemeId).toBe("daintree");
    });

    it('leaves "daintree" unchanged', () => {
      const store = createMockStore(storePath, {
        appTheme: { colorSchemeId: "daintree" },
      });
      migration006.up(store as never);
      const appTheme = store.data.appTheme as Record<string, unknown>;
      expect(appTheme.colorSchemeId).toBe("daintree");
    });

    it("skips when no appTheme settings exist", () => {
      const store = createMockStore(storePath, {});
      migration006.up(store as never);
      expect(store.data.appTheme).toBeUndefined();
    });
  });

  describe("migration 007 — reduce default terminal scrollback", () => {
    it("migrates scrollbackLines from 2500 to 1000 and preserves sibling fields", () => {
      const store = createMockStore(storePath, {
        terminalConfig: { scrollbackLines: 2500, performanceMode: false },
      });
      migration007.up(store as never);
      const config = store.data.terminalConfig as Record<string, unknown>;
      expect(config.scrollbackLines).toBe(1000);
      expect(config.performanceMode).toBe(false);
    });

    it("leaves scrollbackLines at 1000 unchanged (new install default)", () => {
      const store = createMockStore(storePath, {
        terminalConfig: { scrollbackLines: 1000 },
      });
      migration007.up(store as never);
      const config = store.data.terminalConfig as Record<string, unknown>;
      expect(config.scrollbackLines).toBe(1000);
    });

    it("leaves custom scrollbackLines unchanged", () => {
      const store = createMockStore(storePath, {
        terminalConfig: { scrollbackLines: 5000 },
      });
      migration007.up(store as never);
      const config = store.data.terminalConfig as Record<string, unknown>;
      expect(config.scrollbackLines).toBe(5000);
    });

    it("skips when no terminalConfig exists", () => {
      const store = createMockStore(storePath, {});
      migration007.up(store as never);
      expect(store.data.terminalConfig).toBeUndefined();
    });
  });

  describe("migration 008 — split notification sounds", () => {
    it("migrates soundFile to completedSoundFile and adds semantic defaults", () => {
      const store = createMockStore(storePath, {
        notificationSettings: {
          enabled: true,
          completedEnabled: false,
          waitingEnabled: false,
          soundEnabled: true,
          soundFile: "ping.wav",
          waitingEscalationEnabled: true,
          waitingEscalationDelayMs: 180_000,
        },
      });
      migration008.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.completedSoundFile).toBe("ping.wav");
      expect(settings.waitingSoundFile).toBe("waiting.wav");
      expect(settings.escalationSoundFile).toBe("ping.wav");
      expect(settings.soundFile).toBeUndefined();
      expect(settings.soundEnabled).toBe(true);
    });

    it("defaults to chime.wav when soundFile is missing", () => {
      const store = createMockStore(storePath, {
        notificationSettings: { enabled: true },
      });
      migration008.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.completedSoundFile).toBe("chime.wav");
      expect(settings.waitingSoundFile).toBe("waiting.wav");
      expect(settings.escalationSoundFile).toBe("ping.wav");
    });

    it("skips when no notificationSettings exist", () => {
      const store = createMockStore(storePath, {});
      migration008.up(store as never);
      expect(store.data.notificationSettings).toBeUndefined();
    });
  });

  describe("migration 011 — minimal soundscape defaults", () => {
    it("resets all three old-default fields and preserves sibling fields", () => {
      const store = createMockStore(storePath, {
        notificationSettings: {
          enabled: true,
          completedEnabled: false,
          waitingEnabled: false,
          soundEnabled: true,
          completedSoundFile: "complete.wav",
          waitingSoundFile: "waiting.wav",
          escalationSoundFile: "ping.wav",
          waitingEscalationEnabled: true,
          waitingEscalationDelayMs: 180_000,
          workingPulseEnabled: false,
          workingPulseSoundFile: "pulse.wav",
          uiFeedbackSoundEnabled: true,
        },
      });
      migration011.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.waitingEnabled).toBe(true);
      expect(settings.waitingEscalationEnabled).toBe(false);
      expect(settings.uiFeedbackSoundEnabled).toBe(false);
      expect(settings.enabled).toBe(true);
      expect(settings.soundEnabled).toBe(true);
      expect(settings.completedEnabled).toBe(false);
      expect(settings.completedSoundFile).toBe("complete.wav");
    });

    it("preserves custom waitingEnabled (already true)", () => {
      const store = createMockStore(storePath, {
        notificationSettings: {
          waitingEnabled: true,
          waitingEscalationEnabled: true,
          uiFeedbackSoundEnabled: true,
        },
      });
      migration011.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.waitingEnabled).toBe(true);
      expect(settings.waitingEscalationEnabled).toBe(false);
      expect(settings.uiFeedbackSoundEnabled).toBe(false);
    });

    it("preserves custom waitingEscalationEnabled (already false)", () => {
      const store = createMockStore(storePath, {
        notificationSettings: {
          waitingEnabled: false,
          waitingEscalationEnabled: false,
          uiFeedbackSoundEnabled: true,
        },
      });
      migration011.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.waitingEnabled).toBe(true);
      expect(settings.waitingEscalationEnabled).toBe(false);
      expect(settings.uiFeedbackSoundEnabled).toBe(false);
    });

    it("preserves custom uiFeedbackSoundEnabled (already false)", () => {
      const store = createMockStore(storePath, {
        notificationSettings: {
          waitingEnabled: false,
          waitingEscalationEnabled: true,
          uiFeedbackSoundEnabled: false,
        },
      });
      migration011.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.waitingEnabled).toBe(true);
      expect(settings.waitingEscalationEnabled).toBe(false);
      expect(settings.uiFeedbackSoundEnabled).toBe(false);
    });

    it("skips when no notificationSettings exist", () => {
      const store = createMockStore(storePath, {});
      migration011.up(store as never);
      expect(store.data.notificationSettings).toBeUndefined();
    });

    it("is idempotent — second call is a no-op", () => {
      const store = createMockStore(storePath, {
        notificationSettings: {
          waitingEnabled: false,
          waitingEscalationEnabled: true,
          uiFeedbackSoundEnabled: true,
          soundEnabled: true,
        },
      });
      migration011.up(store as never);
      const after1 = { ...(store.data.notificationSettings as Record<string, unknown>) };
      migration011.up(store as never);
      const after2 = store.data.notificationSettings as Record<string, unknown>;
      expect(after2).toEqual(after1);
    });
  });

  describe("migration 019 — remove orphaned fleet deck keys", () => {
    it("deletes fleetDeckOpen/fleetDeckAlwaysPreview/fleetDeckQuorumThreshold and preserves siblings", () => {
      const store = createMockStore(storePath, {
        appState: {
          sidebarWidth: 350,
          fleetDeckOpen: true,
          fleetDeckAlwaysPreview: true,
          fleetDeckQuorumThreshold: 8,
          fleetScopeMode: "scoped",
        },
      });
      migration019.up(store as never);
      const after = store.data.appState as Record<string, unknown>;
      expect("fleetDeckOpen" in after).toBe(false);
      expect("fleetDeckAlwaysPreview" in after).toBe(false);
      expect("fleetDeckQuorumThreshold" in after).toBe(false);
      expect(after.sidebarWidth).toBe(350);
      expect(after.fleetScopeMode).toBe("scoped");
    });

    it("is a no-op when appState has no fleet deck keys", () => {
      const store = createMockStore(storePath, {
        appState: { sidebarWidth: 400, fleetScopeMode: "scoped" },
      });
      migration019.up(store as never);
      expect(store.data.appState).toEqual({ sidebarWidth: 400, fleetScopeMode: "scoped" });
    });

    it("skips when no appState exists", () => {
      const store = createMockStore(storePath, {});
      migration019.up(store as never);
      expect(store.data.appState).toBeUndefined();
    });

    it("runs end-to-end through MigrationRunner on a v18 store", async () => {
      const store = createMockStore(storePath, {
        _schemaVersion: 18,
        appState: {
          sidebarWidth: 350,
          fleetDeckOpen: true,
          fleetDeckAlwaysPreview: false,
          fleetDeckQuorumThreshold: 4,
        },
      });
      const runner = new MigrationRunner(store as never);
      await runner.runMigrations([migration019]);
      const after = store.data.appState as Record<string, unknown>;
      expect(store.data._schemaVersion).toBe(19);
      expect("fleetDeckOpen" in after).toBe(false);
      expect("fleetDeckAlwaysPreview" in after).toBe(false);
      expect("fleetDeckQuorumThreshold" in after).toBe(false);
      expect(after.sidebarWidth).toBe(350);
    });
  });

  it("LATEST_SCHEMA_VERSION matches the highest version in the migrations barrel", () => {
    const highest = Math.max(...migrations.map((m) => m.version));
    expect(LATEST_SCHEMA_VERSION).toBe(highest);
  });

  it("does nothing when there are no pending migrations", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 2 });
    const runner = new MigrationRunner(store as never);
    const migration = vi.fn();

    await runner.runMigrations([
      {
        version: 1,
        description: "old",
        up: migration,
      },
      {
        version: 2,
        description: "current",
        up: migration,
      },
    ]);

    expect(migration).not.toHaveBeenCalled();
    expect(store.data._schemaVersion).toBe(2);
  });

  describe("heavy fixture — full migration chain", () => {
    beforeEach(() => {
      mockProjectStore.getCurrentProjectId.mockReturnValue("perf-project-0");
      mockProjectStore.getProjectById.mockReturnValue({
        id: "perf-project-0",
        name: "Perf Project",
        path: "/tmp/perf",
      });
      mockProjectStore.getRecipes.mockResolvedValue([]);
      mockProjectStore.saveRecipes.mockResolvedValue(undefined);
    });

    afterEach(() => {
      mockProjectStore.getCurrentProjectId.mockReset();
      mockProjectStore.getProjectById.mockReset();
      mockProjectStore.getRecipes.mockReset();
      mockProjectStore.saveRecipes.mockReset();
    });

    it("applies all migrations to a heavy v0 fixture within budget", async () => {
      const terminalCount = 10_000;
      const recipeCount = 500;
      const agentCount = 200;

      const terminals = Array.from({ length: terminalCount }, (_, i) => ({
        id: `term-${i}`,
        title: `Terminal ${i}`,
        cwd: `/repo/wt-${i % 100}`,
        worktreeId: `wt-${i % 100}`,
      }));

      const recipes = Array.from({ length: recipeCount }, (_, i) => ({
        id: `recipe-${i}`,
        name: `Recipe ${i}`,
        worktreeId: i % 2 === 0 ? `wt-${i % 100}` : undefined,
        terminals: Array.from({ length: 3 }, (_, j) => ({
          type: "terminal" as const,
          title: `Tab ${j}`,
          command: `echo ${i}-${j}`,
        })),
        createdAt: Date.now() - i * 1000,
        showInEmptyState: i < 10,
        lastUsedAt: i % 5 === 0 ? Date.now() - i * 5000 : undefined,
      }));

      const agents: Record<string, Record<string, unknown>> = {};
      for (let i = 0; i < agentCount; i++) {
        if (i % 2 === 0) {
          agents[`agent-${i}`] = { selected: i % 3 !== 0, enabled: true, customFlag: `v-${i}` };
        } else {
          agents[`agent-${i}`] = { pinned: true };
        }
      }

      const fixture = {
        _schemaVersion: 0,
        windowState: { width: 1200, height: 800, isMaximized: false },
        terminalConfig: { scrollbackLines: 2500, performanceMode: false },
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
          panelGridConfig: { strategy: "automatic", value: 3 },
          fleetDeckOpen: false,
        },
        userConfig: {},
        worktreeConfig: { pathPattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}" },
        agentSettings: { agents },
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
        agentUpdateSettings: { autoCheck: true, checkFrequencyHours: 24, lastAutoCheck: null },
        keybindingOverrides: { overrides: {} },
        projectEnv: {},
        globalEnvironmentVariables: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`PERF_VAR_${i}`, `value-${i}`])
        ),
        appAgentConfig: {},
        windowStates: {},
        worktreeIssueMap: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [
            `wt-${i}`,
            { issueNumber: 1000 + i, url: `https://github.com/org/repo/issues/${1000 + i}` },
          ])
        ),
        appTheme: { colorSchemeId: "canopy" },
        privacy: { telemetryLevel: "off", hasSeenPrompt: false, logRetentionDays: 30 },
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
        pendingErrors: [],
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
          migratedFromLocalStorage: false,
        },
        activationFunnel: {},
        orchestrationMilestones: {},
        shortcutHintCounts: {},
        updateChannel: "stable",
        logLevelOverrides: {},
      };

      const store = createMockStore(storePath, fixture);
      const runner = new MigrationRunner(store as never);

      const start = performance.now();
      await runner.runMigrations(migrations);
      const elapsedMs = performance.now() - start;

      // Verify migrations actually ran
      expect(store.data._schemaVersion).toBe(LATEST_SCHEMA_VERSION);

      // Migration 002: terminals should have location field
      const migratedTerminals = (store.data.appState as Record<string, unknown>).terminals as Array<
        Record<string, unknown>
      >;
      expect(migratedTerminals[0]?.location).toBe("grid");
      expect(migratedTerminals).toHaveLength(terminalCount);

      // Migration 003: recipes should be cleared
      expect((store.data.appState as Record<string, unknown>).recipes).toEqual([]);
      expect(mockProjectStore.saveRecipes).toHaveBeenCalled();

      // Migration 006: canopy → daintree
      expect((store.data.appTheme as Record<string, unknown>).colorSchemeId).toBe("daintree");

      // Migration 007: scrollback reduced
      expect((store.data.terminalConfig as Record<string, unknown>).scrollbackLines).toBe(1000);

      // Migration 008: soundFile split
      const notif = store.data.notificationSettings as Record<string, unknown>;
      expect(notif.completedSoundFile).toBe("ping.wav");
      expect(notif.waitingSoundFile).toBe("waiting.wav");
      expect(notif.soundFile).toBeUndefined();

      // Migration 012: agents should have pinned field, no selected/enabled
      const migratedAgents = (store.data.agentSettings as Record<string, unknown>).agents as Record<
        string,
        Record<string, unknown>
      >;
      for (const [, entry] of Object.entries(migratedAgents)) {
        expect(entry.selected).toBeUndefined();
        expect(entry.enabled).toBeUndefined();
        expect(typeof entry.pinned).toBe("boolean");
      }

      // Migration 019: orphaned fleet deck keys should be gone
      const migratedAppState = store.data.appState as Record<string, unknown>;
      expect("fleetDeckOpen" in migratedAppState).toBe(false);
      expect("fleetDeckAlwaysPreview" in migratedAppState).toBe(false);
      expect("fleetDeckQuorumThreshold" in migratedAppState).toBe(false);

      // Single-run sanity check; statistical p95 is measured by PERF-080
      // Use generous tolerance to avoid CI flake under load
      expect(elapsedMs).toBeLessThan(2000);
    });
  });
});
