import { dialog } from "electron";
import { writeFile } from "fs/promises";
import { CHANNELS } from "../channels.js";
import type * as McpServerServiceModule from "../../services/McpServerService.js";
import { broadcastToRenderer, typedHandle, typedHandleWithContext } from "../utils.js";
import { sanitizePath } from "../../utils/pathScrubber.js";
import { scrubSecrets } from "../../utils/secretScrubber.js";

type McpServerSingleton = typeof McpServerServiceModule.mcpServerService;

let cachedMcpServerService: McpServerSingleton | null = null;
async function getMcpServerService(): Promise<McpServerSingleton> {
  if (!cachedMcpServerService) {
    const mod = await import("../../services/McpServerService.js");
    cachedMcpServerService = mod.mcpServerService;
  }
  return cachedMcpServerService;
}

export function registerMcpServerHandlers(): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GET_STATUS, async () => {
      const svc = await getMcpServerService();
      return svc.getStatus();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_SET_ENABLED, async (enabled: boolean) => {
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      const svc = await getMcpServerService();
      await svc.setEnabled(enabled);
      return svc.getStatus();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_SET_PORT, async (port: number | null) => {
      if (
        port !== null &&
        (typeof port !== "number" || port < 1024 || port > 65535 || !Number.isInteger(port))
      ) {
        throw new Error("port must be null or an integer between 1024 and 65535");
      }
      const svc = await getMcpServerService();
      await svc.setPort(port);
      return svc.getStatus();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_ROTATE_API_KEY, async () => {
      const svc = await getMcpServerService();
      return await svc.rotateApiKey();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GET_CONFIG_SNIPPET, async () => {
      const svc = await getMcpServerService();
      return svc.getConfigSnippet();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GET_AUDIT_RECORDS, async () => {
      const svc = await getMcpServerService();
      return svc.getAuditRecords();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GET_AUDIT_CONFIG, async () => {
      const svc = await getMcpServerService();
      return svc.getAuditConfig();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GET_AUDIT_STATS, async () => {
      const svc = await getMcpServerService();
      return svc.getAuditStats();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_CLEAR_AUDIT_LOG, async () => {
      const svc = await getMcpServerService();
      svc.clearAuditLog();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_SET_AUDIT_ENABLED, async (enabled: boolean) => {
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      const svc = await getMcpServerService();
      return svc.setAuditEnabled(enabled);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS, async (max: number) => {
      if (typeof max !== "number" || !Number.isFinite(max) || !Number.isInteger(max)) {
        throw new Error("max must be a finite integer");
      }
      if (max < 50 || max > 10000) {
        throw new Error("max must be between 50 and 10000");
      }
      const svc = await getMcpServerService();
      return svc.setAuditMaxRecords(max);
    })
  );

  // Runtime-state surface — distinct from `getStatus()` because the renderer
  // needs the derived 4-state snapshot (`disabled|starting|ready|failed`)
  // plus `lastError`, not just config + bound port.
  handlers.push(
    typedHandle(CHANNELS.MCP_SERVER_GET_RUNTIME_STATE, async () => {
      const svc = await getMcpServerService();
      return svc.getRuntimeState();
    })
  );

  handlers.push(
    typedHandleWithContext(
      CHANNELS.MCP_SERVER_EXPORT_AUDIT_LOG,
      async (ctx, records: unknown): Promise<boolean> => {
        if (!Array.isArray(records)) throw new Error("records must be an array");
        const ndjsonLines = records.map((rawRecord) => {
          const record = rawRecord as Record<string, unknown>;
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
      }
    )
  );

  handlers.push(
    typedHandleWithContext(
      CHANNELS.MCP_SERVER_SET_SESSION_TIER,
      async (ctx, payload: { sessionId: string; tier: "workbench" | "action" | "system" }) => {
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
      }
    )
  );

  handlers.push(
    typedHandleWithContext(
      CHANNELS.MCP_SERVER_ISSUE_GRANT,
      async (ctx, payload: { sessionId: string; toolId: string }) => {
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
      }
    )
  );

  handlers.push(
    typedHandleWithContext(
      CHANNELS.MCP_SERVER_REVOKE_SESSION_GRANTS,
      async (ctx, payload: { sessionId: string }) => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { sessionId } = payload;
        if (typeof sessionId !== "string" || !sessionId) {
          throw new Error("Invalid sessionId");
        }
        const svc = await getMcpServerService();
        return svc.revokeSessionGrants(sessionId, ctx.webContentsId);
      }
    )
  );

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
  void getMcpServerService().then((svc) => {
    if (cancelled) return;
    pendingUnsubscribe = svc.onRuntimeStateChange((snapshot) => {
      broadcastToRenderer(CHANNELS.MCP_SERVER_RUNTIME_STATE_CHANGED, snapshot);
    });
  });

  return () => {
    cancelled = true;
    handlers.forEach((cleanup) => cleanup());
    pendingUnsubscribe?.();
    pendingUnsubscribe = null;
  };
}
