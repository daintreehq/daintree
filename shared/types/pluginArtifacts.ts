/**
 * A file the host holds for a plugin (#14100): a copy of a file the person
 * chose or a scoped path, or a provider file downloaded into the cache. The
 * handle is metadata only. It never carries a path, a provider URL or bytes,
 * and the id alone authorizes nothing outside the plugin that owns it.
 *
 * Artifacts live for the session: an index in main, the bytes under the
 * app's data directory. They go when they expire, when the plugin releases
 * them, when their project closes, when the plugin unloads, or when the cache
 * needs the room, oldest use first. A restart starts with an empty cache.
 */
export interface PluginArtifact {
  readonly id: string;
  /** The project the artifact belongs to; null for an app-wide artifact of an app-global plugin. */
  readonly projectId: string | null;
  /** Display name: the source file's base name, or the one the plugin gave. */
  readonly name: string;
  readonly mimeType: string;
  /** Exact byte length of the stored file. */
  readonly size: number;
  readonly createdAt: number;
  /** When the host drops it unless released earlier. */
  readonly expiresAt: number;
  readonly origin: "import" | "download";
}

/** Byte progress of one artifact transfer. */
export interface PluginArtifactProgress {
  readonly transferredBytes: number;
  /** Null when the provider did not say how long the body is. */
  readonly totalBytes: number | null;
  /** 1-based; a retried download reports its second attempt as 2. */
  readonly attempt: number;
}

/** Options every call that creates an artifact accepts. */
export interface PluginArtifactCreateOptions {
  signal?: AbortSignal;
  /**
   * The project the artifact belongs to. A project plugin's artifacts always
   * belong to its own project, and naming another rejects. An app-global
   * plugin may name a project so the artifact goes when that project closes;
   * without one it is app-wide.
   */
  projectId?: string;
  /** Display name; defaults to the source's base name. */
  name?: string;
  /** Overrides the type the host infers from the name or the response. */
  mimeType?: string;
  /** Lifetime from creation, clamped to 1 minute through 24 hours. */
  ttlMs?: number;
  /** Called at most every ~150 ms while bytes move, and once at the end. */
  onProgress?: (progress: PluginArtifactProgress) => void;
}

/** What {@link PluginArtifactApi.import} copies from. */
export interface PluginArtifactImportSource {
  /** An absolute path inside the plugin's declared `scopes.fs.allowedPaths` or its data dir. */
  path: string;
}

/** A provider file {@link PluginArtifactApi.download} fetches. */
export interface PluginArtifactDownloadRequest {
  /** HTTPS URL under one of the manifest's `scopes.network.allowedUrls`. */
  url: string;
  /**
   * Request headers, for a provider token for instance. Dropped from any
   * redirect hop that leaves the original origin, and never stored or logged.
   */
  headers?: Record<string, string>;
}

/** Options for {@link PluginArtifactApi.download}. */
export interface PluginArtifactDownloadOptions extends PluginArtifactCreateOptions {
  /**
   * Attempts in all, 1 to 3; default 3. A
   * retry resumes from the bytes already received when the provider supports
   * ranges and the file has not changed, and starts over otherwise.
   */
  attempts?: number;
}

/** Where {@link PluginArtifactApi.upload} sends an artifact. */
export interface PluginArtifactUploadRequest {
  /** HTTPS URL under one of the manifest's `scopes.network.allowedUrls`. Redirects are refused. */
  url: string;
  /** Default `PUT`. The artifact is the whole request body. */
  method?: "PUT" | "POST";
  headers?: Record<string, string>;
}

/** Options for {@link PluginArtifactApi.upload}. */
export interface PluginArtifactUploadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PluginArtifactProgress) => void;
}

/** The provider's answer to an upload. Any status counts as an answer; the plugin judges it. */
export interface PluginArtifactUploadResult {
  status: number;
  /** Response headers, lower-cased. */
  headers: Record<string, string>;
  /** The response body as text, cut at 64 KiB. */
  body: string;
  bodyTruncated: boolean;
}

/** Options for {@link PluginArtifactApi.list}. */
export interface PluginArtifactListOptions {
  /** Only this project's artifacts; an app-global plugin's app-wide ones when null. */
  projectId?: string | null;
}

/**
 * Host-managed large files (#14100), gated on the `artifact:store`
 * capability. Bytes never cross the plugin's channel: the host reads, writes
 * and streams them, and the plugin holds {@link PluginArtifact} handles. A
 * view plays and previews one with the kit's `MediaPlayer` and
 * `MediaThumbnail`, and takes the person's files in with `FileDropzone`'s
 * `onArtifacts`.
 *
 * Every rejection carries a `code`: `ARTIFACT_NOT_FOUND` (missing, expired or
 * released), `ARTIFACT_TOO_LARGE`, `ARTIFACT_QUOTA_EXCEEDED`, `ARTIFACT_BUSY`
 * (too many transfers at once), `ARTIFACT_URL_NOT_ALLOWED`,
 * `ARTIFACT_TRANSFER_FAILED`, `ABORT_ERR`, `PERMISSION_REQUIRED`,
 * `INVALID_PATH` or `VALIDATION`.
 */
export interface PluginArtifactApi {
  /**
   * Copy a scoped file into the cache. Needs the `fs:*-read` capability for the
   * path's root, as `host.fs.readFileBytes` does. Directories, FIFOs and
   * symlinks are refused.
   */
  import(
    source: PluginArtifactImportSource,
    options?: PluginArtifactCreateOptions
  ): Promise<PluginArtifact>;
  /**
   * Stream a provider file into the cache. Needs `network:fetch`, and the URL
   * and every redirect hop must fall under `scopes.network.allowedUrls`. The
   * artifact exists only once every byte has arrived; a cancelled or failed
   * download leaves nothing behind.
   */
  download(
    request: PluginArtifactDownloadRequest,
    options?: PluginArtifactDownloadOptions
  ): Promise<PluginArtifact>;
  /** Stream an artifact to a provider as one request body. Needs `network:fetch`. */
  upload(
    artifactId: string,
    request: PluginArtifactUploadRequest,
    options?: PluginArtifactUploadOptions
  ): Promise<PluginArtifactUploadResult>;
  /** The artifact's current handle, or null once it is gone. */
  stat(artifactId: string): Promise<PluginArtifact | null>;
  /** This plugin's live artifacts, oldest first. */
  list(options?: PluginArtifactListOptions): Promise<PluginArtifact[]>;
  /** Drop the artifact now; false when it was already gone. Playback of it stops. */
  release(artifactId: string): Promise<boolean>;
}

/** A playable source for an artifact, minted for one view. */
export interface PluginArtifactSource {
  url: string;
  mimeType: string;
  size: number;
}
