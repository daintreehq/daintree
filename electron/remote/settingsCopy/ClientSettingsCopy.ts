import {
  PORTABLE_SETTINGS_CATEGORIES,
  type PortableSettingsCategoryId,
} from "../../../shared/config/portableSettings.js";
import {
  CONFIG_BUNDLE_MAX_BYTES,
  isConfigBundleSectionId,
  type ConfigBundlePreviewSection,
  type ConfigBundleSectionId,
  type ConfigImportReport,
} from "../../../shared/types/configBundle.js";
import type {
  SettingsCopyApplyPayload,
  SettingsCopyPreview,
  SettingsCopyPreviewPayload,
  SettingsCopyWithheld,
} from "../../../shared/types/ipc/settingsCopy.js";
import { isValidRemoteHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { omitSectionSecrets, type ConfigBundleSections } from "../../utils/configBundleIO.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  SettingsCopyLinkMethod,
  SettingsCopyPreviewResultSchema,
  SettingsCopyReportSchema,
} from "./linkMethods.js";

/** The slice of a link session this client calls through. */
export interface SettingsCopySession {
  readonly isOpen: boolean;
  call(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

export interface ClientSettingsCopyDeps {
  sessionFor(hostId: HostId): SettingsCopySession | null;
  /** Keep the host's connection open until released, across an apply. */
  holdHost?(hostId: HostId): () => void;
  isKnownHost(hostId: HostId): boolean;
  hostLabel(hostId: HostId): string;
  /** This machine's own portable settings, whatever host the asking window shows. */
  collect(ids: readonly ConfigBundleSectionId[]): Promise<ConfigBundleSections>;
}

const PREVIEW_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 60_000;

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function notConnected(hostLabel: string): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: "The host is not connected",
    userMessage: `Not connected to ${hostLabel}. Connect to it and try again.`,
  });
}

/** "agentSettings.claude.globalEnv.GITHUB_TOKEN" → GITHUB_TOKEN; "…args[2]" → args. */
function withheldName(path: string): string {
  const last = path.split(".").pop() ?? path;
  return last.replace(/\[\d+\]$/, "");
}

/**
 * The Shell side of Copy settings (#13346). It collects this machine's own
 * settings for the categories asked for, withholds secrets before anything
 * leaves, and lets the host preview and then apply them. It works per session,
 * so Settings copies with no window on the host, and it never runs unasked.
 */
export class ClientSettingsCopy {
  constructor(private readonly deps: ClientSettingsCopyDeps) {}

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

  private session(hostId: HostId): SettingsCopySession {
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) throw notConnected(this.deps.hostLabel(hostId));
    return session;
  }

  private translate(error: unknown, hostId: HostId, fallback: string): AppError {
    const host = this.deps.hostLabel(hostId);
    switch (errorCode(error)) {
      case "UNSUPPORTED":
        return new AppError({
          code: "UNSUPPORTED",
          message: "The host has no settings copy",
          userMessage: `Daintree on ${host} is too old to receive settings. Update it there and try again.`,
        });
      case "SETTINGS_PREVIEW_STALE":
        return new AppError({
          code: "SETTINGS_PREVIEW_STALE",
          message: "The host's settings changed since the preview",
          userMessage: `Settings on ${host} changed since this preview. Preview again to see what a copy would change now.`,
        });
      case "HOST_DISCONNECTED":
        return notConnected(host);
      case "VALIDATION":
        return new AppError({
          code: "VALIDATION",
          message: formatErrorMessage(error, "The host refused the settings"),
          userMessage: `${host} couldn't read these settings. Its Daintree may be a different version.`,
        });
      default:
        return new AppError({
          code: "INTERNAL",
          message: formatErrorMessage(error, fallback),
          userMessage: `${fallback}.`,
        });
    }
  }

  async preview(payload: SettingsCopyPreviewPayload): Promise<SettingsCopyPreview> {
    const hostId = this.requireHost(payload?.hostId);
    const wanted = new Set<PortableSettingsCategoryId>(
      Array.isArray(payload?.categories) ? payload.categories : []
    );
    const ids = PORTABLE_SETTINGS_CATEGORIES.filter((category) => wanted.has(category.id)).flatMap(
      (category) => category.sections
    );
    if (ids.length === 0) {
      throw new AppError({
        code: "VALIDATION",
        message: "No settings chosen",
        userMessage: "Choose what to copy first.",
      });
    }
    const session = this.session(hostId);
    const host = this.deps.hostLabel(hostId);

    const { sections, omittedSecretPaths } = omitSectionSecrets(await this.deps.collect(ids));
    if (Buffer.byteLength(JSON.stringify(sections), "utf8") > CONFIG_BUNDLE_MAX_BYTES) {
      throw new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "Settings too large to copy",
        userMessage: "These settings are too large to copy in one go. Choose fewer.",
      });
    }

    let raw: unknown;
    try {
      raw = await session.call(
        SettingsCopyLinkMethod.PREVIEW,
        { sections },
        { timeoutMs: PREVIEW_TIMEOUT_MS }
      );
    } catch (error) {
      throw this.translate(error, hostId, `Couldn't preview the copy on ${host}`);
    }
    const parsed = SettingsCopyPreviewResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: "The host's preview could not be read",
        userMessage: `Couldn't read ${host}'s preview.`,
      });
    }

    const withheld: SettingsCopyWithheld[] = [];
    for (const path of omittedSecretPaths) {
      const section = path.split(".")[0];
      if (isConfigBundleSectionId(section)) withheld.push({ section, name: withheldName(path) });
    }
    return {
      ticket: parsed.data.ticket,
      hostPlatform: parsed.data.platform,
      // Only sections this Shell sent and knows how to name.
      sections: parsed.data.sections.filter(
        (section): section is ConfigBundlePreviewSection =>
          isConfigBundleSectionId(section.section) && ids.includes(section.section)
      ),
      unknownSections: parsed.data.unknownSections,
      withheld,
    };
  }

  async apply(payload: SettingsCopyApplyPayload): Promise<ConfigImportReport> {
    const hostId = this.requireHost(payload?.hostId);
    if (typeof payload?.ticket !== "string" || !/^[0-9a-f]{32}$/.test(payload.ticket)) {
      throw new AppError({ code: "VALIDATION", message: "Invalid preview" });
    }
    const session = this.session(hostId);
    const host = this.deps.hostLabel(hostId);
    const release = this.deps.holdHost?.(hostId);
    let raw: unknown;
    try {
      raw = await session.call(
        SettingsCopyLinkMethod.APPLY,
        { ticket: payload.ticket },
        { timeoutMs: APPLY_TIMEOUT_MS }
      );
    } catch (error) {
      const code = errorCode(error);
      if (code === "HOST_DISCONNECTED" || code === "OUTCOME_UNKNOWN") {
        // The link went, or the answer took too long: the write may have
        // landed or may still be landing. Say so rather than call it a
        // failure, and let a fresh preview show where it stands.
        throw new AppError({
          code: "OUTCOME_UNKNOWN",
          message: "The link dropped during a settings copy",
          userMessage: `The connection to ${host} dropped during the copy. Preview again to see what landed.`,
        });
      }
      throw this.translate(error, hostId, `Couldn't copy settings to ${host}`);
    } finally {
      release?.();
    }
    const parsed = SettingsCopyReportSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: "The host's report could not be read",
        userMessage: `${host} applied the copy but its report couldn't be read. Preview again to check.`,
      });
    }
    return {
      ...parsed.data,
      sections: parsed.data.sections.filter((section) =>
        isConfigBundleSectionId(section.section)
      ) as ConfigImportReport["sections"],
    };
  }
}
