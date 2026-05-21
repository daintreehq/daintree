import { dialog } from "electron";
import { writeFile } from "fs/promises";
import { CHANNELS } from "../channels.js";
import type * as McpServerServiceModule from "../../services/McpServerService.js";
import { defineIpcNamespace, op } from "../define.js";
import { MCP_SERVER_METHOD_CHANNELS } from "./mcpServer.preload.js";
import { broadcastToRenderer } from "../utils.js";
import { sanitizePath } from "../../utils/pathScrubber.js";
import { scrubSecrets } from "../../utils/secretScrubber.js";
import type {
  AssistantTurnRecord,
  McpActiveClientInfo,
  McpAuditRecord,
  McpAuditStats,
  McpIssueGrantResult,
  McpRevokeSessionGrantsResult,
  McpRuntimeSnapshot,
  McpServerStatusSnapshot,
} from "../../../shared/types/ipc/mcpServer.js";

type McpServerSingleton = typeof McpServerServiceModule.mcpServerService;

let cachedMcpServerService: McpServerSingleton | null = null;
async function getMcpServerService(): Promise<McpServerSingleton> {
  if (!cachedMcpServerService) {
    const mod = await import("../../services/McpServerService.js");
    cachedMcpServerService = mod.mcpServerService;
  }
  return cachedMcpServerService;
}

export const mcpServerNamespace = defineIpcNamespace({
  name: "mcpServer",
  ops: {
    getStatus: op(
      MCP_SERVER_METHOD_CHANNELS.getStatus,
      async (): Promise<McpServerStatusSnapshot> => {
        const svc = await getMcpServerService();
        return svc.getStatus();
      }
    ),
    setEnabled: op(
      MCP_SERVER_METHOD_CHANNELS.setEnabled,
      async (enabled: boolean): Promise<McpServerStatusSnapshot> => {
        if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
        const svc = await getMcpServerService();
        await svc.setEnabled(enabled);
        return svc.getStatus();
      }
    ),
    setPort: op(
      MCP_SERVER_METHOD_CHANNELS.setPort,
      async (port: number | null): Promise<McpServerStatusSnapshot> => {
        if (
          port !== null &&
          (typeof port !== "number" || port < 1024 || port > 65535 || !Number.isInteger(port))
        ) {
          throw new Error("port must be null or an integer between 1024 and 65535");
        }
        const svc = await getMcpServerService();
        await svc.setPort(port);
        return svc.getStatus();
      }
    ),
    rotateApiKey: op(MCP_SERVER_METHOD_CHANNELS.rotateApiKey, async (): Promise<string> => {
      const svc = await getMcpServerService();
      return await svc.rotateApiKey();
    }),
    getConfigSnippet: op(MCP_SERVER_METHOD_CHANNELS.getConfigSnippet, async (): Promise<string> => {
      const svc = await getMcpServerService();
      return svc.getConfigSnippet();
    }),
    listActiveClients: op(
      MCP_SERVER_METHOD_CHANNELS.listActiveClients,
      async (): Promise<McpActiveClientInfo[]> => {
        const svc = await getMcpServerService();
        return svc.listActiveClients();
      }
    ),
    getAuditRecords: op(
      MCP_SERVER_METHOD_CHANNELS.getAuditRecords,
      async (): Promise<McpAuditRecord[]> => {
        const svc = await getMcpServerService();
        return svc.getAuditRecords();
      }
    ),
    getAuditConfig: op(
      MCP_SERVER_METHOD_CHANNELS.getAuditConfig,
      async (): Promise<{ enabled: boolean; maxRecords: number }> => {
        const svc = await getMcpServerService();
        return svc.getAuditConfig();
      }
    ),
    getAuditStats: op(
      MCP_SERVER_METHOD_CHANNELS.getAuditStats,
      async (): Promise<McpAuditStats> => {
        const svc = await getMcpServerService();
        return svc.getAuditStats();
      }
    ),
    clearAuditLog: op(MCP_SERVER_METHOD_CHANNELS.clearAuditLog, async (): Promise<void> => {
      const svc = await getMcpServerService();
      svc.clearAuditLog();
    }),
    getTurnOutcomeRecords: op(
      MCP_SERVER_METHOD_CHANNELS.getTurnOutcomeRecords,
      async (): Promise<AssistantTurnRecord[]> => {
        const svc = await getMcpServerService();
        return svc.getTurnOutcomeRecords();
      }
    ),
    clearTurnOutcomeLog: op(
      MCP_SERVER_METHOD_CHANNELS.clearTurnOutcomeLog,
      async (): Promise<void> => {
        const svc = await getMcpServerService();
        svc.clearTurnOutcomeLog();
      }
    ),
    setAuditEnabled: op(
      MCP_SERVER_METHOD_CHANNELS.setAuditEnabled,
      async (enabled: boolean): Promise<{ enabled: boolean; maxRecords: number }> => {
        if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
        const svc = await getMcpServerService();
        return svc.setAuditEnabled(enabled);
      }
    ),
    setAuditMaxRecords: op(
      MCP_SERVER_METHOD_CHANNELS.setAuditMaxRecords,
      async (max: number): Promise<{ enabled: boolean; maxRecords: number }> => {
        if (typeof max !== "number" || !Number.isFinite(max) || !Number.isInteger(max)) {
          throw new Error("max must be a finite integer");
        }
        if (max < 50 || max > 10000) {
          throw new Error("max must be between 50 and 10000");
        }
        const svc = await getMcpServerService();
        return svc.setAuditMaxRecords(max);
      }
    ),
    // Runtime-state surface — distinct from `getStatus()` because the renderer
    // needs the derived 4-state snapshot (`disabled|starting|ready|failed`)
    // plus `lastError`, not just config + bound port.
    getRuntimeState: op(
      MCP_SERVER_METHOD_CHANNELS.getRuntimeState,
      async (): Promise<McpRuntimeSnapshot> => {
        const svc = await getMcpServerService();
        return svc.getRuntimeState();
      }
    ),
    exportAuditLog: op(
      MCP_SERVER_METHOD_CHANNELS.exportAuditLog,
      async (ctx, records: McpAuditRecord[]): Promise<boolean> => {
        if (!Array.isArray(records)) throw new Error("records must be an array");
        const ndjsonLines = records.map((rawRecord) => {
          const record = rawRecord as unknown as Record<string, unknown>;
          const cleaned: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(record)) {
            cleaned[key] = typeof value === "string" ? sanitizePath(value) : value;
          }
          return scrubSecrets(JSON.stringify(cleaned));
        });
        const ndjsonContent = ndjsonLines.join("\n") + "\n";
        const win = ctx.senderWindow ?? undefined;
        const now = Date.now();
        const defaultFilename = `mcp-audit-log-${new Date(now).toISOString().replace(/[:.]/g, "-")}.ndjson`;
        const dialogOptions: Electron.SaveDialogOptions = {
          title: "Export MCP Audit Log",
          defaultPath: defaultFilename,
          filters: [{ name: "NDJSON Files", extensions: ["ndjson"] }],
        };
        const { filePath, canceled } = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);
        if (canceled || !filePath) return false;
        await writeFile(filePath, ndjsonContent, "utf-8");
        return true;
      },
      { withContext: true }
    ),
    setSessionTier: op(
      MCP_SERVER_METHOD_CHANNELS.setSessionTier,
      async (
        ctx,
        payload: { sessionId: string; tier: "workbench" | "action" | "system" }
      ): Promise<{ sessionId: string; tier: "workbench" | "action" | "system" }> => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { sessionId, tier } = payload;
        if (typeof sessionId !== "string" || !sessionId) {
          throw new Error("Invalid sessionId");
        }
        if (tier !== "workbench" && tier !== "action" && tier !== "system") {
          throw new Error("Invalid tier");
        }
        const svc = await getMcpServerService();
        // Caller-pin check: only the renderer that minted the help-session
        // can elevate it. Without this, a different window/view could pass
        // a sessionId pinned to another WebContents and succeed.
        const result = svc.setSessionTier(sessionId, tier, ctx.webContentsId);
        return {
          sessionId: result.sessionId,
          tier: result.tier as "workbench" | "action" | "system",
        };
      },
      { withContext: true }
    ),
    issueGrant: op(
      MCP_SERVER_METHOD_CHANNELS.issueGrant,
      async (ctx, payload: { sessionId: string; toolId: string }): Promise<McpIssueGrantResult> => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { sessionId, toolId } = payload;
        if (typeof sessionId !== "string" || !sessionId) {
          throw new Error("Invalid sessionId");
        }
        if (typeof toolId !== "string" || !toolId) {
          throw new Error("Invalid toolId");
        }
        const svc = await getMcpServerService();
        // Same caller-pin invariant as `setSessionTier` — only the
        // renderer that minted the session can issue grants for it.
        return svc.issueGrant(sessionId, toolId, ctx.webContentsId);
      },
      { withContext: true }
    ),
    revokeSessionGrants: op(
      MCP_SERVER_METHOD_CHANNELS.revokeSessionGrants,
      async (ctx, payload: { sessionId: string }): Promise<McpRevokeSessionGrantsResult> => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { sessionId } = payload;
        if (typeof sessionId !== "string" || !sessionId) {
          throw new Error("Invalid sessionId");
        }
        const svc = await getMcpServerService();
        return svc.revokeSessionGrants(sessionId, ctx.webContentsId);
      },
      { withContext: true }
    ),
  },
});

export function registerMcpServerHandlers(): () => void {
  const namespaceCleanup = mcpServerNamespace.register();

  // Push runtime-state transitions to every renderer. Subscribed lazily so
  // we don't pay the McpServerService import cost just to register a no-op
  // listener — but cleanup MUST observe whichever side won the race:
  //   - import resolves first → cleanup unsubscribes
  //   - cleanup runs first    → import resolves after, sees the cancel flag
  //                             and skips the subscription entirely
  // Without this, an early teardown (test harness, app shutdown) would
  // miss the unsubscribe and leak a `runtimeStateListeners` entry.
  let cancelled = false;
  let pendingUnsubscribe: (() => void) | null = null;
  void getMcpServerService()
    .then((svc) => {
      if (cancelled) return;
      pendingUnsubscribe = svc.onRuntimeStateChange((snapshot) => {
        broadcastToRenderer(CHANNELS.MCP_SERVER_RUNTIME_STATE_CHANGED, snapshot);
      });
    })
    .catch((err) => {
      console.warn("[McpServerHandlers] Failed to subscribe to runtime-state changes:", err);
    });

  return () => {
    cancelled = true;
    namespaceCleanup();
    pendingUnsubscribe?.();
    pendingUnsubscribe = null;
  };
}
