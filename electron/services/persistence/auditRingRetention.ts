import {
  FORGE_AUDIT_DEFAULT_MAX_RECORDS,
  FORGE_AUDIT_MAX_RECORDS,
  FORGE_AUDIT_MIN_RECORDS,
} from "../../../shared/types/ipc/forge.js";
import {
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_MIN_RECORDS,
} from "../../../shared/types/ipc/mcpServer.js";
import {
  PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
  PLUGIN_AUDIT_MAX_RECORDS,
  PLUGIN_AUDIT_MIN_RECORDS,
} from "../../../shared/types/ipc/pluginAudit.js";
import {
  PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS,
  PLUGIN_MCP_AUDIT_MAX_RECORDS,
  PLUGIN_MCP_AUDIT_MIN_RECORDS,
} from "../../../shared/types/ipc/pluginMcpAudit.js";
import { RUN_HISTORY_DEFAULT_MAX_RECORDS } from "../../../shared/types/ipc/runHistory.js";
import type { AuditRingName } from "./auditRingStore.js";

export interface AuditRingRetention {
  min: number;
  /**
   * The highest limit a user can configure. Ring owners trim their in-memory
   * ring to the configured limit and pass this ceiling to `writeAll`, so
   * storage keeps exactly what the owner kept.
   */
  max: number;
  /** The limit when none is configured, or the configured value is not a number. */
  fallback: number;
}

export const AUDIT_RING_RETENTION: Readonly<Record<AuditRingName, AuditRingRetention>> = {
  mcpAuditLog: {
    min: MCP_AUDIT_MIN_RECORDS,
    max: MCP_AUDIT_MAX_RECORDS,
    fallback: MCP_AUDIT_DEFAULT_MAX_RECORDS,
  },
  // Shares the MCP audit setting (`mcpServer.auditMaxRecords`).
  mcpTurnOutcomeLog: {
    min: MCP_AUDIT_MIN_RECORDS,
    max: MCP_AUDIT_MAX_RECORDS,
    fallback: MCP_AUDIT_DEFAULT_MAX_RECORDS,
  },
  pluginAuditLog: {
    min: PLUGIN_AUDIT_MIN_RECORDS,
    max: PLUGIN_AUDIT_MAX_RECORDS,
    fallback: PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
  },
  forgeAuditLog: {
    min: FORGE_AUDIT_MIN_RECORDS,
    max: FORGE_AUDIT_MAX_RECORDS,
    fallback: FORGE_AUDIT_DEFAULT_MAX_RECORDS,
  },
  // Not configurable.
  runHistoryRecords: {
    min: RUN_HISTORY_DEFAULT_MAX_RECORDS,
    max: RUN_HISTORY_DEFAULT_MAX_RECORDS,
    fallback: RUN_HISTORY_DEFAULT_MAX_RECORDS,
  },
  pluginMcpAuditLog: {
    min: PLUGIN_MCP_AUDIT_MIN_RECORDS,
    max: PLUGIN_MCP_AUDIT_MAX_RECORDS,
    fallback: PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS,
  },
};

/** The effective record limit for a ring, given its raw `auditMaxRecords` setting. */
export function normalizeAuditRingMaxRecords(ring: AuditRingName, value: unknown): number {
  const { min, max, fallback } = AUDIT_RING_RETENTION[ring];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
