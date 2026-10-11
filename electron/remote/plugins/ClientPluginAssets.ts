import crypto from "node:crypto";
import path from "node:path";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { stripPluginViewGeneration } from "../../../shared/utils/pluginViewUrl.js";
import type { RemotePluginAsset, RemotePluginAssetProxy } from "../../setup/protocols.js";
import {
  PLUGIN_ASSET_METHOD,
  PLUGIN_VIEW_MANIFEST_METHOD,
  PluginAssetResponseSchema,
  PluginViewManifestResponseSchema,
  type PluginAssetRequest,
} from "./assetLinkMethods.js";
import type { PluginViewAdmitter, PluginViewManifest } from "./pluginViewGate.js";

/** The slice of a link session the asset client calls through. */
export interface AssetSession {
  readonly isOpen: boolean;
  call(method: string, payload: unknown): Promise<unknown>;
}

interface CachedAsset {
  hostId: HostId;
  pluginId: string;
  /** The view generation the URL named, or null for an ungenerated asset. */
  generation: number | null;
  etag: string;
  lastModified: number | null;
  body: Uint8Array;
  /** sha256 (hex) of `body`, worked out here. */
  sha256: string;
  lastUsed: number;
}

/** Bound on the bytes kept for all hosts together; least recently used goes first. */
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Loads host plugins' view assets for this Shell's windows attached to those
 * hosts, and keeps the bytes.
 *
 * Entries are keyed by host, authority (one plugin load on that host) and path
 * — which carries the view generation — and remember the plugin they belong to,
 * so the effective key is (host, plugin, generation). A cached copy is still
 * never served on its own say-so: every read asks the host, which answers
 * "unchanged" without the bytes. The host is what decides whether this Shell
 * may still see the plugin, so a closed project or a moved drive lease revokes
 * access on the next read, and the refusal drops the copy here too. Everything
 * a host holds is dropped when its last endpoint here closes.
 *
 * The host deciding is not enough for this machine to run the code, though:
 * every file, fresh or cached, passes this machine's own gate first, which
 * holds it to the exact bundle the person here allowed.
 */
export class ClientPluginAssets {
  private readonly endpoints = new Map<
    HostId,
    Map<string, { session: AssetSession; webContentsId: number }>
  >();
  private readonly cache = new Map<string, CachedAsset>();
  private cachedBytes = 0;
  private clock = 0;

  constructor(
    private readonly gate: PluginViewAdmitter,
    private readonly maxCacheBytes = DEFAULT_CACHE_BYTES
  ) {}

  noteEndpointOpened(
    hostId: HostId,
    info: { session: AssetSession; webContentsId: number; endpointId: string }
  ): void {
    let byId = this.endpoints.get(hostId);
    if (!byId) {
      byId = new Map();
      this.endpoints.set(hostId, byId);
    }
    byId.set(info.endpointId, { session: info.session, webContentsId: info.webContentsId });
  }

  noteEndpointClosed(hostId: HostId, info: { endpointId: string }): void {
    const byId = this.endpoints.get(hostId);
    if (!byId) return;
    byId.delete(info.endpointId);
    if (byId.size > 0) return;
    this.endpoints.delete(hostId);
    this.revoke((entry) => entry.hostId === hostId);
  }

  /** Drop what is cached for a host, or for one of its plugins. */
  revokeHost(hostId: HostId, pluginId?: string): void {
    this.revoke(
      (entry) => entry.hostId === hostId && (pluginId === undefined || entry.pluginId === pluginId)
    );
  }

  get size(): number {
    return this.cache.size;
  }

  /** The host's list of a plugin bundle's files, through this machine's newest open endpoint. */
  async loadManifest(hostId: HostId, authority: string): Promise<PluginViewManifest | null> {
    const open = this.openEndpoints(hostId);
    if (open.length === 0) return null;
    const parsed = PluginViewManifestResponseSchema.safeParse(
      await open[open.length - 1]![1].session.call(PLUGIN_VIEW_MANIFEST_METHOD, {
        endpointIds: open.map(([id]) => id).slice(-64),
        authority,
      })
    );
    if (!parsed.success || parsed.data.status !== 200) return null;
    const { pluginId, files } = parsed.data;
    if (!pluginId || !files) return null;
    return { pluginId, files: new Map(files.map((file) => [file.path, file.sha256])) };
  }

  private openEndpoints(hostId: HostId) {
    const byId = this.endpoints.get(hostId);
    return byId ? [...byId.entries()].filter(([, ep]) => ep.session.isOpen) : [];
  }

  readonly proxy: RemotePluginAssetProxy = async ({ hostId, authority, path, method }) => {
    const open = this.openEndpoints(hostId);
    if (open.length === 0) return { status: 503, body: null };
    const [, newest] = open[open.length - 1]!;
    const session = newest.session;
    const filePath = pinPathOf(path);
    // A path the host's handler would normalize to another file is never admitted.
    if (filePath === null) return { status: 403, body: null };
    const key = `${hostId}\0${authority}\0${path}`;
    const cached = this.cache.get(key);
    const request: PluginAssetRequest = {
      endpointIds: open.map(([id]) => id).slice(-64),
      authority,
      path,
      method,
      ...(cached ? { ifMatch: cached.etag } : {}),
    };
    const parsed = PluginAssetResponseSchema.safeParse(
      await session.call(PLUGIN_ASSET_METHOD, request)
    );
    if (!parsed.success) return { status: 502, body: null };
    const answer = parsed.data;
    if (answer.status === 304 && cached) {
      if (answer.pluginId !== null && answer.pluginId !== cached.pluginId) {
        this.drop(key);
        return { status: 403, body: null };
      }
      if (!(await this.admit(hostId, authority, cached, filePath, newest.webContentsId))) {
        return { status: 403, body: null };
      }
      cached.lastUsed = ++this.clock;
      return this.toAsset(cached);
    }
    if (answer.status !== 200) {
      // Refused or gone on the host: whatever this Shell kept is no longer its to serve.
      if (cached) this.drop(key);
      return { status: answer.status === 304 ? 502 : answer.status, body: null };
    }
    if (method === "HEAD") {
      return { status: 200, body: null, lastModified: answer.lastModified ?? undefined };
    }
    if (!answer.body || !answer.etag || !answer.pluginId) return { status: 502, body: null };
    if (cached) this.drop(key);
    const entry: CachedAsset = {
      hostId,
      pluginId: answer.pluginId,
      generation: generationOf(path),
      etag: answer.etag,
      lastModified: answer.lastModified,
      body: answer.body,
      sha256: crypto.createHash("sha256").update(answer.body).digest("hex"),
      lastUsed: ++this.clock,
    };
    if (!(await this.admit(hostId, authority, entry, filePath, newest.webContentsId))) {
      return { status: 403, body: null };
    }
    this.store(key, entry);
    return this.toAsset(entry);
  };

  private admit(
    hostId: HostId,
    authority: string,
    entry: CachedAsset,
    filePath: string,
    webContentsId: number
  ): Promise<boolean> {
    return this.gate.admit({
      hostId,
      authority,
      webContentsId,
      loadManifest: () => this.loadManifest(hostId, authority),
      pluginId: entry.pluginId,
      path: filePath,
      sha256: entry.sha256,
    });
  }

  private toAsset(entry: CachedAsset): RemotePluginAsset {
    return {
      status: 200,
      body: entry.body,
      ...(entry.lastModified !== null ? { lastModified: entry.lastModified } : {}),
    };
  }

  private store(key: string, entry: CachedAsset): void {
    if (entry.body.byteLength > this.maxCacheBytes) return;
    this.cache.set(key, entry);
    this.cachedBytes += entry.body.byteLength;
    while (this.cachedBytes > this.maxCacheBytes) {
      let oldest: [string, CachedAsset] | null = null;
      for (const candidate of this.cache) {
        if (!oldest || candidate[1].lastUsed < oldest[1].lastUsed) oldest = candidate;
      }
      if (!oldest) break;
      this.drop(oldest[0]);
    }
  }

  private drop(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cachedBytes -= entry.body.byteLength;
  }

  private revoke(match: (entry: CachedAsset) => boolean): void {
    for (const [key, entry] of [...this.cache]) if (match(entry)) this.drop(key);
  }
}

/**
 * The file's normalized path within the plugin, without the view generation
 * a reload adds; null for anything the host could resolve to a different file
 * than the one named (`..`, `.`, empty segments, NUL, backslash).
 */
function pinPathOf(encodedPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  const stripped = stripPluginViewGeneration(decoded);
  if (!stripped || decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = stripped.path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return path.posix.normalize(stripped.path);
}

function generationOf(encodedPath: string): number | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  return stripPluginViewGeneration(decoded)?.generation ?? null;
}
