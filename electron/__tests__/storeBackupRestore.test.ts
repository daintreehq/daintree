import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

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
  consumePendingSettingsRecovery,
  _resetPendingSettingsRecovery,
  _resetStoreInstance,
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
    it("returns path when cwd is provided", () => {
      expect(resolveConfigPath("/some/path")).toBe(path.join("/some/path", "config.json"));
    });

    it("returns null when cwd is undefined", () => {
      expect(resolveConfigPath(undefined)).toBeNull();
    });
  });

  describe("preflightValidateConfig", () => {
    it("returns 'missing' when file does not exist", () => {
      expect(preflightValidateConfig(configPath)).toBe("missing");
    });

    it("returns 'valid' for valid JSON", () => {
      fs.writeFileSync(configPath, JSON.stringify({ foo: "bar" }), "utf8");
      expect(preflightValidateConfig(configPath)).toBe("valid");
    });

    it("returns 'corrupt' for invalid JSON", () => {
      fs.writeFileSync(configPath, "{invalid json", "utf8");
      expect(preflightValidateConfig(configPath)).toBe("corrupt");
    });

    it("returns 'corrupt' for empty file", () => {
      fs.writeFileSync(configPath, "", "utf8");
      expect(preflightValidateConfig(configPath)).toBe("corrupt");
    });

    it("returns 'corrupt' for partial JSON", () => {
      fs.writeFileSync(configPath, "{", "utf8");
      expect(preflightValidateConfig(configPath)).toBe("corrupt");
    });

    it("returns 'corrupt' for non-object JSON values", () => {
      fs.writeFileSync(configPath, '"a string"', "utf8");
      expect(preflightValidateConfig(configPath)).toBe("corrupt");
      fs.writeFileSync(configPath, "42", "utf8");
      expect(preflightValidateConfig(configPath)).toBe("corrupt");
      fs.writeFileSync(configPath, "[]", "utf8");
      expect(preflightValidateConfig(configPath)).toBe("corrupt");
      fs.writeFileSync(configPath, "null", "utf8");
      expect(preflightValidateConfig(configPath)).toBe("corrupt");
    });

    it("returns 'valid' on non-SyntaxError read failures", () => {
      const dirPath = path.join(tempDir, "not-a-file");
      fs.mkdirSync(dirPath);
      expect(preflightValidateConfig(dirPath)).toBe("valid");
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
    expect(fs.existsSync(`${configPath}.bak`)).toBe(true);
  });

  it("loads valid config and creates backup", () => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: 5 }), "utf8");
    const instance = initializeStore(testOptions(tempDir));
    expect(instance.get("_schemaVersion")).toBe(5);
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

  it("uses in-memory fallback on non-SyntaxError failures", () => {
    // Use null byte in path — invalid on all platforms
    const instance = initializeStore(testOptions("/nonexistent/\0/path"));
    expect(instance).toBeDefined();
    expect(instance.path).toBe("");
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
    // Backup must remain untouched — recovery is still possible
    expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(lastGood);
    // …and recovery state should reflect the silent reset
    expect(consumePendingSettingsRecovery()).toEqual({ kind: "reset-to-defaults" });
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

    it("returns reset-to-defaults when store silently clears schema-invalid config", () => {
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify({ _schemaVersion: "bad" }), "utf8");
      fs.writeFileSync(`${configPath}.bak`, JSON.stringify({ _schemaVersion: 7 }), "utf8");
      const opts = testOptions(tempDir);
      opts.schema = { _schemaVersion: { type: "number" } };
      initializeStore(opts);
      const recovery = consumePendingSettingsRecovery();
      expect(recovery).toEqual({ kind: "reset-to-defaults" });
      expect(consumePendingSettingsRecovery()).toBeNull();
    });

    it("consume-once: second call returns null", () => {
      const configPath = path.join(tempDir, "config.json");
      fs.writeFileSync(configPath, "{corrupt!", "utf8");
      initializeStore(testOptions(tempDir));
      expect(consumePendingSettingsRecovery()).not.toBeNull();
      expect(consumePendingSettingsRecovery()).toBeNull();
    });
  });
});
