import {
  HOST_SETTING_KEYS,
  hostSettingRefusal,
  HostSettingsPatchSchema,
  HostSettingsReadingSchema,
  HostSettingsUpdateReplySchema,
  isHostSettingKey,
  type HostSettingKey,
  type HostSettingLeaf,
  type HostSettingsReadPayload,
  type HostSettingsReading,
  type HostSettingsSnapshot,
  type HostSettingsUpdatePayload,
  type HostSettingsUpdateResult,
} from "../../../shared/types/hostSettings.js";
import { isValidRemoteHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { SettingsControlLinkMethod } from "./linkMethods.js";

/** The slice of a link session this client calls through. */
export interface SettingsControlSession {
  readonly isOpen: boolean;
  call(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

export interface ClientSettingsControlDeps {
  sessionFor(hostId: HostId): SettingsControlSession | null;
  /** Keep the host's connection open until released, across an update. */
  holdHost?(hostId: HostId): () => void;
  isKnownHost(hostId: HostId): boolean;
  hostLabel(hostId: HostId): string;
}

const READ_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 30_000;

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/** Codes that are the host's own answer: the change was refused, not lost. */
const REFUSALS: ReadonlySet<string> = new Set([
  "VALIDATION",
  "PERMISSION",
  "UNSUPPORTED",
  "RATE_LIMITED",
]);

/**
 * Exactly the keys asked about, each once, each holding a value of its own
 * kind. Anything less can't say what the host has, so it is never read as
 * a confirmation.
 */
function coversExactly(settings: readonly HostSettingLeaf[], keys: readonly HostSettingKey[]) {
  if (settings.length !== keys.length) return false;
  const seen = new Set<HostSettingKey>();
  for (const leaf of settings) {
    if (!keys.includes(leaf.key) || seen.has(leaf.key)) return false;
    if (hostSettingRefusal(leaf.key, leaf.value) !== null) return false;
    seen.add(leaf.key);
  }
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The Shell side of editing a host's settings by name (#14167), for Settings
 * here and for this machine's assistants. It works per session, so no window
 * or project needs to be on the host, and it never changes this machine: a
 * host's settings travel only to and from that host.
 */
export class ClientSettingsControl {
  constructor(private readonly deps: ClientSettingsControlDeps) {}

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

  private session(hostId: HostId): SettingsControlSession {
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: "The host is not connected",
        userMessage: `Not connected to ${this.deps.hostLabel(hostId)}. Connect to it and try again.`,
      });
    }
    return session;
  }

  private translate(error: unknown, hostId: HostId, fallback: string): AppError {
    const host = this.deps.hostLabel(hostId);
    switch (errorCode(error)) {
      case "UNSUPPORTED":
        return new AppError({
          code: "UNSUPPORTED",
          message: "The host can't be edited from here",
          userMessage: `Daintree on ${host} is too old to change its settings from here. Update it there and try again.`,
        });
      case "RATE_LIMITED":
        return new AppError({
          code: "RATE_LIMITED",
          message: "The host is limiting changes",
          userMessage: `${host} is taking too many changes at once. Wait a moment and try again.`,
        });
      case "HOST_DISCONNECTED":
        return new AppError({
          code: "HOST_DISCONNECTED",
          message: "The host is not connected",
          userMessage: `Not connected to ${host}. Connect to it and try again.`,
        });
      case "VALIDATION":
      case "PERMISSION": {
        // The host's own fixed words on why it wouldn't take the value.
        const said =
          typeof error === "object" && error !== null && "userMessage" in error
            ? error.userMessage
            : undefined;
        return new AppError({
          code: errorCode(error) as "VALIDATION" | "PERMISSION",
          message: formatErrorMessage(error, `${host} refused the change`),
          userMessage:
            typeof said === "string" && said.length > 0 && said.length <= 200
              ? `${host}: ${said}`
              : `${host} refused the change.`,
        });
      }
      default:
        return new AppError({
          code: "INTERNAL",
          message: formatErrorMessage(error, fallback),
          userMessage: `${fallback}.`,
        });
    }
  }

  private snapshot(hostId: HostId, reading: HostSettingsReading): HostSettingsSnapshot {
    return { hostId, hostName: this.deps.hostLabel(hostId), scope: "host", ...reading };
  }

  /**
   * As `readFromHost`, but a host from before Canopy read locally knows no
   * `canopyModel` and refuses any read naming it: such a host is read without
   * it, and its reading simply has no model (`readsCanopyLocally`).
   */
  private async readFrom(
    hostId: HostId,
    keys: readonly HostSettingKey[]
  ): Promise<HostSettingsReading> {
    try {
      return await this.readFromHost(hostId, keys);
    } catch (error) {
      // Only the host's own refusal of a key it doesn't know says it is older:
      // a timeout, a disconnect or a rate limit says nothing of its version.
      const without = keys.filter((key) => key !== "canopyModel");
      if (errorCode(error) !== "VALIDATION" || without.length === keys.length) throw error;
      if (without.length === 0) throw error;
      return this.readFromHost(hostId, without);
    }
  }

  /** Whether the host reads Canopy with its own model, rather than the retired hosted service. */
  private async readsCanopyLocally(hostId: HostId): Promise<boolean> {
    try {
      const reading = await this.readFromHost(hostId, ["canopyModel"]);
      return reading.settings.some((leaf) => leaf.key === "canopyModel");
    } catch (error) {
      // Refused as an unknown key: an older host. Anything else is a failure to ask.
      if (errorCode(error) === "VALIDATION") return false;
      throw error;
    }
  }

  private async readFromHost(
    hostId: HostId,
    keys: readonly HostSettingKey[]
  ): Promise<HostSettingsReading> {
    let raw: unknown;
    try {
      raw = await this.session(hostId).call(
        SettingsControlLinkMethod.READ,
        { keys },
        { timeoutMs: READ_TIMEOUT_MS }
      );
    } catch (error) {
      throw this.translate(
        error,
        hostId,
        `Couldn't read settings on ${this.deps.hostLabel(hostId)}`
      );
    }
    const parsed = HostSettingsReadingSchema.safeParse(raw);
    if (!parsed.success || !coversExactly(parsed.data.settings, keys)) {
      throw new AppError({
        code: "INTERNAL",
        message: "The host's settings reply was malformed",
        userMessage: `${this.deps.hostLabel(hostId)} answered in a way this Daintree can't read. Update both to the same version.`,
      });
    }
    return parsed.data;
  }

  /** The named settings (every one by default) as the host reads them now. */
  async read(payload: HostSettingsReadPayload): Promise<HostSettingsSnapshot> {
    const hostId = this.requireHost(payload?.hostId);
    const keys =
      payload.keys === undefined
        ? [...HOST_SETTING_KEYS]
        : HOST_SETTING_KEYS.filter((key) => payload.keys!.includes(key));
    if (payload.keys !== undefined && !payload.keys.every(isHostSettingKey)) {
      throw new AppError({ code: "VALIDATION", message: "Unknown host setting" });
    }
    if (keys.length === 0) throw new AppError({ code: "VALIDATION", message: "No settings named" });
    return this.snapshot(hostId, await this.readFrom(hostId, keys));
  }

  /**
   * Changes the named settings on the host, against the revisions they were
   * read at. A reply that never comes is not a verdict: the host is read back
   * and its own state says whether the change landed. Nothing is resent.
   */
  async update(payload: HostSettingsUpdatePayload): Promise<HostSettingsUpdateResult> {
    const hostId = this.requireHost(payload?.hostId);
    const parsedPatch = HostSettingsPatchSchema.safeParse(payload.patch);
    if (!parsedPatch.success) {
      throw new AppError({
        code: "VALIDATION",
        message: "Invalid host settings change",
        userMessage: "That isn't a setting, or a value, this host takes.",
      });
    }
    const patch = parsedPatch.data;
    // Turned on, an older host's Canopy would send its screens to the retired
    // hosted service: it is updated first.
    if (patch.canopyMode === "on" && !(await this.readsCanopyLocally(hostId))) {
      throw new AppError({
        code: "PERMISSION",
        message: "The host's Canopy still reads with the hosted service",
        userMessage: `Update Daintree on ${this.deps.hostLabel(hostId)} before turning Canopy on there.`,
      });
    }
    const keys = HOST_SETTING_KEYS.filter((key) => Object.hasOwn(patch, key));
    const session = this.session(hostId);
    const base = { hostId, hostName: this.deps.hostLabel(hostId), scope: "host" as const };
    const release = this.deps.holdHost?.(hostId);
    try {
      let raw: unknown;
      try {
        raw = await session.call(
          SettingsControlLinkMethod.UPDATE,
          { patch, expect: payload.expect },
          { timeoutMs: UPDATE_TIMEOUT_MS }
        );
      } catch (error) {
        const code = errorCode(error);
        if (code !== null && REFUSALS.has(code)) {
          throw this.translate(error, hostId, `Couldn't change settings on ${base.hostName}`);
        }
        return { ...base, ...(await this.readBack(hostId, keys, patch, payload.expect)) };
      }
      const reply = HostSettingsUpdateReplySchema.safeParse(raw);
      if (!reply.success || !coversExactly(reply.data.settings, keys)) {
        // A host that answered nonsense may still have written: its state says.
        return { ...base, ...(await this.readBack(hostId, keys, patch, payload.expect)) };
      }
      return {
        ...base,
        outcome: reply.data.outcome,
        confirmedBy: "reply",
        instanceId: reply.data.instanceId,
        settings: reply.data.settings,
      };
    } finally {
      release?.();
    }
  }

  private async readBack(
    hostId: HostId,
    keys: readonly HostSettingKey[],
    patch: Record<string, unknown>,
    expect: HostSettingsUpdatePayload["expect"]
  ): Promise<Omit<HostSettingsUpdateResult, "hostId" | "hostName" | "scope">> {
    let now: HostSettingsReading;
    try {
      now = await this.readFrom(hostId, keys);
    } catch {
      return { outcome: "unconfirmed", confirmedBy: null, instanceId: null, settings: [] };
    }
    const result = (outcome: HostSettingsUpdateResult["outcome"], settings: HostSettingLeaf[]) => ({
      outcome,
      confirmedBy: "readback" as const,
      instanceId: now.instanceId,
      settings,
    });
    // A readback that couldn't cover every key changed can't say the change landed.
    if (!keys.every((key) => now.settings.some((leaf) => leaf.key === key))) {
      return { outcome: "unconfirmed", confirmedBy: null, instanceId: null, settings: [] };
    }
    // A restart since the read: whatever stands there now isn't this change's doing.
    if (now.instanceId !== expect.instanceId) return result("conflict", now.settings);
    // Canopy counts its own changes, so its readback says whose change stands:
    // this one's is the very next revision, or none when it was already so.
    const landed = now.settings.every((leaf) => {
      if (!sameValue(leaf.value, patch[leaf.key])) return false;
      if (leaf.key !== "canopyMode") return true;
      const was = Number(expect.revisions.canopyMode);
      return leaf.revision === `${was}` || leaf.revision === `${was + 1}`;
    });
    if (landed) return result("applied", now.settings);
    const untouched = now.settings.every((leaf) => expect.revisions[leaf.key] === leaf.revision);
    return result(untouched ? "not-applied" : "conflict", now.settings);
  }
}
