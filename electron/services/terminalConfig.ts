// eager-import-allow: reads terminal config via store.get synchronously so a change's broadcast carries what was just written
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { TERMINAL_CONFIG_FIELD_OWNERSHIP, type SettingOwner } from "../storeOwnership.js";
import { effectiveCachedProjectViews } from "../utils/cachedProjectViews.js";
import {
  migrateCustomSchemes,
  terminalCustomSchemesReadSchema,
  terminalCustomSchemesWriteSchema,
} from "../schemas/customSchemes.js";
import { normalizeScrollbackLines } from "../../shared/config/scrollback.js";
import type { TerminalConfig } from "../../shared/types/ipc/config.js";

type TerminalConfigField = keyof typeof TERMINAL_CONFIG_FIELD_OWNERSHIP;

function storedTerminalConfig(): Record<string, unknown> {
  const config = store.get("terminalConfig");
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
}

/**
 * The saved custom schemes, a legacy string or invalid entries parsed in
 * memory. Nothing is written back: every reader of terminal config is a read,
 * and the next save stores the native form.
 */
export function readCustomSchemes(raw: unknown): {
  schemes: NonNullable<TerminalConfig["customSchemes"]>;
  errors: string[];
} {
  if (typeof raw !== "string" && !Array.isArray(raw)) return { schemes: [], errors: [] };
  const { schemes, errors } = migrateCustomSchemes(
    raw,
    terminalCustomSchemesReadSchema,
    terminalCustomSchemesWriteSchema
  );
  return { schemes, errors };
}

/**
 * This machine's terminal config as every reader sees it: `terminalConfig.get`,
 * each hydrate, and each change broadcast.
 *
 * `TerminalConfig` types `scrollbackLines` and `performanceMode` as required,
 * but nothing on disk guarantees them: electron-store's defaults merge is
 * shallow (a persisted partial `terminalConfig` replaces the default object
 * wholesale) and every writer sets a single dot-path. They are backfilled here
 * so the declared type holds. An unset cached-view count means the hardware
 * default, which the renderer can't resolve itself.
 */
export function readTerminalConfig(): TerminalConfig {
  const config = storedTerminalConfig();
  return {
    ...config,
    scrollbackLines: normalizeScrollbackLines(config.scrollbackLines),
    performanceMode: config.performanceMode === true,
    customSchemes: readCustomSchemes(config.customSchemes).schemes,
    cachedProjectViews: effectiveCachedProjectViews(config.cachedProjectViews),
  } as TerminalConfig;
}

const OWNER_CHANNEL: Record<SettingOwner, string> = {
  device: CHANNELS.TERMINAL_CONFIG_DEVICE_CHANGED,
  host: CHANNELS.TERMINAL_CONFIG_HOST_CHANGED,
};

/** Every field one owner holds, as {@link readTerminalConfig} reports it. */
export function readTerminalConfigOwnedBy(owner: SettingOwner): Partial<TerminalConfig> {
  const config = readTerminalConfig() as Record<string, unknown>;
  const owned: Record<string, unknown> = {};
  for (const [field, fieldOwner] of Object.entries(TERMINAL_CONFIG_FIELD_OWNERSHIP)) {
    if (fieldOwner === owner && Object.hasOwn(config, field)) owned[field] = config[field];
  }
  return owned as Partial<TerminalConfig>;
}

/**
 * Tells every view a saved field changed (#14699), with all of its owner's
 * fields. Each owner has its own channel, so the remote routing sends a view
 * bound to another host the device half from this machine and the host half
 * from that host, and never this machine's host half.
 */
export function notifyTerminalConfigChanged(field: TerminalConfigField): void {
  const owner = TERMINAL_CONFIG_FIELD_OWNERSHIP[field];
  broadcastToRenderer(OWNER_CHANNEL[owner], readTerminalConfigOwnedBy(owner));
}
