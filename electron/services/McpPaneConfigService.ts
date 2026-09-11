import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { app } from "electron";
import { resilientAtomicWriteFile, resilientUnlink } from "../utils/fs.js";
import type { DaintreeMcpTier } from "../../shared/types/project.js";
import type { ActionContext } from "../../shared/types/actions.js";
import { pluginManifestIdFromInstanceKey } from "../../shared/types/plugin.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  pluginMcpGrantRegistry,
  type PluginMcpGrantRegistry,
} from "./pluginAgentMcp/grantRegistry.js";
import { pluginMcpRoutePath } from "./pluginAgentMcp/types.js";

const PANE_CONFIG_DIR_NAME = "mcp-pane-configs";
const MCP_SERVER_KEY = "daintree";
const PLUGIN_SERVER_KEY_PREFIX = "daintree-plugin-";
// Claude names a server's tools `mcp__<server>__<tool>`, and that whole name
// has to stay short enough for the model's tool-name limit, so a long manifest
// id is truncated and disambiguated by hash rather than carried whole.
const MAX_PLUGIN_SERVER_KEY_LENGTH = 48;
const SERVER_KEY_HASH_LENGTH = 8;

interface PaneRecord {
  configPath: string;
  /** Null when the tier is "off" and the file carries plugin entries only. */
  token: string | null;
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

export interface PanePluginEndpoint {
  readonly pluginInstanceId: string;
  readonly endpointId: string;
}

export interface PreparePanePluginEndpoints {
  projectId: string;
  endpoints: readonly PanePluginEndpoint[];
  launchAgentIdHint?: string;
}

export interface PreparePaneConfigParams {
  paneId: string;
  port: number;
  /** "off" writes no Daintree entry and registers no pane token; only valid alongside plugin endpoints. */
  tier: DaintreeMcpTier;
  /** Plugin endpoints the user enabled for this project, each given its own grant and server entry. */
  plugin?: PreparePanePluginEndpoints;
}

export interface PreparedPaneConfig {
  configPath: string;
  /** The Daintree orchestration bearer, or null when no Daintree entry was written. */
  token: string | null;
  /** Server keys of the plugin entries written, one per grant minted. */
  pluginServerKeys: string[];
}

/** What a call without plugin endpoints gets back: always a file with the Daintree entry. */
export interface PreparedDaintreePaneConfig extends PreparedPaneConfig {
  token: string;
}

interface PluginServerEntry {
  type: "http";
  url: string;
  headers: { Authorization: string };
}

function sanitiseServerKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, SERVER_KEY_HASH_LENGTH);
}

function withHashSuffix(base: string, hash: string): string {
  const room = MAX_PLUGIN_SERVER_KEY_LENGTH - hash.length - 1;
  return `${base.slice(0, room)}-${hash}`;
}

/**
 * One server key per endpoint, restricted to `[A-Za-z0-9_-]`, never `daintree`,
 * and collision-free across the list. Keyed by manifest id rather than instance
 * key because a project plugin's instance key embeds a 64-hex project id; when
 * two endpoints still land on the same key (an installed and a project copy of
 * one plugin, or ids that differ only in characters the sanitiser folds), every
 * member of that group gets a hash of its full instance and endpoint id, so a
 * key does not depend on which of them happened to be listed first.
 */
export function pluginServerKeysFor(endpoints: readonly PanePluginEndpoint[]): string[] {
  const identities = endpoints.map((e) => `${e.pluginInstanceId}\0${e.endpointId}`);
  const bases = endpoints.map((e, i) => {
    const base = `${PLUGIN_SERVER_KEY_PREFIX}${sanitiseServerKeyPart(
      pluginManifestIdFromInstanceKey(e.pluginInstanceId)
    )}-${sanitiseServerKeyPart(e.endpointId)}`;
    return base.length > MAX_PLUGIN_SERVER_KEY_LENGTH
      ? withHashSuffix(base, shortHash(identities[i]))
      : base;
  });
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  // Any clash left (a hashed key landing on another endpoint's plain key) is
  // settled in identity order, so the set of endpoints decides every key and
  // the order they were listed in never does.
  const order = endpoints
    .map((_, i) => i)
    .sort((a, b) => (identities[a] < identities[b] ? -1 : identities[a] > identities[b] ? 1 : 0));
  const keys = new Array<string>(endpoints.length);
  const used = new Set<string>();
  for (const i of order) {
    const base = bases[i];
    let key = (counts.get(base) ?? 0) > 1 ? withHashSuffix(base, shortHash(identities[i])) : base;
    for (let n = 2; used.has(key); n++) {
      key = withHashSuffix(base, shortHash(`${identities[i]}\0${n}`));
    }
    used.add(key);
    keys[i] = key;
  }
  return keys;
}

export class McpPaneConfigService {
  private records = new Map<string, PaneRecord>();
  private tokens = new Map<string, TokenRecord>();
  // Every pane this service has minted plugin grants for and not yet revoked,
  // including one whose file write failed, so `revokeAll` reaches them all.
  private grantedPanes = new Set<string>();
  // The live preparation attempt per pane. Revocation deletes the entry and a
  // newer preparation replaces it, so an attempt that finds itself no longer
  // current knows its grants may be gone or no longer its own, and must neither
  // publish a record nor roll back what now belongs to its successor.
  private attempts = new Map<string, number>();
  private nextAttempt = 0;

  constructor(private readonly pluginGrants: PluginMcpGrantRegistry = pluginMcpGrantRegistry) {}

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

  /**
   * Write the pane's managed `--mcp-config` file. One file carries the Daintree
   * orchestration entry (unless the tier is "off") and one Streamable HTTP entry
   * per enabled plugin endpoint, each with its own freshly minted grant.
   *
   * Returns null when the tier is "off" and no plugin grant could be minted:
   * there is nothing to hand the agent, so no file is written. Any grant minted
   * here is revoked again before a failure propagates.
   */
  preparePaneConfig(
    params: PreparePaneConfigParams & { plugin?: undefined }
  ): Promise<PreparedDaintreePaneConfig>;
  preparePaneConfig(params: PreparePaneConfigParams): Promise<PreparedPaneConfig | null>;
  async preparePaneConfig({
    paneId,
    port,
    tier,
    plugin,
  }: PreparePaneConfigParams): Promise<PreparedPaneConfig | null> {
    if (!paneId) {
      throw new Error("paneId is required");
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid MCP port: ${port}`);
    }
    const pluginEndpoints = plugin?.endpoints ?? [];
    if (tier === "off" && pluginEndpoints.length === 0) {
      throw new Error(
        'preparePaneConfig should not be called with tier "off" and no plugin endpoints'
      );
    }
    // Validate paneId early — configPathFor throws on traversal attempts.
    const configPath = this.configPathFor(paneId);

    // Also revokes every plugin grant a previous launch of this pane id held,
    // so a restart never leaves the old launch's credentials live.
    await this.revokePaneConfig(paneId);
    const attempt = ++this.nextAttempt;
    this.attempts.set(paneId, attempt);
    const isCurrent = () => this.attempts.get(paneId) === attempt;
    const hasSuccessor = () => this.attempts.has(paneId) && !isCurrent();

    await fs.mkdir(this.baseDir, { recursive: true });
    if (process.platform !== "win32") {
      await fs.chmod(this.baseDir, 0o700).catch((err) => {
        console.error("[MCP] Failed to chmod pane config directory:", err);
      });
    }

    // A revocation with no successor is the previous launch's exit landing
    // late. Before anything is minted it costs nothing, so re-claim the pane
    // and carry on, as this path always has.
    if (hasSuccessor()) {
      throw new Error(`Pane config for ${paneId} was superseded while preparing`);
    }
    this.attempts.set(paneId, attempt);

    const token = tier === "off" ? null : randomUUID();
    const pluginServers = plugin ? this.mintPluginServers(paneId, port, plugin) : {};
    const pluginServerKeys = Object.keys(pluginServers);

    if (token === null && pluginServerKeys.length === 0) {
      this.attempts.delete(paneId);
      return null;
    }

    // Bake the token literal into the file rather than using ${VAR} substitution.
    // Claude Code's `${VAR}` substitution in `headers` is still broken as of
    // v2.1.83 through v2.1.133 (tested May 2026): placeholders aren't forwarded
    // to the wire (anthropics/claude-code#6204). `claude mcp add`/`remove` also
    // rewrite `${VAR}` to its literal env value (#18692, #57131), which would
    // leak the session bearer to disk — the literal-token path sidesteps that
    // leak class. (#28293 separately drops headers on SSE POSTs regardless of
    // value; neither path fixes it.) Same reason as HelpSessionService.ts.
    // Plugin grants follow the same rule, and this 0600 file is the only place
    // one is ever written.
    const payload = {
      mcpServers: {
        ...(token !== null
          ? {
              [MCP_SERVER_KEY]: {
                type: "sse",
                url: `http://127.0.0.1:${port}/sse`,
                headers: { Authorization: `Bearer ${token}` },
              },
            }
          : {}),
        ...pluginServers,
      },
    };

    try {
      await resilientAtomicWriteFile(configPath, JSON.stringify(payload, null, 2) + "\n", "utf-8", {
        mode: 0o600,
      });
    } catch (err) {
      if (isCurrent()) {
        this.attempts.delete(paneId);
        this.revokePluginGrants(paneId);
      }
      throw err;
    }

    if (hasSuccessor()) {
      // The successor owns the path and whatever grants the pane now holds.
      throw new Error(`Pane config for ${paneId} was superseded while preparing`);
    }
    if (!isCurrent()) {
      // Revoked mid-write. The Daintree token was never registered, so a
      // Daintree-only config is still good and goes ahead as it always has;
      // plugin grants were live and are gone now, so that file would hand the
      // agent dead bearers.
      if (pluginServerKeys.length > 0) {
        await resilientUnlink(configPath).catch(() => {
          // best-effort cleanup
        });
        throw new Error(`Pane config for ${paneId} was revoked while preparing`);
      }
      this.attempts.set(paneId, attempt);
    }

    this.records.set(paneId, { configPath, token, tier });
    if (token !== null) {
      this.tokens.set(token, { paneId, tier });
    }

    return { configPath, token, pluginServerKeys };
  }

  /**
   * Mint one grant per endpoint and build its server entry. An endpoint the
   * registry refuses (a project plugin bound to another project, a non-project
   * workspace) is skipped rather than failing the launch.
   */
  private mintPluginServers(
    paneId: string,
    port: number,
    { projectId, endpoints, launchAgentIdHint }: PreparePanePluginEndpoints
  ): Record<string, PluginServerEntry> {
    const seen = new Set<string>();
    const minted: Array<{ endpoint: PanePluginEndpoint; token: string }> = [];
    for (const endpoint of endpoints) {
      const identity = `${endpoint.pluginInstanceId}\0${endpoint.endpointId}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try {
        const { token } = this.pluginGrants.issue({
          pluginInstanceId: endpoint.pluginInstanceId,
          endpointId: endpoint.endpointId,
          projectId,
          terminalId: paneId,
          ...(launchAgentIdHint !== undefined ? { launchAgentIdHint } : {}),
        });
        this.grantedPanes.add(paneId);
        minted.push({ endpoint, token });
      } catch (err) {
        console.warn(
          `[MCP] Skipping plugin MCP endpoint ${endpoint.pluginInstanceId}/${endpoint.endpointId}:`,
          formatErrorMessage(err, "grant refused")
        );
      }
    }

    const keys = pluginServerKeysFor(minted.map((m) => m.endpoint));
    const servers: Record<string, PluginServerEntry> = {};
    minted.forEach(({ endpoint, token }, i) => {
      servers[keys[i]] = {
        // Streamable HTTP: the plugin route does not serve SSE.
        type: "http",
        url: `http://127.0.0.1:${port}${pluginMcpRoutePath(endpoint.pluginInstanceId, endpoint.endpointId)}`,
        headers: { Authorization: `Bearer ${token}` },
      };
    });
    return servers;
  }

  private revokePluginGrants(paneId: string): void {
    this.grantedPanes.delete(paneId);
    this.pluginGrants.revokeTerminal(paneId);
  }

  async revokePaneConfig(paneId: string): Promise<void> {
    // Unconditional, and first: grants are keyed by terminal id in their own
    // registry, so they go even when this pane has no record here (a write that
    // failed, a record already torn down), and before any await so no request
    // can authenticate with them once revocation has started.
    this.attempts.delete(paneId);
    this.revokePluginGrants(paneId);

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
    if (record.token !== null) {
      this.tokens.delete(record.token);
    }

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
    const ids = new Set([...this.records.keys(), ...this.grantedPanes]);
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
