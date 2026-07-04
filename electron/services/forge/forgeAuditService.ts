// eager-import-allow: reads/writes the forgeAudit store key via store.get/set inside the audit callbacks, invoked from forge IPC handlers (not at boot)
import type { ForgeAuditResult, ForgeProviderMethodName } from "../../../shared/types/ipc/forge.js";
import { FORGE_AUDIT_DEFAULT_MAX_RECORDS } from "../../../shared/types/ipc/forge.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { auditRingStore } from "../persistence/auditRingStore.js";
import { store } from "../../store.js";
import { ForgeAuditService, type ForgeAuditLogStore } from "./auditLog.js";

export { summarizeForgeArgs } from "./auditLog.js";

/**
 * Process-global forge audit singleton. Forge provider calls originate from
 * any window's IPC, so the audit ring accumulates cross-window — a module-level
 * singleton, never per-window (lesson #4624). The pure {@link ForgeAuditService}
 * class lives in `auditLog.ts` (store-free, unit-testable); this thin wrapper
 * wires it to the `forgeAudit` store key, mirroring `McpServerService`'s
 * separation of the class from its persistence callbacks.
 */
const FORGE_AUDIT_CONFIG_DEFAULTS = {
  auditEnabled: true,
  auditMaxRecords: FORGE_AUDIT_DEFAULT_MAX_RECORDS,
} as const;

function getConfig(): Record<string, unknown> {
  // Defensive `?? {}`: the store default always supplies `forgeAudit`, but a
  // test harness mocking the store may not — readConfig must never be undefined.
  return (store.get("forgeAudit") as Record<string, unknown> | undefined) ?? {};
}

function persistConfig(patch: Record<string, unknown>): void {
  // Flags only — the ring is persisted via `forgeAuditLogStore` since
  // migration023. The spread merge keeps a legacy `auditLog` carryover intact
  // for installs where the migration deferred (audit-logs store not durable).
  const current = store.get("forgeAudit") ?? FORGE_AUDIT_CONFIG_DEFAULTS;
  store.set("forgeAudit", { ...current, ...patch });
}

// Persists the ring in the dedicated audit-logs store so config.json stays
// small and audit appends never re-serialize it. `auditEnabled` /
// `auditMaxRecords` stay in config.json (`forgeAudit`).
const forgeAuditLogStore: ForgeAuditLogStore = {
  read: () => auditRingStore.readAll("forgeAuditLog"),
  write: (records, options) =>
    auditRingStore.writeAll("forgeAuditLog", records, FORGE_AUDIT_DEFAULT_MAX_RECORDS, options),
};

export const forgeAuditService = new ForgeAuditService(
  persistConfig,
  getConfig,
  forgeAuditLogStore
);

/**
 * Time and audit a single forge-provider method call. Wraps only the provider
 * call thunk — callers place it INSIDE any singleflight `run()` closure and
 * AFTER `resolveForCwd`, so the recorded duration measures the provider call,
 * not resolution or coalescing wait. Failures still rethrow: auditing is
 * transparent to callers (#8442 — record even when the UI banner is silenced).
 */
export async function auditForgeCall<T>(
  meta: {
    providerId: string;
    methodName: ForgeProviderMethodName | (string & {});
    repoOwner?: string;
    repoName?: string;
    argsSummary?: string;
  },
  run: () => Promise<T>,
  classify?: (value: T) => ForgeAuditResult
): Promise<T> {
  const start = Date.now();
  try {
    const value = await run();
    safeAppend({
      ...meta,
      durationMs: Date.now() - start,
      result: classify ? classify(value) : "success",
    });
    return value;
  } catch (err) {
    safeAppend({
      ...meta,
      durationMs: Date.now() - start,
      result: "error",
      errorMessage: formatErrorMessage(err, "forge provider call failed"),
    });
    throw err;
  }
}

/**
 * Append a record without ever surfacing an audit failure to the caller. A
 * throw from `appendRecord` (corrupt store, disk error) must not swallow the
 * provider's return value or replace the original error — auditing is strictly
 * a side channel.
 */
function safeAppend(input: Parameters<ForgeAuditService["appendRecord"]>[0]): void {
  try {
    forgeAuditService.appendRecord(input);
  } catch (err) {
    console.error("[Forge] Failed to append audit record:", err);
  }
}
