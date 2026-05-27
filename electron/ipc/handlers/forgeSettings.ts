// eager-import-allow: reads forge settings via store.get synchronously in the IPC handler
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { typedHandle } from "../utils.js";
import {
  getForgeProviderImpl,
  getRegisteredForgeProviders,
} from "../../services/forgeProviderRegistry.js";
import { resolveForgeProvider } from "../../services/forgeProviderResolver.js";
import { projectStore } from "../../services/ProjectStore.js";
import { gitServiceCache } from "../../services/GitServiceCache.js";
import {
  makeForgeProviderId,
  normalizeProviderId,
} from "../../../shared/utils/forgeProviderIds.js";
import { auditForgeCall } from "../../services/forge/forgeAuditService.js";
import type { AuthValidation, CredentialField } from "../../../shared/types/forge.js";

/**
 * Read the persisted global default provider id, normalizing legacy forms
 * (`"github"`, `"builtin.github"`) to the canonical `{pluginId}.{contributionId}`
 * shape (#8451) so downstream resolution does not need to know about aliases.
 */
function readDefaultProviderId(): string | null {
  return normalizeProviderId(store.get("forgeDefaultProviderId"));
}

/**
 * Look up a registered provider's declared credential fields by canonical id.
 * Returns `[]` when the provider declares none (or is not registered) — the
 * caller treats that as a single-value credential.
 */
function credentialFieldsFor(providerId: string): CredentialField[] {
  const entry = getRegisteredForgeProviders().find(
    (p) => makeForgeProviderId(p.pluginId, p.contribution.id) === providerId
  );
  return entry?.contribution.credentialFields ?? [];
}

/**
 * Pick the value passed to `validateToken`, which takes a single string. The
 * primary field is the first `"password"`-typed declared field, else the
 * first declared field; with no declared fields, the first record value.
 */
function pickPrimaryValue(fields: CredentialField[], credentials: Record<string, string>): string {
  if (fields.length > 0) {
    const primary = fields.find((f) => f.type === "password") ?? fields[0];
    return credentials[primary.id] ?? "";
  }
  const first = Object.values(credentials)[0];
  return typeof first === "string" ? first : "";
}

/** True when a stored record has at least one non-empty value. */
function recordHasCredential(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    return Object.values(parsed as Record<string, unknown>).some(
      (v) => typeof v === "string" && v.trim().length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Push a provider's credentials to the live workspace-host UtilityProcess so
 * branch→PR detection can use them. Mirrors `syncWorkspaceToken` in
 * `GitHubTokenOrchestrator` exactly: a best-effort live push that only
 * reaches currently-spawned hosts and swallows errors when the client is not
 * yet initialized. Note this is a live push only — like the GitHub path,
 * there is no boot-time replay of persisted credentials into a freshly
 * spawned host, and the workspace host currently only consumes GitHub
 * credentials (`PRIntegrationService.updateForgeCredentials` no-ops for
 * non-GitHub ids until a provider plugin wires its own auth module). The
 * `forgeCredentials` store entry is the durable source of truth; wiring a
 * boot-time replay for third-party providers is a provider-agnostic
 * follow-on, not part of #8454's settings/auth surface.
 */
async function syncWorkspaceCredential(
  providerId: string,
  primaryValue: string | null
): Promise<void> {
  try {
    const { getWorkspaceClient } = await import("../../services/WorkspaceClient.js");
    const credentials =
      primaryValue && primaryValue.length > 0
        ? { kind: "bearer" as const, value: primaryValue }
        : null;
    getWorkspaceClient().updateForgeCredentials(providerId, credentials);
  } catch {
    // WorkspaceClient may not be initialized yet — store is the source of truth.
  }
}

export function registerForgeSettingsHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_SETTINGS, () => {
      return { defaultProviderId: readDefaultProviderId() };
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_SET_DEFAULT_PROVIDER, (providerId: unknown) => {
      // Normalize on the write path so a caller that still sends a legacy
      // alias (`"github"` / `"builtin.github"`) persists the canonical form,
      // keeping the set→get round-trip consistent and avoiding a brief
      // "Unknown provider" flash in the renderer (#8451).
      const next = normalizeProviderId(providerId);
      store.set("forgeDefaultProviderId", next);
      return { defaultProviderId: next };
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_PROVIDERS, () => {
      return getRegisteredForgeProviders();
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_RESOLVE_PROVIDER, async (projectId: unknown, remoteUrl: unknown) => {
      if (typeof projectId !== "string" || projectId.length === 0) {
        return { entry: null, resolvedVia: null };
      }
      try {
        const project = projectStore.getProjectById(projectId);
        if (!project) return { entry: null, resolvedVia: null };

        const settings = await projectStore.getProjectSettings(projectId).catch(() => null);
        const forgeProviderOverride = settings?.forgeProviderOverride ?? null;

        let effectiveRemoteUrl: string | null;
        if (typeof remoteUrl === "string" && remoteUrl.length > 0) {
          effectiveRemoteUrl = remoteUrl;
        } else {
          const gitService = gitServiceCache.getGitService(project.path);
          effectiveRemoteUrl = await gitService.getRemoteUrl(project.path).catch(() => null);
        }

        const globalDefaultProviderId = readDefaultProviderId();

        return resolveForgeProvider({
          remoteUrl: effectiveRemoteUrl,
          forgeProviderOverride,
          globalDefaultProviderId,
        });
      } catch (error) {
        console.warn(`[forgeSettings] resolve failed for ${projectId}:`, error);
        return { entry: null, resolvedVia: null };
      }
    })
  );

  cleanups.push(
    typedHandle(
      CHANNELS.FORGE_SET_CREDENTIAL,
      async (providerId: unknown, credentials: unknown): Promise<AuthValidation> => {
        if (typeof providerId !== "string" || providerId.length === 0) {
          return { valid: false, error: "Provider id is required" };
        }
        if (!credentials || typeof credentials !== "object") {
          return { valid: false, error: "Credentials are required" };
        }
        const record: Record<string, string> = {};
        for (const [k, v] of Object.entries(credentials as Record<string, unknown>)) {
          if (typeof v === "string") record[k] = v;
        }

        const fields = credentialFieldsFor(providerId);
        const primaryValue = pickPrimaryValue(fields, record).trim();
        if (primaryValue.length === 0) {
          return { valid: false, error: "Credential is required" };
        }

        const impl = getForgeProviderImpl(providerId);
        if (!impl) {
          return { valid: false, error: "Provider not activated. Open it in Settings first." };
        }

        const validation = await auditForgeCall(
          { providerId, methodName: "validateToken", argsSummary: "" },
          () => impl.validateToken(primaryValue)
        );
        if (!validation.valid) {
          return validation;
        }

        const existing = store.get("forgeCredentials") ?? {};
        store.set("forgeCredentials", { ...existing, [providerId]: JSON.stringify(record) });

        await syncWorkspaceCredential(providerId, primaryValue);

        return validation;
      }
    )
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_GET_CREDENTIAL_STATUS, (providerId: unknown) => {
      if (typeof providerId !== "string" || providerId.length === 0) {
        return { hasCredential: false };
      }
      const map = store.get("forgeCredentials") ?? {};
      return { hasCredential: recordHasCredential(map[providerId]) };
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_CLEAR_CREDENTIAL, async (providerId: unknown) => {
      if (typeof providerId !== "string" || providerId.length === 0) {
        return;
      }
      const existing = store.get("forgeCredentials") ?? {};
      if (providerId in existing) {
        const next = { ...existing };
        delete next[providerId];
        store.set("forgeCredentials", next);
      }
      await syncWorkspaceCredential(providerId, null);
    })
  );

  return () => cleanups.forEach((c) => c());
}
