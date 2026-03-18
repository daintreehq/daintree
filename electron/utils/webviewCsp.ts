import type { OnHeadersReceivedListenerDetails } from "electron";

export type WebviewPartitionType = "browser" | "dev-preview" | "sidecar" | "unknown";

/**
 * Checks if a partition is a valid dev-preview partition.
 * Matches exact "persist:dev-preview" or dynamic "persist:dev-preview-*" patterns.
 */
export function isDevPreviewPartition(partition: string): boolean {
  return partition === "persist:dev-preview" || partition.startsWith("persist:dev-preview-");
}

/**
 * Classifies a partition string into its type.
 * Used to apply appropriate CSP policies to different webview partitions.
 */
export function classifyPartition(partition: string): WebviewPartitionType {
  if (partition === "persist:browser") {
    return "browser";
  }
  if (partition === "persist:sidecar") {
    return "sidecar";
  }
  if (isDevPreviewPartition(partition)) {
    return "dev-preview";
  }
  return "unknown";
}

/**
 * Returns the CSP policy string for localhost-based dev server webviews.
 * Used for browser panels and dev preview panels that load localhost content.
 * Includes https: and wss: for secure localhost dev servers.
 *
 * 'unsafe-inline' is kept in script-src and style-src because dev servers
 * (Vite, Next.js, webpack) inject inline scripts and <style> tags for HMR.
 * 'unsafe-eval' is intentionally omitted — Vite 6 does not require it, and
 * the CSP is applied at the session level before the framework is known, so
 * we default to the stricter policy.
 */
export function getLocalhostDevCSP(): string {
  return [
    "default-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    "script-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    "style-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:* http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    "img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    "font-src 'self' data:",
    "frame-src 'self' blob: http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/**
 * Merges CSP headers into response headers, replacing any existing CSP header.
 * This prevents multiple conflicting CSP headers from accumulating.
 */
export function mergeCspHeaders(
  details: OnHeadersReceivedListenerDetails,
  cspPolicy: string
): Record<string, string[]> {
  const responseHeaders = { ...details.responseHeaders };

  // Remove any existing CSP headers (case-insensitive)
  const cspKeys = Object.keys(responseHeaders).filter(
    (key) => key.toLowerCase() === "content-security-policy"
  );
  cspKeys.forEach((key) => delete responseHeaders[key]);

  // Add the new CSP header
  responseHeaders["Content-Security-Policy"] = [cspPolicy];

  return responseHeaders;
}
