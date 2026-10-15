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
  SettingsCopyLastCopy,
  SettingsCopyPreview,
  SettingsCopyPreviewPayload,
  SettingsCopyStatus,
  SettingsCopyStatusPayload,
  SettingsCopyUndoPayload,
  SettingsCopyUndoResult,
  SettingsCopyUndone,
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
  SettingsCopyStatusResultSchema,
  SettingsCopyUndoResultSchema,
  type SettingsCopyUndoLinkResult,
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
const ALL_SECTIONS = PORTABLE_SETTINGS_CATEGORIES.flatMap((category) => category.sections);

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

/** Only sections this Shell knows how to name. */
function known<T extends { section: string }>(
  items: T[]
): Array<T & { section: ConfigBundleSectionId }> {
  return items.filter((item): item is T & { section: ConfigBundleSectionId } =>
    isConfigBundleSectionId(item.section)
  );
}

function undoneOf(undone: SettingsCopyUndoLinkResult["undone"]): SettingsCopyUndone {
  return { ...undone, leaves: known(undone.leaves) };
}

function lastCopyOf(copy: SettingsCopyUndoLinkResult["lastCopy"]): SettingsCopyLastCopy {
  const { undone, changed, ...rest } = copy;
  return {
    ...rest,
    sections: known(copy.sections),
    ...(changed ? { changed: known(changed) } : {}),
    ...(undone ? { undone: undoneOf(undone) } : {}),
  };
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

  /** This machine's settings as a copy would send them: secrets withheld, size checked. */
  private async outgoing(ids: readonly ConfigBundleSectionId[]) {
    const collected = omitSectionSecrets(await this.deps.collect(ids));
    if (Buffer.byteLength(JSON.stringify(collected.sections), "utf8") > CONFIG_BUNDLE_MAX_BYTES) {
      throw new AppError({
        code: "PAYLOAD_TOO_LARGE",
        message: "Settings too large to copy",
        userMessage: "These settings are too large to copy in one go. Choose fewer.",
      });
    }
    return collected;
  }

  /**
   * What a copy of everything copyable would change on the host, by category,
   * and the last copy it received (#13347). Asked for when the host's page
   * opens or is refreshed, never on a timer. A host too old to answer says so
   * quietly: the page just shows nothing for it.
   */
  async status(payload: SettingsCopyStatusPayload): Promise<SettingsCopyStatus> {
    const hostId = this.requireHost(payload?.hostId);
    const session = this.session(hostId);
    const host = this.deps.hostLabel(hostId);
    const { sections } = await this.outgoing(ALL_SECTIONS);

    let raw: unknown;
    try {
      raw = await session.call(
        SettingsCopyLinkMethod.STATUS,
        { sections },
        { timeoutMs: PREVIEW_TIMEOUT_MS }
      );
    } catch (error) {
      if (errorCode(error) === "UNSUPPORTED") {
        return { supported: false, changes: [], lastCopy: null };
      }
      throw this.translate(error, hostId, `Couldn't check settings on ${host}`);
    }
    const parsed = SettingsCopyStatusResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: "The host's settings status could not be read",
        userMessage: `Couldn't read ${host}'s settings status.`,
      });
    }
    const changed = new Set(
      parsed.data.sections
        .filter((section) => section.add + section.update > 0)
        .map((section) => section.section)
    );
    const lastCopy = parsed.data.lastCopy;
    return {
      supported: true,
      changes: PORTABLE_SETTINGS_CATEGORIES.filter((category) =>
        category.sections.some((section) => changed.has(section))
      ).map((category) => category.id),
      lastCopy: lastCopy && lastCopyOf(lastCopy),
    };
  }

  /** Take back the host's last copy, where nothing has changed it since. */
  async undo(payload: SettingsCopyUndoPayload): Promise<SettingsCopyUndoResult> {
    const hostId = this.requireHost(payload?.hostId);
    if (typeof payload?.copyId !== "string" || !/^[0-9a-f]{32}$/.test(payload.copyId)) {
      throw new AppError({ code: "VALIDATION", message: "Invalid copy" });
    }
    const session = this.session(hostId);
    const host = this.deps.hostLabel(hostId);
    const release = this.deps.holdHost?.(hostId);
    let raw: unknown;
    try {
      raw = await session.call(
        SettingsCopyLinkMethod.UNDO,
        { copyId: payload.copyId },
        { timeoutMs: APPLY_TIMEOUT_MS }
      );
    } catch (error) {
      const code = errorCode(error);
      if (code === "HOST_DISCONNECTED" || code === "OUTCOME_UNKNOWN") {
        throw new AppError({
          code: "OUTCOME_UNKNOWN",
          message: "The link dropped during an undo",
          userMessage: `The connection to ${host} dropped during the undo. Refresh to see where it stands.`,
        });
      }
      if (code === "SETTINGS_COPY_UNDO_STALE") {
        throw new AppError({
          code: "SETTINGS_COPY_UNDO_STALE",
          message: "The host's last copy changed",
          userMessage: `${host} has a newer copy, or this one was already undone. Refresh to see it.`,
        });
      }
      throw this.translate(error, hostId, `Couldn't undo the copy on ${host}`);
    } finally {
      release?.();
    }
    const parsed = SettingsCopyUndoResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError({
        code: "INTERNAL",
        message: "The host's undo report could not be read",
        userMessage: `${host} undid the copy but its report couldn't be read. Refresh to check.`,
      });
    }
    const { undone, lastCopy } = parsed.data;
    return { undone: undoneOf(undone), lastCopy: lastCopyOf(lastCopy) };
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

    const { sections, omittedSecretPaths } = await this.outgoing(ids);

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
