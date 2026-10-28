// Limits for host-managed plugin artifacts (#14100). Each bounds something the
// host holds on a plugin's behalf: disk, open transfers, live handles.

export const PLUGIN_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Disk one plugin's artifacts may hold across all its projects, partial files included. */
export const PLUGIN_ARTIFACT_PLUGIN_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
/** Disk the whole cache may hold; past it the least recently used artifacts go first. */
export const PLUGIN_ARTIFACT_CACHE_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
export const PLUGIN_ARTIFACT_MAX_PER_PLUGIN = 256;

export const PLUGIN_ARTIFACT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const PLUGIN_ARTIFACT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const PLUGIN_ARTIFACT_MIN_TTL_MS = 60 * 1000;

export const PLUGIN_ARTIFACT_MAX_TRANSFERS_PER_PLUGIN = 2;
export const PLUGIN_ARTIFACT_MAX_TRANSFERS = 4;

export const PLUGIN_ARTIFACT_MAX_ATTEMPTS = 3;
export const PLUGIN_ARTIFACT_DEFAULT_ATTEMPTS = 3;
/** A transfer that moves no byte for this long is failed (and retried, for a download). */
export const PLUGIN_ARTIFACT_IDLE_TIMEOUT_MS = 30_000;
export const PLUGIN_ARTIFACT_PROGRESS_INTERVAL_MS = 150;

export const PLUGIN_ARTIFACT_UPLOAD_RESPONSE_MAX_BYTES = 64 * 1024;
export const PLUGIN_ARTIFACT_NAME_MAX_LENGTH = 255;
export const PLUGIN_ARTIFACT_HEADERS_MAX = 32;
export const PLUGIN_ARTIFACT_HEADER_VALUE_MAX_LENGTH = 8192;
export const PLUGIN_ARTIFACT_URL_MAX_LENGTH = 8192;

/** Playback leases one view may hold at once; minting past it drops that view's oldest. */
export const PLUGIN_ARTIFACT_LEASES_PER_VIEW = 64;
