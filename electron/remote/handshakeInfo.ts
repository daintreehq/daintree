import { app } from "electron";
import {
  REMOTE_PROTOCOL_VERSION,
  type HostArch,
  type HostHandshakeInfo,
  type HostPlatform,
} from "../../shared/types/remoteHosts.js";
import { BUILD_COMMIT } from "./buildGate.js";

/** What this process says about itself in a link handshake. */
export function getLocalHandshakeInfo(): HostHandshakeInfo {
  return {
    version: app.getVersion(),
    commit: BUILD_COMMIT,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    platform: (process.platform === "darwin" ? "darwin" : "linux") satisfies HostPlatform,
    arch: (process.arch === "arm64" ? "arm64" : "x64") satisfies HostArch,
  };
}
