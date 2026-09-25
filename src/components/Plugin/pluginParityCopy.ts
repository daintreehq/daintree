import type { PluginParityRow } from "@shared/types/ipc/pluginParity";
import type { PluginIncompatibleReason } from "@shared/types/remoteHosts";

const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux" };

function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/** Why a plugin can't serve a window on `host`, and what to do about it. */
export function describeIncompatibility(reason: PluginIncompatibleReason, host: string): string {
  switch (reason.kind) {
    case "engine":
      return `Requires Daintree ${reason.required}; ${host} runs ${reason.hostVersion}. It still loads there, but may not work.`;
    case "platform":
      return `Has no build for ${platformName(reason.hostPlatform)}, so it can't run on ${host}.`;
    case "remote-unsupported":
      return `Only works when you're sitting at ${host}.`;
    case "untrusted":
      return `Blocked on ${host} by the plugin blocklist.`;
    case "unconfigured":
      return `Set it up on ${host}: ${reason.missing.join(", ")} ${reason.missing.length === 1 ? "isn't" : "aren't"} set there.`;
  }
}

/** The compact line for a host: "plugins: 1 missing · 1 older", or null when they match. */
export function summarizePluginParity(rows: readonly PluginParityRow[]): string | null {
  const missing = rows.filter((row) => row.group === "only-here").length;
  const older = rows.filter(
    (row) => row.action === "update-on-host" && row.group === "version-differs"
  ).length;
  const newer = rows.filter(
    (row) => row.group === "version-differs" && row.action !== "update-on-host"
  ).length;
  const incompatible = rows.filter((row) => row.group === "incompatible").length;
  const parts = [
    missing > 0 ? `${missing} missing` : null,
    older > 0 ? `${older} older` : null,
    newer > 0 ? `${newer} newer` : null,
    incompatible > 0 ? `${incompatible} can't run` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `plugins: ${parts.join(" · ")}` : null;
}
