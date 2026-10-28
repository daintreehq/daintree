import fs from "fs/promises";
import path from "path";

import type { PluginArtifactService } from "./PluginArtifactService.js";
import { artifactError } from "./pluginArtifactErrors.js";
import {
  admitTransferHeaders,
  admitTransferUrl,
  compileAllowedUrls,
} from "./pluginArtifactNetworkPolicy.js";
import { isArtifactId } from "./PluginArtifactStore.js";
import {
  PLUGIN_ARTIFACT_DEFAULT_ATTEMPTS,
  PLUGIN_ARTIFACT_MAX_ATTEMPTS,
} from "../../../shared/config/pluginArtifacts.js";
import type {
  PluginArtifactApi,
  PluginArtifactCreateOptions,
} from "../../../shared/types/pluginArtifacts.js";

import type { BuiltInPluginCapability } from "../../../shared/types/plugin.js";
import { type PluginHostFactoryDeps } from "./pluginHostDeps.js";
import { withVerifiedReadHandle, containToDeclaredRoots } from "./pluginHostFsApi.js";

/**
 * Host-managed artifacts (`host.artifacts`, #14100). The gates are here; the
 * bytes are {@link PluginArtifactService}'s. Every method needs
 * `artifact:store`. An import is contained and read-gated exactly like
 * `fs.readFileBytes`, and opened through the same verified descriptor; a
 * transfer needs `network:fetch` and a URL under the manifest's
 * `scopes.network.allowedUrls`, which this is the first runtime enforcement
 * of. Ownership is the plugin instance, plus the project the artifact belongs
 * to: a project plugin's own, or one an app-global plugin names.
 *
 * Non-async on purpose where validation can fail synchronously, so a bad
 * argument rejects rather than throws (#10627); the worker proxy mirrors the
 * same checks.
 */
export function buildArtifactsApi(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  boundProjectId: string | null
): PluginArtifactApi {
  const fail = (code: Parameters<typeof artifactError>[0], op: string, message: string) =>
    artifactError(code, `plugin "${pluginId}" artifacts.${op}: ${message}`);
  const admit = (op: string, extra?: BuiltInPluginCapability): PluginArtifactService => {
    if (!deps.plugins.has(pluginId)) {
      throw fail("PLUGIN_UNLOADED", op, "plugin is no longer loaded");
    }
    const caps = deps.declaredCapabilities(pluginId);
    for (const needed of ["artifact:store", ...(extra ? [extra] : [])] as const) {
      if (!caps.has(needed)) {
        throw fail(
          "PERMISSION_REQUIRED",
          op,
          `requires the "${needed}" capability, which is not declared in manifest.capabilities`
        );
      }
    }
    const service = deps.artifactService();
    if (!service) throw fail("ARTIFACT_TRANSFER_FAILED", op, "the artifact cache has shut down");
    return service;
  };
  const projectFor = (op: string, requested: unknown): string | null => {
    if (requested === undefined) return boundProjectId;
    if (typeof requested !== "string" || !/^[0-9a-f]{64}$/.test(requested)) {
      throw fail("VALIDATION", op, "projectId must be a project id");
    }
    if (boundProjectId !== null && requested !== boundProjectId) {
      throw fail("VALIDATION", op, "a project plugin's artifacts belong to its own project");
    }
    return requested;
  };
  const createOptions = (op: string, raw: unknown) => {
    if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
      throw fail("VALIDATION", op, "options must be an object");
    }
    const options = (raw ?? {}) as PluginArtifactCreateOptions & { attempts?: unknown };
    const optionalString = (key: "name" | "mimeType") => {
      const value = options[key];
      if (value !== undefined && (typeof value !== "string" || value.length > 255)) {
        throw fail("VALIDATION", op, `${key} must be a string of at most 255 characters`);
      }
      return value;
    };
    if (
      options.ttlMs !== undefined &&
      (typeof options.ttlMs !== "number" || !(options.ttlMs > 0))
    ) {
      throw fail("VALIDATION", op, "ttlMs must be a positive number");
    }
    if (options.onProgress !== undefined && typeof options.onProgress !== "function") {
      throw fail("VALIDATION", op, "onProgress must be a function");
    }
    return {
      projectId: projectFor(op, options.projectId),
      name: optionalString("name"),
      mimeType: optionalString("mimeType"),
      ttlMs: options.ttlMs,
      signal: options.signal,
      onProgress: options.onProgress,
      attempts: options.attempts,
    };
  };
  const artifactIdOf = (op: string, raw: unknown): string => {
    if (!isArtifactId(raw)) throw fail("VALIDATION", op, "artifactId must be an artifact id");
    return raw;
  };
  const urlScope = () =>
    compileAllowedUrls(deps.plugins.get(pluginId)?.manifest.scopes?.network?.allowedUrls);

  return {
    import: async (source, rawOptions) => {
      const service = admit("import");
      const options = createOptions("import", rawOptions);
      options.signal?.throwIfAborted();
      const sourcePath = (source as { path?: unknown } | null)?.path;
      if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) {
        throw fail("VALIDATION", "import", "source.path must be an absolute path");
      }
      const { resolved, rootClass } = await containToDeclaredRoots(deps, pluginId, sourcePath);
      admit("import");
      const readCap = rootClass === "project" ? "fs:project-read" : "fs:user-data-read";
      if (!deps.declaredCapabilities(pluginId).has(readCap)) {
        throw fail(
          "PERMISSION_REQUIRED",
          "import",
          `requires the "${readCap}" capability for ${rootClass} paths`
        );
      }
      options.signal?.throwIfAborted();
      return withVerifiedReadHandle(
        pluginId,
        "artifacts.import",
        resolved,
        fs.constants.O_NONBLOCK ?? 0,
        async (handle, opened) => {
          if (!opened.isFile())
            throw fail("INVALID_PATH", "import", "the source is not a regular file");
          // Synchronously before the transfer registers: an unload during the
          // open must not leave an import nothing will cancel.
          admit("import");
          return service.importFromHandle({
            pluginId,
            projectId: options.projectId,
            name: options.name,
            mimeType: options.mimeType,
            ttlMs: options.ttlMs,
            signal: options.signal,
            onProgress: options.onProgress,
            handle,
            size: Number(opened.size),
            sourceName: path.basename(resolved),
          });
        }
      );
    },
    download: (request, rawOptions) => {
      try {
        const service = admit("download", "network:fetch");
        const options = createOptions("download", rawOptions);
        const attempts = options.attempts ?? PLUGIN_ARTIFACT_DEFAULT_ATTEMPTS;
        if (
          typeof attempts !== "number" ||
          !Number.isInteger(attempts) ||
          attempts < 1 ||
          attempts > PLUGIN_ARTIFACT_MAX_ATTEMPTS
        ) {
          throw fail(
            "VALIDATION",
            "download",
            `attempts must be 1 to ${PLUGIN_ARTIFACT_MAX_ATTEMPTS}`
          );
        }
        const isAllowed = urlScope();
        const url = admitTransferUrl(pluginId, "download", request?.url, isAllowed);
        const headers = admitTransferHeaders(pluginId, "download", request?.headers);
        return service.download({
          pluginId,
          projectId: options.projectId,
          name: options.name,
          mimeType: options.mimeType,
          ttlMs: options.ttlMs,
          signal: options.signal,
          onProgress: options.onProgress,
          url,
          headers,
          isAllowed,
          attempts,
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    upload: (artifactId, request, options) => {
      try {
        const service = admit("upload", "network:fetch");
        const id = artifactIdOf("upload", artifactId);
        const method = request?.method ?? "PUT";
        if (method !== "PUT" && method !== "POST") {
          throw fail("VALIDATION", "upload", 'method must be "PUT" or "POST"');
        }
        if (options?.onProgress !== undefined && typeof options.onProgress !== "function") {
          throw fail("VALIDATION", "upload", "onProgress must be a function");
        }
        const url = admitTransferUrl(pluginId, "upload", request?.url, urlScope());
        const headers = admitTransferHeaders(pluginId, "upload", request?.headers);
        return service.upload({
          pluginId,
          artifactId: id,
          url,
          method,
          headers,
          signal: options?.signal,
          onProgress: options?.onProgress,
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    stat: (artifactId) => {
      try {
        const service = admit("stat");
        return Promise.resolve(service.store.get(pluginId, artifactIdOf("stat", artifactId)));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    list: (options) => {
      try {
        const service = admit("list");
        const requested = (options as { projectId?: unknown } | undefined)?.projectId;
        const projectId =
          requested === undefined
            ? undefined
            : requested === null
              ? null
              : projectFor("list", requested);
        if (requested === null && boundProjectId !== null) {
          throw fail("VALIDATION", "list", "a project plugin has no app-wide artifacts");
        }
        return Promise.resolve(service.store.list(pluginId, projectId));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    release: (artifactId) => {
      try {
        const service = admit("release");
        return Promise.resolve(
          service.store.release(pluginId, artifactIdOf("release", artifactId))
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
