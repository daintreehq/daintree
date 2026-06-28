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
// A model ID is a single CLI token (e.g. "claude-sonnet-4-6"); cap well above
// any realistic ID so a corrupted store value can't bloat the launch command.
const MODEL_ID_MAX_LEN = 200;

const HELP_ASSISTANT_DEFAULTS: HelpAssistantSettings = {
  docSearch: true,
  daintreeControl: true,
  tier: "action",
  bypassPermissions: false,
  auditRetention: 7,
  modelId: "",
  customArgs: "",
  idleHibernateMinutes: 30,
  debugLogging: false,
};

const HELP_ASSISTANT_KEYS = [
  "docSearch",
  "daintreeControl",
  "tier",
  "bypassPermissions",
  "auditRetention",
  "modelId",
  "customArgs",
  "idleHibernateMinutes",
  "debugLogging",
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

// A valid model ID is a single shell-safe token. The empty string is valid and
// means "use the CLI default" (no `--model` injected). Anything with internal
// whitespace, control characters, a leading `-` (would inject a bare flag), or
// shell metacharacters is rejected outright rather than coerced — the picker
// only ever emits clean IDs, so a dirty value is corruption, not a near-miss to
// salvage. Whitespace/control chars are checked, not stripped, so a tab or
// newline can't be silently collapsed into a bogus token.
function sanitizeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return "";
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) return undefined;
  if (trimmed.startsWith("-")) return undefined;
  if (hasShellMetachar(trimmed)) return undefined;
  return trimmed.slice(0, MODEL_ID_MAX_LEN);
}

function sanitizeStored(stored: unknown): Partial<HelpAssistantSettings> {
  if (!stored || typeof stored !== "object") return {};
  const out: Partial<HelpAssistantSettings> = {};
  const record = stored as Record<string, unknown>;
  if (typeof record.docSearch === "boolean") out.docSearch = record.docSearch;
  if (typeof record.daintreeControl === "boolean") out.daintreeControl = record.daintreeControl;
  if (typeof record.debugLogging === "boolean") out.debugLogging = record.debugLogging;
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
  const sanitizedModelId = sanitizeModelId(record.modelId);
  if (sanitizedModelId !== undefined) out.modelId = sanitizedModelId;
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
  tier: "workbench",
  activeGrants: [],
};

// The session-store tier is an `McpTier` which also admits `"external"` for
// api-key/loopback sessions. Help-session bearers are never external, but
// narrow defensively so the IPC surface only ever exposes a HelpAssistantTier.
function narrowToHelpAssistantTier(tier: string): HelpAssistantTier {
  return isValidHelpAssistantTier(tier) ? tier : "workbench";
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
          if (
            (field === "docSearch" ||
              field === "daintreeControl" ||
              field === "bypassPermissions" ||
              field === "debugLogging") &&
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
          if (field === "modelId") {
            const sanitized = sanitizeModelId(value);
            if (sanitized === undefined) continue;
            storedValue = sanitized;
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
