// eager-import-allow: reads forge settings via store.get synchronously in the IPC handler
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { checkRateLimit, typedHandle } from "../utils.js";
import {
  getForgeProviderImpl,
  getRegisteredForgeProviders,
} from "../../services/forgeProviderRegistry.js";
import { resolveForgeProvider } from "../../services/forgeProviderResolver.js";
import { resolveEffectiveRemoteUrl } from "./forgeResolution.js";
import { projectStore } from "../../services/ProjectStore.js";
import { gitServiceCache } from "../../services/GitServiceCache.js";
import { normalizeProviderId } from "../../../shared/utils/forgeProviderIds.js";
import { auditForgeCall } from "../../services/forge/forgeAuditService.js";
import {
  credentialFieldsFor,
  pickPrimaryValue,
} from "../../services/forge/forgeCredentialUtils.js";
import type { AuthValidation } from "../../../shared/types/forge.js";

/**
 * Read the persisted global default provider id, normalizing legacy forms
 * (`"github"`, `"builtin.github"`) to the canonical `{pluginId}.{contributionId}`
 * shape (#8451) so downstream resolution does not need to know about aliases.
 */
function readDefaultProviderId(): string | null {
  return normalizeProviderId(store.get("forgeDefaultProviderId"));
}

// PluginService is loaded lazily (mirrors forgeRpcServer) so this eagerly
// registered handler module never constructs the singleton at import time.
type PluginInitGate = { waitForInit(): Promise<void> };
let pluginServicePromise: Promise<PluginInitGate> | null = null;

/**
 * Block registry reads until startup plugin load + activation has settled.
 * Forge provider descriptors register during the DEFERRED `PluginService.
 * initialize()` (which only runs after the renderer reports first-interactive),
 * so a mount-time `forge:resolve-provider` / `forge:get-providers` call always
 * races it. Answering from the pre-init empty registry returns `{entry: null}`,
 * which the renderer caches for the session (`useResolvedForgeProvider`'s
 * resolutionCache) — no later signal re-triggers resolution, so every forge
 * surface (stats pills, sidebar affordances) silently stays hidden. Same
 * init-race guard as `handleToolbarButtons` (#9285); the workspace-host got
 * its equivalent via the "not-ready" retry status (#9997).
 */
function awaitPluginInit(): Promise<void> {
  pluginServicePromise ??= import("../../services/PluginService.js").then((m) => m.pluginService);
  return pluginServicePromise.then((svc) => svc.waitForInit());
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
 * yet initialized. The host applies no credential VALUES itself — forge calls
 * route over the RPC bridge to main — the push signals presence/absence so
 * detection refreshes or resets promptly (`PRIntegrationService.
 * updateForgeCredentials`). Freshly spawned hosts are covered by the
 * registry-backed ready replay in `WorkspaceHostProcess`; the
 * `forgeCredentials` store entry stays the durable source of truth.
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
    typedHandle(CHANNELS.FORGE_GET_PROVIDERS, async () => {
      await awaitPluginInit();
      return getRegisteredForgeProviders();
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.FORGE_RESOLVE_PROVIDER, async (projectId: unknown, remoteUrl: unknown) => {
      if (typeof projectId !== "string" || projectId.length === 0) {
        return { entry: null, resolvedVia: null };
      }
      try {
        await awaitPluginInit();
        const project = projectStore.getProjectById(projectId);
        if (!project) return { entry: null, resolvedVia: null };

        const settings = await projectStore.getProjectSettings(projectId).catch(() => null);
        const forgeProviderOverride = settings?.forgeProviderOverride ?? null;

        let effectiveRemoteUrl: string | null;
        if (typeof remoteUrl === "string" && remoteUrl.length > 0) {
          // An explicit URL means the caller is asking about one specific
          // remote (the Settings routing panel probes each in turn) — the
          // project's selection must not override that.
          effectiveRemoteUrl = remoteUrl;
        } else {
          // No URL: answer for whichever remote the project actually routes
          // through (#11408). This is the toolbar's pill-visibility gate, so an
          // origin-only lookup here hid issues and PRs on every fork or mirror
          // whose forge remote is named something else.
          const gitService = gitServiceCache.getGitService(project.path);
          effectiveRemoteUrl = await resolveEffectiveRemoteUrl(
            gitService,
            project.path,
            settings?.forgeRemote ?? settings?.githubRemote ?? null,
            forgeProviderOverride
          );
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
        // Same budget as github:set-token — each call hits the provider's
        // token-validation API (#9956).
        checkRateLimit(CHANNELS.FORGE_SET_CREDENTIAL, 5, 10_000);
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
          () => impl.validateToken(primaryValue),
          // A rejected credential is a resolved call but a failed outcome —
          // audit it as an error so bad-token bursts surface in anomaly
          // detection rather than hiding behind result: "success".
          (validation) => (validation.valid ? "success" : "error")
        );
        if (!validation.valid) {
          return validation;
        }

        const existing = store.get("forgeCredentials") ?? {};
        store.set("forgeCredentials", { ...existing, [providerId]: JSON.stringify(record) });

        // Deliver the credential to the live impl so forge API calls run
        // authenticated. Without this the token only ever reached the store —
        // the impl stayed unauthenticated despite the UI showing "connected"
        // (#9983). `setCredentials` is optional; a synchronous throw here is a
        // plugin bug that should surface, so it is intentionally uncaught,
        // mirroring `validateToken` above.
        impl.setCredentials?.({ kind: "bearer", value: primaryValue });

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
      // Clear in-memory auth state on the live impl for symmetry with SET
      // (#9983). The impl may be unbound here — a user can clear a credential
      // without the provider plugin being active — so guard the lookup.
      const impl = getForgeProviderImpl(providerId);
      if (impl) impl.setCredentials?.(null);

      await syncWorkspaceCredential(providerId, null);
    })
  );

  return () => cleanups.forEach((c) => c());
}
