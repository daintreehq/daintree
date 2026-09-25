import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  HostDescriptor,
  HostId,
  OperationId,
  OperationOutcome,
} from "../../../shared/types/remoteHosts.js";
import type {
  DiscoveredHost,
  HostInstallPlan,
  HostProbeResult,
  InstallHostPayload,
  InstallHostResult,
  PlanInstallPayload,
  RemoteHostsEvent,
} from "../../../shared/types/ipc/remoteHosts.js";
import {
  OperationRegistry,
  normalizeOperationId,
} from "../../services/operations/OperationRegistry.js";
import { AppError } from "../../utils/errorTypes.js";
import type { CommandRunner } from "./commandRunner.js";
import { discoverHosts } from "./discovery.js";
import { runHostInstall } from "./hostInstaller.js";
import { MAC_APP_PATH, LINUX_UNIT_NAME, probeHost, type ProbeOutcome } from "./hostProbe.js";
import { NIGHTLY_FEED_URL, STABLE_FEED_URL, type ClientBuild, planInstall } from "./installPlan.js";
import { createRemoteShell, failureDetail, type RemoteShell } from "./remoteShell.js";
import { controlPathFor, isValidSshTarget } from "./sshTransport.js";

/**
 * The Add host flow and host upkeep behind the `remoteHosts` namespace:
 * discover machines, check one over SSH, install or update its build as a
 * tracked operation, start Host mode there, and clean up after a forgotten
 * host. Everything reaches the host through the system `ssh`.
 */

export interface HostSetupDeps {
  run: CommandRunner;
  /** Daintree-owned directory holding control sockets (see SshTransport). */
  clientDir: string;
  platform: NodeJS.Platform;
  knownTargets(): string[];
  clientBuild(): ClientBuild;
  /** Agents the host reports working; null when unobservable (not connected, no summary). */
  workingAgents(hostId: HostId | null): Promise<number | null>;
  reconnect?(hostId: HostId): Promise<boolean | null>;
  download(url: string, destination: string, signal: AbortSignal): Promise<void>;
  emit(event: RemoteHostsEvent): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  now?: () => number;
  idlePollMs?: number;
}

function requireTarget(payload: unknown): string {
  const target = (payload as { sshTarget?: unknown } | null)?.sshTarget;
  if (typeof target !== "string" || !isValidSshTarget(target.trim())) {
    throw new AppError({
      code: "VALIDATION",
      message: "Not a usable SSH target",
      userMessage: "Enter user@host, a host name, or an ~/.ssh/config alias.",
    });
  }
  return target.trim();
}

function targetKey(target: string): string {
  return crypto.createHash("sha256").update(target).digest("hex").slice(0, 16);
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
  private readonly targets = new Map<OperationId, string>();

  constructor(private readonly deps: HostSetupDeps) {
    this.operations = new OperationRegistry({
      now: deps.now,
      emit: (_projectId, event) => {
        const opId = event.type === "progress" ? event.progress.opId : event.record.opId;
        const sshTarget = this.targets.get(opId) ?? "";
        if (event.type === "progress") {
          deps.emit({ type: "install-progress", opId, sshTarget, progress: event.progress });
        } else {
          deps.emit({ type: "install-settled", opId, sshTarget, outcome: event.record.outcome });
        }
      },
    });
  }

  discover(signal?: AbortSignal): Promise<DiscoveredHost[]> {
    return discoverHosts({
      run: this.deps.run,
      platform: this.deps.platform,
      knownTargets: this.deps.knownTargets(),
      signal,
    });
  }

  async probe(payload: { sshTarget: string }): Promise<HostProbeResult> {
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
    const sshTarget = requireTarget(payload);
    const opId = normalizeOperationId(payload?.opId);
    if (!opId) throw new AppError({ code: "VALIDATION", message: "opId is required" });
    const whileWorking = payload.whileWorking ?? "refuse";
    if (!["refuse", "proceed", "wait-for-idle"].includes(whileWorking)) {
      throw new AppError({ code: "VALIDATION", message: "whileWorking is not valid" });
    }
    if (payload.linuxPackage !== undefined && !["deb", "appimage"].includes(payload.linuxPackage)) {
      throw new AppError({ code: "VALIDATION", message: "linuxPackage is not valid" });
    }
    if (!this.targets.has(opId)) this.targets.set(opId, sshTarget);
    const normalized: InstallHostPayload = {
      opId,
      sshTarget,
      hostId: typeof payload.hostId === "string" ? payload.hostId : undefined,
      linuxPackage: payload.linuxPackage,
      whileWorking,
    };
    return this.operations.run(
      {
        opId,
        kind: "host-update",
        projectId: null,
        dedupKey: `host-update:${sshTarget}`,
        fingerprint: JSON.stringify([
          sshTarget,
          normalized.hostId ?? null,
          normalized.linuxPackage ?? null,
          whileWorking,
        ]),
      },
      async (handle) => {
        const controller = new AbortController();
        handle.onCancel(() => controller.abort());
        const shell = this.shellFor(sshTarget);
        return runHostInstall(
          normalized,
          {
            shell,
            run: this.deps.run,
            client: this.deps.clientBuild(),
            probe: (signal) => this.probeOutcome(sshTarget, shell, signal),
            workingAgents: (hostId) => this.deps.workingAgents(hostId),
            download: (url, destination, signal) => this.deps.download(url, destination, signal),
            cacheDir: this.cacheDirFor(sshTarget),
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
   * Start Daintree in Host mode on the machine. macOS hands the launch to the
   * logged-in session (`open`), so the app never runs as a child of this SSH
   * session; Linux starts only the Daintree-owned user unit, and without one
   * the user turns Host mode on at the machine.
   */
  async startHostMode(payload: { sshTarget: string }): Promise<HostProbeResult> {
    const sshTarget = requireTarget(payload);
    const shell = this.shellFor(sshTarget);
    const before = await this.probeOutcome(sshTarget, shell);
    if (!before.parsed) return before.result;
    if (before.result.hostModeListening) return before.result;
    if (!before.result.install) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "Daintree is not installed on the host",
        userMessage: "Install Daintree on this host first.",
      });
    }
    let script: string;
    if (before.result.platform === "darwin") {
      script = `open -g -a '${MAC_APP_PATH}' --args --host-mode`;
    } else if (before.parsed.advice.hostModeUnit) {
      script = `systemctl --user start ${LINUX_UNIT_NAME}`;
    } else {
      throw new AppError({
        code: "UNSUPPORTED",
        message: "No Host mode unit on the host",
        userMessage:
          "Open Daintree on that machine and turn on “Allow this machine to be a host” in Settings → Hosts.",
      });
    }
    const started = await shell.exec(script, { timeoutMs: 30_000 });
    if (started.code !== 0) {
      throw new AppError({
        code: "INTERNAL",
        message: `Couldn't start Host mode: ${failureDetail(started, "ssh failed")}`,
        userMessage: "Couldn't start Daintree on the host. Log in there once and open it.",
      });
    }
    const sleep = this.deps.sleep ?? abortableSleep;
    const signal = new AbortController().signal;
    let after = before;
    for (let i = 0; i < 15 && !after.result.hostModeListening; i++) {
      await sleep(2_000, signal);
      after = await this.probeOutcome(sshTarget, shell);
    }
    return after.result;
  }

  /** Forgetting a host drops its SSH master, control socket and any cached bundles. */
  async forgetArtifacts(descriptor: Pick<HostDescriptor, "sshTarget">): Promise<void> {
    const target = descriptor.sshTarget;
    const controlPath = (() => {
      try {
        return controlPathFor(this.deps.clientDir, target);
      } catch {
        return null;
      }
    })();
    if (controlPath && isValidSshTarget(target)) {
      await this.deps
        .run("ssh", ["-o", `ControlPath=${controlPath}`, "-O", "exit", "--", target], {
          timeoutMs: 10_000,
        })
        .catch(() => {});
      if (!controlPath.includes("%")) await fs.rm(controlPath, { force: true }).catch(() => {});
    }
    await fs.rm(this.cacheDirFor(target), { recursive: true, force: true }).catch(() => {});
  }

  private cacheDirFor(target: string): string {
    return path.join(this.deps.clientDir, "bundles", targetKey(target));
  }

  private shellFor(target: string): RemoteShell {
    return createRemoteShell({
      target,
      controlPath: controlPathFor(this.deps.clientDir, target),
      run: this.deps.run,
    });
  }

  private async probeOutcome(
    target: string,
    shell: RemoteShell = this.shellFor(target),
    signal?: AbortSignal
  ): Promise<ProbeOutcome> {
    await fs.mkdir(this.deps.clientDir, { recursive: true, mode: 0o700 }).catch(() => {});
    return probeHost({
      sshTarget: target,
      shell,
      client: this.deps.clientBuild(),
      options: signal ? { signal } : undefined,
    });
  }
}

export const RELEASE_FEED_PREFIXES = [STABLE_FEED_URL, NIGHTLY_FEED_URL] as const;
