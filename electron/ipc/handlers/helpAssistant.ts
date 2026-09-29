// eager-import-allow: reads help-assistant settings via store.get synchronously in the IPC handler
import { store } from "../../store.js";
import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import type { IpcContext } from "../types.js";
import { HELP_ASSISTANT_METHOD_CHANNELS } from "./helpAssistant.preload.js";
import type {
  HelpAssistantAuditRetention,
  HelpAssistantIdleHibernateMinutes,
  HelpAssistantSettings,
  HelpSessionLiveStatus,
} from "../../../shared/types/ipc/api.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";
import {
  DEFAULT_HELP_ASSISTANT_TIER,
  normalizeHelpAssistantTier,
} from "../../../shared/config/helpAssistantTierAllowlists.js";
import { hasShellMetachar } from "../../../shared/utils/shellEscape.js";
import { isHelpAssistantDaintreeConfirmations as isValidDaintreeConfirmations } from "../../../shared/utils/assistantDaintreeConfirmations.js";
import { applyModelIdPatch, sanitizeModelIdMap } from "../../utils/helpAssistantModels.js";
import type * as McpServerServiceModule from "../../services/McpServerService.js";

type McpServerSingleton = typeof McpServerServiceModule.mcpServerService;

let cachedMcpServerService: McpServerSingleton | null = null;
async function getMcpServerService(): Promise<McpServerSingleton> {
  if (!cachedMcpServerService) {
    const mod = await import("../../services/McpServerService.js");
    cachedMcpServerService = mod.mcpServerService;
  }
  return cachedMcpServerService;
}

const CUSTOM_ARGS_MAX_LEN = 10000;

const HELP_ASSISTANT_DEFAULTS: HelpAssistantSettings = {
  docSearch: true,
  daintreeControl: true,
  runbookSearch: true,
  tier: DEFAULT_HELP_ASSISTANT_TIER,
  bypassPermissions: false,
  auditRetention: 7,
  modelIds: {},
  customArgs: "",
  idleHibernateMinutes: 5,
  debugLogging: false,
  loadGlobalHooksAndServers: false,
  daintreeConfirmations: "inherit",
};

const HELP_ASSISTANT_KEYS = [
  "docSearch",
  "daintreeControl",
  "runbookSearch",
  "tier",
  "bypassPermissions",
  "auditRetention",
  "modelIds",
  "customArgs",
  "idleHibernateMinutes",
  "debugLogging",
  "loadGlobalHooksAndServers",
  "daintreeConfirmations",
] as const satisfies ReadonlyArray<keyof HelpAssistantSettings>;

const KNOWN_KEYS: ReadonlySet<string> = new Set(HELP_ASSISTANT_KEYS);

function isValidAuditRetention(value: unknown): value is HelpAssistantAuditRetention {
  return value === 0 || value === 7 || value === 30;
}

function isValidIdleHibernateMinutes(value: unknown): value is HelpAssistantIdleHibernateMinutes {
  return (
    value === 0 || value === 5 || value === 15 || value === 30 || value === 60 || value === 120
  );
}

function isValidHelpAssistantTier(value: unknown): value is HelpAssistantTier {
  return value === "core" || value === "full";
}

function sanitizeCustomArgs(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const collapsed = value.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  if (hasShellMetachar(collapsed)) return undefined;
  return collapsed.slice(0, CUSTOM_ARGS_MAX_LEN);
}

function sanitizeStored(stored: unknown): Partial<HelpAssistantSettings> {
  if (!stored || typeof stored !== "object") return {};
  const out: Partial<HelpAssistantSettings> = {};
  const record = stored as Record<string, unknown>;
  if (typeof record.docSearch === "boolean") out.docSearch = record.docSearch;
  if (typeof record.daintreeControl === "boolean") out.daintreeControl = record.daintreeControl;
  if (typeof record.runbookSearch === "boolean") out.runbookSearch = record.runbookSearch;
  if (typeof record.debugLogging === "boolean") out.debugLogging = record.debugLogging;
  if (typeof record.loadGlobalHooksAndServers === "boolean") {
    out.loadGlobalHooksAndServers = record.loadGlobalHooksAndServers;
  }
  // Read-time migration from the legacy `skipPermissions` boolean: if the
  // new fields aren't stored, derive them from the old boolean. New writes
  // never touch `skipPermissions`, so once a user has saved the new fields
  // the legacy fallback is dormant.
  // A tier stored before the core/full split is read onto the new pair.
  const storedTier = normalizeHelpAssistantTier(record.tier);
  if (storedTier) {
    out.tier = storedTier;
  } else if (typeof record.skipPermissions === "boolean") {
    out.tier = record.skipPermissions ? "full" : "core";
  }
  if (typeof record.bypassPermissions === "boolean") {
    out.bypassPermissions = record.bypassPermissions;
  } else if (typeof record.skipPermissions === "boolean") {
    out.bypassPermissions = record.skipPermissions;
  }
  if (isValidAuditRetention(record.auditRetention)) out.auditRetention = record.auditRetention;
  if (isValidDaintreeConfirmations(record.daintreeConfirmations)) {
    out.daintreeConfirmations = record.daintreeConfirmations;
  }
  if (isValidIdleHibernateMinutes(record.idleHibernateMinutes)) {
    out.idleHibernateMinutes = record.idleHibernateMinutes;
  }
  const sanitizedModelIds = sanitizeModelIdMap(record.modelIds);
  if (sanitizedModelIds !== undefined) out.modelIds = sanitizedModelIds;
  const sanitizedArgs = sanitizeCustomArgs(record.customArgs);
  if (sanitizedArgs !== undefined) out.customArgs = sanitizedArgs;
  return out;
}

export function getHelpAssistantSettings(): HelpAssistantSettings {
  const stored = store.get("helpAssistant");
  return { ...HELP_ASSISTANT_DEFAULTS, ...sanitizeStored(stored) };
}

// Safe "no live session" snapshot returned when the caller has no pinned help
// session — the renderer renders this as a quiet idle state, never a spinner.
const DISCONNECTED_LIVE_STATUS: HelpSessionLiveStatus = {
  connected: false,
  tier: DEFAULT_HELP_ASSISTANT_TIER,
  activeGrants: [],
};

// The session-store tier is an `McpTier` which also admits `"external"` for
// api-key/loopback sessions. Help-session bearers are never external, but
// narrow defensively so the IPC surface only ever exposes a HelpAssistantTier.
function narrowToHelpAssistantTier(tier: string): HelpAssistantTier {
  return isValidHelpAssistantTier(tier) ? tier : "core";
}

export const helpAssistantNamespace = defineIpcNamespace({
  name: "helpAssistant",
  ops: {
    getSettings: op(
      HELP_ASSISTANT_METHOD_CHANNELS.getSettings,
      async (): Promise<HelpAssistantSettings> => {
        return getHelpAssistantSettings();
      }
    ),
    setSettings: op(
      HELP_ASSISTANT_METHOD_CHANNELS.setSettings,
      async (patch: Partial<HelpAssistantSettings>): Promise<void> => {
        if (!patch || typeof patch !== "object") return;
        let daintreeControlTurnedOn = false;
        let auditRetentionWritten: HelpAssistantAuditRetention | null = null;
        for (const [field, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          if (!KNOWN_KEYS.has(field)) continue;
          if (field === "auditRetention" && !isValidAuditRetention(value)) continue;
          if (field === "idleHibernateMinutes" && !isValidIdleHibernateMinutes(value)) continue;
          if (field === "tier" && !isValidHelpAssistantTier(value)) continue;
          if (field === "daintreeConfirmations" && !isValidDaintreeConfirmations(value)) continue;
          if (
            (field === "docSearch" ||
              field === "daintreeControl" ||
              field === "runbookSearch" ||
              field === "bypassPermissions" ||
              field === "debugLogging" ||
              field === "loadGlobalHooksAndServers") &&
            typeof value !== "boolean"
          ) {
            continue;
          }
          let storedValue: unknown = value;
          if (field === "customArgs") {
            const sanitized = sanitizeCustomArgs(value);
            if (sanitized === undefined) continue;
            storedValue = sanitized;
          }
          if (field === "modelIds") {
            // Merged per agent against what's stored, never a whole-map
            // replace, so a stale renderer snapshot can't erase another
            // agent's choice. Written as one object under a fixed path so a
            // dotted agent ID stays a literal key.
            const current = sanitizeModelIdMap(store.get("helpAssistant")?.modelIds) ?? {};
            const next = applyModelIdPatch(current, value);
            if (next === undefined) continue;
            storedValue = next;
          }
          if (field === "daintreeControl" && value === true) {
            const previous = store.get("helpAssistant")?.daintreeControl ?? true;
            if (previous !== true) daintreeControlTurnedOn = true;
          }
          if (field === "auditRetention") {
            auditRetentionWritten = storedValue as HelpAssistantAuditRetention;
          }
          store.set(`helpAssistant.${field}`, storedValue);
        }

        // Apply the new retention window to the assistant audit rings
        // immediately so a shortened (or "Off"→on) setting takes effect now,
        // not only on the next periodic-cleanup tick. Fire-and-forget with a
        // logged catch — pruning failures must not block the settings write;
        // the periodic sweep retries on its own cadence. Mirrors the
        // daintreeControl auto-couple below.
        if (auditRetentionWritten !== null) {
          const days = auditRetentionWritten;
          void getMcpServerService()
            .then((svc) => svc.pruneAuditByRetention(days))
            .catch((err) => {
              console.warn("[HelpAssistant] auditRetention prune failed:", err);
            });
        }

        // Auto-couple: turning on Daintree control implies the in-process MCP
        // server must be running, since the assistant talks to Daintree
        // exclusively through that server. Without this, the contradictory
        // shipped defaults (`daintreeControl: true`, `mcpServer.enabled: false`)
        // would silently launch the assistant with no daintree MCP wired —
        // exactly the failure mode this auto-coupling was added to prevent.
        // Failures are logged but do not block the settings write; the renderer
        // observes the failure via the runtime-state push and surfaces it
        // through the dock pip and the Settings tab's status panel.
        if (daintreeControlTurnedOn) {
          try {
            const svc = await getMcpServerService();
            if (!svc.isEnabled()) {
              await svc.setEnabled(true);
            }
          } catch (err) {
            console.warn(
              "[HelpAssistant] Auto-enable of MCP server after daintreeControl=on failed:",
              err
            );
          }
        }
      }
    ),
    getLiveSessionStatus: opValidated(
      HELP_ASSISTANT_METHOD_CHANNELS.getLiveSessionStatus,
      z.object({ sessionId: z.string().min(1) }),
      async (
        ctx: IpcContext,
        { sessionId }: { sessionId: string }
      ): Promise<HelpSessionLiveStatus> => {
        const svc = await getMcpServerService();
        const live = svc.getHelpSessionLiveStatus(sessionId, ctx.webContentsId);
        if (!live) return DISCONNECTED_LIVE_STATUS;
        return {
          connected: true,
          tier: narrowToHelpAssistantTier(live.tier),
          activeGrants: live.activeGrants,
        };
      },
      { withContext: true }
    ),
  },
});

export function registerHelpAssistantHandlers(): () => void {
  return helpAssistantNamespace.register();
}
