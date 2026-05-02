import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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
import { app as electronApp } from "electron";

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
import {
  LATEST_SCHEMA_VERSION,
  MigrationRunner,
  StoreMigrationError,
  isStoreMigrationError,
} from "../StoreMigrations.js";
import { migrations } from "../migrations/index.js";
import { migration002 } from "../migrations/002-add-terminal-location.js";
import { migration003 } from "../migrations/003-migrate-recipes-to-project.js";
import { migration004 } from "../migrations/004-upgrade-correction-model.js";
import { migration005 } from "../migrations/005-add-getting-started-checklist.js";
import { migration007 } from "../migrations/007-reduce-default-terminal-scrollback.js";
import { migration008 } from "../migrations/008-split-notification-sounds.js";
import { migration010 } from "../migrations/010-add-working-pulse-setting.js";
import { migration011 } from "../migrations/011-minimal-soundscape-defaults.js";
import { migration018 } from "../migrations/018-archive-notes.js";
import { migration019 } from "../migrations/019-remove-fleet-deck-open.js";
import { migration021 } from "../migrations/021-drop-mcp-api-key.js";

type MockStoreData = Record<string, unknown>;

type MockStore = {
  path: string;
  data: MockStoreData;
  get: (key: string, defaultValue?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
  clear: () => void;
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
    clear: () => {
      for (const key of Object.keys(data)) {
        delete data[key];
      }
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

  it("skips migrations and preserves version when store schema is newer than supported", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 5 });
    const runner = new MigrationRunner(store as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const up = vi.fn();

    await expect(
      runner.runMigrations([
        {
          version: 2,
          description: "v2",
          up,
        },
      ])
    ).resolves.toBeUndefined();

    expect(up).not.toHaveBeenCalled();
    expect(store.data._schemaVersion).toBe(5);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Store schema v5 is ahead of this binary")
    );
    const files = fs.readdirSync(tempDir);
    expect(files.filter((f) => f.startsWith("config.json.backup-"))).toHaveLength(0);

    warnSpy.mockRestore();
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

  it("creates a version-tagged backup file before applying pending migrations", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 3 });
    const runner = new MigrationRunner(store as never);

    await runner.runMigrations([
      {
        version: 4,
        description: "noop",
        up: () => {},
      },
    ]);

    const files = fs.readdirSync(tempDir);
    const backupFiles = files.filter((file) => file.startsWith("config.json.backup-v3-"));
    expect(backupFiles).toHaveLength(1);
  });

  describe("auto-restore on migration failure", () => {
    it("atomically restores the pre-migration store file when a migration throws", async () => {
      const originalBytes = JSON.stringify({ _schemaVersion: 0, sentinel: "pre-migration" });
      fs.writeFileSync(storePath, originalBytes, "utf8");

      const store = createMockStore(storePath, { _schemaVersion: 0, sentinel: "pre-migration" });
      const runner = new MigrationRunner(store as never);

      await expect(
        runner.runMigrations([
          {
            version: 1,
            description: "broken",
            up: () => {
              throw new Error("disk full");
            },
          },
        ])
      ).rejects.toThrow("Migration v1 failed: disk full");

      expect(fs.readFileSync(storePath, "utf8")).toBe(originalBytes);
      const remainingBackups = fs
        .readdirSync(tempDir)
        .filter((f) => f.startsWith("config.json.backup-"));
      expect(remainingBackups).toHaveLength(0);
    });

    it("preserves the failed migration state at .failed-<ts> for diagnostics", async () => {
      const partialBytes = JSON.stringify({ _schemaVersion: 0, will: "be replaced" });
      fs.writeFileSync(storePath, partialBytes, "utf8");
      const store = createMockStore(storePath, { _schemaVersion: 0 });
      const runner = new MigrationRunner(store as never);

      await expect(
        runner.runMigrations([
          {
            version: 1,
            description: "broken",
            up: () => {
              throw new Error("kaboom");
            },
          },
        ])
      ).rejects.toThrow();

      const failedFile = fs.readdirSync(tempDir).find((f) => f.startsWith("config.json.failed-"));
      expect(failedFile).toBeDefined();
      expect(fs.readFileSync(path.join(tempDir, failedFile!), "utf8")).toBe(partialBytes);
    });

    it("throws StoreMigrationError carrying backupPath, failedStatePath, restored=true", async () => {
      fs.writeFileSync(storePath, JSON.stringify({ _schemaVersion: 0 }), "utf8");
      const store = createMockStore(storePath, { _schemaVersion: 0 });
      const runner = new MigrationRunner(store as never);

      let caught: unknown;
      try {
        await runner.runMigrations([
          {
            version: 1,
            description: "broken",
            up: () => {
              throw new Error("kaboom");
            },
          },
        ]);
      } catch (err) {
        caught = err;
      }

      expect(isStoreMigrationError(caught)).toBe(true);
      expect(caught).toBeInstanceOf(StoreMigrationError);
      const migrationError = caught as StoreMigrationError;
      expect(migrationError.backupPath).toMatch(/config\.json\.backup-/);
      expect(migrationError.failedStatePath).toMatch(/config\.json\.failed-/);
      expect(migrationError.restored).toBe(true);
      expect(migrationError.restoreError).toBeNull();
      expect(migrationError.cause).toBeInstanceOf(Error);
      expect((migrationError.cause as Error).message).toBe("kaboom");
    });

    it("surfaces a StoreMigrationError with restored=false when no backup was available", async () => {
      // Remove the on-disk store file so backupStore() returns null
      fs.rmSync(storePath, { force: true });
      const store = createMockStore(storePath, { _schemaVersion: 0 });
      const runner = new MigrationRunner(store as never);

      let caught: unknown;
      try {
        await runner.runMigrations([
          {
            version: 1,
            description: "broken",
            up: () => {
              throw new Error("kaboom");
            },
          },
        ]);
      } catch (err) {
        caught = err;
      }

      expect(isStoreMigrationError(caught)).toBe(true);
      const migrationError = caught as StoreMigrationError;
      expect(migrationError.backupPath).toBeNull();
      expect(migrationError.restored).toBe(false);
      expect(migrationError.failedStatePath).toBeNull();
      expect(migrationError.message).toContain("no backup was available");
    });

    it("reports failedStatePath and restoreError when atomic restore (backup -> storePath) throws", async () => {
      fs.writeFileSync(storePath, JSON.stringify({ _schemaVersion: 0 }), "utf8");
      const store = createMockStore(storePath, { _schemaVersion: 0 });
      const runner = new MigrationRunner(store as never);

      // Allow the first rename (storePath -> failedPath) to succeed; fail the
      // second (backupPath -> storePath). Mirrors the partial-failure window
      // described in the #6038 review.
      const realRenameSync = fs.renameSync.bind(fs);
      let renameCalls = 0;
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(((
        src: fs.PathLike,
        dest: fs.PathLike
      ) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          realRenameSync(src, dest);
          return;
        }
        throw new Error("EROFS: read-only filesystem");
      }) as typeof fs.renameSync);

      let caught: unknown;
      try {
        await runner.runMigrations([
          {
            version: 1,
            description: "broken",
            up: () => {
              throw new Error("kaboom");
            },
          },
        ]);
      } catch (err) {
        caught = err;
      } finally {
        renameSpy.mockRestore();
      }

      expect(isStoreMigrationError(caught)).toBe(true);
      const migrationError = caught as StoreMigrationError;
      expect(migrationError.restored).toBe(false);
      expect(migrationError.restoreError).toBeInstanceOf(Error);
      expect(migrationError.restoreError?.message).toContain("EROFS");
      // Critical: failedStatePath must be reported even when step 2 fails so
      // the user has a path to manual recovery.
      expect(migrationError.failedStatePath).toMatch(/config\.json\.failed-/);
      expect(migrationError.message).toContain("auto-restore failed");
    });

    it("triggers restore when post-migration sanity validation rejects state", async () => {
      const originalBytes = JSON.stringify({ _schemaVersion: 0, sentinel: true });
      fs.writeFileSync(storePath, originalBytes, "utf8");

      const store = createMockStore(storePath, { _schemaVersion: 0 });
      // Inject a corrupt _schemaVersion read AFTER set is called once, so the
      // post-migration sanity check sees a non-numeric value even though the
      // runner wrote a valid number. This proves the validation is wired in.
      let setSeen = false;
      const realGet = store.get;
      store.set = ((key: string, value: unknown) => {
        if (key === "_schemaVersion") setSeen = true;
        if (value === undefined) {
          throw new Error(`undefined not allowed for ${key}`);
        }
        store.data[key] = value;
      }) as MockStore["set"];
      store.get = ((key: string, defaultValue?: unknown) => {
        if (key === "_schemaVersion" && setSeen) {
          return "corrupted-string";
        }
        return realGet.call(store, key, defaultValue);
      }) as MockStore["get"];

      const validatingRunner = new MigrationRunner(store as never);
      await expect(
        validatingRunner.runMigrations([{ version: 1, description: "noop", up: () => {} }])
      ).rejects.toThrow(/Post-migration sanity check failed/);

      expect(fs.readFileSync(storePath, "utf8")).toBe(originalBytes);
    });
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

  describe("migration 021 — drop persistent MCP api key", () => {
    it("removes apiKey from mcpServer and preserves siblings", () => {
      const store = createMockStore(storePath, {
        mcpServer: {
          enabled: true,
          port: 45454,
          apiKey: "daintree_oldsecret",
          fullToolSurface: false,
          auditEnabled: true,
          auditMaxRecords: 500,
        },
      });
      migration021.up(store as never);
      const after = store.data.mcpServer as Record<string, unknown>;
      expect("apiKey" in after).toBe(false);
      expect(after.enabled).toBe(true);
      expect(after.port).toBe(45454);
      expect(after.fullToolSurface).toBe(false);
      expect(after.auditEnabled).toBe(true);
      expect(after.auditMaxRecords).toBe(500);
    });

    it("is a no-op when mcpServer has no apiKey", () => {
      const store = createMockStore(storePath, {
        mcpServer: { enabled: false, port: 45454 },
      });
      migration021.up(store as never);
      expect(store.data.mcpServer).toEqual({ enabled: false, port: 45454 });
    });

    it("skips when mcpServer is missing entirely", () => {
      const store = createMockStore(storePath, {});
      migration021.up(store as never);
      expect(store.data.mcpServer).toBeUndefined();
    });

    it("runs end-to-end through MigrationRunner on a v20 store", async () => {
      const store = createMockStore(storePath, {
        _schemaVersion: 20,
        mcpServer: {
          enabled: true,
          port: 45454,
          apiKey: "daintree_legacy",
          fullToolSurface: false,
          auditEnabled: true,
          auditMaxRecords: 500,
        },
      });
      const runner = new MigrationRunner(store as never);
      await runner.runMigrations([migration021]);
      const after = store.data.mcpServer as Record<string, unknown>;
      expect(store.data._schemaVersion).toBe(21);
      expect("apiKey" in after).toBe(false);
      expect(after.enabled).toBe(true);
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

  describe("migration 002 — add terminal location", () => {
    it("adds location='grid' to terminals missing the field and preserves sibling fields", () => {
      const store = createMockStore(storePath, {
        appState: {
          sidebarWidth: 350,
          terminals: [
            { id: "t1", title: "One", cwd: "/repo" },
            { id: "t2", title: "Two", cwd: "/repo" },
          ],
        },
      });
      migration002.up(store as never);
      const appState = store.data.appState as Record<string, unknown>;
      const terminals = appState.terminals as Array<Record<string, unknown>>;
      expect(terminals[0]?.location).toBe("grid");
      expect(terminals[1]?.location).toBe("grid");
      expect(terminals[0]?.id).toBe("t1");
      expect(appState.sidebarWidth).toBe(350);
    });

    it("preserves existing location values", () => {
      const store = createMockStore(storePath, {
        appState: {
          terminals: [{ id: "t1", location: "dock" }, { id: "t2", location: "grid" }, { id: "t3" }],
        },
      });
      migration002.up(store as never);
      const terminals = (store.data.appState as Record<string, unknown>).terminals as Array<
        Record<string, unknown>
      >;
      expect(terminals[0]?.location).toBe("dock");
      expect(terminals[1]?.location).toBe("grid");
      expect(terminals[2]?.location).toBe("grid");
    });

    it("is a no-op when appState has no terminals array", () => {
      const store = createMockStore(storePath, { appState: { sidebarWidth: 350 } });
      migration002.up(store as never);
      expect(store.data.appState).toEqual({ sidebarWidth: 350 });
    });

    it("is a no-op when terminals is not an array", () => {
      const store = createMockStore(storePath, {
        appState: { terminals: "not-an-array" as unknown },
      });
      migration002.up(store as never);
      expect((store.data.appState as Record<string, unknown>).terminals).toBe("not-an-array");
    });

    it("skips when no appState exists", () => {
      const store = createMockStore(storePath, {});
      migration002.up(store as never);
      expect(store.data.appState).toBeUndefined();
    });

    it("is idempotent — second run is a no-op", () => {
      const store = createMockStore(storePath, {
        appState: { terminals: [{ id: "t1" }] },
      });
      migration002.up(store as never);
      const after1 = JSON.stringify(store.data);
      migration002.up(store as never);
      expect(JSON.stringify(store.data)).toBe(after1);
    });
  });

  describe("migration 003 — migrate recipes to project", () => {
    beforeEach(() => {
      mockProjectStore.getCurrentProjectId.mockReset().mockReturnValue(null);
      mockProjectStore.getProjectById.mockReset().mockReturnValue(null);
      mockProjectStore.getRecipes.mockReset().mockResolvedValue([]);
      mockProjectStore.saveRecipes.mockReset().mockResolvedValue(undefined);
    });

    it("no-ops when no appState", async () => {
      const store = createMockStore(storePath, {});
      await migration003.up(store as never);
      expect(mockProjectStore.saveRecipes).not.toHaveBeenCalled();
    });

    it("no-ops when recipes array is empty", async () => {
      const store = createMockStore(storePath, { appState: { recipes: [] } });
      await migration003.up(store as never);
      expect(mockProjectStore.getCurrentProjectId).not.toHaveBeenCalled();
    });

    it("preserves legacy recipes when no current project is selected", async () => {
      const recipes = [{ id: "r1", name: "Recipe", terminals: [] }];
      const store = createMockStore(storePath, { appState: { recipes } });
      mockProjectStore.getCurrentProjectId.mockReturnValue(null);
      await migration003.up(store as never);
      expect(mockProjectStore.saveRecipes).not.toHaveBeenCalled();
      expect((store.data.appState as Record<string, unknown>).recipes).toEqual(recipes);
    });

    it("preserves legacy recipes when project does not exist", async () => {
      const recipes = [{ id: "r1", name: "Recipe", terminals: [] }];
      const store = createMockStore(storePath, { appState: { recipes } });
      mockProjectStore.getCurrentProjectId.mockReturnValue("missing-proj");
      mockProjectStore.getProjectById.mockReturnValue(null);
      await migration003.up(store as never);
      expect(mockProjectStore.saveRecipes).not.toHaveBeenCalled();
      expect((store.data.appState as Record<string, unknown>).recipes).toEqual(recipes);
    });

    it("migrates recipes and clears the global array on success", async () => {
      const store = createMockStore(storePath, {
        appState: {
          sidebarWidth: 350,
          recipes: [
            {
              id: "r1",
              name: "Recipe One",
              worktreeId: "wt-1",
              terminals: [{ type: "terminal", title: "Tab", command: "echo hi" }],
              createdAt: 1000,
              showInEmptyState: true,
            },
          ],
        },
      });
      mockProjectStore.getCurrentProjectId.mockReturnValue("proj-1");
      mockProjectStore.getProjectById.mockReturnValue({ id: "proj-1", name: "P", path: "/p" });
      mockProjectStore.getRecipes.mockResolvedValue([]);
      await migration003.up(store as never);
      expect(mockProjectStore.saveRecipes).toHaveBeenCalledTimes(1);
      const firstCall =
        (mockProjectStore.saveRecipes.mock.calls as unknown as [unknown, unknown][][])[0] ?? [];
      const [projectId, saved] = firstCall;
      expect(projectId).toBe("proj-1");
      const savedArr = saved as Array<Record<string, unknown>>;
      expect(savedArr).toHaveLength(1);
      expect(savedArr[0]?.id).toBe("r1");
      expect(savedArr[0]?.projectId).toBe("proj-1");
      const appState = store.data.appState as Record<string, unknown>;
      expect(appState.recipes).toEqual([]);
      expect(appState.sidebarWidth).toBe(350);
    });

    it("skips duplicate recipes already in the project", async () => {
      const store = createMockStore(storePath, {
        appState: {
          recipes: [
            { id: "r1", name: "Dup", terminals: [] },
            { id: "r2", name: "New", terminals: [] },
          ],
        },
      });
      mockProjectStore.getCurrentProjectId.mockReturnValue("proj-1");
      mockProjectStore.getProjectById.mockReturnValue({ id: "proj-1" });
      mockProjectStore.getRecipes.mockResolvedValue([
        { id: "r1", name: "Dup", projectId: "proj-1", terminals: [] },
      ]);
      await migration003.up(store as never);
      expect(mockProjectStore.saveRecipes).toHaveBeenCalledTimes(1);
      const merged = (
        mockProjectStore.saveRecipes.mock.calls as unknown as [unknown, unknown][][]
      )[0]?.[1] as Array<Record<string, unknown>>;
      expect(merged).toHaveLength(2);
      expect(merged.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
      expect((store.data.appState as Record<string, unknown>).recipes).toEqual([]);
    });

    it("does not save when every legacy recipe is a duplicate, but still clears globals", async () => {
      const store = createMockStore(storePath, {
        appState: { recipes: [{ id: "r1", name: "Dup", terminals: [] }] },
      });
      mockProjectStore.getCurrentProjectId.mockReturnValue("proj-1");
      mockProjectStore.getProjectById.mockReturnValue({ id: "proj-1" });
      mockProjectStore.getRecipes.mockResolvedValue([
        { id: "r1", name: "Dup", projectId: "proj-1", terminals: [] },
      ]);
      await migration003.up(store as never);
      expect(mockProjectStore.saveRecipes).not.toHaveBeenCalled();
      expect((store.data.appState as Record<string, unknown>).recipes).toEqual([]);
    });

    it("swallows errors from saveRecipes and preserves legacy recipes", async () => {
      const recipes = [{ id: "r1", name: "Recipe", terminals: [] }];
      const store = createMockStore(storePath, { appState: { recipes } });
      mockProjectStore.getCurrentProjectId.mockReturnValue("proj-1");
      mockProjectStore.getProjectById.mockReturnValue({ id: "proj-1" });
      mockProjectStore.getRecipes.mockResolvedValue([]);
      mockProjectStore.saveRecipes.mockRejectedValue(new Error("disk full"));
      await expect(migration003.up(store as never)).resolves.toBeUndefined();
      expect((store.data.appState as Record<string, unknown>).recipes).toEqual(recipes);
    });

    it("swallows errors from getRecipes and preserves legacy recipes without saving", async () => {
      const recipes = [{ id: "r1", name: "Recipe", terminals: [] }];
      const store = createMockStore(storePath, { appState: { recipes } });
      mockProjectStore.getCurrentProjectId.mockReturnValue("proj-1");
      mockProjectStore.getProjectById.mockReturnValue({ id: "proj-1" });
      mockProjectStore.getRecipes.mockRejectedValue(new Error("sqlite locked"));
      await expect(migration003.up(store as never)).resolves.toBeUndefined();
      expect(mockProjectStore.saveRecipes).not.toHaveBeenCalled();
      expect((store.data.appState as Record<string, unknown>).recipes).toEqual(recipes);
    });
  });

  describe("migration 005 — getting-started checklist", () => {
    it("adds a dismissed checklist when onboarding was previously completed", () => {
      const store = createMockStore(storePath, {
        onboarding: { completed: true, schemaVersion: 0 },
      });
      migration005.up(store as never);
      const onboarding = store.data.onboarding as Record<string, unknown>;
      const checklist = onboarding.checklist as {
        dismissed: boolean;
        items: Record<string, boolean>;
      };
      expect(checklist.dismissed).toBe(true);
      expect(checklist.items.openedProject).toBe(true);
      expect(checklist.items.launchedAgent).toBe(true);
      expect(checklist.items.createdWorktree).toBe(true);
      expect(onboarding.schemaVersion).toBe(0);
    });

    it("adds an open checklist when onboarding is not yet completed", () => {
      const store = createMockStore(storePath, {
        onboarding: { completed: false },
      });
      migration005.up(store as never);
      const checklist = (store.data.onboarding as Record<string, unknown>).checklist as {
        dismissed: boolean;
        items: Record<string, boolean>;
      };
      expect(checklist.dismissed).toBe(false);
      expect(checklist.items.openedProject).toBe(false);
      expect(checklist.items.launchedAgent).toBe(false);
      expect(checklist.items.createdWorktree).toBe(false);
    });

    it("treats undefined completed flag as open checklist", () => {
      const store = createMockStore(storePath, { onboarding: {} });
      migration005.up(store as never);
      const checklist = (store.data.onboarding as Record<string, unknown>).checklist as {
        dismissed: boolean;
      };
      expect(checklist.dismissed).toBe(false);
    });

    it("does not overwrite an existing checklist", () => {
      const existing = { dismissed: false, items: { openedProject: true } };
      const store = createMockStore(storePath, {
        onboarding: { completed: true, checklist: existing },
      });
      migration005.up(store as never);
      expect((store.data.onboarding as Record<string, unknown>).checklist).toBe(existing);
    });

    it("skips when no onboarding state exists", () => {
      const store = createMockStore(storePath, {});
      migration005.up(store as never);
      expect(store.data.onboarding).toBeUndefined();
    });
  });

  describe("migration 010 — add working pulse setting", () => {
    it("adds workingPulseEnabled=false and workingPulseSoundFile when absent", () => {
      const store = createMockStore(storePath, {
        notificationSettings: { enabled: true, soundEnabled: true },
      });
      migration010.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.workingPulseEnabled).toBe(false);
      expect(settings.workingPulseSoundFile).toBe("pulse.wav");
      expect(settings.enabled).toBe(true);
      expect(settings.soundEnabled).toBe(true);
    });

    it("preserves an existing workingPulseEnabled value", () => {
      const store = createMockStore(storePath, {
        notificationSettings: { workingPulseEnabled: true, workingPulseSoundFile: "custom.wav" },
      });
      migration010.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.workingPulseEnabled).toBe(true);
      expect(settings.workingPulseSoundFile).toBe("custom.wav");
    });

    // Documents the intentional guard-only-on-flag behavior: a partial write
    // where workingPulseEnabled is present but workingPulseSoundFile is not
    // is treated as already-migrated. If this becomes a user-visible issue,
    // the guard in the migration source should extend to also check the
    // sound file key.
    it("treats a partially-migrated record (flag set, sound file missing) as already migrated", () => {
      const store = createMockStore(storePath, {
        notificationSettings: { workingPulseEnabled: true },
      });
      migration010.up(store as never);
      const settings = store.data.notificationSettings as Record<string, unknown>;
      expect(settings.workingPulseEnabled).toBe(true);
      expect(settings.workingPulseSoundFile).toBeUndefined();
    });

    it("skips when notificationSettings is absent", () => {
      const store = createMockStore(storePath, {});
      migration010.up(store as never);
      expect(store.data.notificationSettings).toBeUndefined();
    });

    it("is idempotent — second run does not change state", () => {
      const store = createMockStore(storePath, {
        notificationSettings: { enabled: true },
      });
      migration010.up(store as never);
      const after1 = JSON.stringify(store.data.notificationSettings);
      migration010.up(store as never);
      expect(JSON.stringify(store.data.notificationSettings)).toBe(after1);
    });
  });

  describe("migration 018 — archive notes directory", () => {
    let renameSpy: ReturnType<typeof vi.spyOn>;
    let userDataDir: string;

    beforeEach(() => {
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-m018-"));
      (electronApp.getPath as Mock).mockReturnValue(userDataDir);
      renameSpy = vi.spyOn(fs, "renameSync");
    });

    afterEach(() => {
      renameSpy.mockRestore();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      (electronApp.getPath as Mock).mockReturnValue(os.tmpdir());
    });

    it("renames legacy notes directory to notes_archived", () => {
      const notesDir = path.join(userDataDir, "notes");
      fs.mkdirSync(notesDir);
      const store = createMockStore(storePath, {});
      migration018.up(store as never);
      expect(renameSpy).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(userDataDir, "notes_archived"))).toBe(true);
      expect(fs.existsSync(notesDir)).toBe(false);
    });

    it("skips when legacy notes directory does not exist", () => {
      const store = createMockStore(storePath, {});
      migration018.up(store as never);
      expect(renameSpy).not.toHaveBeenCalled();
    });

    it("skips when notes_archived already exists", () => {
      const notesDir = path.join(userDataDir, "notes");
      const archivedDir = path.join(userDataDir, "notes_archived");
      fs.mkdirSync(notesDir);
      fs.mkdirSync(archivedDir);
      const store = createMockStore(storePath, {});
      migration018.up(store as never);
      expect(renameSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(notesDir)).toBe(true);
    });

    it("swallows rename failures without throwing", () => {
      const notesDir = path.join(userDataDir, "notes");
      fs.mkdirSync(notesDir);
      renameSpy.mockImplementation(() => {
        throw new Error("permission denied");
      });
      const store = createMockStore(storePath, {});
      expect(() => migration018.up(store as never)).not.toThrow();
    });

    it("skips silently when app.getPath('userData') throws", () => {
      (electronApp.getPath as Mock).mockImplementation(() => {
        throw new Error("app not ready");
      });
      const store = createMockStore(storePath, {});
      expect(() => migration018.up(store as never)).not.toThrow();
      expect(renameSpy).not.toHaveBeenCalled();
    });
  });

  describe("floorVersion option", () => {
    it("runs migrations normally when floorVersion is omitted", async () => {
      const applied: number[] = [];
      const store = createMockStore(storePath, { _schemaVersion: 0 });
      const runner = new MigrationRunner(store as never);
      await runner.runMigrations([
        { version: 1, description: "v1", up: () => void applied.push(1) },
        { version: 2, description: "v2", up: () => void applied.push(2) },
      ]);
      expect(applied).toEqual([1, 2]);
      expect(store.data._schemaVersion).toBe(2);
    });

    it("runs migrations normally when stored version equals floorVersion", async () => {
      const applied: number[] = [];
      const store = createMockStore(storePath, { _schemaVersion: 3, other: "keep" });
      const runner = new MigrationRunner(store as never, { floorVersion: 3 });
      await runner.runMigrations([
        { version: 2, description: "v2", up: () => void applied.push(2) },
        { version: 4, description: "v4", up: () => void applied.push(4) },
      ]);
      expect(applied).toEqual([4]);
      expect(store.data._schemaVersion).toBe(4);
      expect(store.data.other).toBe("keep");
    });

    it("runs migrations normally when stored version is above floorVersion", async () => {
      const applied: number[] = [];
      const store = createMockStore(storePath, { _schemaVersion: 4, keep: true });
      const runner = new MigrationRunner(store as never, { floorVersion: 3 });
      await runner.runMigrations([
        { version: 3, description: "v3", up: () => void applied.push(3) },
        { version: 5, description: "v5", up: () => void applied.push(5) },
      ]);
      expect(applied).toEqual([5]);
      expect(store.data._schemaVersion).toBe(5);
      expect(store.data.keep).toBe(true);
    });

    it("clears the store and sets _schemaVersion to floor when stored version is below floor", async () => {
      const upSpy = vi.fn();
      const store = createMockStore(storePath, {
        _schemaVersion: 2,
        appState: { sidebarWidth: 350 },
        appTheme: { colorSchemeId: "daintree" },
        notificationSettings: { enabled: true },
      });
      const runner = new MigrationRunner(store as never, { floorVersion: 5 });
      await runner.runMigrations([
        { version: 3, description: "v3", up: upSpy },
        { version: 5, description: "v5", up: upSpy },
        { version: 6, description: "v6", up: upSpy },
      ]);
      expect(upSpy).not.toHaveBeenCalled();
      expect(store.data._schemaVersion).toBe(5);
      expect(store.data.appState).toBeUndefined();
      expect(store.data.appTheme).toBeUndefined();
      expect(store.data.notificationSettings).toBeUndefined();
    });

    it("treats missing _schemaVersion (defaulting to 0) as below floor", async () => {
      const upSpy = vi.fn();
      const store = createMockStore(storePath, { legacyKey: { nested: true } });
      const runner = new MigrationRunner(store as never, { floorVersion: 10 });
      await runner.runMigrations([{ version: 5, description: "v5", up: upSpy }]);
      expect(upSpy).not.toHaveBeenCalled();
      expect(store.data._schemaVersion).toBe(10);
      expect(store.data.legacyKey).toBeUndefined();
    });

    it("preserves a too-new schema version even when floorVersion is set (compatibility mode wins)", async () => {
      const upSpy = vi.fn();
      const store = createMockStore(storePath, { _schemaVersion: 99 });
      const runner = new MigrationRunner(store as never, { floorVersion: 5 });
      await runner.runMigrations([{ version: 5, description: "v5", up: upSpy }]);
      expect(upSpy).not.toHaveBeenCalled();
      expect(store.data._schemaVersion).toBe(99);
    });

    it("writes a backup containing the pre-reset store bytes before clearing", async () => {
      const originalBytes = JSON.stringify({ _schemaVersion: 1, sentinel: "pre-reset-value" });
      fs.writeFileSync(storePath, originalBytes, "utf8");
      const store = createMockStore(storePath, { _schemaVersion: 1 });
      const runner = new MigrationRunner(store as never, { floorVersion: 5 });
      await runner.runMigrations([{ version: 5, description: "v5", up: () => {} }]);
      const backupFile = fs
        .readdirSync(tempDir)
        .find((file) => file.startsWith("config.json.backup-"));
      expect(backupFile).toBeDefined();
      const backupContents = fs.readFileSync(path.join(tempDir, backupFile!), "utf8");
      expect(backupContents).toBe(originalBytes);
    });

    it("rejects a non-integer floorVersion", async () => {
      const store = createMockStore(storePath, { _schemaVersion: 1 });
      const runner = new MigrationRunner(store as never, { floorVersion: 5.5 });
      await expect(
        runner.runMigrations([{ version: 5, description: "v5", up: () => {} }])
      ).rejects.toThrow(/floorVersion must be a non-negative integer/);
      // Store should be untouched when validation fails
      expect(store.data._schemaVersion).toBe(1);
    });

    it("rejects a negative floorVersion", async () => {
      const store = createMockStore(storePath, { _schemaVersion: 0 });
      const runner = new MigrationRunner(store as never, { floorVersion: -1 });
      await expect(
        runner.runMigrations([{ version: 5, description: "v5", up: () => {} }])
      ).rejects.toThrow(/floorVersion must be a non-negative integer/);
    });

    it("accepts floorVersion === 0 as a no-op floor", async () => {
      const upSpy = vi.fn();
      const store = createMockStore(storePath, { _schemaVersion: 0 });
      const runner = new MigrationRunner(store as never, { floorVersion: 0 });
      await runner.runMigrations([{ version: 1, description: "v1", up: upSpy }]);
      expect(upSpy).toHaveBeenCalledTimes(1);
      expect(store.data._schemaVersion).toBe(1);
    });
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
        appTheme: { colorSchemeId: "daintree" },
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
        mcpServer: { enabled: false, port: 45454 },
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
        },
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
