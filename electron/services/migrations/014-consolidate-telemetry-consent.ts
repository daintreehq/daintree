import type { Migration } from "../StoreMigrations.js";

type TelemetryLevel = "off" | "errors" | "full";

interface PrivacySnapshot {
  telemetryLevel?: TelemetryLevel;
  hasSeenPrompt?: boolean;
  logRetentionDays?: 7 | 30 | 90 | 0;
  [key: string]: unknown;
}

interface LegacyTelemetry {
  enabled?: unknown;
  hasSeenPrompt?: unknown;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidLevel(value: unknown): value is TelemetryLevel {
  return value === "off" || value === "errors" || value === "full";
}

export const migration014: Migration = {
  version: 14,
  description:
    "Consolidate telemetry consent into privacy.{telemetryLevel,hasSeenPrompt} and drop legacy telemetry key (issue #5257)",
  up: (store) => {
    const legacyRaw = (store as unknown as { get: (k: string) => unknown }).get("telemetry");
    const privacyRaw = store.get("privacy") as unknown;

    const legacy: LegacyTelemetry = isPlainObject(legacyRaw) ? (legacyRaw as LegacyTelemetry) : {};
    const privacy: PrivacySnapshot = isPlainObject(privacyRaw)
      ? (privacyRaw as PrivacySnapshot)
      : {};

    const nextPrivacy: PrivacySnapshot = { ...privacy };

    if (!isValidLevel(nextPrivacy.telemetryLevel)) {
      nextPrivacy.telemetryLevel = legacy.enabled === true ? "errors" : "off";
    }

    if (typeof nextPrivacy.hasSeenPrompt !== "boolean") {
      nextPrivacy.hasSeenPrompt = legacy.hasSeenPrompt === true;
    }

    store.set("privacy", nextPrivacy as never);

    // Remove the legacy top-level key. electron-store v11 throws on
    // `store.set(key, undefined)`, so use `delete` directly. The TypeScript
    // schema no longer includes `telemetry`, so the cast is required.
    const legacyDelete = (store as unknown as { delete?: (key: string) => void }).delete;
    if (typeof legacyDelete === "function" && legacyRaw !== undefined) {
      legacyDelete.call(store, "telemetry");
    }
  },
};
