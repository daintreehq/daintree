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
  HostRestartImpact,
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
import { connectionKey, requireHostConnection, requireSupportedConnection } from "./connection.js";
import { discoverHosts, discoverWslDistros } from "./discovery.js";
import { type ArtifactChecksum, lookupArtifactChecksum } from "./clientBuild.js";
import { runHostInstall } from "./hostInstaller.js";
import { RestartImpactSchema } from "../metrics/linkMethods.js";
import { bootstrapHostMode, LINUX_START_SCRIPT, macStartScript } from "./hostModeBootstrap.js";
import { probeHost, type ProbeOutcome } from "./hostProbe.js";
import { NIGHTLY_FEED_URL, STABLE_FEED_URL, type ClientBuild, planInstall } from "./installPlan.js";
import { createSshCommandChannel, failureDetail, type HostCommandChannel } from "./remoteShell.js";
import { closeSshMaster, controlPathFor } from "./sshTransport.js";
import type { WslKeepalive } from "./wslKeepalive.js";
import { createWslCommandChannel } from "./wslShell.js";

/**
 * The Add host flow and host upkeep behind the `remoteHosts` namespace:
 * discover machines, check one over SSH, install or update its build as a
 * tracked operation, turn Host mode on there, and clean up after a forgotten
 * host. Everything reaches the host through a {@link HostCommandChannel}: the
 * system `ssh`, or `wsl.exe` for a Linux Host in a WSL distro on Windows.
 */

export interface HostSetupDeps {
  run: CommandRunner;
  /** Daintree-owned directory holding control sockets (see SshTransport). */
  clientDir: string;
  platform: NodeJS.Platform;
  knownConnections(): HostConnection[];
  clientBuild(): ClientBuild;
  /** What restarting the host would end, as it reports it now (unknown parts are null). */
  restartImpact(hostId: HostId | null): Promise<HostRestartImpact>;
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
  /**
   * A host on this connection is being removed or re-pointed: its cleanup
   * closes the SSH master, so nothing that changes the host starts meanwhile.
   */
  isRetiring?(connection: HostConnection): boolean;
  /** Holds WSL distros up between setup's commands; released when a host is forgotten. */
  wslKeepalive?: Pick<WslKeepalive, "touch" | "release">;
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
  /**
   * Connections a full probe found Daintree can't be started on (not
   * installed, Host mode off, quit on purpose, no way to start it), by
   * {@link connectionKey}. A failed dial there goes by that answer until
   * {@link recheckStart} says something changed.
   */
  private readonly unstartable = new Set<string>();
  /** Rechecks so far, by connection: a probe under way through one doesn't record what it saw before it. */
  private readonly rechecks = new Map<string, number>();

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
    // A Windows Shell's hosts are the WSL distros on this PC.
    if (this.deps.platform === "win32") {
      return discoverWslDistros({ knownConnections: this.deps.knownConnections() });
    }
    return discoverHosts({
      run: this.deps.run,
      platform: this.deps.platform,
      knownConnections: this.deps.knownConnections(),
      signal,
    });
  }

  async probe(payload: HostSetupTarget): Promise<HostProbeResult> {
    return (await this.probeOutcome(this.requireTarget(payload))).result;
  }

  async planInstall(payload: PlanInstallPayload): Promise<HostInstallPlan> {
    const outcome = await this.probeOutcome(this.requireTarget(payload));
    return planInstall({
      client: this.deps.clientBuild(),
      probe: outcome.result,
      linuxPackage: payload.linuxPackage,
      appImageConflict: outcome.parsed?.appImageConflict ?? null,
      allowDowngrade: payload.allowDowngrade === true,
    });
  }

  install(payload: InstallHostPayload): Promise<InstallHostResult> {
    const connection = this.requireTarget(payload);
    this.refuseWhileRetiring(connection);
    const opId = normalizeOperationId(payload?.opId);
    if (!opId) throw new AppError({ code: "VALIDATION", message: "opId is required" });
    const whileWorking = payload.whileWorking ?? "refuse";
    if (!["refuse", "proceed", "wait-for-idle"].includes(whileWorking)) {
      throw new AppError({ code: "VALIDATION", message: "whileWorking is not valid" });
    }
    if (payload.linuxPackage !== undefined && !["deb", "appimage"].includes(payload.linuxPackage)) {
      throw new AppError({ code: "VALIDATION", message: "linuxPackage is not valid" });
    }
    const confirmed =
      payload.confirmed === undefined
        ? undefined
        : RestartImpactSchema.safeParse(payload.confirmed);
    if (confirmed && !confirmed.success) {
      throw new AppError({ code: "VALIDATION", message: "confirmed is not valid" });
    }
    if (payload.allowDowngrade !== undefined && typeof payload.allowDowngrade !== "boolean") {
      throw new AppError({ code: "VALIDATION", message: "allowDowngrade is not valid" });
    }
    const stagedVersion = payload.applyStaged?.version;
    if (
      payload.applyStaged !== undefined &&
      (typeof stagedVersion !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(stagedVersion))
    ) {
      throw new AppError({ code: "VALIDATION", message: "applyStaged is not valid" });
    }
    if (!this.targets.has(opId)) this.targets.set(opId, connection);
    // An install changes what is there and starts it itself.
    this.recheckStart(connection);
    const normalized: InstallHostPayload = {
      opId,
      connection,
      hostId: typeof payload.hostId === "string" ? payload.hostId : undefined,
      linuxPackage: payload.linuxPackage,
      whileWorking,
      ...(confirmed ? { confirmed: confirmed.data } : {}),
      ...(payload.allowDowngrade === true ? { allowDowngrade: true } : {}),
      ...(stagedVersion !== undefined ? { applyStaged: { version: stagedVersion } } : {}),
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
          normalized.allowDowngrade === true,
          stagedVersion ?? null,
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
            restartImpact: (hostId) => this.deps.restartImpact(hostId),
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
          result.status === "needs-confirmation"
            ? { status: result.status, impact: result.impact }
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
    const connection = this.requireTarget(payload);
    this.refuseWhileRetiring(connection);
    const channel = this.shellFor(connection);
    const before = await this.probeOutcome(connection, channel);
    if (!before.parsed) {
      // Nothing was changed there: say why rather than return as if it had been checked.
      const detail = before.result.sshError?.trim();
      const message = `Couldn't check ${formatHostConnection(connection)}, so Host mode wasn't turned on.${detail ? ` ${detail}` : ""}`;
      throw new AppError({ code: "INTERNAL", message, userMessage: message });
    }
    this.refuseWhileRetiring(connection);
    try {
      return await bootstrapHostMode(connection, before, {
        channel,
        probe: () => this.probeOutcome(connection, channel),
        sleep: this.deps.sleep ?? abortableSleep,
        now: this.deps.now,
        updateChannel: this.deps.clientBuild().channel,
      });
    } finally {
      // Host mode may be on there now, whatever a dial that checked meanwhile saw.
      this.recheckStart(connection);
    }
  }

  /**
   * Start Daintree on a host where it is set up but not serving, as after a
   * reboot or a power cut, so a connection can carry on. Starts it as it was
   * set up and changes nothing about it: never installs, never writes a
   * service, never turns on Host mode or start at login. Consent is what
   * survives a reboot there: a Mac's own Host mode record saying on, a Linux
   * user service that setup installed. Skipped while an install or update for
   * the host runs (it stops and starts the host itself), and for a host the
   * last full probe found can't be started, until {@link recheckStart}.
   * `onStart` is called just before the start goes to the host. Throws why it
   * couldn't start (no logged-in session on a Mac, a failed service).
   */
  async ensureHostRunning(
    connection: HostConnection,
    signal?: AbortSignal,
    onStart?: () => void
  ): Promise<"listening" | "started" | "not-startable"> {
    if (this.isInstallRunning(connection) || this.deps.isRetiring?.(connection)) {
      return "not-startable";
    }
    const key = connectionKey(connection);
    if (this.unstartable.has(key)) return "not-startable";
    const rechecks = this.rechecks.get(key) ?? 0;
    const unstartable = (): "not-startable" => {
      if (rechecks === (this.rechecks.get(key) ?? 0) && !signal?.aborted) {
        this.unstartable.add(key);
      }
      return "not-startable";
    };
    const channel = this.shellFor(connection);
    const outcome = await this.probeOutcome(connection, channel, signal);
    const probe = outcome.result;
    // Nothing was learned: the next failed dial looks again.
    if (!outcome.parsed || !probe.reachable) return "not-startable";
    if (!probe.install) return unstartable();
    if (probe.hostModeListening) return "listening";
    if (probe.hostModeState?.enabled === false) return unstartable();
    // Quit there on purpose: starting it again would undo that.
    if (probe.hostModeState?.stopped === true) return unstartable();
    const script =
      probe.platform === "darwin" && probe.hostModeState?.enabled === true
        ? macStartScript(probe.install.path)
        : probe.platform === "linux" && probe.advice.hostModeUnit === true
          ? LINUX_START_SCRIPT
          : null;
    if (!script) return unstartable();
    // Last look before changing anything on the host.
    if (
      signal?.aborted ||
      this.isInstallRunning(connection) ||
      this.deps.isRetiring?.(connection)
    ) {
      return "not-startable";
    }
    const label = formatHostConnection(connection);
    onStart?.();
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

  /**
   * Something changed there that this machine saw (its Daintree answered, a
   * person asked to try again, setup ran): the next failed dial checks
   * whether Daintree can be started rather than going by the last answer.
   */
  recheckStart(connection: HostConnection): void {
    const key = connectionKey(connection);
    this.rechecks.set(key, (this.rechecks.get(key) ?? 0) + 1);
    this.unstartable.delete(key);
  }

  /** The payload's connection, if this platform's Shell can reach hosts that way. */
  private requireTarget(payload: unknown): HostConnection {
    return requireSupportedConnection(
      requireHostConnection((payload as { connection?: unknown } | null)?.connection),
      this.deps.platform
    );
  }

  private refuseWhileRetiring(connection: HostConnection): void {
    if (!this.deps.isRetiring?.(connection)) return;
    const message = `${formatHostConnection(connection)} is being removed or changed on this device. Try again once that finishes.`;
    throw new AppError({ code: "VALIDATION", message, userMessage: message });
  }

  /** An install or update for this host is running: it stops and starts Daintree there itself. */
  isInstallRunning(connection: HostConnection): boolean {
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
    this.recheckStart(connection);
    switch (connection.kind) {
      case "ssh":
        await closeSshMaster(this.deps.run, this.deps.clientDir, connection.target, 10_000);
        break;
      case "wsl":
        // The distro may stop once nothing else uses it; its Host goes with it.
        this.deps.wslKeepalive?.release(connection.distro);
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
    const supported = requireSupportedConnection(connection, this.deps.platform);
    switch (supported.kind) {
      case "ssh":
        return createSshCommandChannel({
          target: supported.target,
          controlPath: controlPathFor(this.deps.clientDir, supported.target),
          run: this.deps.run,
        });
      case "wsl": {
        const keepalive = this.deps.wslKeepalive;
        return createWslCommandChannel({
          distro: supported.distro,
          run: this.deps.run,
          // Not while the host is removed or re-pointed: its distro was just let go.
          keepalive: keepalive
            ? (distro) => {
                if (!this.deps.isRetiring?.(supported)) keepalive.touch(distro);
              }
            : undefined,
        });
      }
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
