import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { app } from "electron";
import { resilientAtomicWriteFile, resilientUnlink } from "../utils/fs.js";
import type { DaintreeMcpTier } from "../../shared/types/project.js";

const PANE_CONFIG_DIR_NAME = "mcp-pane-configs";
const MCP_SERVER_KEY = "daintree";

interface PaneRecord {
  configPath: string;
  token: string;
  tier: DaintreeMcpTier;
}

interface TokenRecord {
  paneId: string;
  tier: DaintreeMcpTier;
}

export interface PreparePaneConfigParams {
  paneId: string;
  port: number;
  tier: DaintreeMcpTier;
}

export interface PreparedPaneConfig {
  configPath: string;
  token: string;
}

export class McpPaneConfigService {
  private records = new Map<string, PaneRecord>();
  private tokens = new Map<string, TokenRecord>();

  private get baseDir(): string {
    return path.join(app.getPath("userData"), PANE_CONFIG_DIR_NAME);
  }

  private configPathFor(paneId: string): string {
    const baseDir = this.baseDir;
    const candidate = path.join(baseDir, `${paneId}.json`);
    // Defense in depth: paneIds are normally crypto.randomUUID(), but the
    // callers' schemas allow arbitrary strings. Require the resulting file to
    // be a direct child of the base dir — rejects `../escape`, `subdir/leak`,
    // and similar.
    if (path.dirname(candidate) !== baseDir) {
      throw new Error(`Invalid paneId: ${paneId}`);
    }
    return candidate;
  }

  async preparePaneConfig({
    paneId,
    port,
    tier,
  }: PreparePaneConfigParams): Promise<PreparedPaneConfig> {
    if (!paneId) {
      throw new Error("paneId is required");
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid MCP port: ${port}`);
    }
    if (tier === "off") {
      throw new Error('preparePaneConfig should not be called with tier "off"');
    }
    // Validate paneId early — configPathFor throws on traversal attempts.
    const configPath = this.configPathFor(paneId);

    await this.revokePaneConfig(paneId);

    await fs.mkdir(this.baseDir, { recursive: true });
    if (process.platform !== "win32") {
      await fs.chmod(this.baseDir, 0o700).catch((err) => {
        console.error("[MCP] Failed to chmod pane config directory:", err);
      });
    }

    const token = randomUUID();

    // Bake the token literal into the file rather than using ${VAR} substitution.
    // Claude Code's env substitution in `headers` has an active bug; literal value is reliable.
    const payload = {
      mcpServers: {
        [MCP_SERVER_KEY]: {
          type: "sse",
          url: `http://127.0.0.1:${port}/sse`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    };

    await resilientAtomicWriteFile(configPath, JSON.stringify(payload, null, 2) + "\n", "utf-8", {
      mode: 0o600,
    });

    this.records.set(paneId, { configPath, token, tier });
    this.tokens.set(token, { paneId, tier });

    return { configPath, token };
  }

  async revokePaneConfig(paneId: string): Promise<void> {
    const record = this.records.get(paneId);
    if (!record) {
      // Defensive: try to remove a stale file even if no record exists.
      try {
        await resilientUnlink(this.configPathFor(paneId));
      } catch {
        // best-effort cleanup
      }
      return;
    }

    this.records.delete(paneId);
    this.tokens.delete(record.token);

    try {
      await resilientUnlink(record.configPath);
    } catch (err) {
      const code =
        err != null && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "ENOENT") {
        console.error("[MCP] Failed to delete pane config:", err);
      }
    }
  }

  async revokeAll(): Promise<void> {
    const ids = Array.from(this.records.keys());
    for (const id of ids) {
      await this.revokePaneConfig(id);
    }
  }

  isValidPaneToken(token: string): boolean {
    if (!token) return false;
    return this.tokens.has(token);
  }

  getTierForToken(token: string): DaintreeMcpTier | undefined {
    if (!token) return undefined;
    return this.tokens.get(token)?.tier;
  }
}

export const mcpPaneConfigService = new McpPaneConfigService();
