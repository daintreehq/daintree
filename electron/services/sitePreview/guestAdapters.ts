/**
 * The named guest runtimes this host is willing to install.
 *
 * A binding names an adapter; the host loads its body itself. That is the whole
 * point of the registry: before it, `bind` took the script to install as a
 * string, so any renderer-side caller — a compromised plugin view included —
 * decided what ran inside the site the user was previewing. It also gives every
 * binding an owner, which a bare source string never carried.
 *
 * An adapter's body is still code the host cannot vet. What the registry bounds
 * is who chose it: only main, at startup, from an asset it shipped.
 */

import { AppError } from "../../utils/errorTypes.js";

export interface GuestAdapter {
  /** Stable id the renderer binds by. */
  id: string;
  /** Plugin that owns this runtime; recorded on every binding it backs. */
  pluginId: string;
  /** Reads the runtime body. */
  load: () => Promise<string>;
  /**
   * Whether the body may be kept after the first read. False for an asset a
   * running build can replace — `build:main --watch` rebuilds the guest bundle
   * without restarting Electron, and a cached body would pin the version that
   * happened to be on disk at the first bind for the rest of the session.
   */
  cache: boolean;
}

/**
 * Ceiling on a loaded body, so a corrupt or replaced asset cannot pin megabytes
 * of source per binding. The real guest runtime is an order of magnitude under.
 */
export const MAX_GUEST_ADAPTER_BYTES = 512 * 1024;

const adapters = new Map<string, GuestAdapter>();
const sources = new Map<string, string>();

/** Returns a disposer, so a handler's teardown leaves no adapter behind. */
export function registerGuestAdapter(adapter: GuestAdapter): () => void {
  adapters.set(adapter.id, adapter);
  sources.delete(adapter.id);
  return () => {
    if (adapters.get(adapter.id) === adapter) {
      adapters.delete(adapter.id);
      sources.delete(adapter.id);
    }
  };
}

export function resolveGuestAdapter(id: string): GuestAdapter | null {
  return adapters.get(id) ?? null;
}

/**
 * The adapter's body. Kept after the first read when the adapter says it may be
 * — a shipped asset cannot change under a running app — and reread every time
 * when it may not.
 */
export async function loadGuestAdapterSource(id: string): Promise<string> {
  const cached = sources.get(id);
  if (cached !== undefined) return cached;

  const adapter = adapters.get(id);
  if (!adapter) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "No guest runtime is registered under that id",
      context: { adapterId: id },
    });
  }

  let source: string;
  try {
    source = await adapter.load();
  } catch (cause) {
    throw new AppError({
      code: "INTERNAL",
      message: "The guest runtime for that adapter could not be read",
      context: { adapterId: id, pluginId: adapter.pluginId },
      cause: cause instanceof Error ? cause : undefined,
    });
  }

  if (source.length === 0) {
    throw new AppError({
      code: "INTERNAL",
      message: "The guest runtime for that adapter is empty",
      context: { adapterId: id, pluginId: adapter.pluginId },
    });
  }
  if (Buffer.byteLength(source, "utf8") > MAX_GUEST_ADAPTER_BYTES) {
    throw new AppError({
      code: "PAYLOAD_TOO_LARGE",
      message: "The guest runtime for that adapter exceeds the per-binding ceiling",
      context: { adapterId: id, pluginId: adapter.pluginId },
    });
  }

  // A re-registration during the read replaces the adapter and clears the
  // cache; caching this text then would serve the outgoing adapter's body under
  // the new one's id for the rest of the session.
  if (adapter.cache && adapters.get(id) === adapter) sources.set(id, source);
  return source;
}

export function __resetGuestAdaptersForTests(): void {
  adapters.clear();
  sources.clear();
}
