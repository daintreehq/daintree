// Helpers shared by several plugin manifest contribution schemas.

import { z } from "zod";
import { isPrivateOrLoopbackHostname } from "../pluginIdentifiers.js";

export const utf8 = new TextEncoder();

/**
 * Validate a plugin-relative asset path (a view's `componentPath` #9229, or a
 * skill's markdown `path` #10892) at the manifest gate. Realpath containment at
 * read/request time is the security boundary (the `plugin://` protocol handler
 * for views; `resolveContainedPath` for skills); this check rejects an absolute
 * path, a Windows separator, an embedded URL scheme/query/fragment, a NUL, or a
 * `..` segment at parse time so the failure is a loud manifest-validation error,
 * not a silent 404 / read failure later. Accepts relative POSIX paths only — a
 * leading `./` is preserved.
 */
export function isSafePluginAssetPath(componentPath: string): boolean {
  if (componentPath.startsWith("/")) return false;
  if (componentPath.includes("\\")) return false;
  if (componentPath.includes("\0")) return false;
  // Reject embedded URL structure markers — `https://...` (`:`), `?query`, or
  // `#fragment` — to catch typos early and avoid polluting the V8 module cache
  // with duplicate query-string variants.
  if (componentPath.includes(":")) return false;
  if (componentPath.includes("?")) return false;
  if (componentPath.includes("#")) return false;
  // A bare current-dir / root path (`.`, `./`) resolves to no module file — a
  // 404 from the protocol handler — so reject it at the manifest gate.
  const normalized = componentPath.startsWith("./") ? componentPath.slice(2) : componentPath;
  if (normalized === "" || normalized === ".") return false;
  return !componentPath.split("/").includes("..");
}

export const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Shared per-entry validator body for manifest URL fields. Each entry must:
 *
 * - Parse as a `https:` URL (no `http:`, `file:`, custom schemes).
 * - Contain no `*` substring (wildcards are rejected so a tightly-bound
 *   declaration cannot smuggle a permissive value past the manifest gate).
 * - Carry no embedded credentials (no `https://user:pass@host`).
 * - Target a multi-label hostname (at least one `.` after parse). Single-label
 *   intranet hosts are rejected to keep URLs auditable from the manifest.
 * - Not target a private/loopback/link-local address (SSRF mitigation).
 *
 * `fieldLabel` names the offending field in error messages so the same
 * discipline can back both `scopes.network.allowedUrls` and `authors[].url`
 * without leaking a misleading field name into the other's validation errors.
 */
export function refinePluginHttpsUrl(
  value: string,
  ctx: z.RefinementCtx,
  fieldLabel: string
): void {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in ${fieldLabel}: "${value}"`,
      params: { errorCode: "scope_wildcard_rejected" },
    });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entry is not a valid URL: "${value}"`,
      params: { errorCode: "scope_url_invalid" },
    });
    return;
  }
  if (parsed.protocol !== "https:") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entries must use https:// — got "${parsed.protocol}" in "${value}"`,
      params: { errorCode: "scope_url_not_https" },
    });
    return;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entries must not embed credentials: "${value}"`,
      params: { errorCode: "scope_url_has_credentials" },
    });
    return;
  }
  const hostname = parsed.hostname;
  if (isPrivateOrLoopbackHostname(hostname)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entry targets a private or loopback address: "${value}"`,
      params: { errorCode: "scope_url_private_target" },
    });
    return;
  }
  if (hostname === "" || !hostname.includes(".")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} hostnames must be multi-label (got "${hostname}" in "${value}")`,
      params: { errorCode: "scope_url_hostname_unqualified" },
    });
    return;
  }
}
