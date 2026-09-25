import fs from "node:fs/promises";
import * as semver from "semver";
import os from "node:os";
import path from "node:path";
import type { PluginParityRow } from "../../../../shared/types/ipc/pluginParity.js";
import type { PluginInstallResult } from "../../../../shared/types/plugin.js";
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
}

const INVENTORY_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
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

  private session(hostId: HostId): ParitySession {
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) throw notConnected(this.deps.hostLabel(hostId));
    return session;
  }

  private async hostInventory(hostId: HostId, session: ParitySession): Promise<PluginInventory> {
    const parsed = PluginInventorySchema.safeParse(
      await session.call(PluginParityLinkMethod.INVENTORY, {}, { timeoutMs: INVENTORY_TIMEOUT_MS })
    );
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
  async installLocalPackageOnHost(hostId: HostId, localPath: string): Promise<PluginInstallResult> {
    this.requireHost(hostId);
    const session = this.session(hostId);
    const refusal = await localArchiveRefusal(localPath);
    if (refusal) return failed("archive_invalid", refusal);
    return this.sendPackage(hostId, session, localPath, { update: false });
  }

  private async sendPackage(
    hostId: HostId,
    session: ParitySession,
    archivePath: string,
    target: { pluginId?: string; update: boolean }
  ): Promise<PluginInstallResult> {
    const hostLabel = this.deps.hostLabel(hostId);
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
      return StageInstallResultSchema.parse(
        await session.call(
          PluginParityLinkMethod.STAGE_INSTALL,
          {
            token,
            update: target.update,
            ...(target.pluginId ? { pluginId: target.pluginId } : {}),
          },
          { timeoutMs: INSTALL_TIMEOUT_MS }
        )
      );
    } catch (error) {
      throw restate(error, hostId, hostLabel);
    } finally {
      await Promise.resolve(source.close?.()).catch(() => {});
    }
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

/** A host or link failure, restated with the host's name; typed plugin errors keep their details. */
function restate(error: unknown, hostId: HostId, hostLabel: string): Error {
  const code = errorCode(error);
  const details = (error as { details?: unknown } | null)?.details;
  if ((code === "PLUGIN_INCOMPATIBLE" || code === "PLUGIN_NOT_ON_HOST") && details) {
    const userMessage = (error as { userMessage?: unknown }).userMessage;
    const raw = details as { pluginId?: unknown; reason?: unknown };
    if (code === "PLUGIN_INCOMPATIBLE" && typeof raw.pluginId === "string" && raw.reason) {
      return pluginIncompatibleError(
        raw.pluginId,
        raw.reason as Parameters<typeof pluginIncompatibleError>[1],
        typeof userMessage === "string"
          ? `${stripPeriod(userMessage)}; it can't be installed on ${hostLabel}.`
          : `That plugin can't run on ${hostLabel}.`,
        hostId
      );
    }
    return error as Error;
  }
  if (error instanceof AppError && code !== "HOST_DISCONNECTED" && code !== "OUTCOME_UNKNOWN") {
    return error;
  }
  if (code === "HOST_DISCONNECTED") return notConnected(hostLabel);
  if (code === "OUTCOME_UNKNOWN") {
    return new AppError({
      code: "OUTCOME_UNKNOWN",
      message: "The link dropped during a plugin install",
      userMessage: `The connection to ${hostLabel} dropped during the install. Check its plugin list before trying again.`,
    });
  }
  return new AppError({
    code: code === "RATE_LIMITED" ? "RATE_LIMITED" : "INTERNAL",
    message: formatErrorMessage(error, "Plugin install on the host failed"),
    userMessage: `Couldn't install the plugin on ${hostLabel}.`,
  });
}

function isNewer(candidate: string, than: string): boolean {
  const a = semver.valid(candidate);
  const b = semver.valid(than);
  return a !== null && b !== null && semver.gt(a, b);
}

function stripPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

function installFailure(result: PluginInstallResult, displayName: string, hostLabel: string) {
  const reason =
    result.status === "failed"
      ? (result.errors[0]?.message ?? "the install failed")
      : "the install didn't finish";
  return new AppError({
    code: "INTERNAL",
    message: `Plugin install on the host did not complete (${result.status})`,
    userMessage: `Couldn't install ${displayName} on ${hostLabel}: ${reason}`,
  });
}
