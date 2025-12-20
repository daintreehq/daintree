import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface GeminiConfig {
  ui?: {
    useAlternateBuffer?: boolean;
    incrementalRendering?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GeminiConfigStatus {
  exists: boolean;
  alternateBufferEnabled: boolean;
  error?: string;
}

const GEMINI_CONFIG_DIR = ".gemini";
const GEMINI_SETTINGS_FILE = "settings.json";

export class GeminiConfigService {
  private configPath: string;
  private configDir: string;

  constructor() {
    this.configDir = path.join(homedir(), GEMINI_CONFIG_DIR);
    this.configPath = path.join(this.configDir, GEMINI_SETTINGS_FILE);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async readConfig(): Promise<GeminiConfig | null> {
    try {
      if (!existsSync(this.configPath)) {
        return null;
      }
      const content = await readFile(this.configPath, "utf8");
      return JSON.parse(content) as GeminiConfig;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read Gemini config: ${message}`);
    }
  }

  async getStatus(): Promise<GeminiConfigStatus> {
    if (!existsSync(this.configPath)) {
      return { exists: false, alternateBufferEnabled: false };
    }

    try {
      const config = await this.readConfig();
      if (!config) {
        return { exists: true, alternateBufferEnabled: false };
      }
      return {
        exists: true,
        alternateBufferEnabled: config.ui?.useAlternateBuffer === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { exists: true, alternateBufferEnabled: false, error: message };
    }
  }

  async isAlternateBufferEnabled(): Promise<boolean> {
    try {
      const config = await this.readConfig();
      return config?.ui?.useAlternateBuffer === true;
    } catch {
      return false;
    }
  }

  async enableAlternateBuffer(): Promise<void> {
    let existingConfig: GeminiConfig = {};

    try {
      const config = await this.readConfig();
      if (config) {
        existingConfig = config;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        // File doesn't exist - will create new
      } else if (error instanceof SyntaxError) {
        // JSON parse error - will repair by creating new config
      } else {
        // Other errors (permissions, I/O) should surface
        throw error;
      }
    }

    const updatedConfig: GeminiConfig = {
      ...existingConfig,
      ui: {
        ...existingConfig.ui,
        useAlternateBuffer: true,
      },
    };

    await this.writeConfig(updatedConfig);
  }

  private async writeConfig(config: GeminiConfig): Promise<void> {
    try {
      await mkdir(this.configDir, { recursive: true });
      const content = JSON.stringify(config, null, 2);
      await writeFile(this.configPath, content, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write Gemini config: ${message}`);
    }
  }
}

let instance: GeminiConfigService | null = null;

export function getGeminiConfigService(): GeminiConfigService {
  if (!instance) {
    instance = new GeminiConfigService();
  }
  return instance;
}
