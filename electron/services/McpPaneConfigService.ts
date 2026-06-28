import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { app } from "electron";
import { resilientAtomicWriteFile, resilientUnlink } from "../utils/fs.js";
import type { DaintreeMcpTier } from "../../shared/types/project.js";
import type { ActionContext } from "../../shared/types/actions.js";

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
  // Assistant-session pinning side-channel (#10647). Set only for
  // `daintree-assistant` pane tokens via `registerAssistantPaneBearer`; left
  // undefined for every generic pane agent so the resolvers below return null
  // and those sessions keep their existing focused-window fallback in
  // `httpLifecycle.buildSessionServerDeps`. Stored on the token record so that
  // `revokePaneConfig` (PTY exit / spawn failure) tears it down for free.
  webContentsId?: number;
  actionContext?: ActionContext;
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
    // Claude Code's `${VAR}` substitution in `headers` is still broken as of
    // v2.1.83 through v2.1.133 (tested May 2026): placeholders aren't forwarded
    // to the wire (anthropics/claude-code#6204). `claude mcp add`/`remove` also
    // rewrite `${VAR}` to its literal env value (#18692, #57131), which would
    // leak the session bearer to disk — the literal-token path sidesteps that
    // leak class. (#28293 separately drops headers on SSE POSTs regardless of
    // value; neither path fixes it.) Same reason as HelpSessionService.ts.
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

  /**
   * Promote an already-minted pane token to a pinned assistant-session bearer
   * (#10647). Binds the token to the launching renderer's WebContents and the
   * launch-time `ActionContext` snapshot so the MCP transport handshake routes
   * the session through `dispatchActionForWebContents` instead of the
   * active-window fallback. Must be called synchronously in the spawn handler,
   * after `preparePaneConfig`, before the IPC promise resolves — otherwise the
   * CLI's first `/mcp` POST can race ahead of the binding and pin to nothing.
   *
   * No-ops if the token was never minted or has already been revoked (the
   * record is gone), so a teardown that races the registration can't resurrect
   * a stale entry.
   */
  registerAssistantPaneBearer(
    token: string,
    webContentsId: number,
    actionContext?: ActionContext
  ): void {
    const record = this.tokens.get(token);
    if (!record) return;
    record.webContentsId = webContentsId;
    record.actionContext = actionContext;
  }

  /**
   * Resolver consulted at MCP handshake to pin an assistant-session bearer to
   * the WebContents that launched it. Returns null for generic pane tokens
   * (never registered as assistant bearers) so they keep focused-window
   * semantics. Mirrors `HelpSessionService.getWebContentsIdForToken`.
   */
  getWebContentsIdForToken(token: string): number | null {
    if (!token) return null;
    return this.tokens.get(token)?.webContentsId ?? null;
  }

  /**
   * Resolver consulted at MCP handshake to replay the launch-time
   * `ActionContext` for an assistant-session bearer. Returns null for generic
   * pane tokens so they keep the live focused-window context.
   */
  getActionContextForToken(token: string): ActionContext | null {
    if (!token) return null;
    return this.tokens.get(token)?.actionContext ?? null;
  }
}

export const mcpPaneConfigService = new McpPaneConfigService();
