import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Conf from "conf";

vi.mock("electron-store", async () => {
  const conf = await import("conf");
  return { default: conf.default };
});

import {
  resolveConfigPath,
  preflightValidateConfig,
  quarantineCorruptConfig,
  restoreFromBackup,
  refreshBackup,
  initializeStore,
  runDeferredStoreBackup,
  consumePendingSettingsRecovery,
  _resetPendingSettingsRecovery,
  _resetStoreInstance,
  wasStoreFreshAtBoot,
  store,
  invalidateStoreValueCache,
  _peekStoreInstance,
  clearWslGitEntry,
  writeWslGitMap,
} from "../store.js";

describe("Store backup/restore helpers", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-"));
    configPath = path.join(tempDir, "config.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("resolveConfigPath", () => {
    it("returns null when cwd is undefined", () => {
      expect(resolveConfigPath(undefined)).toBeNull();
    });
  });

  describe("preflightValidateConfig", () => {
    it("returns 'missing' when file does not exist", () => {
      expect(preflightValidateConfig(configPath).status).toBe("missing");
    });

    it("returns 'valid' for valid JSON", () => {
      fs.writeFileSync(configPath, JSON.stringify({ foo: "bar" }), "utf8");
      expect(preflightValidateConfig(configPath).status).toBe("valid");
    });

    it("carries the raw bytes it read so the caller can skip a second read", () => {
      fs.writeFileSync(configPath, JSON.stringify({ foo: "bar", n: 42 }), "utf8");
      const result = preflightValidateConfig(configPath);
      expect(result.status).toBe("valid");
      expect(result.status === "valid" && Buffer.isBuffer(result.rawBuffer)).toBe(true);
      // The reused buffer must be byte-identical to a fresh raw read so it can
      // serve as the pre-construction wipe-detection snapshot.
      expect(
        result.status === "valid" && result.rawBuffer?.equals(fs.readFileSync(configPath))
      ).toBe(true);
    });

    it("carries byte-identical bytes for non-ASCII (CJK + emoji) content", () => {
      fs.writeFileSync(configPath, JSON.stringify({ greeting: "你好", emoji: "🚀" }), "utf8");
      const result = preflightValidateConfig(configPath);
      expect(
        result.status === "valid" && result.rawBuffer?.equals(fs.readFileSync(configPath))
      ).toBe(true);
    });

    it("returns 'corrupt' for invalid JSON", () => {
      fs.writeFileSync(configPath, "{invalid json", "utf8");
      expect(preflightValidateConfig(configPath).status).toBe("corrupt");
    });

    it("returns 'corrupt' for non-object JSON values", () => {
      fs.writeFileSync(configPath, '"a string"', "utf8");
      expect(preflightValidateConfig(configPath).status).toBe("corrupt");
      fs.writeFileSync(configPath, "42", "utf8");
      expect(preflightValidateConfig(configPath).status).toBe("corrupt");
      fs.writeFileSync(configPath, "[]", "utf8");
      expect(preflightValidateConfig(configPath).status).toBe("corrupt");
      fs.writeFileSync(configPath, "null", "utf8");
      expect(preflightValidateConfig(configPath).status).toBe("corrupt");
    });

    it("returns 'valid' with no raw bytes on non-SyntaxError read failures", () => {
      const dirPath = path.join(tempDir, "not-a-file");
      fs.mkdirSync(dirPath);
      const result = preflightValidateConfig(dirPath);
      expect(result.status).toBe("valid");
      // Fail-open: no usable bytes, so the caller must fall back to a fresh read.
      expect(result.status === "valid" && result.rawBuffer).toBeUndefined();
    });
  });

  describe("quarantineCorruptConfig", () => {
    it("renames corrupt config with timestamp and returns quarantine path", () => {
      fs.writeFileSync(configPath, "bad", "utf8");
      const result = quarantineCorruptConfig(configPath);
      const expectedPath = path.join(tempDir, `config.json.corrupted.${Date.now()}`);
      expect(result).toBe(expectedPath);
      expect(fs.existsSync(configPath)).toBe(false);
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(fs.readFileSync(expectedPath, "utf8")).toBe("bad");
    });

    it("returns null when file does not exist", () => {
      expect(quarantineCorruptConfig(configPath)).toBeNull();
    });

    it.skipIf(process.platform === "win32")(
      "tightens the quarantined file to 0o600 on POSIX",
      () => {
        fs.writeFileSync(configPath, '{"githubToken":"ghp_secret"', "utf8");
        fs.chmodSync(configPath, 0o644);
        const quarantined = quarantineCorruptConfig(configPath);
        expect(quarantined).not.toBeNull();
        const mode = fs.statSync(quarantined!).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    );
  });

  describe("restoreFromBackup", () => {
    it("returns false when no backup exists", () => {
      expect(restoreFromBackup(configPath)).toBe(false);
    });

    it("restores valid backup and returns true", () => {
      const data = { restored: true };
      fs.writeFileSync(`${configPath}.bak`, JSON.stringify(data), "utf8");
      expect(restoreFromBackup(configPath)).toBe(true);
      expect(fs.existsSync(configPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(data);
    });

    it("returns false when backup contains invalid JSON", () => {
      fs.writeFileSync(`${configPath}.bak`, "not json", "utf8");
      expect(restoreFromBackup(configPath)).toBe(false);
      expect(fs.existsSync(configPath)).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "tightens the restored config.json to 0o600 even when the backup was 0o644",
      () => {
        fs.writeFileSync(`${configPath}.bak`, JSON.stringify({ restored: true }), "utf8");
        fs.chmodSync(`${configPath}.bak`, 0o644);
        expect(restoreFromBackup(configPath)).toBe(true);
        const mode = fs.statSync(configPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    );
  });

  describe("refreshBackup", () => {
    it("creates backup from valid config", () => {
      const data = { backed: "up" };
      fs.writeFileSync(configPath, JSON.stringify(data), "utf8");
      refreshBackup(configPath);
      expect(fs.existsSync(`${configPath}.bak`)).toBe(true);
      expect(JSON.parse(fs.readFileSync(`${configPath}.bak`, "utf8"))).toEqual(data);
    });

    it("does not throw when config does not exist", () => {
      expect(() => refreshBackup(configPath)).not.toThrow();
      expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "writes the backup file with 0o600 mode on POSIX",
      () => {
        // Source 0o644 to verify refreshBackup retightens the copy regardless
        // of source mode (Linux copyFileSync semantics vary by filesystem).
        fs.writeFileSync(configPath, JSON.stringify({ backed: "up" }), { mode: 0o644 });
        fs.chmodSync(configPath, 0o644);
        refreshBackup(configPath);
        const mode = fs.statSync(`${configPath}.bak`).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    );
  });
});

describe("initializeStore", () => {
  let tempDir: string;

  function testOptions(cwd: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { defaults: { _schemaVersion: 0 } as Record<string, unknown>, cwd } as any;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-init-"));
    _resetStoreInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetPendingSettingsRecovery();
    _resetStoreInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates store with defaults on first launch (no config.json)", () => {
    const instance = initializeStore(testOptions(tempDir));
    expect(instance).toBeDefined();
    expect(instance.get("_schemaVersion")).toBe(0);
    const configPath = path.join(tempDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    // The .bak refresh is deferred off the boot path; it only lands once the
    // bootstrap-scheduled task runs.
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
    runDeferredStoreBackup();
    expect(fs.existsSync(`${configPath}.bak`)).toBe(true);
  });

  it("does not trip wipe detection on a pretty-printed valid config (reused-buffer byte identity)", () => {
    const configPath = path.join(tempDir, "config.json");
    // Whitespace-heavy formatting: the reused preflight buffer must match the
    // on-disk bytes exactly, or detectStoreWipe's byte fast-path would diverge.
    fs.writeFileSync(configPath, `${JSON.stringify({ _schemaVersion: 5 }, null, 2)}\n`, "utf8");
    const instance = initializeStore(testOptions(tempDir));
    expect(instance.get("_schemaVersion")).toBe(5);
    // A benign load must not be misreported as a silent reset.
    expect(consumePendingSettingsRecovery()).toBeNull();
    runDeferredStoreBackup();
    expect(fs.existsSync(`${configPath}.bak`)).toBe(true);
  });

  it("recovers from corrupt config with valid backup", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, "{corrupt!", "utf8");
    fs.writeFileSync(`${configPath}.bak`, JSON.stringify({ _schemaVersion: 3 }), "utf8");
    const instance = initializeStore(testOptions(tempDir));
    expect(instance.get("_schemaVersion")).toBe(3);
    const quarantined = path.join(tempDir, `config.json.corrupted.${Date.now()}`);
    expect(fs.existsSync(quarantined)).toBe(true);
    expect(fs.readFileSync(quarantined, "utf8")).toBe("{corrupt!");
  });

  it("starts fresh with defaults when config is corrupt and no backup exists", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, "not valid json", "utf8");
    const instance = initializeStore(testOptions(tempDir));
    expect(instance.get("_schemaVersion")).toBe(0);
    const quarantined = path.join(tempDir, `config.json.corrupted.${Date.now()}`);
    expect(fs.existsSync(quarantined)).toBe(true);
  });

  it("starts fresh with defaults when both config and backup are corrupt", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, "bad json 1", "utf8");
    fs.writeFileSync(`${configPath}.bak`, "bad json 2", "utf8");
    const instance = initializeStore(testOptions(tempDir));
    expect(instance.get("_schemaVersion")).toBe(0);
  });

  it("does NOT overwrite backup when store silently clears a schema-invalid config", () => {
    const configPath = path.join(tempDir, "config.json");
    const lastGood = JSON.stringify({ _schemaVersion: 7 });
    const violating = JSON.stringify({ _schemaVersion: "not-a-number" });
    fs.writeFileSync(configPath, violating, "utf8");
    fs.writeFileSync(`${configPath}.bak`, lastGood, "utf8");

    const opts = testOptions(tempDir);
    opts.schema = { _schemaVersion: { type: "number" } };

    const instance = initializeStore(opts);
    expect(instance).toBeDefined();
    // Store has been silently reset to defaults by electron-store
    expect(instance.get("_schemaVersion")).toBe(0);
    // Even after the deferred backup task runs, the wipe guard must keep the
    // last-good backup untouched — recovery is still possible.
    runDeferredStoreBackup();
    expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(lastGood);
    // …and recovery state should reflect the silent reset
    expect(consumePendingSettingsRecovery()).toEqual({ kind: "reset-to-defaults" });
  });

  describe("wasStoreFreshAtBoot", () => {
    it("is true on first launch (no config.json)", () => {
      initializeStore(testOptions(tempDir));
      expect(wasStoreFreshAtBoot()).toBe(true);
    });

    it("is false when a config.json exists", () => {
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({ _schemaVersion: 5 }));
      initializeStore(testOptions(tempDir));
      expect(wasStoreFreshAtBoot()).toBe(false);
    });

    it("is false when the config existed but was corrupt (quarantine/reset path)", () => {
      fs.writeFileSync(path.join(tempDir, "config.json"), "not valid json", "utf8");
      initializeStore(testOptions(tempDir));
      // The file held (possibly recoverable) user data — the migration
      // fast path must not treat this boot as a fresh install.
      expect(wasStoreFreshAtBoot()).toBe(false);
    });

    it("is false on the in-memory fallback path even when the path looked fresh", () => {
      initializeStore(testOptions("/nonexistent/\0/path"));
      expect(wasStoreFreshAtBoot()).toBe(false);
    });
  });

  it("refreshes backup when conf merges new defaults into a valid config (app upgrade scenario)", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 5 }), "utf8");

    const opts = testOptions(tempDir);
    // Simulate app upgrade adding a new default key the existing config lacks
    opts.defaults = { _schemaVersion: 0, newDefault: "added" };

    const instance = initializeStore(opts);
    expect(instance.get("_schemaVersion")).toBe(5);
    expect(instance.get("newDefault")).toBe("added");
    // Backup must reflect the merged-on-disk content, not stay frozen
    runDeferredStoreBackup();
    const backup = JSON.parse(fs.readFileSync(`${configPath}.bak`, "utf8"));
    expect(backup._schemaVersion).toBe(5);
    expect(backup.newDefault).toBe("added");
    // No phantom recovery notification on a benign merge
    expect(consumePendingSettingsRecovery()).toBeNull();
  });

  it("preserves restored-from-backup recovery when conf merges defaults into restored backup", () => {
    const configPath = path.join(tempDir, "config.json");
    // Main config is corrupt (preflight will quarantine it and restore .bak)
    fs.writeFileSync(configPath, "{corrupt!", "utf8");
    // Backup is valid but missing a current default key (typical post-upgrade state)
    fs.writeFileSync(`${configPath}.bak`, JSON.stringify({ _schemaVersion: 7 }), "utf8");

    const opts = testOptions(tempDir);
    opts.defaults = { _schemaVersion: 0, newDefault: "added" };

    const instance = initializeStore(opts);
    expect(instance.get("_schemaVersion")).toBe(7);

    const recovery = consumePendingSettingsRecovery();
    expect(recovery?.kind).toBe("restored-from-backup");
    expect(recovery?.quarantinedPath).toBeDefined();
  });

  it("is idempotent — second call returns the same instance and skips re-init", () => {
    const first = initializeStore(testOptions(tempDir));
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, "{corrupt!", "utf8");
    const second = initializeStore(testOptions(tempDir));
    expect(second).toBe(first);
    // Existing config left untouched — no quarantine triggered on second call
    expect(fs.readFileSync(configPath, "utf8")).toBe("{corrupt!");
    expect(consumePendingSettingsRecovery()).toBeNull();
  });

  describe("consumePendingSettingsRecovery", () => {
    it("returns null on normal startup", () => {
      initializeStore(testOptions(tempDir));
      expect(consumePendingSettingsRecovery()).toBeNull();
    });

    it("returns restored-from-backup when corrupt config has valid backup", () => {
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, "{corrupt!", "utf8");
      fs.writeFileSync(`${configPath}.bak`, JSON.stringify({ _schemaVersion: 3 }), "utf8");
      initializeStore(testOptions(tempDir));
      const recovery = consumePendingSettingsRecovery();
      expect(recovery).toEqual({
        kind: "restored-from-backup",
        quarantinedPath: path.join(tempDir, `config.json.corrupted.${Date.now()}`),
      });
    });

    it("returns reset-to-defaults when corrupt config has no backup", () => {
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, "not valid json", "utf8");
      initializeStore(testOptions(tempDir));
      const recovery = consumePendingSettingsRecovery();
      expect(recovery).toEqual({
        kind: "reset-to-defaults",
        quarantinedPath: path.join(tempDir, `config.json.corrupted.${Date.now()}`),
      });
    });

    it("returns reset-to-defaults on in-memory fallback", () => {
      initializeStore(testOptions("/nonexistent/\0/path"));
      const recovery = consumePendingSettingsRecovery();
      expect(recovery).toEqual({ kind: "reset-to-defaults" });
    });

    it("consume-once: second call returns null", () => {
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, "{corrupt!", "utf8");
      initializeStore(testOptions(tempDir));
      expect(consumePendingSettingsRecovery()).not.toBeNull();
      expect(consumePendingSettingsRecovery()).toBeNull();
    });
  });

  describe("file permissions", () => {
    it.skipIf(process.platform === "win32")(
      "creates config.json with 0o600 on first launch",
      () => {
        const configPath = path.join(tempDir, "config.json");
        initializeStore(testOptions(tempDir));
        const mode = fs.statSync(configPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    );

    it.skipIf(process.platform === "win32")(
      "tightens a pre-existing 0o644 config.json on init even without a write",
      () => {
        const configPath = path.join(tempDir, "config.json");
        fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 5 }), "utf8");
        fs.chmodSync(configPath, 0o644);
        initializeStore(testOptions(tempDir));
        const mode = fs.statSync(configPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    );

    it.skipIf(process.platform === "win32")(
      "tightens a pre-existing 0o644 config.json.bak on init",
      () => {
        const configPath = path.join(tempDir, "config.json");
        const backupPath = `${configPath}.bak`;
        fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 5 }), "utf8");
        fs.writeFileSync(backupPath, JSON.stringify({ _schemaVersion: 5 }), "utf8");
        fs.chmodSync(backupPath, 0o644);
        initializeStore(testOptions(tempDir));
        runDeferredStoreBackup();
        const mode = fs.statSync(backupPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    );

    it.skipIf(process.platform === "win32")(
      "still returns a valid store when chmodSync throws",
      () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
          throw new Error("EPERM");
        });
        try {
          const instance = initializeStore(testOptions(tempDir));
          expect(instance).toBeDefined();
          expect(instance.get("_schemaVersion")).toBe(0);
        } finally {
          chmodSpy.mockRestore();
          warnSpy.mockRestore();
        }
      }
    );
  });
});

type AnyStore = {
  set: (key: string, value: unknown) => void;
  get: (key: string) => unknown;
  delete: (key: string) => void;
};

describe("Store dot-path persistence", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    _resetStoreInstance();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-dotpath-"));
    configPath = path.join(tempDir, "config.json");
  });

  afterEach(() => {
    _resetStoreInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  }

  function makeStore(defaults: Record<string, unknown> = {}): AnyStore {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return initializeStore({ defaults, cwd: tempDir } as any) as unknown as AnyStore;
  }

  it("dot-path set preserves siblings already on disk", () => {
    fs.writeFileSync(configPath, JSON.stringify({ foo: { bar: 1, baz: 2 } }), "utf8");
    const store = makeStore();
    store.set("foo.bar", 99);
    expect(readConfig()).toEqual({ foo: { bar: 99, baz: 2 } });
  });

  it("nested dot-path set writes deeply without baking unrelated keys", () => {
    const store = makeStore();
    store.set("a.b.c", true);
    expect(readConfig()).toEqual({ a: { b: { c: true } } });
  });

  it("whole-slice replacement still works for explicit resets", () => {
    fs.writeFileSync(configPath, JSON.stringify({ foo: { keep: 1, drop: 2 } }), "utf8");
    const store = makeStore();
    store.set("foo", { onlyField: "value" });
    expect(readConfig()).toEqual({ foo: { onlyField: "value" } });
  });

  it("dot-path delete clears a leaf without dropping siblings", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ appState: { activeWorktreeId: "wt-old", sidebarWidth: 350 } }),
      "utf8"
    );
    const store = makeStore();
    store.delete("appState.activeWorktreeId");
    const slice = readConfig().appState as Record<string, unknown>;
    expect(slice).not.toHaveProperty("activeWorktreeId");
    expect(slice.sidebarWidth).toBe(350);
  });

  it("preserves nested record fields not addressed by the dot-path", () => {
    // Models the agentSettings.agents pattern: writing the whole `agents` record
    // at slice.field level instead of per-agent leaves (which would be unsafe for
    // user-defined agent IDs containing dots).
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentSettings: {
          rootField: "preserved",
          agents: { claude: { customFlags: "--foo" } },
        },
      }),
      "utf8"
    );
    const store = makeStore();
    store.set("agentSettings.agents", {
      claude: { customFlags: "--bar" },
      gemini: { model: "gemini-2.0" },
    });
    const after = readConfig().agentSettings as Record<string, unknown>;
    expect(after.rootField).toBe("preserved");
    expect(after.agents).toEqual({
      claude: { customFlags: "--bar" },
      gemini: { model: "gemini-2.0" },
    });
  });
});

describe("wslGitByWorktree store helpers (#9926)", () => {
  let tempDir: string;

  function testOptions(cwd: string) {
    // Mirror the production defaults shape for the keys these tests touch
    // (electron-store returns the default for missing keys, so the in-shape
    // `wslGitByWorktree: {}` is what real callers see on first read).

    return {
      defaults: {
        _schemaVersion: 0,
        wslGitByWorktree: {},
      } as Record<string, unknown>,
      cwd,
    } as any;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-wsl-git-store-"));
    _resetStoreInstance();
    initializeStore(testOptions(tempDir));
  });

  afterEach(() => {
    _resetStoreInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("clearWslGitEntry drops the requested key and leaves siblings intact", () => {
    store.set("wslGitByWorktree", {
      "/repo/a": { enabled: true, dismissed: false },
      "/repo/b": { enabled: false, dismissed: true },
    });

    clearWslGitEntry("/repo/a");

    expect(store.get("wslGitByWorktree")).toEqual({
      "/repo/b": { enabled: false, dismissed: true },
    });
  });

  it("clearWslGitEntry writes {} (never undefined) when clearing the last key", () => {
    store.set("wslGitByWorktree", {
      "/repo/only": { enabled: true, dismissed: true },
    });

    clearWslGitEntry("/repo/only");

    // electron-store v11 throws on set(undefined); the helper must always
    // write a real object so the on-disk shape stays consistent.
    expect(store.get("wslGitByWorktree")).toEqual({});
  });

  it("clearWslGitEntry is a no-op when the key is missing", () => {
    store.set("wslGitByWorktree", {
      "/repo/a": { enabled: true, dismissed: false },
    });

    clearWslGitEntry("/repo/never-existed");

    expect(store.get("wslGitByWorktree")).toEqual({
      "/repo/a": { enabled: true, dismissed: false },
    });
  });

  it("clearWslGitEntry is a no-op when the persisted map is empty", () => {
    // No prior set — store proxy returns the default ({}) on first read.
    clearWslGitEntry("/repo/whatever");
    expect(store.get("wslGitByWorktree")).toEqual({});
  });

  it("clearWslGitEntry is a no-op on junk input", () => {
    store.set("wslGitByWorktree", {
      "/repo/a": { enabled: true, dismissed: false },
    });

    // Each of these is rejected by the type guard at the entry of the helper.
    clearWslGitEntry("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearWslGitEntry(undefined as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearWslGitEntry(null as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearWslGitEntry(42 as any);

    expect(store.get("wslGitByWorktree")).toEqual({
      "/repo/a": { enabled: true, dismissed: false },
    });
  });

  it("clearWslGitEntry does not mutate the original map (read-mutate-set, not in-place delete)", () => {
    // Captured as a defensive snapshot: helpers that hold a reference to the
    // previous shape and only call set(undefined) would corrupt subsequent
    // reads. The helper clones into a fresh object before deleting, so the
    // next read returns the original sibling entry from the cloned map.
    store.set("wslGitByWorktree", {
      "/repo/a": { enabled: true, dismissed: false },
      "/repo/b": { enabled: true, dismissed: false },
    });

    clearWslGitEntry("/repo/a");

    // Repeat-clear must still find /repo/b (the prior in-place delete would
    // have left a torn shape behind).
    clearWslGitEntry("/repo/b");
    expect(store.get("wslGitByWorktree")).toEqual({});
  });

  it("writeWslGitMap replaces the whole map atomically", () => {
    store.set("wslGitByWorktree", {
      "/repo/old": { enabled: true, dismissed: false },
    });

    writeWslGitMap({
      "/repo/new-a": { enabled: true, dismissed: false },
      "/repo/new-b": { enabled: false, dismissed: true },
    });

    expect(store.get("wslGitByWorktree")).toEqual({
      "/repo/new-a": { enabled: true, dismissed: false },
      "/repo/new-b": { enabled: false, dismissed: true },
    });
  });

  it("writeWslGitMap normalizes junk input to {} so it never writes undefined", () => {
    store.set("wslGitByWorktree", {
      "/repo/old": { enabled: true, dismissed: false },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeWslGitMap(null as any);
    expect(store.get("wslGitByWorktree")).toEqual({});
  });
});

function initializeStoreForComparison(cwd: string) {
  // The unproxied conf path the proxy's write-through must match byte for byte.
  return new Conf({ defaults: { _schemaVersion: 0 }, cwd, configFileMode: 0o600 } as never) as {
    set(key: string, value: unknown): void;
    get(key: string): unknown;
  };
}

function findStoreDescriptor(proto: object | null): PropertyDescriptor | undefined {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, "store");
    if (d) return d;
  }
  return undefined;
}

describe("store Proxy", () => {
  let tempDir: string;

  function testOptions(cwd: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { defaults: { _schemaVersion: 0 } as Record<string, unknown>, cwd } as any;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-proxy-"));
    _resetStoreInstance();
  });

  afterEach(() => {
    _resetStoreInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("supports `key in store` via the has trap", () => {
    initializeStore(testOptions(tempDir));
    expect("get" in store).toBe(true);
    expect("set" in store).toBe(true);
    expect("definitelyMissingMethod" in store).toBe(false);
  });

  it("binds methods so callers can detach them without losing `this`", () => {
    initializeStore(testOptions(tempDir));
    const get = store.get;
    expect(() => get("_schemaVersion" as never)).not.toThrow();
    expect(get("_schemaVersion" as never)).toBe(0);
  });

  it("lazy-initializes on first proxy access when init was skipped", () => {
    expect(_peekStoreInstance()).toBeUndefined();
    void store.get;
    expect(_peekStoreInstance()).toBeDefined();
  });

  describe("value cache", () => {
    it("serves repeat reads from the in-memory snapshot, not the file", () => {
      initializeStore(testOptions(tempDir));
      expect(store.get("_schemaVersion" as never)).toBe(0);
      // Rewrite the file behind electron-store's back; a cached read must
      // not see it (proving no per-get disk read happens).
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 42 }), "utf8");
      expect(store.get("_schemaVersion" as never)).toBe(0);
    });

    it("writes set() through to the snapshot instead of re-reading the file", () => {
      initializeStore(testOptions(tempDir));
      expect(store.get("_schemaVersion" as never)).toBe(0);
      const configPath = path.join(tempDir, "config.json");
      const readSpy = vi.spyOn(fs, "readFileSync");
      store.set("other" as never, 2 as never);
      expect(store.get("other" as never)).toBe(2);
      expect(store.get("_schemaVersion" as never)).toBe(0);
      const configReads = readSpy.mock.calls.filter(([p]) => p === configPath).length;
      readSpy.mockRestore();
      // Only conf's __internal__ preservation read inside the store setter.
      expect(configReads).toBeLessThanOrEqual(1);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        _schemaVersion: 0,
        other: 2,
      });
    });

    it("writes the same bytes conf's own set() would", () => {
      const confDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-proxy-conf-"));
      try {
        initializeStore(testOptions(tempDir));
        const direct = initializeStoreForComparison(confDir);
        const ops: [string, unknown][] = [
          ["appState", { sidebarWidth: 300, terminals: [{ id: "a" }], at: new Date(0) }],
          ["nested.inner.value", 7],
          ["nested.inner.other", { deep: [1, 2] }],
          ["prim", 1],
          ["prim.child", "replaces a primitive"],
          ["list", [1, 2]],
          ["list.0", "numeric segment falls back to conf"],
          ["list.named", "array intermediate falls back to conf"],
          ["nullable", null],
          ["nullable.child", "replaces a null"],
          ["dropped", { toJSON: () => undefined }],
          ["kept", { inner: { toJSON: () => undefined }, n: Number.NaN }],
          ["keyed", { toJSON: (key: string) => `serialized under ${key}` }],
          ["protoHolder", JSON.parse('{"__proto__":{"x":1},"y":2}')],
          ["protoHolder.b", "copying keeps an own __proto__ key"],
          ["nested.inner.value", 8],
        ];
        for (const [key, value] of ops) {
          store.set(key as never, value as never);
          direct.set(key, value);
          expect(store.get(key as never)).toEqual(direct.get(key));
          expect(fs.readFileSync(path.join(tempDir, "config.json"), "utf8")).toBe(
            fs.readFileSync(path.join(confDir, "config.json"), "utf8")
          );
        }
        invalidateStoreValueCache();
        for (const key of ["appState", "nested", "prim", "list", "nullable", "kept", "keyed"]) {
          expect(store.get(key as never)).toEqual(direct.get(key));
        }
      } finally {
        fs.rmSync(confDir, { recursive: true, force: true });
      }
    });

    it("caches a JSON copy so the caller's object cannot alias the snapshot", () => {
      initializeStore(testOptions(tempDir));
      const value = { list: [1], when: new Date(0) };
      store.set("obj" as never, value as never);
      value.list.push(2);
      expect(store.get("obj" as never)).toEqual({ list: [1], when: new Date(0).toISOString() });
    });

    it("keeps a nested write made by a change listener", () => {
      initializeStore(testOptions(tempDir));
      const instance = _peekStoreInstance() as unknown as {
        onDidChange(key: string, cb: () => void): () => void;
      };
      let fired = false;
      const off = instance.onDidChange("a", () => {
        if (fired) return;
        fired = true;
        store.set("b" as never, 2 as never);
      });
      store.set("a" as never, 1 as never);
      off();
      expect(store.get("b" as never)).toBe(2);
      store.set("c" as never, 3 as never);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf8"));
      expect(onDisk).toMatchObject({ a: 1, b: 2, c: 3 });
    });

    it("invalidates on appendToArray() so a later set() cannot drop the append", () => {
      initializeStore(testOptions(tempDir));
      store.set("list" as never, [] as never);
      store.appendToArray("list" as never, 1 as never);
      expect(store.get("list" as never)).toEqual([1]);
      store.set("other" as never, 2 as never);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf8"));
      expect(onDisk.list).toEqual([1]);
    });

    it("drops the snapshot when the write fails, so the next read reflects disk", () => {
      initializeStore(testOptions(tempDir));
      store.set("k" as never, 1 as never);
      const instance = _peekStoreInstance() as unknown as Record<string, unknown>;
      const proto = Object.getPrototypeOf(instance) as object;
      const descriptor = findStoreDescriptor(proto)!;
      Object.defineProperty(instance, "store", {
        configurable: true,
        get: descriptor.get,
        set() {
          throw new Error("disk full");
        },
      });
      try {
        expect(() => store.set("k" as never, 2 as never)).toThrow("disk full");
      } finally {
        delete instance.store;
      }
      expect(store.get("k" as never)).toBe(1);
    });

    it("rejects values conf rejects, without touching the snapshot", () => {
      initializeStore(testOptions(tempDir));
      store.set("k" as never, 1 as never);
      expect(() => store.set("k" as never, undefined as never)).toThrow(TypeError);
      expect(() => store.set("__internal__" as never, 1 as never)).toThrow(TypeError);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => store.set("k" as never, cyclic as never)).toThrow(TypeError);
      expect(store.get("k" as never)).toBe(1);
    });

    it("invalidates on delete()", () => {
      initializeStore(testOptions(tempDir));
      store.set("flag" as never, true as never);
      expect(store.get("flag" as never)).toBe(true);
      store.delete("flag" as never);
      expect(store.get("flag" as never)).toBeUndefined();
    });

    it("invalidateStoreValueCache() forces a re-read after an external file swap", () => {
      initializeStore(testOptions(tempDir));
      expect(store.get("_schemaVersion" as never)).toBe(0);
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 9 }), "utf8");
      invalidateStoreValueCache();
      expect(store.get("_schemaVersion" as never)).toBe(9);
    });

    it("resolves dot-notation paths against the snapshot", () => {
      initializeStore(testOptions(tempDir));
      store.set("nested" as never, { inner: { value: 7 } } as never);
      expect(store.get("nested.inner.value" as never)).toBe(7);
      expect(store.get("nested.missing.value" as never)).toBeUndefined();
      expect(store.get("nested.missing" as never, "fallback" as never)).toBe("fallback");
    });

    it("returns isolated clones — mutating a read result cannot poison later reads", () => {
      initializeStore(testOptions(tempDir));
      store.set("obj" as never, { list: [1] } as never);
      const first = store.get("obj" as never) as { list: number[] };
      first.list.push(2);
      const second = store.get("obj" as never) as { list: number[] };
      expect(second.list).toEqual([1]);
    });

    it("bypasses the cache for the in-memory fallback store", () => {
      initializeStore(testOptions("/nonexistent/\0/path"));
      expect(_peekStoreInstance()?.path).toBe("");
      store.set("k" as never, "v" as never);
      expect(store.get("k" as never)).toBe("v");
    });
  });
});
