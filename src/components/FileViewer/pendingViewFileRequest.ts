// Eager-loaded buffer for `daintree:view-file` requests. FileViewerModalHost
// lives in a lazy chunk, so its event listener registers only after that chunk
// loads — a request dispatched before then (first open right after hydration,
// or the re-dispatch that resets a crashed host boundary) would otherwise be
// lost. AppInner's always-mounted listener stashes the latest request here and
// the host consumes it on mount.

export interface ViewFileRequest {
  path: string;
  rootPath?: string;
  line?: number;
  col?: number;
}

let pending: ViewFileRequest | null = null;

export function parseViewFileEvent(e: Event): ViewFileRequest | null {
  if (!(e instanceof CustomEvent)) return null;
  const detail = e.detail as unknown;
  const d = detail as { path?: unknown; rootPath?: unknown; line?: unknown; col?: unknown };
  if (typeof d?.path !== "string" || !d.path) return null;
  return {
    path: d.path,
    rootPath: typeof d.rootPath === "string" && d.rootPath ? d.rootPath : undefined,
    line: typeof d.line === "number" ? d.line : undefined,
    col: typeof d.col === "number" ? d.col : undefined,
  };
}

export function stashViewFileRequest(e: Event): void {
  const request = parseViewFileEvent(e);
  if (request) pending = request;
}

export function consumePendingViewFileRequest(): ViewFileRequest | null {
  const request = pending;
  pending = null;
  return request;
}
