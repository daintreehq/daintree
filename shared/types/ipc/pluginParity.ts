import type { HostId, PluginIncompatibleReason } from "../remoteHosts.js";

export type PluginParityGroup =
  "only-here" | "only-on-host" | "version-differs" | "incompatible" | "same";

export interface PluginParityRow {
  pluginId: string;
  displayName: string;
  group: PluginParityGroup;
  localVersion: string | null;
  hostVersion: string | null;
  incompatibility: PluginIncompatibleReason | null;
  /** Action the row offers: install or update on the host. */
  action: "install-on-host" | "update-on-host" | null;
}

export interface PluginParityPayload {
  hostId: HostId;
}

export interface InstallOnHostPayload {
  hostId: HostId;
  pluginId: string;
}
