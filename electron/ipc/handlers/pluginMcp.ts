// eager-import-allow: reads pluginMcpConfig via store.get synchronously in IPC handlers
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { webContents as electronWebContents } from "electron";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { CHANNELS } from "../channels.js";
import { PLUGIN_MCP_METHOD_CHANNELS } from "./pluginMcp.preload.js";
import type * as PluginMcpSupervisorModule from "../../services/PluginMcpSupervisor.js";
import type * as PluginServiceModule from "../../services/PluginService.js";
import { store } from "../../store.js";
import {
  getPluginMcpAuditService,
  getPluginMcpConsentService,
  getPluginMcpRateLimiter,
} from "../../services/plugin-mcp/instances.js";
import { deriveDangerTier } from "../../services/plugin-mcp/PluginMcpTierAuth.js";
import type {
  PluginMcpAuthorizeInput,
  PluginMcpConsentBridge,
  PluginMcpConsentRequest,
} from "../../services/plugin-mcp/PluginMcpConsentService.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { PLUGIN_MCP_RATE_LIMITED_CODE } from "../../../shared/types/ipc/pluginMcpAudit.js";
import {
  PLUGIN_MCP_CONSENT_TIMEOUT_MS,
  type PluginMcpConsentDecision,
  type PluginMcpDangerTier,
} from "../../../shared/types/pluginMcpConsent.js";
import {
  PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION,
  PLUGIN_MCP_MAX_MAX_TOOLS_PER_SESSION,
  PLUGIN_MCP_MIN_MAX_TOOLS_PER_SESSION,
  type PluginMcpCallToolInput,
  type PluginMcpCallToolResult,
  type PluginMcpConfig,
  type PluginMcpGetFullSchemaResult,
  type PluginMcpListToolsResult,
  type PluginMcpResolveConsentInput,
  type PluginMcpServerInfo,
  type PluginMcpServerKey,
  type PluginMcpStderrResult,
  type PluginMcpToolKey,
} from "../../../shared/types/ipc/pluginMcp.js";

type PluginMcpSupervisor = ReturnType<typeof PluginMcpSupervisorModule.getPluginMcpSupervisor>;
type PluginServiceSingleton = typeof PluginServiceModule.pluginService;

// Lazy accessors (mirrors helpAssistant.ts): static imports here would pull
// PluginMcpSupervisor and — transitively — the ~3,200-line PluginService onto
// the eager startup path that #9285 deferred them off of.
let cachedSupervisorModule: typeof PluginMcpSupervisorModule | null = null;
async function getSupervisor(): Promise<PluginMcpSupervisor> {
  if (!cachedSupervisorModule) {
    cachedSupervisorModule = await import("../../services/PluginMcpSupervisor.js");
  }
  return cachedSupervisorModule.getPluginMcpSupervisor();
}

let cachedPluginService: PluginServiceSingleton | null = null;
async function getPluginService(): Promise<PluginServiceSingleton> {
  if (!cachedPluginService) {
    const mod = await import("../../services/PluginService.js");
    cachedPluginService = mod.pluginService;
  }
  return cachedPluginService;
}

async function handleList(): Promise<PluginMcpServerInfo[]> {
  return (await getSupervisor()).list();
}

async function handleGetStderr(key: PluginMcpServerKey): Promise<PluginMcpStderrResult> {
  return (await getSupervisor()).getStderr(key.pluginId, key.serverId);
}

/**
 * Resolve the plugin's contribution and lazily spawn its MCP server (idempotent
 * — a no-op if already running), then return tier-1 tool summaries (#9235).
 * Spawning here, on first enumeration, is the lazy-discovery contract: plugin
 * activation no longer eagerly starts MCP subprocesses.
 */
async function handleListTools(key: PluginMcpServerKey): Promise<PluginMcpListToolsResult> {
  await ensureServerStarted(key);
  const cfg = store.get("pluginMcpConfig") as { maxToolsPerSession?: unknown } | undefined;
  return (await getSupervisor()).listTools(
    key.pluginId,
    key.serverId,
    clampMaxTools(cfg?.maxToolsPerSession)
  );
}

/** Tier-2 lookup: the full input schema for a single agent-selected tool (#9235). */
async function handleGetFullSchema(key: PluginMcpToolKey): Promise<PluginMcpGetFullSchemaResult> {
  await ensureServerStarted(key);
  return (await getSupervisor()).getFullSchema(key.pluginId, key.serverId, key.toolName);
}

/**
 * Look up the live contribution and (idempotently) start its supervised server.
 * Resolution happens at the handler boundary — same pattern as
 * {@link handleRestart} — so the supervisor stays decoupled from `PluginService`
 * and never holds a stale `resolveSettings` closure across a plugin reload.
 */
async function ensureServerStarted(key: PluginMcpServerKey): Promise<void> {
  const pluginService = await getPluginService();
  const lookup = pluginService.findMcpServerContribution(key.pluginId, key.serverId);
  if (!lookup) {
    throw new Error(
      `Cannot enumerate tools for "${key.pluginId}/${key.serverId}": plugin or server is not registered`
    );
  }
  await (
    await getSupervisor()
  ).start({
    pluginId: key.pluginId,
    pluginDir: lookup.pluginDir,
    contributions: [lookup.contribution],
    resolveSettings: (settingId) => pluginService.resolveSettingTemplate(key.pluginId, settingId),
  });
}

/**
 * Re-spawn a specific supervised server, e.g. after the user rotates a secret
 * the manifest substitutes in via `${settings:*}`. Resolution of the new
 * settings value happens here at the handler boundary so the supervisor stays
 * decoupled from `PluginService`.
 */
async function handleRestart(key: PluginMcpServerKey): Promise<void> {
  const pluginService = await getPluginService();
  const lookup = pluginService.findMcpServerContribution(key.pluginId, key.serverId);
  if (!lookup) {
    // A renderer race with plugin unload can land here. Throw so the caller
    // sees the failure rather than treating it as a silent no-op restart.
    throw new Error(
      `Cannot restart "${key.pluginId}/${key.serverId}": plugin or server is not registered`
    );
  }
  await (
    await getSupervisor()
  ).restart({
    pluginId: key.pluginId,
    pluginDir: lookup.pluginDir,
    serverId: key.serverId,
    contribution: lookup.contribution,
    resolveSettings: (settingId) => pluginService.resolveSettingTemplate(key.pluginId, settingId),
  });
  // A respawned server is a clean slate — clear any accumulated throttle debt so
  // the first call after a manual restart isn't rejected by a stale empty bucket.
  getPluginMcpRateLimiter().dropServer(key.pluginId, key.serverId);
}

/**
 * Read the advanced plugin-MCP config (#9235). Falls back to the default cap if
 * the persisted value is absent or out of range — the supervisor applies the
 * same clamp at enumeration time, so this only normalises what the UI shows.
 */
async function handleGetConfig(): Promise<PluginMcpConfig> {
  const cfg = store.get("pluginMcpConfig") as { maxToolsPerSession?: unknown } | undefined;
  return { maxToolsPerSession: clampMaxTools(cfg?.maxToolsPerSession) };
}

/** Persist the advanced plugin-MCP config, clamping the cap to a sane range. */
async function handleSetConfig(config: PluginMcpConfig): Promise<PluginMcpConfig> {
  const next: PluginMcpConfig = { maxToolsPerSession: clampMaxTools(config.maxToolsPerSession) };
  store.set("pluginMcpConfig", next);
  return next;
}

function clampMaxTools(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION;
  }
  const floored = Math.floor(value);
  if (floored < PLUGIN_MCP_MIN_MAX_TOOLS_PER_SESSION) return PLUGIN_MCP_MIN_MAX_TOOLS_PER_SESSION;
  if (floored > PLUGIN_MCP_MAX_MAX_TOOLS_PER_SESSION) return PLUGIN_MCP_MAX_MAX_TOOLS_PER_SESSION;
  return floored;
}

// --- Consent bridge (main → renderer prompt, renderer → main decision) --------
//
// `PluginMcpConsentService.authorizeToolCall` blocks on an injected bridge when
// a prompt is required. The bridge pushes a `plugin-mcp:consent-request` over
// the typed event bus to the WebContents that *initiated* the call — pinned via
// the IPC `event.sender`, never the focused window (lesson #7003) — and resolves
// when the renderer replies via `plugin-mcp:resolve-consent`. The initiating
// `webContentsId` reaches the singleton bridge through `AsyncLocalStorage` so
// concurrent calls from different windows never clobber a shared target.

interface PendingConsent {
  resolve: (decision: PluginMcpConsentDecision) => void;
  webContentsId: number;
  cleanup: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingConsents = new Map<string, PendingConsent>();
const consentTargetStore = new AsyncLocalStorage<number>();
let consentBridgeInstalled = false;

function settleConsent(requestId: string, decision: PluginMcpConsentDecision): void {
  const pending = pendingConsents.get(requestId);
  if (!pending) return;
  pendingConsents.delete(requestId);
  clearTimeout(pending.timer);
  pending.cleanup();
  pending.resolve(decision);
}

function pushConsentRequest(
  webContentsId: number,
  request: PluginMcpConsentRequest
): Promise<PluginMcpConsentDecision> {
  const wc = electronWebContents.fromId(webContentsId);
  if (!wc || wc.isDestroyed()) {
    // Fail closed: the initiating renderer is gone, so no one can approve.
    return Promise.resolve("rejected");
  }
  return new Promise<PluginMcpConsentDecision>((resolve) => {
    const requestId = randomUUID();
    const onDestroyed = () => settleConsent(requestId, "rejected");
    const cleanup = () => {
      try {
        wc.removeListener("destroyed", onDestroyed);
      } catch {
        // best-effort — the WebContents may already be torn down
      }
    };
    // Safety net: an abandoned prompt settles itself as "timeout" so the gating
    // promise never hangs and the pending entry is freed (#10841).
    const timer = setTimeout(
      () => settleConsent(requestId, "timeout"),
      PLUGIN_MCP_CONSENT_TIMEOUT_MS
    );
    pendingConsents.set(requestId, { resolve, webContentsId, cleanup, timer });
    wc.once("destroyed", onDestroyed);
    try {
      wc.send(CHANNELS.EVENTS_PUSH, {
        name: "plugin-mcp:consent-request",
        payload: {
          requestId,
          pluginId: request.identity.pluginId,
          serverId: request.identity.serverId,
          toolName: request.identity.toolName,
          pluginDisplayName: request.pluginDisplayName,
          descriptionDisplay: request.descriptionDisplay,
          argsSummary: request.argsSummary,
          dangerTier: request.dangerTier,
          declaredCapabilities: request.declaredCapabilities,
          reason: request.reason,
        },
      });
    } catch {
      settleConsent(requestId, "rejected");
    }
  });
}

const consentBridge: PluginMcpConsentBridge = (request) => {
  const webContentsId = consentTargetStore.getStore();
  if (webContentsId === undefined) {
    // No initiating-renderer context on the async stack — fail closed.
    return Promise.resolve("rejected");
  }
  return pushConsentRequest(webContentsId, request);
};

/** Install the consent bridge once, lazily — keeps an unused boot path bridge-free. */
function ensureConsentBridge(): void {
  if (consentBridgeInstalled) return;
  consentBridgeInstalled = true;
  getPluginMcpConsentService().setConsentBridge(consentBridge);
}

/** Test-only: drop installed-bridge state and reject any pending prompts. */
export function _resetConsentBridgeForTest(): void {
  for (const requestId of [...pendingConsents.keys()]) {
    settleConsent(requestId, "rejected");
  }
  consentBridgeInstalled = false;
}

function tierForAudit(
  annotations: ToolAnnotations | undefined,
  capabilities: readonly import("../../../shared/types/plugin.js").BuiltInPluginCapability[]
): PluginMcpDangerTier {
  const result = deriveDangerTier(annotations, capabilities);
  return result.kind === "tier" ? result.tier : result.observedFloor;
}

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "DISPATCH_FAILED";
}

/**
 * Dispatch a plugin-MCP `tools/call` through the full guard pipeline:
 * rate limit → consent → supervised dispatch, writing an audit row for every
 * *gated* outcome (rate-limit denial, consent denial, dispatch success/error).
 * Returns a discriminated result rather than throwing so the assistant can
 * distinguish a delivered result from a denial or a dispatch error. The consent
 * push is pinned to `ctx.webContentsId` (the calling renderer) so prompts
 * surface in the originating session, never the focused window.
 *
 * Preflight resolution failures (unknown tool, unloaded plugin) return early
 * without an audit row: they never reached the gate and carry no danger tier or
 * tool surface to record.
 */
export async function handleCallTool(
  ctx: IpcContext,
  input: PluginMcpCallToolInput
): Promise<PluginMcpCallToolResult> {
  const key: PluginMcpServerKey = { pluginId: input.pluginId, serverId: input.serverId };

  // Server start + schema/meta resolution can throw (plugin unloaded mid-race,
  // server crashed). Surface those as a typed error rather than an IPC reject.
  let descriptionRaw: string;
  let inputSchema: unknown;
  let annotations: ToolAnnotations | undefined;
  let pluginDisplayName: string;
  let manifestCapabilities: readonly import("../../../shared/types/plugin.js").BuiltInPluginCapability[];
  try {
    await ensureServerStarted(key);
    const supervisor = await getSupervisor();
    const schema = await supervisor.getFullSchema(input.pluginId, input.serverId, input.toolName);
    if (!schema.found) {
      return {
        kind: "error",
        errorCode: "TOOL_NOT_FOUND",
        message: `Tool "${input.toolName}" is not available on "${input.pluginId}/${input.serverId}"`,
      };
    }
    const meta = (await getPluginService()).getMcpConsentMeta(input.pluginId);
    if (!meta) {
      return {
        kind: "error",
        errorCode: "PLUGIN_NOT_LOADED",
        message: `Plugin "${input.pluginId}" is not loaded`,
      };
    }
    descriptionRaw = schema.tool.description ?? "";
    inputSchema = schema.tool.inputSchema;
    annotations = schema.tool.annotations as ToolAnnotations | undefined;
    pluginDisplayName = meta.pluginDisplayName;
    manifestCapabilities = meta.manifestCapabilities;
  } catch (err) {
    return {
      kind: "error",
      errorCode: errorCodeOf(err),
      message: formatErrorMessage(err, "Plugin MCP tool call failed"),
    };
  }

  const audit = getPluginMcpAuditService();
  const baseAudit = {
    pluginId: input.pluginId,
    serverId: input.serverId,
    toolName: input.toolName,
    descriptionRaw,
    inputSchema,
    rawArgs: input.args,
  };

  // Rate limit BEFORE consent — a throttled call must not spend a user prompt.
  const limit = getPluginMcpRateLimiter().check(input.pluginId, input.serverId);
  if (!limit.allowed) {
    audit.append({
      ...baseAudit,
      dangerTier: tierForAudit(annotations, manifestCapabilities),
      durationMs: 0,
      result: "denied",
      errorCode: PLUGIN_MCP_RATE_LIMITED_CODE,
    });
    return {
      kind: "denied",
      errorCode: PLUGIN_MCP_RATE_LIMITED_CODE,
      retryAfterMs: limit.retryAfterMs,
    };
  }

  ensureConsentBridge();
  const authorizeInput: PluginMcpAuthorizeInput = {
    identity: { pluginId: input.pluginId, serverId: input.serverId, toolName: input.toolName },
    pluginDisplayName,
    descriptionRaw,
    inputSchema,
    annotations,
    manifestCapabilities,
    rawArgs: input.args,
  };
  const outcome = await consentTargetStore.run(ctx.webContentsId, () =>
    getPluginMcpConsentService().authorizeToolCall(authorizeInput)
  );

  if (outcome.kind === "denied") {
    audit.append({
      ...baseAudit,
      dangerTier: outcome.dangerTier,
      durationMs: 0,
      result:
        outcome.consentDecision === "rejected"
          ? "rejected"
          : outcome.consentDecision === "timeout"
            ? "timeout"
            : "denied",
      consentReason: outcome.consentReason,
      consentDecision: outcome.consentDecision,
      errorCode: outcome.errorCode,
    });
    return { kind: "denied", errorCode: outcome.errorCode };
  }

  // Approved — dispatch and time the supervised call.
  const startMs = Date.now();
  try {
    const result = await (
      await getSupervisor()
    ).callTool({
      pluginId: input.pluginId,
      serverId: input.serverId,
      tool: input.toolName,
      args: input.args,
    });
    audit.append({
      ...baseAudit,
      dangerTier: outcome.dangerTier,
      durationMs: Date.now() - startMs,
      result: "success",
      consentReason: outcome.consentReason,
      consentDecision: outcome.consentDecision,
    });
    return { kind: "success", result };
  } catch (err) {
    const errorCode = errorCodeOf(err);
    audit.append({
      ...baseAudit,
      dangerTier: outcome.dangerTier,
      durationMs: Date.now() - startMs,
      result: "error",
      consentReason: outcome.consentReason,
      consentDecision: outcome.consentDecision,
      errorCode,
    });
    return {
      kind: "error",
      errorCode,
      message: formatErrorMessage(err, "Plugin MCP tool call failed"),
    };
  }
}

/**
 * Renderer reply to a `plugin-mcp:consent-request` push. The pending consent is
 * dropped (resolving the bridge promise) only when the responding WebContents
 * is the one the prompt was pinned to — a sibling window cannot answer another
 * window's prompt.
 */
export async function handleResolveConsent(
  ctx: IpcContext,
  input: PluginMcpResolveConsentInput
): Promise<void> {
  const pending = pendingConsents.get(input.requestId);
  if (!pending) return;
  if (ctx.webContentsId !== pending.webContentsId) {
    console.warn(
      `[plugin-mcp] Ignoring consent reply from unexpected sender ${ctx.webContentsId} (expected ${pending.webContentsId}, requestId=${input.requestId})`
    );
    return;
  }
  settleConsent(input.requestId, input.decision);
}

export const pluginMcpNamespace = defineIpcNamespace({
  name: "pluginMcp",
  ops: {
    list: op(PLUGIN_MCP_METHOD_CHANNELS.list, handleList),
    getStderr: op(PLUGIN_MCP_METHOD_CHANNELS.getStderr, handleGetStderr),
    restart: op(PLUGIN_MCP_METHOD_CHANNELS.restart, handleRestart),
    listTools: op(PLUGIN_MCP_METHOD_CHANNELS.listTools, handleListTools),
    getFullSchema: op(PLUGIN_MCP_METHOD_CHANNELS.getFullSchema, handleGetFullSchema),
    getConfig: op(PLUGIN_MCP_METHOD_CHANNELS.getConfig, handleGetConfig),
    setConfig: op(PLUGIN_MCP_METHOD_CHANNELS.setConfig, handleSetConfig),
    callTool: op(PLUGIN_MCP_METHOD_CHANNELS.callTool, handleCallTool, { withContext: true }),
    resolveConsent: op(PLUGIN_MCP_METHOD_CHANNELS.resolveConsent, handleResolveConsent, {
      withContext: true,
    }),
  },
});

export function registerPluginMcpHandlers(): () => void {
  const unregister = pluginMcpNamespace.register();
  return () => {
    unregister();
    // Tear down the consent bridge so a re-registration reinstalls cleanly and
    // no stale prompt resolves against a torn-down renderer. Pending prompts are
    // rejected (fail closed) rather than left dangling.
    if (consentBridgeInstalled) {
      getPluginMcpConsentService().setConsentBridge(null);
      consentBridgeInstalled = false;
    }
    for (const requestId of [...pendingConsents.keys()]) {
      settleConsent(requestId, "rejected");
    }
  };
}
