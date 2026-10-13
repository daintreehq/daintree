import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const testDir = mkdtempSync(path.join(tmpdir(), "gemini-config-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  return { ...actual, homedir: () => testDir };
});

// Dynamic import so the mock applies before the module loads.
const { GeminiConfigService } = await import("../services/gemini/GeminiConfigService.js");

function createService() {
  return new GeminiConfigService();
}

function configPath(): string {
  return path.join(testDir, ".gemini", "settings.json");
}

async function writeConfigFile(content: string): Promise<void> {
  const dir = path.dirname(configPath());
  await mkdir(dir, { recursive: true });
  await writeFile(configPath(), content, "utf8");
}

async function readConfigFile(): Promise<string> {
  return readFile(configPath(), "utf8");
}

describe("GeminiConfigService", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("readConfig", () => {
    it("returns null when no config file exists", async () => {
      const service = createService();
      const config = await service.readConfig();
      expect(config).toBeNull();
    });

    it("returns parsed config when file exists", async () => {
      await writeConfigFile(JSON.stringify({ ui: { useAlternateBuffer: true } }));
      const service = createService();
      const config = await service.readConfig();
      expect(config).toEqual({ ui: { useAlternateBuffer: true } });
    });

    it("throws SyntaxError for malformed JSON", async () => {
      await writeConfigFile("{invalid}");
      const service = createService();
      await expect(service.readConfig()).rejects.toBeInstanceOf(SyntaxError);
    });
  });

  describe("getStatus", () => {
    it("reports exists:false when no file", async () => {
      const service = createService();
      const status = await service.getStatus();
      expect(status).toEqual({ exists: false, alternateBufferEnabled: false });
    });

    it("reports exists:true with alternateBufferEnabled:true", async () => {
      await writeConfigFile(JSON.stringify({ ui: { useAlternateBuffer: true } }));
      const service = createService();
      const status = await service.getStatus();
      expect(status).toEqual({ exists: true, alternateBufferEnabled: true });
    });

    it("reports exists:true with alternateBufferEnabled:false when not set", async () => {
      await writeConfigFile("{}");
      const service = createService();
      const status = await service.getStatus();
      expect(status).toEqual({ exists: true, alternateBufferEnabled: false });
    });

    it("reports error for malformed JSON", async () => {
      await writeConfigFile("{broken}");
      const service = createService();
      const status = await service.getStatus();
      expect(status.exists).toBe(true);
      expect(status.alternateBufferEnabled).toBe(false);
      expect(typeof status.error).toBe("string");
      expect(status.error!.length).toBeGreaterThan(0);
    });
  });

  describe("enableAlternateBuffer", () => {
    it("creates file when none exists", async () => {
      const service = createService();
      await service.enableAlternateBuffer();
      const raw = await readConfigFile();
      const parsed = JSON.parse(raw);
      expect(parsed.ui?.useAlternateBuffer).toBe(true);
    });

    it("sets useAlternateBuffer:true on existing config", async () => {
      await writeConfigFile(JSON.stringify({ ui: { incrementalRendering: true } }));
      const service = createService();
      await service.enableAlternateBuffer();
      const raw = await readConfigFile();
      const parsed = JSON.parse(raw);
      expect(parsed.ui?.useAlternateBuffer).toBe(true);
      expect(parsed.ui?.incrementalRendering).toBe(true);
    });

    it("self-heals malformed JSON by overwriting", async () => {
      await writeConfigFile("garbage{not}json");
      const service = createService();
      await service.enableAlternateBuffer();
      const raw = await readConfigFile();
      const parsed = JSON.parse(raw);
      expect(parsed.ui?.useAlternateBuffer).toBe(true);
    });

    it("preserves unrelated keys", async () => {
      await writeConfigFile(JSON.stringify({ otherKey: "value" }));
      const service = createService();
      await service.enableAlternateBuffer();
      const raw = await readConfigFile();
      const parsed = JSON.parse(raw);
      expect(parsed.otherKey).toBe("value");
      expect(parsed.ui?.useAlternateBuffer).toBe(true);
    });
  });

  describe("isAlternateBufferEnabled", () => {
    it("returns false when no file", async () => {
      const service = createService();
      expect(await service.isAlternateBufferEnabled()).toBe(false);
    });

    it("returns true when enabled", async () => {
      await writeConfigFile(JSON.stringify({ ui: { useAlternateBuffer: true } }));
      const service = createService();
      expect(await service.isAlternateBufferEnabled()).toBe(true);
    });

    it("returns false when malformed", async () => {
      await writeConfigFile("{broken}");
      const service = createService();
      expect(await service.isAlternateBufferEnabled()).toBe(false);
    });
  });
});
