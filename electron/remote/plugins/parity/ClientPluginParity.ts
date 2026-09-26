import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import * as semver from "semver";
import os from "node:os";
import path from "node:path";
import type { PluginParityRow } from "../../../../shared/types/ipc/pluginParity.js";
import type {
  PluginInstallErrorCode,
  PluginInstallPhase,
  PluginInstallResult,
} from "../../../../shared/types/plugin.js";
import { isValidRemoteHostId, type HostId } from "../../../../shared/types/remoteHosts.js";
import { computePluginParity } from "../../../services/plugin/parity/diff.js";
import { pluginIncompatibleError } from "../../../services/plugin/parity/errors.js";
import {
  PluginInventorySchema,
  type PluginInventory,
  type PluginPlatform,
} from "../../../services/plugin/parity/inventory.js";
import { platformDisplayName } from "../../../services/plugin/parity/preflight.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { AppError } from "../../../utils/errorTypes.js";
import { fileTransferSource, type TransferSource } from "../../link/transfer.js";
import {
  InstallStatusResultSchema,
  MAX_STAGED_BYTES,
  PluginParityLinkMethod,
  STAGE_CHUNK_BYTES,
  StageBeginResultSchema,
  StageInstallResultSchema,
} from "./linkMethods.js";

/** The slice of a link session this client calls through. */
export interface ParitySession {
  readonly isOpen: boolean;
  call(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

/** This machine's own plugins, as the Shell's plugin service knows them. */
export interface LocalPlugins {
  inventory(): Promise<PluginInventory>;
  /** Folder of an installed (not built-in, not project) plugin, or null. */
  installedDir(pluginId: string): Promise<string | null>;
}

export interface ClientPluginParityDeps {
  sessionFor(hostId: HostId): ParitySession | null;
  isKnownHost(hostId: HostId): boolean;
  hostLabel(hostId: HostId): string;
  local: LocalPlugins;
  /** Pack a plugin folder into a package at `outputPath`. */
  pack(dir: string, outputPath: string): Promise<void>;
  tmpDir?: string;
  /** Mints the id an install is known by on the host. */
  newOperationId?: () => string;
  /** How long to keep asking the host about an install whose answer was lost. */
  reconcileTimeoutMs?: number;
  /** Interval between those questions, and between progress reads. */
  pollMs?: number;
}

/** A window's install job: its id, and where the host's install phases go. */
export interface InstallJob {
  jobId?: string;
  onPhase?: (phase: PluginInstallPhase) => void;
}

const INVENTORY_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
const STATUS_TIMEOUT_MS = 10_000;
const RECONCILE_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const PHASES: ReadonlySet<string> = new Set<PluginInstallPhase>([
  "downloading",
  "extracting",
  "validating",
  "activating",
]);
/** Windows remembered for the switch notice; far more than anyone has open. */
const MAX_NOTICE_WINDOWS = 256;

function notConnected(hostLabel: string): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: "The host is not connected",
    userMessage: `Not connected to ${hostLabel}. Connect to it and try again.`,
  });
}

function formatPlatforms(list: readonly PluginPlatform[]): string {
  return list.map(platformDisplayName).join(" and ");
}

/**
 * The Shell side of plugin parity. It compares this machine's plugins with a
 * host's, and installs one package on a host only when asked: nothing is
 * pushed, pulled or kept in step in the background.
 */
export class ClientPluginParity {
  private readonly noticeByWindow = new Map<number, HostId>();

  constructor(private readonly deps: ClientPluginParityDeps) {}

  private requireHost(hostId: unknown): HostId {
    if (typeof hostId !== "string" || !isValidRemoteHostId(hostId)) {
      throw new AppError({ code: "VALIDATION", message: "Invalid host" });
    }
    if (!this.deps.isKnownHost(hostId)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `Unknown host ${hostId}`,
        userMessage: "That host isn't in your host list any more.",
      });
    }
    return hostId;
  }

  /**
   * Whether `pluginId` is loaded on the host right now. The host's plugins are
   * the ones a remote view uses, so this is what a Shell-side feature bound to
   * such a view (site preview) asks instead of its own plugin service. Any
   * failure to ask reads as "not loaded": the feature is then refused, never
   * run on a guess.
   */
  async isPluginLoadedOnHost(hostId: HostId, pluginId: string): Promise<boolean> {
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) return false;
    try {
      const answer = await session.call(
        PluginParityLinkMethod.LOADED,
        { pluginId },
        { timeoutMs: STATUS_TIMEOUT_MS }
      );
      return answer === true;
    } catch {
      return false;
    }
  }

  private session(hostId: HostId): ParitySession {
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) throw notConnected(this.deps.hostLabel(hostId));
    return session;
  }

  private async hostInventory(hostId: HostId, session: ParitySession): Promise<PluginInventory> {
    let raw: unknown;
    try {
      raw = await session.call(
        PluginParityLinkMethod.INVENTORY,
        {},
        { timeoutMs: INVENTORY_TIMEOUT_MS }
      );
    } catch (error) {
      const hostLabel = this.deps.hostLabel(hostId);
      if (errorCode(error) === "HOST_DISCONNECTED") throw notConnected(hostLabel);
      throw new AppError({
        code: "INTERNAL",
        message: formatErrorMessage(error, "The host's plugin list could not be read"),
        userMessage: `Couldn't read the plugins installed on ${hostLabel}.`,
      });
    }
    const parsed = PluginInventorySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: "The host's plugin list could not be read",
        userMessage: `Couldn't read the plugins installed on ${this.deps.hostLabel(hostId)}.`,
      });
    }
    return parsed.data;
  }

  async diff(payload: { hostId: HostId }): Promise<PluginParityRow[]> {
    const hostId = this.requireHost(payload?.hostId);
    const session = this.session(hostId);
    const [local, host] = await Promise.all([
      this.deps.local.inventory(),
      this.hostInventory(hostId, session),
    ]);
    return computePluginParity(local, host);
  }

  /**
   * Whether the window showing `hostId` should get the one summary notice for
   * this switch: true the first time a window lands on a host, false again
   * until it moves to a different one.
   */
  claimSwitchNotice(windowId: number, payload: { hostId: HostId }): boolean {
    const hostId = this.requireHost(payload?.hostId);
    if (this.noticeByWindow.get(windowId) === hostId) return false;
    this.noticeByWindow.delete(windowId);
    this.noticeByWindow.set(windowId, hostId);
    while (this.noticeByWindow.size > MAX_NOTICE_WINDOWS) {
      const oldest = this.noticeByWindow.keys().next().value;
      if (oldest === undefined) break;
      this.noticeByWindow.delete(oldest);
    }
    return true;
  }

  /** "Install on <host>": copy this machine's package of one plugin there. */
  installOnHost(payload: { hostId: HostId; pluginId: string }): Promise<void> {
    return this.copyInstalledPlugin(payload, false);
  }

  /** "Update on <host>": replace the host's older copy with this machine's. */
  updateOnHost(payload: { hostId: HostId; pluginId: string }): Promise<void> {
    return this.copyInstalledPlugin(payload, true);
  }

  private async copyInstalledPlugin(
    payload: { hostId: HostId; pluginId: string },
    update: boolean
  ): Promise<void> {
    const hostId = this.requireHost(payload?.hostId);
    const pluginId = payload?.pluginId;
    if (typeof pluginId !== "string" || pluginId.length === 0 || pluginId.length > 256) {
      throw new AppError({ code: "VALIDATION", message: "Invalid plugin id" });
    }
    const hostLabel = this.deps.hostLabel(hostId);
    const session = this.session(hostId);
    const [local, host] = await Promise.all([
      this.deps.local.inventory(),
      this.hostInventory(hostId, session),
    ]);
    const entry = local.plugins.find((candidate) => candidate.pluginId === pluginId);
    const dir = entry ? await this.deps.local.installedDir(pluginId) : null;
    if (!entry || dir === null) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `Plugin ${pluginId} is not installed on this machine`,
        userMessage: `That plugin isn't installed on this machine, so there's nothing to copy to ${hostLabel}.`,
      });
    }
    const hostPlatform = host.platform === "darwin" ? "darwin" : "linux";
    if (entry.platforms !== null && !(entry.platforms as string[]).includes(host.platform)) {
      // Refused before a byte is copied: the host couldn't load it.
      throw pluginIncompatibleError(
        pluginId,
        {
          kind: "platform",
          hostPlatform,
          supported: entry.platforms.filter(
            (p): p is "darwin" | "linux" => p === "darwin" || p === "linux"
          ),
        },
        `${entry.displayName} has no build for ${platformDisplayName(host.platform)} (only ${formatPlatforms(entry.platforms)}); it can't run on ${hostLabel}.`,
        hostId
      );
    }
    const onHost = host.plugins.find((candidate) => candidate.pluginId === pluginId);
    if (!update && onHost) {
      throw new AppError({
        code: "VALIDATION",
        message: `Plugin ${pluginId} is already installed on host ${hostId}`,
        userMessage: `${entry.displayName} is already installed on ${hostLabel}.`,
      });
    }
    if (update && onHost && !isNewer(entry.version, onHost.version)) {
      throw new AppError({
        code: "VALIDATION",
        message: `Plugin ${pluginId} on host ${hostId} is not older than this machine's`,
        userMessage: `${hostLabel} has ${entry.displayName} ${onHost.version}, which isn't older than your ${entry.version}.`,
      });
    }
    if (update && !onHost) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `Plugin ${pluginId} is not installed on host ${hostId}`,
        userMessage: `${entry.displayName} isn't installed on ${hostLabel}; install it there instead.`,
      });
    }

    const staging = await fs.mkdtemp(
      path.join(this.deps.tmpDir ?? os.tmpdir(), "daintree-plugin-pack-")
    );
    try {
      const archive = path.join(staging, "package.dntr");
      await this.deps.pack(dir, archive);
      const result = await this.sendPackage(hostId, session, archive, { pluginId, update });
      if (result.status !== "installed") {
        throw installFailure(result, entry.displayName, hostLabel);
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * A `.dntr` on this machine, dropped or picked in a window attached to
   * `hostId`: send it and install it on the host, where the window's plugins
   * live. It passes the same gate a local install does (an absolute path to a
   * regular `.dntr` file that starts like a ZIP) before a byte leaves here, and
   * answers the way the local install does.
   */
  async installLocalPackageOnHost(
    hostId: HostId,
    localPath: string,
    job: InstallJob = {}
  ): Promise<PluginInstallResult> {
    this.requireHost(hostId);
    const session = this.session(hostId);
    const refusal = await localArchiveRefusal(localPath);
    if (refusal) return failed("archive_invalid", refusal);
    return this.sendPackage(hostId, session, localPath, { update: false }, job);
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? POLL_MS));
  }

  private async installStatus(session: ParitySession, opId: string) {
    const parsed = InstallStatusResultSchema.safeParse(
      await session.call(
        PluginParityLinkMethod.INSTALL_STATUS,
        { opId },
        { timeoutMs: STATUS_TIMEOUT_MS }
      )
    );
    return parsed.success ? parsed.data : null;
  }

  /** Relay the host's install phases to the window's job until stopped. */
  private followPhases(session: ParitySession, opId: string, job: InstallJob): () => void {
    const onPhase = job.onPhase;
    if (!onPhase) return () => {};
    let stopped = false;
    let last: string | null = null;
    void (async () => {
      while (!stopped) {
        await this.sleep();
        if (stopped || !session.isOpen) return;
        const status = await this.installStatus(session, opId).catch(() => null);
        if (stopped || status?.status !== "running") continue;
        const stage = status.progress?.stage ?? null;
        if (stage !== null && stage !== last && PHASES.has(stage)) {
          last = stage;
          onPhase(stage as PluginInstallPhase);
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }

  /**
   * The link dropped or timed out after the install was sent, so it may have
   * run. Ask the host what became of it (over whichever session is open by
   * then) before telling the person anything, so a retry is only offered for
   * an install that didn't happen.
   */
  private async reconcile(hostId: HostId, opId: string): Promise<PluginInstallResult> {
    const hostLabel = this.deps.hostLabel(hostId);
    const deadline = Date.now() + (this.deps.reconcileTimeoutMs ?? RECONCILE_TIMEOUT_MS);
    for (;;) {
      const session = this.deps.sessionFor(hostId);
      const status = session?.isOpen
        ? await this.installStatus(session, opId).catch(() => null)
        : null;
      switch (status?.status) {
        case "succeeded": {
          const result = StageInstallResultSchema.safeParse(status.result);
          if (result.success) return result.data;
          throw unknownOutcome(hostLabel);
        }
        case "cancelled":
          return { status: "cancelled" };
        case "failed":
          if (status.error.code === "CANCELLED") return { status: "cancelled" };
          throw hostFailure(status.error.code, hostLabel);
        case "unknown":
          throw new AppError({
            code: "INTERNAL",
            message: "The install never reached the host",
            userMessage: `The connection to ${hostLabel} dropped before the install reached it. Nothing was installed; try again.`,
          });
      }
      if (Date.now() >= deadline) throw unknownOutcome(hostLabel);
      await this.sleep();
    }
  }

  private async sendPackage(
    hostId: HostId,
    session: ParitySession,
    archivePath: string,
    target: { pluginId?: string; update: boolean },
    job: InstallJob = {}
  ): Promise<PluginInstallResult> {
    const hostLabel = this.deps.hostLabel(hostId);
    const opId = (this.deps.newOperationId ?? randomUUID)();
    let source: TransferSource;
    try {
      source = await fileTransferSource(archivePath);
    } catch {
      return failed("archive_invalid", "The plugin package couldn't be read on this machine");
    }
    try {
      if (source.size > MAX_STAGED_BYTES) {
        return failed("size_exceeded", `The plugin package is too large to send to ${hostLabel}`);
      }
      const { token } = StageBeginResultSchema.parse(
        await session.call(PluginParityLinkMethod.STAGE_BEGIN, {
          size: source.size,
          sha256: source.sha256,
          ...(job.jobId !== undefined ? { jobId: job.jobId } : {}),
        })
      );
      try {
        for (let offset = 0; offset < source.size; offset += STAGE_CHUNK_BYTES) {
          const length = Math.min(STAGE_CHUNK_BYTES, source.size - offset);
          const bytes = await source.read(offset, length);
          if (bytes.byteLength !== length) throw new Error("The package changed while sending");
          await session.call(PluginParityLinkMethod.STAGE_CHUNK, {
            token,
            offset,
            bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          });
        }
      } catch (error) {
        await session.call(PluginParityLinkMethod.STAGE_DISCARD, { token }).catch(() => undefined);
        throw error;
      }
      const stopPhases = this.followPhases(session, opId, job);
      try {
        return StageInstallResultSchema.parse(
          await session.call(
            PluginParityLinkMethod.STAGE_INSTALL,
            {
              token,
              update: target.update,
              opId,
              ...(target.pluginId ? { pluginId: target.pluginId } : {}),
            },
            { timeoutMs: INSTALL_TIMEOUT_MS }
          )
        );
      } catch (error) {
        if (errorCode(error) !== "OUTCOME_UNKNOWN") throw error;
      } finally {
        stopPhases();
      }
    } catch (error) {
      // The person's Cancel reached the host before its commit point.
      if (errorCode(error) === "CANCELLED") return { status: "cancelled" };
      throw restate(error, hostId, hostLabel);
    } finally {
      await Promise.resolve(source.close?.()).catch(() => {});
    }
    return this.reconcile(hostId, opId);
  }
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function localArchiveRefusal(localPath: string): Promise<string | null> {
  if (!path.isAbsolute(localPath)) return "Install path must be an absolute filesystem path";
  if (path.extname(localPath).toLowerCase() !== ".dntr") return "Only .dntr files can be installed";
  const stat = await fs.stat(localPath).catch(() => null);
  if (!stat) return "Couldn't read the dropped file";
  // Never open a FIFO or device: it could block the call forever.
  if (!stat.isFile()) return "That path isn't a regular file";
  const handle = await fs.open(localPath, "r").catch(() => null);
  if (!handle) return "Couldn't read the dropped file";
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return bytesRead === 4 && header.equals(ZIP_MAGIC)
      ? null
      : "That file isn't a valid .dntr plugin archive";
  } finally {
    await handle.close().catch(() => {});
  }
}

function failed(code: "archive_invalid" | "size_exceeded", message: string): PluginInstallResult {
  return { status: "failed", errors: [{ code, message }] };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function unknownOutcome(hostLabel: string): AppError {
  return new AppError({
    code: "OUTCOME_UNKNOWN",
    message: "The link dropped during a plugin install",
    userMessage: `The connection to ${hostLabel} dropped during the install. Check its plugin list before trying again.`,
  });
}

/**
 * A host-side failure by its code alone. The host's own text can carry its
 * paths or transport detail, so what the person reads is written here.
 */
function hostFailure(code: string | null, hostLabel: string): AppError {
  switch (code) {
    case "HOST_DISCONNECTED":
      return notConnected(hostLabel);
    case "OUTCOME_UNKNOWN":
      return unknownOutcome(hostLabel);
    case "RATE_LIMITED":
      return new AppError({
        code: "RATE_LIMITED",
        message: "The host is busy with other plugin installs",
        userMessage: `${hostLabel} is busy with other plugin installs. Try again in a moment.`,
      });
    case "VALIDATION":
      return new AppError({
        code: "VALIDATION",
        message: "The host refused the staged plugin package",
        userMessage: `The plugin package didn't reach ${hostLabel} intact. Try again.`,
      });
    case "PLUGIN_INCOMPATIBLE":
      return new AppError({
        code: "PLUGIN_INCOMPATIBLE",
        message: "The host refused the plugin as incompatible",
        userMessage: `That plugin can't run on ${hostLabel}.`,
      });
    default:
      return new AppError({
        code: "INTERNAL",
        message: `Plugin install on the host failed (${code ?? "no code"})`,
        userMessage: `Couldn't install the plugin on ${hostLabel}.`,
      });
  }
}

/** A host or link failure, restated with the host's name; typed plugin errors keep their details. */
function restate(error: unknown, hostId: HostId, hostLabel: string): Error {
  const code = errorCode(error);
  const details = (error as { details?: unknown } | null)?.details;
  if ((code === "PLUGIN_INCOMPATIBLE" || code === "PLUGIN_NOT_ON_HOST") && details) {
    const raw = details as { pluginId?: unknown; reason?: { kind?: unknown } };
    if (code === "PLUGIN_INCOMPATIBLE" && typeof raw.pluginId === "string" && raw.reason) {
      // Written here from the reason's kind: the host's own wording is not shown.
      return pluginIncompatibleError(
        raw.pluginId,
        raw.reason as Parameters<typeof pluginIncompatibleError>[1],
        incompatibleOnHost(raw.reason.kind, hostLabel),
        hostId
      );
    }
    return error as Error;
  }
  return hostFailure(code, hostLabel);
}

function incompatibleOnHost(kind: unknown, hostLabel: string): string {
  switch (kind) {
    case "platform":
      return `That plugin has no build for ${hostLabel}'s system, so it can't be installed there.`;
    case "untrusted":
      return `That plugin is blocked on ${hostLabel} by the plugin blocklist.`;
    case "engine":
      return `That plugin needs a different Daintree version than ${hostLabel} runs.`;
    default:
      return `That plugin can't be installed on ${hostLabel}.`;
  }
}

function isNewer(candidate: string, than: string): boolean {
  const a = semver.valid(candidate);
  const b = semver.valid(than);
  return a !== null && b !== null && semver.gt(a, b);
}

/** What the person reads for each way the host's install can refuse or fail. */
function installFailureReason(
  code: PluginInstallErrorCode | undefined,
  displayName: string,
  hostLabel: string
): string {
  switch (code) {
    case "archive_mismatch":
      return `${hostLabel}'s copy of ${displayName} changed since the comparison. Refresh the list and try again.`;
    case "lock_failed":
      return `${hostLabel} is busy installing another plugin. Try again in a moment.`;
    case "name_collision":
      return `${displayName} clashes with a plugin built into ${hostLabel}.`;
    case "extraction_timeout":
      return `${displayName} took too long to unpack on ${hostLabel}. Try again.`;
    case "archive_invalid":
    case "manifest_invalid":
    case "namespace_unauthorized":
    case "hash_failed":
    case "size_exceeded":
      return `${hostLabel} couldn't read this machine's package of ${displayName}.`;
    case "load_failed":
    case "unload_failed":
    case "swap_failed":
    case "swap_unrecoverable":
      return `${displayName} didn't load on ${hostLabel}. Check its plugin list.`;
    default:
      return `Couldn't install ${displayName} on ${hostLabel}.`;
  }
}

function installFailure(result: PluginInstallResult, displayName: string, hostLabel: string) {
  const code = result.status === "failed" ? result.errors[0]?.code : undefined;
  return new AppError({
    code: "INTERNAL",
    message: `Plugin install on the host did not complete (${result.status}${code ? `: ${code}` : ""})`,
    userMessage:
      result.status === "failed"
        ? installFailureReason(code, displayName, hostLabel)
        : result.status === "cancelled"
          ? `The install of ${displayName} on ${hostLabel} was cancelled.`
          : `Couldn't install ${displayName} on ${hostLabel}.`,
  });
}
