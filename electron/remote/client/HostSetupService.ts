import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  formatHostConnection,
  sameHostConnection,
  type HostConnection,
  type HostDescriptor,
  type HostId,
  type OperationId,
  type OperationOutcome,
} from "../../../shared/types/remoteHosts.js";
import type {
  DiscoveredHost,
  HostInstallPlan,
  HostProbeResult,
  HostSetupTarget,
  InstallHostPayload,
  InstallHostResult,
  PlanInstallPayload,
  RemoteHostsEvent,
  StartHostModeResult,
} from "../../../shared/types/ipc/remoteHosts.js";
import {
  OperationRegistry,
  normalizeOperationId,
} from "../../services/operations/OperationRegistry.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CommandRunner } from "./commandRunner.js";
import { connectionKey, requireHostConnection, unsupportedConnection } from "./connection.js";
import { discoverHosts } from "./discovery.js";
import { type ArtifactChecksum, lookupArtifactChecksum } from "./clientBuild.js";
import { runHostInstall } from "./hostInstaller.js";
import { bootstrapHostMode, LINUX_START_SCRIPT, MAC_START_SCRIPT } from "./hostModeBootstrap.js";
import { probeHost, type ProbeOutcome } from "./hostProbe.js";
import { NIGHTLY_FEED_URL, STABLE_FEED_URL, type ClientBuild, planInstall } from "./installPlan.js";
import { createSshCommandChannel, failureDetail, type HostCommandChannel } from "./remoteShell.js";
import { closeSshMaster, controlPathFor } from "./sshTransport.js";

/**
 * The Add host flow and host upkeep behind the `remoteHosts` namespace:
 * discover machines, check one over SSH, install or update its build as a
 * tracked operation, turn Host mode on there, and clean up after a forgotten
 * host. Everything reaches the host through a {@link HostCommandChannel}: the
 * system `ssh` today.
 */

export interface HostSetupDeps {
  run: CommandRunner;
  /** Daintree-owned directory holding control sockets (see SshTransport). */
  clientDir: string;
  platform: NodeJS.Platform;
  knownConnections(): HostConnection[];
  clientBuild(): ClientBuild;
  /** Agents the host reports working; null when unobservable (not connected, no summary). */
  workingAgents(hostId: HostId | null): Promise<number | null>;
  reconnect?(hostId: HostId): Promise<boolean | null>;
  download(url: string, destination: string, signal: AbortSignal): Promise<void>;
  /** The release feed's checksum for an artifact; defaults to reading the feed's update manifest. */
  checksum?(url: string, signal: AbortSignal): Promise<ArtifactChecksum | null>;
  emit(event: RemoteHostsEvent): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?: () => number;
  idlePollMs?: number;
  /** How commands reach a host; by its connection kind (ssh over the shared ControlMaster) unless given. */
  channelFor?(connection: HostConnection): HostCommandChannel;
}

function requireTarget(payload: unknown): HostConnection {
  return requireHostConnection((payload as { connection?: unknown } | null)?.connection);
}

/** Per-machine cache key: an ssh host keeps the key of its target alone. */
/** How long a host started for a connection gets to begin listening. */
const START_LISTEN_TIMEOUT_MS = 60_000;

function targetKey(connection: HostConnection): string {
  let key: string;
  switch (connection.kind) {
    case "ssh":
      key = connection.target;
      break;
    default:
      key = connectionKey(connection);
  }
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AppError({ code: "CANCELLED", message: "Cancelled" }));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError({ code: "CANCELLED", message: "Cancelled" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class HostSetupService {
  private readonly operations: OperationRegistry;
  private readonly targets = new Map<OperationId, HostConnection>();

  constructor(private readonly deps: HostSetupDeps) {
    this.operations = new OperationRegistry({
      now: deps.now,
      emit: (_projectId, event) => {
        const opId = event.type === "progress" ? event.progress.opId : event.record.opId;
        const connection = this.targets.get(opId);
        if (!connection) return;
        if (event.type === "progress") {
          deps.emit({ type: "install-progress", opId, connection, progress: event.progress });
        } else {
          deps.emit({ type: "install-settled", opId, connection, outcome: event.record.outcome });
        }
      },
    });
  }

  discover(signal?: AbortSignal): Promise<DiscoveredHost[]> {
    return discoverHosts({
      run: this.deps.run,
      platform: this.deps.platform,
      knownConnections: this.deps.knownConnections(),
      signal,
    });
  }

  async probe(payload: HostSetupTarget): Promise<HostProbeResult> {
    return (await this.probeOutcome(requireTarget(payload))).result;
  }

  async planInstall(payload: PlanInstallPayload): Promise<HostInstallPlan> {
    const outcome = await this.probeOutcome(requireTarget(payload));
    return planInstall({
      client: this.deps.clientBuild(),
      probe: outcome.result,
      linuxPackage: payload.linuxPackage,
      appImageConflict: outcome.parsed?.appImageConflict ?? null,
    });
  }

  install(payload: InstallHostPayload): Promise<InstallHostResult> {
    const connection = requireTarget(payload);
    const opId = normalizeOperationId(payload?.opId);
    if (!opId) throw new AppError({ code: "VALIDATION", message: "opId is required" });
    const whileWorking = payload.whileWorking ?? "refuse";
    if (!["refuse", "proceed", "wait-for-idle"].includes(whileWorking)) {
      throw new AppError({ code: "VALIDATION", message: "whileWorking is not valid" });
    }
    if (payload.linuxPackage !== undefined && !["deb", "appimage"].includes(payload.linuxPackage)) {
      throw new AppError({ code: "VALIDATION", message: "linuxPackage is not valid" });
    }
    if (!this.targets.has(opId)) this.targets.set(opId, connection);
    const normalized: InstallHostPayload = {
      opId,
      connection,
      hostId: typeof payload.hostId === "string" ? payload.hostId : undefined,
      linuxPackage: payload.linuxPackage,
      whileWorking,
    };
    return this.operations.run(
      {
        opId,
        kind: "host-update",
        projectId: null,
        dedupKey: `host-update:${connectionKey(connection)}`,
        fingerprint: JSON.stringify([
          connectionKey(connection),
          normalized.hostId ?? null,
          normalized.linuxPackage ?? null,
          whileWorking,
        ]),
      },
      async (handle) => {
        const controller = new AbortController();
        handle.onCancel(() => controller.abort());
        const shell = this.shellFor(connection);
        return runHostInstall(
          normalized,
          {
            shell,
            run: this.deps.run,
            client: this.deps.clientBuild(),
            probe: (signal) => this.probeOutcome(connection, shell, signal),
            workingAgents: (hostId) => this.deps.workingAgents(hostId),
            download: (url, destination, signal) => this.deps.download(url, destination, signal),
            checksum: (url, signal) =>
              this.deps.checksum
                ? this.deps.checksum(url, signal)
                : lookupArtifactChecksum({ url, signal }),
            cacheDir: this.cacheDirFor(connection),
            reconnect: this.deps.reconnect,
            sleep: this.deps.sleep ?? abortableSleep,
            now: this.deps.now,
            idlePollMs: this.deps.idlePollMs,
          },
          controller.signal,
          (progress) => handle.progress(progress)
        );
      },
      {
        // A refusal changed nothing: the record says so rather than "succeeded".
        recordResult: (result) =>
          result.status === "agents-working"
            ? { status: result.status, working: result.working }
            : { status: result.status },
      }
    );
  }

  installStatus(payload: { opId: OperationId }): OperationOutcome {
    const opId = normalizeOperationId(payload?.opId);
    return opId ? this.operations.status(opId) : { status: "unknown" };
  }

  cancelInstall(payload: { opId: OperationId }): boolean {
    const opId = normalizeOperationId(payload?.opId);
    return opId ? this.operations.cancel(opId) : false;
  }

  /**
   * Turn Host mode on for good on the machine and read back that it is: the
   * host's own Daintree saves the setting, installs start at login and checks
   * its keychain, as its Settings switch would. See hostModeBootstrap.ts.
   */
  async startHostMode(payload: HostSetupTarget): Promise<StartHostModeResult> {
    const connection = requireTarget(payload);
    const channel = this.shellFor(connection);
    const before = await this.probeOutcome(connection, channel);
    if (!before.parsed) return { probe: before.result, lingerRefused: null };
    return bootstrapHostMode(connection, before, {
      channel,
      probe: () => this.probeOutcome(connection, channel),
      sleep: this.deps.sleep ?? abortableSleep,
      now: this.deps.now,
    });
  }

  /**
   * Start Daintree on a host where it is set up but not serving, as after a
   * reboot or a power cut, so a connection can carry on. Starts it as it was
   * set up and changes nothing about it: never installs, never writes a
   * service, never turns on Host mode or start at login. Consent is what
   * survives a reboot there: a Mac's own Host mode record saying on, a Linux
   * user service that setup installed. Skipped while an install or update for
   * the host runs (it stops and starts the host itself). Throws why it
   * couldn't start (no logged-in session on a Mac, a failed service).
   */
  async ensureHostRunning(
    connection: HostConnection,
    signal?: AbortSignal
  ): Promise<"listening" | "started" | "not-startable"> {
    if (this.installRunningFor(connection)) return "not-startable";
    const channel = this.shellFor(connection);
    const outcome = await this.probeOutcome(connection, channel, signal);
    const probe = outcome.result;
    if (!outcome.parsed || !probe.reachable || !probe.install) return "not-startable";
    if (probe.hostModeListening) return "listening";
    if (probe.hostModeState?.enabled === false) return "not-startable";
    const script =
      probe.platform === "darwin" && probe.hostModeState?.enabled === true
        ? MAC_START_SCRIPT
        : probe.platform === "linux" && probe.advice.hostModeUnit === true
          ? LINUX_START_SCRIPT
          : null;
    if (!script) return "not-startable";
    // Last look before changing anything on the host.
    if (signal?.aborted || this.installRunningFor(connection)) return "not-startable";
    const label = formatHostConnection(connection);
    const started = await channel.exec(script, { timeoutMs: 30_000, signal });
    if (started.code !== 0) {
      throw new AppError({
        code: "INTERNAL",
        message: `Couldn't start Daintree on the host: ${failureDetail(started, "ssh failed")}`,
        userMessage:
          probe.platform === "darwin"
            ? `Couldn't start Daintree on ${label}. Log in there (or turn on automatic login), then connect again.`
            : `Couldn't start Daintree's service on ${label}: ${failureDetail(started, "systemctl failed")}`,
      });
    }
    const sleep = this.deps.sleep ?? abortableSleep;
    const now = this.deps.now ?? Date.now;
    const deadline = now() + START_LISTEN_TIMEOUT_MS;
    while (now() < deadline) {
      if (signal?.aborted) return "not-startable";
      await sleep(1_000, signal ?? new AbortController().signal);
      const next = await this.probeOutcome(connection, channel, signal);
      if (next.result.hostModeListening) return "started";
    }
    throw new AppError({
      code: "INTERNAL",
      message: "The host's Daintree started but never listened",
      userMessage: `Daintree started on ${label} but didn't begin listening within a minute.`,
    });
  }

  /** An install or update for this host is running: it stops and starts Daintree there itself. */
  private installRunningFor(connection: HostConnection): boolean {
    for (const [opId, target] of this.targets) {
      if (
        sameHostConnection(target, connection) &&
        this.operations.status(opId).status === "running"
      ) {
        return true;
      }
    }
    return false;
  }

  /** Forgetting a host drops what reaching it left here (an SSH master and control socket) and any cached bundles. */
  async forgetArtifacts(descriptor: Pick<HostDescriptor, "connection">): Promise<void> {
    const { connection } = descriptor;
    switch (connection.kind) {
      case "ssh":
        await closeSshMaster(this.deps.run, this.deps.clientDir, connection.target, 10_000);
        break;
    }
    await fs.rm(this.cacheDirFor(connection), { recursive: true, force: true }).catch(() => {});
  }

  private cacheDirFor(connection: HostConnection): string {
    return path.join(this.deps.clientDir, "bundles", targetKey(connection));
  }

  /** The command channel for a connection, by its kind. */
  private shellFor(connection: HostConnection): HostCommandChannel {
    if (this.deps.channelFor) return this.deps.channelFor(connection);
    switch (connection.kind) {
      case "ssh":
        return createSshCommandChannel({
          target: connection.target,
          controlPath: controlPathFor(this.deps.clientDir, connection.target),
          run: this.deps.run,
        });
      default:
        // A new kind brings its own channel (a WSL one runs `wsl.exe -d <distro> -- sh -c`).
        throw unsupportedConnection(connection, "Setting up a host");
    }
  }

  private async probeOutcome(
    connection: HostConnection,
    shell: HostCommandChannel = this.shellFor(connection),
    signal?: AbortSignal
  ): Promise<ProbeOutcome> {
    await fs.mkdir(this.deps.clientDir, { recursive: true, mode: 0o700 }).catch(() => {});
    return probeHost({
      connection,
      shell,
      client: this.deps.clientBuild(),
      options: signal ? { signal } : undefined,
    });
  }
}

export const RELEASE_FEED_PREFIXES = [STABLE_FEED_URL, NIGHTLY_FEED_URL] as const;
