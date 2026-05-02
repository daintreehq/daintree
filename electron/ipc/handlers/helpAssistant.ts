import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { typedHandle } from "../utils.js";
import type {
  HelpAssistantAuditRetention,
  HelpAssistantSettings,
} from "../../../shared/types/ipc/api.js";

const HELP_ASSISTANT_DEFAULTS: HelpAssistantSettings = {
  docSearch: true,
  daintreeControl: true,
  skipPermissions: false,
  auditRetention: 7,
};

const VALID_AUDIT_RETENTIONS: ReadonlySet<HelpAssistantAuditRetention> = new Set([0, 7, 30]);

function isValidAuditRetention(value: unknown): value is HelpAssistantAuditRetention {
  return (
    (value === 0 || value === 7 || value === 30) &&
    VALID_AUDIT_RETENTIONS.has(value as HelpAssistantAuditRetention)
  );
}

export function getHelpAssistantSettings(): HelpAssistantSettings {
  const stored = store.get("helpAssistant") as Partial<HelpAssistantSettings> | undefined;
  return { ...HELP_ASSISTANT_DEFAULTS, ...stored };
}

export function registerHelpAssistantHandlers(): () => void {
  const handleGetSettings = async (): Promise<HelpAssistantSettings> => {
    return getHelpAssistantSettings();
  };

  const handleSetSettings = async (patch: Partial<HelpAssistantSettings>): Promise<void> => {
    if (!patch || typeof patch !== "object") return;
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (field === "auditRetention" && !isValidAuditRetention(value)) continue;
      if (
        (field === "docSearch" || field === "daintreeControl" || field === "skipPermissions") &&
        typeof value !== "boolean"
      ) {
        continue;
      }
      store.set(`helpAssistant.${field}`, value);
    }
  };

  const cleanups: Array<() => void> = [
    typedHandle(CHANNELS.HELP_ASSISTANT_GET_SETTINGS, handleGetSettings),
    typedHandle(CHANNELS.HELP_ASSISTANT_SET_SETTINGS, handleSetSettings),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
