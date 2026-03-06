import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

const CANOPY_PROJECT_JSON = ".canopy/project.json";
const CANOPY_SETTINGS_JSON = ".canopy/settings.json";

async function writeInRepoProjectIdentity(
  projectPath: string,
  data: { name?: string; emoji?: string; color?: string }
): Promise<void> {
  const canopyDir = path.join(projectPath, ".canopy");
  const filePath = path.join(projectPath, CANOPY_PROJECT_JSON);

  const payload: { version: 1; name?: string; emoji?: string; color?: string } = { version: 1 };
  if (data.name !== undefined) payload.name = data.name;
  if (data.emoji !== undefined) payload.emoji = data.emoji;
  if (data.color !== undefined) payload.color = data.color;

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

  const attemptWrite = async (ensureDir: boolean): Promise<void> => {
    if (ensureDir) {
      await fs.mkdir(canopyDir, { recursive: true });
    }
    await fs.writeFile(tempFilePath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.rename(tempFilePath, filePath);
  };

  try {
    await attemptWrite(false);
  } catch (error) {
    const isEnoent =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!isEnoent) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        /* ignore */
      }
      throw error;
    }
    try {
      await attemptWrite(true);
    } catch (retryError) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        /* ignore */
      }
      throw retryError;
    }
  }
}

interface ProjectSettings {
  runCommands: Array<{ id: string; name: string; command: string }>;
  devServerCommand?: string;
  copyTreeSettings?: { maxFileSize?: number };
  excludedPaths?: string[];
  environmentVariables?: Record<string, string>;
  secureEnvironmentVariables?: string[];
  devServerDismissed?: boolean;
  devServerAutoDetected?: boolean;
  projectIconSvg?: string;
  insecureEnvironmentVariables?: string[];
  unresolvedSecureEnvironmentVariables?: string[];
}

async function writeInRepoSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
  const canopyDir = path.join(projectPath, ".canopy");
  const filePath = path.join(projectPath, CANOPY_SETTINGS_JSON);

  const payload: {
    version: 1;
    runCommands?: unknown[];
    devServerCommand?: string;
    copyTreeSettings?: unknown;
    excludedPaths?: string[];
  } = { version: 1 };

  if (settings.runCommands?.length) payload.runCommands = settings.runCommands;
  if (settings.devServerCommand) payload.devServerCommand = settings.devServerCommand;
  if (settings.copyTreeSettings) payload.copyTreeSettings = settings.copyTreeSettings;
  if (settings.excludedPaths?.length) payload.excludedPaths = settings.excludedPaths;

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

  const attemptWrite = async (ensureDir: boolean): Promise<void> => {
    if (ensureDir) {
      await fs.mkdir(canopyDir, { recursive: true });
    }
    await fs.writeFile(tempFilePath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.rename(tempFilePath, filePath);
  };

  try {
    await attemptWrite(false);
  } catch (error) {
    const isEnoent =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!isEnoent) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        /* ignore */
      }
      throw error;
    }
    try {
      await attemptWrite(true);
    } catch (retryError) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        /* ignore */
      }
      throw retryError;
    }
  }
}

describe("writeInRepoProjectIdentity", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-write-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .canopy/ directory and project.json when absent", async () => {
    await writeInRepoProjectIdentity(tmpDir, { name: "My App", emoji: "🚀", color: "blue" });

    const filePath = path.join(tmpDir, CANOPY_PROJECT_JSON);
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content).toEqual({ version: 1, name: "My App", emoji: "🚀", color: "blue" });
  });

  it("writes version: 1 in all cases", async () => {
    await writeInRepoProjectIdentity(tmpDir, {});
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8"));
    expect(content.version).toBe(1);
  });

  it("omits undefined fields from output", async () => {
    await writeInRepoProjectIdentity(tmpDir, { name: "Only Name" });
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8"));
    expect(content).toEqual({ version: 1, name: "Only Name" });
    expect(content).not.toHaveProperty("emoji");
    expect(content).not.toHaveProperty("color");
  });

  it("overwrites existing file with new values", async () => {
    await writeInRepoProjectIdentity(tmpDir, { name: "Old Name", emoji: "🌲" });
    await writeInRepoProjectIdentity(tmpDir, { name: "New Name", emoji: "🚀" });
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8"));
    expect(content.name).toBe("New Name");
    expect(content.emoji).toBe("🚀");
  });

  it("is atomic: no .tmp files left after write", async () => {
    await writeInRepoProjectIdentity(tmpDir, { name: "Test" });
    const canopyDir = path.join(tmpDir, ".canopy");
    const files = await fs.readdir(canopyDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("writes pretty-printed JSON (2-space indent)", async () => {
    await writeInRepoProjectIdentity(tmpDir, { name: "Formatted" });
    const raw = await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });

  it("works when .canopy/ already exists", async () => {
    await fs.mkdir(path.join(tmpDir, ".canopy"), { recursive: true });
    await writeInRepoProjectIdentity(tmpDir, { name: "Existing Dir" });
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8"));
    expect(content.name).toBe("Existing Dir");
  });
});

describe("writeInRepoSettings", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-settings-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .canopy/ directory and settings.json when absent", async () => {
    const settings: ProjectSettings = {
      runCommands: [{ id: "dev", name: "Dev Server", command: "npm run dev" }],
      devServerCommand: "npm run dev",
      excludedPaths: ["node_modules"],
    };
    await writeInRepoSettings(tmpDir, settings);

    const filePath = path.join(tmpDir, CANOPY_SETTINGS_JSON);
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.runCommands).toHaveLength(1);
    expect(content.devServerCommand).toBe("npm run dev");
    expect(content.excludedPaths).toEqual(["node_modules"]);
  });

  it("omits machine-local fields: devServerDismissed", async () => {
    const settings: ProjectSettings = {
      runCommands: [],
      devServerDismissed: true,
    };
    await writeInRepoSettings(tmpDir, settings);
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("devServerDismissed");
  });

  it("omits machine-local fields: devServerAutoDetected", async () => {
    const settings: ProjectSettings = {
      runCommands: [],
      devServerAutoDetected: true,
    };
    await writeInRepoSettings(tmpDir, settings);
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("devServerAutoDetected");
  });

  it("omits environment variables from output", async () => {
    const settings: ProjectSettings = {
      runCommands: [],
      environmentVariables: { API_KEY: "secret123" },
      secureEnvironmentVariables: ["DB_PASS"],
    };
    await writeInRepoSettings(tmpDir, settings);
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("environmentVariables");
    expect(content).not.toHaveProperty("secureEnvironmentVariables");
  });

  it("omits projectIconSvg from output", async () => {
    const settings: ProjectSettings = {
      runCommands: [],
      projectIconSvg: "<svg>...</svg>",
    } as ProjectSettings;
    await writeInRepoSettings(tmpDir, settings);
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("projectIconSvg");
  });

  it("includes copyTreeSettings when present", async () => {
    const settings: ProjectSettings = {
      runCommands: [],
      copyTreeSettings: { maxFileSize: 50000 },
    };
    await writeInRepoSettings(tmpDir, settings);
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content.copyTreeSettings).toEqual({ maxFileSize: 50000 });
  });

  it("is atomic: no .tmp files left after write", async () => {
    await writeInRepoSettings(tmpDir, { runCommands: [] });
    const canopyDir = path.join(tmpDir, ".canopy");
    const files = await fs.readdir(canopyDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("writes pretty-printed JSON (2-space indent)", async () => {
    await writeInRepoSettings(tmpDir, {
      runCommands: [{ id: "build", name: "Build", command: "npm run build" }],
    });
    const raw = await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });

  it("omits runCommands from output when empty", async () => {
    await writeInRepoSettings(tmpDir, { runCommands: [] });
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("runCommands");
  });
});
