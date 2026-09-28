import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stripPluginViewGeneration } from "../../../shared/utils/pluginViewUrl.js";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import type { LinkSession } from "../link/session.js";
import {
  PLUGIN_ASSET_MAX_BYTES,
  PLUGIN_ASSET_METHOD,
  PluginAssetRequestSchema,
  type PluginAssetRequest,
  type PluginAssetResponse,
} from "./assetLinkMethods.js";

export type HostPluginAssetEndpoint = Pick<
  ClientEndpoint,
  "endpointId" | "clientId" | "projectId" | "isClosed" | "onClose"
> & { readonly clientEndpointId: string };

/** The slice of a loaded plugin this service needs. */
export interface HostPluginAssetPlugin {
  instanceId: string;
  projectId: string | null;
  dir: string;
  remoteUnsupported: boolean;
}

export interface HostPluginAssetServiceOptions {
  /** Plugin root a `plugin://` authority serves, or undefined. */
  rootForAuthority(authority: string): string | undefined;
  /** The plugins loaded on this host right now. */
  loadedPlugins(): Promise<HostPluginAssetPlugin[]>;
  isDriving(projectId: string, endpoint: HostPluginAssetEndpoint): boolean;
  /** This host's own `plugin://` handler. */
  fetchAsset(request: Request): Promise<Response>;
  /** Size of the file an asset path names, or null when it isn't a file inside `root`. */
  assetSize?(root: string, encodedPath: string): Promise<number | null>;
}

/**
 * The size of the file `encodedPath` names under `root`, checked for
 * containment the way the protocol handler checks it, so an oversized asset is
 * refused before anything reads it — and a path outside the root reveals
 * nothing about what lies there. The handler still does its own full checks.
 */
export async function containedAssetSize(
  root: string,
  encodedPath: string
): Promise<number | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  const stripped = stripPluginViewGeneration(decoded);
  if (!stripped || decoded.includes("\0") || decoded.includes("\\")) return null;
  const normalized = path.posix.normalize("/" + stripped.path).slice(1);
  try {
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(path.resolve(root, normalized));
    const rel = path.relative(realRoot, realFile);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const stat = await fs.stat(realFile);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function answer(status: number, extra: Partial<PluginAssetResponse> = {}): PluginAssetResponse {
  return { status, pluginId: null, etag: null, lastModified: null, body: null, ...extra };
}

/**
 * Serves a host plugin's view bundle to the Shells whose windows show it. The
 * asset is read through this host's own `plugin://` handler, so containment is
 * exactly the local one; admission is this service's job.
 *
 * A Shell may read a plugin's assets only through one of its own endpoints
 * that is attached to a project, drives it, and can see the plugin: an
 * app-global plugin, or a project plugin of that very project. A plugin that
 * declares `"remote": "unsupported"` is never served. Because every read is
 * checked here, closing the project or losing the drive lease revokes the
 * Shell's access at once; the Shell's cache revalidates against this answer.
 */
export class HostPluginAssetService {
  private readonly sessions = new WeakMap<
    LinkSession,
    { endpoints: Map<string, HostPluginAssetEndpoint>; unregister: Array<() => void> }
  >();
  private disposed = false;

  constructor(private readonly options: HostPluginAssetServiceOptions) {}

  /** Serve this endpoint's asset calls on `session` (its current link). Idempotent. */
  attach(session: LinkSession, endpoint: HostPluginAssetEndpoint): void {
    if (this.disposed) return;
    let entry = this.sessions.get(session);
    if (!entry) {
      const created = {
        endpoints: new Map<string, HostPluginAssetEndpoint>(),
        unregister: [] as Array<() => void>,
      };
      created.unregister.push(
        session.registerCallHandler(PLUGIN_ASSET_METHOD, PluginAssetRequestSchema, (payload) =>
          this.serve(created.endpoints, payload)
        ),
        session.onClose(() => {
          for (const dispose of created.unregister.splice(0)) dispose();
          created.endpoints.clear();
        })
      );
      this.sessions.set(session, created);
      entry = created;
    }
    const endpoints = entry.endpoints;
    if (endpoints.get(endpoint.clientEndpointId) === endpoint) return;
    endpoints.set(endpoint.clientEndpointId, endpoint);
    endpoint.onClose(() => {
      if (endpoints.get(endpoint.clientEndpointId) === endpoint) {
        endpoints.delete(endpoint.clientEndpointId);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private async serve(
    endpoints: Map<string, HostPluginAssetEndpoint>,
    payload: PluginAssetRequest
  ): Promise<PluginAssetResponse> {
    if (this.disposed) return answer(503);
    const root = this.options.rootForAuthority(payload.authority);
    if (!root) return answer(404);
    const plugin = await this.admit(endpoints, payload.endpointIds, root);
    if (plugin === "driven-elsewhere") return answer(403);
    if (!plugin) return answer(404);
    const size = await (this.options.assetSize ?? containedAssetSize)(root, payload.path);
    if (size === null) return answer(404);
    if (size > PLUGIN_ASSET_MAX_BYTES) return answer(413);

    let response: Response;
    try {
      response = await this.options.fetchAsset(
        new Request(`plugin://${payload.authority}/${payload.path}`, { method: payload.method })
      );
    } catch {
      return answer(500);
    }
    if (response.status !== 200) return answer(response.status === 304 ? 500 : response.status);
    const modified = Date.parse(response.headers.get("last-modified") ?? "");
    const lastModified = Number.isFinite(modified) ? modified : null;
    if (payload.method === "HEAD") {
      return answer(200, { pluginId: plugin.instanceId, lastModified });
    }
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > PLUGIN_ASSET_MAX_BYTES) return answer(413);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > PLUGIN_ASSET_MAX_BYTES) return answer(413);
    const etag = createHash("sha256").update(bytes).digest("hex");
    if (payload.ifMatch === etag) {
      return answer(304, { pluginId: plugin.instanceId, etag, lastModified });
    }
    return answer(200, { pluginId: plugin.instanceId, etag, lastModified, body: bytes });
  }

  private async admit(
    endpoints: Map<string, HostPluginAssetEndpoint>,
    endpointIds: readonly string[],
    root: string
  ): Promise<HostPluginAssetPlugin | "driven-elsewhere" | null> {
    const normalizedRoot = path.resolve(root);
    const candidates = (await this.options.loadedPlugins()).filter(
      (plugin) => path.resolve(plugin.dir) === normalizedRoot && !plugin.remoteUnsupported
    );
    if (candidates.length === 0) return null;
    let drivenElsewhere = false;
    for (const id of endpointIds) {
      const endpoint = endpoints.get(id);
      const projectId = endpoint?.projectId ?? null;
      if (!endpoint || endpoint.isClosed() || projectId === null) continue;
      if (!this.options.isDriving(projectId, endpoint)) {
        drivenElsewhere = true;
        continue;
      }
      const visible = candidates.find(
        (plugin) => plugin.projectId === null || plugin.projectId === projectId
      );
      if (visible) return visible;
    }
    return drivenElsewhere ? "driven-elsewhere" : null;
  }
}
