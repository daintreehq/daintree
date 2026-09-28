import type { HostHandshakeInfo } from "../../../shared/types/remoteHosts.js";
import type { OwnedProcess, ProcessSpawner } from "./hostCommands.js";

/**
 * Advertise this host on the local network as `_daintree._tcp` while Host
 * mode is on, through the system's own mDNS tools: `dns-sd -R` on macOS and
 * `avahi-publish-service` on Linux when Avahi is installed. Discovery only
 * says the machine is there; clients still connect over SSH, so the port
 * advertised is SSH's and the TXT record carries the build, never a secret.
 */

export const DAINTREE_SERVICE_TYPE = "_daintree._tcp";
const SSH_PORT = "22";

export type AdvertiseState =
  | { status: "off" }
  | { status: "advertising"; tool: string; instanceName: string }
  | { status: "unavailable"; reason: string };

export function advertiseTxtRecords(handshake: HostHandshakeInfo): string[] {
  return [
    `txtvers=1`,
    `version=${handshake.version}`,
    `commit=${handshake.commit}`,
    `platform=${handshake.platform}`,
    `arch=${handshake.arch}`,
    `transport=ssh`,
  ];
}

/** mDNS instance names are at most 63 bytes; keep the machine name readable. */
export function advertiseInstanceName(hostName: string): string {
  const short = hostName.replace(/\.local\.?$/i, "").trim() || "Daintree host";
  let name = short;
  while (Buffer.byteLength(name) > 63) name = name.slice(0, -1);
  return name;
}

export function advertiseCommand(input: {
  platform: NodeJS.Platform;
  instanceName: string;
  handshake: HostHandshakeInfo;
}): { file: string; args: string[] } | null {
  const txt = advertiseTxtRecords(input.handshake);
  if (input.platform === "darwin") {
    return {
      file: "dns-sd",
      args: ["-R", input.instanceName, DAINTREE_SERVICE_TYPE, "local", SSH_PORT, ...txt],
    };
  }
  if (input.platform === "linux") {
    return {
      file: "avahi-publish-service",
      args: [input.instanceName, DAINTREE_SERVICE_TYPE, SSH_PORT, ...txt],
    };
  }
  return null;
}

export class HostAdvertiser {
  private child: OwnedProcess | null = null;
  private state: AdvertiseState = { status: "off" };

  constructor(
    private readonly deps: {
      platform: NodeJS.Platform;
      hostName: string;
      handshake: HostHandshakeInfo;
      spawn: ProcessSpawner;
      onChange?: () => void;
    }
  ) {}

  getState(): AdvertiseState {
    return this.state;
  }

  start(): void {
    if (this.child) return;
    const instanceName = advertiseInstanceName(this.deps.hostName);
    const command = advertiseCommand({
      platform: this.deps.platform,
      instanceName,
      handshake: this.deps.handshake,
    });
    if (!command) {
      this.set({ status: "unavailable", reason: "No mDNS tool on this platform" });
      return;
    }
    let child: OwnedProcess;
    try {
      child = this.deps.spawn(command.file, command.args);
    } catch (error) {
      this.set({ status: "unavailable", reason: (error as Error).message });
      return;
    }
    this.child = child;
    child.onExit(({ code, notFound }) => {
      if (this.child !== child) return;
      this.child = null;
      this.set({
        status: "unavailable",
        reason: notFound
          ? `${command.file} isn't installed`
          : `${command.file} exited${code !== null ? ` with code ${code}` : ""}`,
      });
    });
    // Only if the spawn didn't already fail synchronously through onExit.
    if (this.child === child) {
      this.set({ status: "advertising", tool: command.file, instanceName });
    }
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
    this.set({ status: "off" });
  }

  private set(state: AdvertiseState): void {
    this.state = state;
    this.deps.onChange?.();
  }
}
