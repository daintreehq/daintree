import { store } from "../../store.js";
import { defineIpcNamespace, op } from "../define.js";
import { HELP_ASSISTANT_METHOD_CHANNELS } from "./helpAssistant.preload.js";
import type {
  HelpAssistantAuditRetention,
  HelpAssistantIdleHibernateMinutes,
  HelpAssistantSettings,
} from "../../../shared/types/ipc/api.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";
import { hasShellMetachar } from "../../../shared/utils/shellEscape.js";
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
  tier: "action",
  bypassPermissions: false,
  auditRetention: 7,
  customArgs: "",
  idleHibernateMinutes: 30,
};

const HELP_ASSISTANT_KEYS = [
  "docSearch",
  "daintreeControl",
  "tier",
  "bypassPermissions",
  "auditRetention",
  "customArgs",
  "idleHibernateMinutes",
] as const satisfies ReadonlyArray<keyof HelpAssistantSettings>;

const KNOWN_KEYS: ReadonlySet<string> = new Set(HELP_ASSISTANT_KEYS);

function isValidAuditRetention(value: unknown): value is HelpAssistantAuditRetention {
  return value === 0 || value === 7 || value === 30;
}

function isValidIdleHibernateMinutes(value: unknown): value is HelpAssistantIdleHibernateMinutes {
  return value === 0 || value === 15 || value === 30 || value === 60 || value === 120;
}

function isValidHelpAssistantTier(value: unknown): value is HelpAssistantTier {
  return value === "workbench" || value === "action" || value === "system";
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
  // Read-time migration from the legacy `skipPermissions` boolean: if the
  // new fields aren't stored, derive them from the old boolean. New writes
  // never touch `skipPermissions`, so once a user has saved the new fields
  // the legacy fallback is dormant.
  if (isValidHelpAssistantTier(record.tier)) {
    out.tier = record.tier;
  } else if (typeof record.skipPermissions === "boolean") {
    out.tier = record.skipPermissions ? "system" : "action";
  }
  if (typeof record.bypassPermissions === "boolean") {
    out.bypassPermissions = record.bypassPermissions;
  } else if (typeof record.skipPermissions === "boolean") {
    out.bypassPermissions = record.skipPermissions;
  }
  if (isValidAuditRetention(record.auditRetention)) out.auditRetention = record.auditRetention;
  if (isValidIdleHibernateMinutes(record.idleHibernateMinutes)) {
    out.idleHibernateMinutes = record.idleHibernateMinutes;
  }
  const sanitizedArgs = sanitizeCustomArgs(record.customArgs);
  if (sanitizedArgs !== undefined) out.customArgs = sanitizedArgs;
  return out;
}

export function getHelpAssistantSettings(): HelpAssistantSettings {
  const stored = store.get("helpAssistant");
  return { ...HELP_ASSISTANT_DEFAULTS, ...sanitizeStored(stored) };
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
        for (const [field, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          if (!KNOWN_KEYS.has(field)) continue;
          if (field === "auditRetention" && !isValidAuditRetention(value)) continue;
          if (field === "idleHibernateMinutes" && !isValidIdleHibernateMinutes(value)) continue;
          if (field === "tier" && !isValidHelpAssistantTier(value)) continue;
          if (
            (field === "docSearch" ||
              field === "daintreeControl" ||
              field === "bypassPermissions") &&
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
          if (field === "daintreeControl" && value === true) {
            const previous = store.get("helpAssistant")?.daintreeControl ?? true;
            if (previous !== true) daintreeControlTurnedOn = true;
          }
          store.set(`helpAssistant.${field}`, storedValue);
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
  },
});

export function registerHelpAssistantHandlers(): () => void {
  return helpAssistantNamespace.register();
}
