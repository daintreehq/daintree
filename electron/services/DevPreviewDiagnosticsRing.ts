import type { DevPreviewDiagnosticEvent } from "../../shared/types/ipc/devPreview.js";

// Bounds for the per-session diagnostics timeline. The ring keeps the last
// DIAGNOSTIC_RING_MAX events per session key; the map keeps rings for the last
// DIAGNOSTIC_SESSIONS_MAX keys touched so a timeline survives hibernation /
// panel-close (the session object is deleted but its ring stays inspectable)
// without growing unbounded across a long app session. Free-text fields are
// capped so one pathological error line can't bloat a snapshot.
export const DIAGNOSTIC_RING_MAX = 100;
export const DIAGNOSTIC_SESSIONS_MAX = 50;
export const DIAGNOSTIC_TEXT_MAX = 200;
// Consecutive identical proxy failures coalesce into one event with a count —
// a webview retry storm must not evict the lifecycle history it explains.
export const PROXY_EVENT_COALESCE_MS = 10_000;

export type DevPreviewDiagnosticsRingMap = Map<
  string,
  { events: DevPreviewDiagnosticEvent[]; seq: number }
>;

// A diagnostic event as recorded at a call site: the ring assigns at/seq/
// generation/count. Distributes over the union so each variant keeps its
// typed details.
export type DevPreviewDiagnosticInput<T = DevPreviewDiagnosticEvent> =
  T extends DevPreviewDiagnosticEvent ? Omit<T, "at" | "seq" | "generation" | "count"> : never;

export function capDiagnosticText(text: string): string {
  return text.length > DIAGNOSTIC_TEXT_MAX ? text.slice(0, DIAGNOSTIC_TEXT_MAX) : text;
}

/**
 * Strip credentials and query/fragment from a URL before it enters the
 * timeline. A dev server's own URL is normally innocuous, but a configured one
 * can carry a token in userinfo or a query parameter, and the timeline is
 * user-visible and copyable. Origin plus path is all a reader needs to tell one
 * candidate from another.
 */
export function sanitizeDiagnosticUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return capDiagnosticText(url);
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return capDiagnosticText(parsed.toString());
}

/**
 * Append a diagnostic event to a session key's bounded ring. Consecutive
 * identical proxy failures coalesce into one event with a count so a webview
 * retry storm can't evict the lifecycle history. Writing touches the key's
 * LRU position; the oldest untouched key is dropped past DIAGNOSTIC_SESSIONS_MAX.
 */
export function recordDevPreviewDiagnostic(
  rings: DevPreviewDiagnosticsRingMap,
  key: string,
  generation: number,
  input: DevPreviewDiagnosticInput
): void {
  let ring = rings.get(key);
  if (ring) {
    rings.delete(key);
  } else {
    ring = { events: [], seq: 0 };
  }
  rings.set(key, ring);
  while (rings.size > DIAGNOSTIC_SESSIONS_MAX) {
    const oldest = rings.keys().next().value;
    if (oldest === undefined) break;
    rings.delete(oldest);
  }

  // Coalesce only true repeats: same failure, same errno, same generation —
  // a post-restart failure or a different errno must stay its own event.
  const last = ring.events[ring.events.length - 1];
  if (
    (input.type === "proxy-502" || input.type === "proxy-ws-failed") &&
    last !== undefined &&
    last.type === input.type &&
    last.cause === input.cause &&
    last.code === input.code &&
    last.generation === generation &&
    Date.now() - last.at <= PROXY_EVENT_COALESCE_MS
  ) {
    last.count = (last.count ?? 1) + 1;
    last.at = Date.now();
    return;
  }

  ring.events.push({
    ...input,
    at: Date.now(),
    seq: ring.seq++,
    generation,
  } as DevPreviewDiagnosticEvent);
  if (ring.events.length > DIAGNOSTIC_RING_MAX) {
    ring.events.splice(0, ring.events.length - DIAGNOSTIC_RING_MAX);
  }
}
